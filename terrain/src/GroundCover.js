/* GroundCover — camera-anchored near-field grass & sage carpet (Three.js r184).
 *
 * ScatterManager's trees and sage domes carry the middle distance, but the first 30 m of
 * walking-mode ground read as painted floor. This module keeps a small ring (~80 m) of
 * instanced alpha-tested cards (2 tris each) around the camera: grass tufts and tiny sage
 * sprigs painted procedurally on a 4-column canvas atlas, matching ScatterManager's painterly
 * sprite style.
 *
 * Structure mirrors ScatterManager: the ring is divided into small cells (~32 m) filled
 * deterministically (seeded by cell coords), so cover re-grows identically and recycling is
 * smooth as the camera walks. All instances live in ONE pooled InstancedMesh (1 draw call):
 * each live cell owns a fixed block of instance slots; retired cells zero-scale their block.
 * Distance fade is a vertex-shader size ramp (cards shrink into the ground 52->78 m), so the
 * ring boundary never pops.
 *
 * Content by NLCD class (Landcover.classAt): two fluffy meadow variants — a TALL LUSH GREEN
 * carpet on grass/riparian/marsh (71/90/95) and a SHORT DRY PALE carpet on the sage flats (52,
 * with occasional woody sage sprigs) — plus sparse dark understory tufts under 41/42/43 and
 * wildflowers dotted through the meadows. Nothing on water or above y≈950 (subalpine).
 *
 * Budget: 32 blocks x 2600 slots = 83 200 instances max (~500k tris worst case, most of it
 * zero-scaled and degenerate), 1 draw call, one 640x128 canvas texture.
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const LEGACY_COLS = 5;
  const V2_COLS = 11;                          // 3 meadow, 3 bunchgrass, 3 sage/understory, flowers, dead stems
  const LOD_COLS = 12;                         // V2 plus low, pale straw background
  const DENSITY = { 71: 1.0, 52: 0.95, 41: 0.45, 42: 0.40, 43: 0.45, 90: 0.85, 95: 0.95 };

  /* Carriageway exclusion (Milestone 1): grass may reach the shoulder but never the asphalt/
     track surface itself. Per-class SURFACE half-widths (m from the centerline) — half of
     RoadRibbon's ribbon WIDTH table. Buildings exclude at the footprint (point query). */
  const ROAD_SURF_HW = { highway: 4.5, park_paved: 3.75, gravel: 2.5, track: 1.5 };
  const ROAD_SURF_M = 0.4;                     // a hair beyond the pavement edge

  const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function vhash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
  /* ~22 m value noise: grass grows in patches, not white noise */
  function clumpNoise(x, z) {
    // two octaves: a broad (~22 m) stand pattern + a finer (~7 m) bunch/gap detail, so grass reads
    // as clumps of bunches with bare soil between — like real sage-steppe, not a uniform lawn.
    const oct = (S) => {
      const gx = x / S, gz = z / S, ix = Math.floor(gx), iz = Math.floor(gz);
      const fx = gx - ix, fz = gz - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
      const l = (a, b, t) => a + (b - a) * t;
      return l(l(vhash(ix, iz), vhash(ix + 1, iz), u),
               l(vhash(ix, iz + 1), vhash(ix + 1, iz + 1), u), v);
    };
    return oct(22) * 0.62 + oct(7.3) * 0.38;
  }

  /* Three nested, world-anchored scales describe plant communities rather than independent
     confetti: broad biome zones, stands/openings and individual bunches. */
  function patchNoise(x, z, scale, salt) {
    const gx = x / scale, gz = z / scale, ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const h = (a, b) => vhash(a + salt * 17.13, b - salt * 11.71);
    const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * u;
    const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * u;
    return a + (b - a) * v;
  }

  /* Authoritative water-surface point query (M1-2 water lane) — see ScatterManager for the full
     rationale. lc.waterAt is the 10 m NHD mask that floods the Oxbow/Willow Flats marsh; the
     ground truth for what's wet at the current LOD is WaterBuilder's baked surface. Bilinear
     S+bias world-Y at (x,z) reusing WaterBuilder's already-decoded arrays (no decode, no rng),
     or null outside the baked band / before the bake loads. Same math as WaterBuilder's
     _surfaceSampler, kept local so GroundCover stays standalone. */
  function makeWaterSurfaceSampler(water) {
    return (x, z) => {
      const surf = water && water._surf;
      if (!surf) return null;
      const m = water.wm, W = m.width, H = m.height, bias = water._bias;
      const cE = m.world.centerEasting, cN = m.world.centerNorthing;
      const e0 = m.elevMin - m.world.datum;
      const u = (x + cE - m.originE) / m.res - 0.5;
      const v = (m.originN - (cN - z)) / m.res - 0.5;
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      let ws = 0, ss = 0, bs = 0;
      for (let dj = 0; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= H) continue;
        for (let di = 0; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= W) continue;
          const q = surf[jj * W + ii];
          if (!q) continue;
          const w = (di ? fu : 1 - fu) * (dj ? fv : 1 - fv);
          ws += w; ss += w * q; bs += w * bias[jj * W + ii];
        }
      }
      if (ws < 1e-6) return null;
      return (ss / ws - 1) * 0.1 + e0 + (bs / ws) * 0.01;
    };
  }

  /* ---------------- ground-colour tint map (imagery-derived) ----------------
     terrain/public/groundtint.png (~9 MB @ 20 m, park-wide): RGB = the true local OPEN-GROUND
     colour baked OFFLINE from the NAIP imagery (tree + water pixels excluded so conifer shadow /
     lake blue don't drag it). GroundCover tints each grass/sage card toward this colour so the
     near-field carpet matches the draped photography instead of a fixed per-NLCD-class swatch.
     Same world->pixel registration + json schema as ScatterManager.ForestMask. Optional: absent /
     failed load -> colorAt returns null everywhere and the class-based colour is kept. */
  class GroundTint {
    constructor(url) { this.url = url; }
    async init() {
      this.m = await (await fetch(this.url)).json();
      const base = this.url.replace(/[^/]+$/, '');
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('groundtint.png failed to load'));
        img.src = base + this.m.url;
      });
      const cv = document.createElement('canvas');
      cv.width = this.m.width; cv.height = this.m.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      this.data = ctx.getImageData(0, 0, this.m.width, this.m.height).data;
      this.cE = this.m.world.centerEasting; this.cN = this.m.world.centerNorthing;
      return this;
    }
    /* bilinear ground colour [r,g,b] in 0..1; null outside the baked band. Same registration as
       ForestMask.probAt; edge texels clamp. Writes into out[] to avoid per-call allocation. */
    colorAt(x, z, out) {
      const m = this.m, W = m.width, H = m.height, d = this.data;
      const u = (x + this.cE - m.originE) / m.res - 0.5;
      const v = (m.originN - (this.cN - z)) / m.res - 0.5;
      if (u < -1 || v < -1 || u > W || v > H) return null;
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const s = (ii, jj, c) => {
        ii = ii < 0 ? 0 : ii >= W ? W - 1 : ii;
        jj = jj < 0 ? 0 : jj >= H ? H - 1 : jj;
        return d[(jj * W + ii) * 4 + c] / 255;
      };
      const bl = (c) => {
        const a = s(i, j, c) + (s(i + 1, j, c) - s(i, j, c)) * fu;
        const b = s(i, j + 1, c) + (s(i + 1, j + 1, c) - s(i, j + 1, c)) * fu;
        return a + (b - a) * fv;
      };
      out[0] = bl(0); out[1] = bl(1); out[2] = bl(2);
      return out;
    }
  }

  // per-atlas-column reference colour (0..1) — the sprite's native paint average, used to turn a
  // sampled imagery colour into a multiplicative instanceColor tint (imageryColour / columnRef).
  //                    0 lush-green    1 dry-pale       2 sage          3 understory    4 wildflower
  const COL_REF = [[0.42, 0.60, 0.28], [0.64, 0.68, 0.48], [0.40, 0.46, 0.32], [0.21, 0.29, 0.17], [0.55, 0.60, 0.42]];
  // imagery pull, per meadow type: keep the lush green (weak pull) but let the dry flats wash toward
  // the pale tan/sage of the photography (stronger pull) — the two-meadow contrast the ref calls for.
  const TINT_LUSH = 0.30, TINT_DRY = 0.55;
  const WORLD_INDEX_IDS = {
    landcover: 'landcover',
    tintR: 'ground-tint-r', tintG: 'ground-tint-g', tintB: 'ground-tint-b',
  };
  const ROAD_CLASS_BY_CODE = [null, 'track', 'gravel', 'park_paved', 'highway'];

  function extractRasterChannel(rgba, channel) {
    const result = new Uint8Array(rgba.length / 4);
    for (let i = 0, p = channel; i < result.length; i++, p += 4) result[i] = rgba[p];
    return result;
  }

  /* ---------------- procedural atlas (painterly, like ScatterManager.buildAtlas) ---------------- */

  function paintGrass(ctx, x0, W, H, rng, o) {
    const cx = x0 + W / 2, base = H * 0.97;
    for (let i = 0; i < o.blades; i++) {
      const a = ((i / (o.blades - 1)) - 0.5) * o.fan + (rng() - 0.5) * 0.35;   // lean angle
      const len = H * (o.len0 + rng() * o.lenV);
      const bx = cx + (rng() - 0.5) * W * 0.26, by = base - rng() * H * 0.02;
      const tx = bx + Math.sin(a) * len * (0.5 + rng() * 0.4);
      const ty = by - Math.cos(a * 0.55) * len;
      const mx = (bx + tx) / 2 + Math.sin(a) * len * 0.30;                     // blades bow outward
      const my = (by + ty) / 2 + len * 0.08;
      const c = o.colors[(rng() * o.colors.length) | 0];
      const f = 0.78 + rng() * 0.5;
      ctx.fillStyle = 'rgb(' + ((c[0] * f) | 0) + ',' + ((c[1] * f) | 0) + ',' + ((c[2] * f) | 0) + ')';
      ctx.globalAlpha = 0.85 + rng() * 0.15;
      const w0 = W * (0.014 + rng() * 0.02);
      ctx.beginPath();
      ctx.moveTo(bx - w0, by);
      ctx.quadraticCurveTo(mx, my, tx, ty);                                    // tapers to a tip
      ctx.quadraticCurveTo(mx, my, bx + w0, by);
      ctx.closePath(); ctx.fill();
      if (o.heads && rng() < 0.4) {                                            // ripe seed heads
        ctx.fillStyle = 'rgb(214,186,120)';
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.ellipse(tx, ty, W * 0.014, W * 0.030, a, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function paintSage(ctx, x0, W, H, rng, lift) {
    lift = lift || 1;
    const cx = x0 + W / 2, base = H * 0.97;
    for (let s = 0; s < 5; s++) {
      const a = (s / 4 - 0.5) * 1.6 + (rng() - 0.5) * 0.3;
      const ex = cx + Math.sin(a) * W * 0.28;
      const ey = base - (0.38 + rng() * 0.30) * H;
      ctx.strokeStyle = 'rgb(' + ((104 * lift) | 0) + ',' + ((94 * lift) | 0) +
        ',' + ((72 * lift) | 0) + ')';                                        // woody stems
      ctx.lineWidth = W * 0.020;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(cx + (rng() - 0.5) * W * 0.08, base);
      ctx.quadraticCurveTo(cx + Math.sin(a) * W * 0.10, base - H * 0.28, ex, ey);
      ctx.stroke();
      for (let i = 0; i < 70; i++) {                                           // grey-green leaf dabs
        const g = (88 + rng() * 46) * lift;
        ctx.fillStyle = 'rgb(' + ((g * 0.84) | 0) + ',' + (g | 0) + ',' + ((g * 0.70) | 0) + ')';
        ctx.globalAlpha = 0.65 + rng() * 0.35;
        const rr = Math.sqrt(rng()) * W * 0.15, aa = rng() * 6.283;
        ctx.beginPath();
        ctx.arc(ex + Math.cos(aa) * rr, ey + Math.sin(aa) * rr * 1.25,
                W * 0.012 + rng() * W * 0.018, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* wildflowers: a low grass base + a few bright petal clusters (white / gold / purple / pink) on
     thin stems — the per-instance tint stays near-white so these painted colours read through. */
  function paintFlowers(ctx, x0, W, H, rng) {
    const cx = x0 + W / 2, base = H * 0.97;
    paintGrass(ctx, x0, W, H, rng, { blades: 8, fan: 1.6, len0: 0.30, lenV: 0.30, heads: false,
      colors: [[120, 140, 74], [104, 126, 66], [136, 150, 88]] });         // short green base
    const petal = [[248, 248, 236], [246, 214, 96], [170, 120, 210], [232, 150, 186], [250, 250, 244]];
    for (let f = 0; f < 5; f++) {
      const a = (f / 4 - 0.5) * 1.4 + (rng() - 0.5) * 0.4;
      const hx = cx + Math.sin(a) * W * 0.26, hy = base - (0.42 + rng() * 0.34) * H;
      ctx.strokeStyle = 'rgb(96,122,64)'; ctx.lineWidth = W * 0.016; ctx.globalAlpha = 0.95;   // stem
      ctx.beginPath(); ctx.moveTo(cx + (rng() - 0.5) * W * 0.1, base); ctx.lineTo(hx, hy); ctx.stroke();
      const col = petal[(rng() * petal.length) | 0];
      for (let p = 0; p < 6; p++) {                                        // petal cluster
        const pa = p / 6 * 6.283, rr = W * (0.03 + rng() * 0.02);
        ctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')'; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(hx + Math.cos(pa) * rr, hy + Math.sin(pa) * rr, W * 0.028, 0, 7); ctx.fill();
      }
      ctx.fillStyle = 'rgb(240,196,70)'; ctx.beginPath(); ctx.arc(hx, hy, W * 0.022, 0, 7); ctx.fill();  // centre
    }
    ctx.globalAlpha = 1;
  }

  /* 3D grass CLUMP: three crossed vertical cards (60° apart), pivot at the base, up-normals for even
     lighting. Reads as a real tuft from any angle instead of a single flat card that vanishes edge-on.
     Built by hand (BufferGeometryUtils is an addon, not three core). 6 tris; instanced attr later. */
  function clumpGeo(planes) {
    const pos = [], uv = [], nrm = [], idx = [], plane = [];
    let b = 0;
    for (let p = 0; p < planes; p++) {
      const ang = p * Math.PI / planes;
      const c = Math.cos(ang), s = Math.sin(ang);
      for (const [qx, qy] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) {
        pos.push(qx * c, qy, qx * s); uv.push(qx + 0.5, qy); nrm.push(0, 1, 0); plane.push(p);
      }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3); b += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('gcPlane', new THREE.Float32BufferAttribute(plane, 1));
    g.setIndex(idx);
    return g;
  }

  function buildAtlas(v2, grassLod) {
    const CW = 128, CH = 128;
    const cols = v2 ? (grassLod ? LOD_COLS : V2_COLS) : LEGACY_COLS;
    const cv = document.createElement('canvas');
    cv.width = CW * cols; cv.height = CH;
    const ctx = cv.getContext('2d');
    const rng = mulberry32(0x96A55);
    // 0: LUSH TALL meadow grass (71/90/95) — many long saturated-green blades, a bushy fluffy tuft
    paintGrass(ctx, 0, CW, CH, rng, { blades: 34, fan: 1.8, len0: 0.60, lenV: 0.40, heads: true,
      colors: [[104, 162, 68], [86, 144, 58], [132, 178, 88], [96, 154, 62]] });
    // 1: SHORT DRY meadow grass (52 sage flats) — pale straw-sage, short blades, still a full carpet
    paintGrass(ctx, CW, CW, CH, rng, { blades: 26, fan: 2.2, len0: 0.34, lenV: 0.28, heads: false,
      colors: [[172, 178, 118], [150, 158, 100], [190, 192, 140], [160, 168, 108]] });
    // 2: sage sprig (52)
    paintSage(ctx, CW * 2, CW, CH, rng);
    // 3: sparse dark understory tuft (41/42/43/90)
    paintGrass(ctx, CW * 3, CW, CH, rng, { blades: 11, fan: 1.7, len0: 0.35, lenV: 0.38, heads: false,
      colors: [[54, 76, 46], [42, 62, 38], [68, 88, 52], [50, 70, 42]] });
    // 4: wildflowers (meadows) — bright petal clusters on a short green base
    paintFlowers(ctx, CW * 4, CW, CH, rng);
    if (v2) {
      // V2 deliberately occupies a narrower, more natural luminance/saturation range. Geometry
      // still comes from one shared crossed clump, but distinct silhouettes inside the atlas make
      // neighbouring communities read as different plants rather than recoloured copies.
      ctx.clearRect(0, 0, cv.width, cv.height);
      paintGrass(ctx, 0, CW, CH, rng, { blades: 22, fan: 1.65, len0: 0.34, lenV: 0.34, heads: false,
        colors: [[74, 100, 50], [88, 112, 58], [66, 90, 45], [104, 119, 65]] });
      paintGrass(ctx, CW, CW, CH, rng, { blades: 30, fan: 1.9, len0: 0.48, lenV: 0.40, heads: false,
        colors: [[70, 99, 49], [82, 111, 55], [96, 119, 62], [62, 88, 44]] });
      paintGrass(ctx, CW * 2, CW, CH, rng, { blades: 18, fan: 2.15, len0: 0.46, lenV: 0.43, heads: true,
        colors: [[96, 112, 61], [112, 124, 70], [82, 100, 55], [128, 132, 78]] });
      paintGrass(ctx, CW * 3, CW, CH, rng, { blades: 17, fan: 1.55, len0: 0.27, lenV: 0.31, heads: false,
        colors: [[122, 119, 75], [142, 133, 84], [105, 108, 68], [154, 143, 92]] });
      paintGrass(ctx, CW * 4, CW, CH, rng, { blades: 23, fan: 2.25, len0: 0.34, lenV: 0.42, heads: true,
        colors: [[112, 111, 68], [134, 125, 76], [96, 101, 62], [150, 139, 88]] });
      paintGrass(ctx, CW * 5, CW, CH, rng, { blades: 13, fan: 2.55, len0: 0.24, lenV: 0.35, heads: false,
        colors: [[91, 96, 62], [119, 116, 72], [139, 127, 78], [80, 88, 57]] });
      paintSage(ctx, CW * 6, CW, CH, rng, 1.22);
      paintSage(ctx, CW * 7, CW, CH, rng, 1.12);
      paintGrass(ctx, CW * 8, CW, CH, rng, { blades: 14, fan: 1.9, len0: 0.25, lenV: 0.34, heads: false,
        colors: [[62, 76, 50], [70, 84, 53], [79, 91, 58], [88, 94, 60]] });
      paintFlowers(ctx, CW * 9, CW, CH, rng);
      paintGrass(ctx, CW * 10, CW, CH, rng, { blades: 10, fan: 2.4, len0: 0.38, lenV: 0.48, heads: true,
        colors: [[104, 91, 59], [124, 103, 65], [81, 76, 53], [143, 118, 72]] });
      if (grassLod) paintGrass(ctx, CW * 11, CW, CH, rng, {
        blades: 18, fan: 2.35, len0: 0.20, lenV: 0.23, heads: false,
        colors: [[178, 165, 116], [194, 178, 122], [161, 157, 109], [207, 185, 128]]
      });
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    // Canvas paint colours are authored in sRGB. Built-in Lambert materials will decode maps
    // tagged this way before lighting, matching the custom terrain's explicit albedo decode.
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------------- manager ---------------- */

  class GroundCover {
    constructor(o) {
      this.scene = o.scene; this.camera = o.camera; this.terrain = o.terrain; this.lc = o.landcover;
      const search = global.location ? global.location.search : '';
      this.v2 = !/[?&]groundv2=0(?:&|$)/.test(search);
      this.grassLod = this.v2 && !/[?&]grasslod=0(?:&|$)/.test(search);
      this.disabled = /[?&]groundcover=0(?:&|$)/.test(search);
      let quality = 'ultra';
      try { quality = new URLSearchParams(search).get('quality') || quality; } catch (_) {}
      this._quality = quality;
      this._sectorCull = this.grassLod && (quality === 'balanced' || quality === 'low');
      this.densityScale = 1;
      try {
        const qd = new URLSearchParams(search).get('grounddensity');
        if (qd !== null && isFinite(+qd)) this.densityScale = Math.max(0, Math.min(2, +qd));
      } catch (e) {}
      this.cols = this.v2 ? (this.grassLod ? LOD_COLS : V2_COLS) : LEGACY_COLS;
      this.water = o.water || null;              // WaterBuilder — authoritative wet field (M1-2)
      this._waterS = makeWaterSurfaceSampler(this.water);
      this.worldIndex = global.GT_APP && global.GT_APP.worldIndex;
      this._worldLandcoverReady = false;
      this._worldTintReady = false;
      this.tint = null;                          // imagery-derived ground colour, set async (optional)
      this._tintRGB = [0, 0, 0];                 // scratch for GroundTint.colorAt (no per-tuft alloc)
      new GroundTint(o.groundTintUrl || 'terrain/public/groundtint.json').init()
        .then((t) => {
          this.tint = t;
          this._installWorldTint(t);
          this._lastCell = null;
        })   // force a refill so live cells retint
        .catch(() => { this.tint = null; });     // absent / decode error -> keep class-based colour
      this.cellSize = o.cellSize || 32;
      this.ringCells = 3;                        // cells kept within this radius (~80-96 m)
      // V2's clustered communities need fewer slots than the legacy continuous carpet. A smaller
      // per-cell block cuts submitted zero/unused vertices as well as memory; dense V2 stands still
      // reach the cap, while their intentional openings do not pay for legacy lawn density.
      const qualityPerCell = quality === 'low' ? 1050 :
        quality === 'balanced' ? 1300 : 2000;
      this.perCell = o.perCell || (this.v2 ? qualityPerCell : 2600);
      this.blocks = 32;                          // >= live cell count (29 for ringCells=3)
      const cap = this.blocks * this.perCell;    // V2 64k; legacy 83.2k
      this.candidates = o.candidates || 3600;    // more draws so the denser cells actually fill
      this.topY0 = 870; this.topY1 = 950;        // cover gives out toward the subalpine

      // 3D crossed-clump tuft (pivot at the base so the distance fade shrinks it into the ground)
      const geo = clumpGeo(this.grassLod ? 4 : 3);
      geo.setAttribute('gcAtlas', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));

      this._windU = { value: 0 };                // wall-clock seconds, set each frame in update()
      const mat = new THREE.MeshLambertMaterial({
        map: buildAtlas(this.v2, this.grassLod), alphaTest: this.v2 ? 0.46 : 0.5, side: THREE.DoubleSide,
        // Vegetation is entirely sun/hemi lit. Even a tiny fixed emissive floor becomes conspicuous
        // after dusk and makes tufts appear self-luminous.
        emissive: new THREE.Color(0, 0, 0)
      });
      // Distance fade = size ramp in the vertex shader, so the ring edge never pops. NOTE: the
      // distance must come from view space (modelViewMatrix) — three never uploads the
      // cameraPosition uniform for Lambert materials, it silently stays (0,0,0). Plus base-anchored
      // WIND: the tip (local y→1) sways, the base (y→0) stays pinned, phase varies by world position.
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = this._windU;
        // M7.6 season: adopt the SHARED window.SEASON_UNIFORMS.uSeason (0 summer .. 0.45 autumn .. 1
        // winter) that ScatterManager writes each frame (before groundCover.update) — terrain + trees
        // already react; this closes the near-field grass gap. Deterministic + world-anchored (no
        // screen/time term), so it cannot crawl. Tint is ACES-tone-mapped like the rest of the grass.
        sh.uniforms.uSeason = (global.SEASON_UNIFORMS =
          global.SEASON_UNIFORMS || { uSeason: { value: 0 } }).uSeason;
        // root-to-tip shading (the "fluffy grass" trick): dark ambient-occluded base fading to a
        // brighter tip along the blade height (vMapUv.y) — gives the carpet depth instead of flat cards.
        // Then the season tint modifies the fully-composed albedo: autumn warms LUSH meadow green to
        // gold (gated on greenness so dry grass/wildflowers hold); deep winter desaturates + frosts.
        // Column recovered from the atlas-shifted vMapUv.x (0 lush,1 dry,2 sage,3 duff,4 wildflower).
        const cols = this.cols;
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uSeason;')
          .replace('#include <color_fragment>',
            '#include <color_fragment>\n  diffuseColor.rgb *= mix(' +
              (this.v2 ? '0.62, 0.96' : '0.42, 1.10') + ', vMapUv.y);\n' +
            (this.v2
              ? '  float gcRoot = smoothstep(0.0, 0.34, vMapUv.y);\n' +
                '  float gcLum0 = dot(diffuseColor.rgb, vec3(0.299,0.587,0.114));\n' +
                '  diffuseColor.rgb = mix(vec3(gcLum0)*vec3(0.48,0.52,0.43), diffuseColor.rgb, gcRoot);\n' +
                '  diffuseColor.a *= mix(0.78,1.0,smoothstep(0.0,0.16,vMapUv.y));\n'
              : '') +
            '  float gcCol = floor(vMapUv.x * ' + cols.toFixed(1) + ');\n' +
            (this.v2
              ? '  float gcSageF=step(5.5,gcCol)*(1.0-step(7.5,gcCol));\n' +
                '  float gcFloorF=max(step(7.5,gcCol)*(1.0-step(8.5,gcCol)),step(9.5,gcCol));\n' +
                '  diffuseColor.rgb*=1.0+0.10*gcSageF+0.07*gcFloorF;\n'
              : '') +
            '  float notFlower = 1.0 - step(' + (this.v2 ? '8.5' : '3.5') + ', gcCol);\n' +
            '  float grnG = clamp(diffuseColor.g - 0.5*(diffuseColor.r + diffuseColor.b), 0.0, 1.0);\n' +
            '  float leafG = smoothstep(0.02, 0.18, grnG);\n' +
            '  float autumnG = clamp(1.0 - abs(uSeason - 0.45) * 2.4, 0.0, 1.0);\n' +
            '  float winterG = smoothstep(0.5, 1.0, uSeason);\n' +
            '  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.42, 1.06, 0.42), 0.6 * autumnG * leafG * notFlower);\n' +
            '  float lumG = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n' +
            '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lumG), 0.5 * winterG * notFlower);\n' +
            '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.93, 0.99), 0.5 * winterG * notFlower);');
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float gcAtlas;\nattribute float gcPlane;\nuniform float uTime;\nuniform float uSeason;')
          .replace('#include <uv_vertex>',
            '#include <uv_vertex>\nvMapUv.x = (vMapUv.x + gcAtlas) * ' + (1 / cols).toFixed(6) + ';')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\n' +
            '#ifdef USE_INSTANCING\n' +
            'float gcD = length((modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);\n' +
            (this.grassLod
              ? 'float gcPlaneOn=1.0;\n' +
                'gcPlaneOn*=mix(1.0,1.0-smoothstep(38.0,48.0,gcD),step(0.5,gcPlane));\n' +
                'gcPlaneOn*=mix(1.0,1.0-smoothstep(18.0,26.0,gcD),step(1.5,gcPlane));\n' +
                'gcPlaneOn*=mix(1.0,1.0-smoothstep(14.0,20.0,gcD),step(2.5,gcPlane));\n' +
                // The background straw column is deliberately one plane at every distance.
                'gcPlaneOn*=mix(1.0,1.0-step(0.5,gcPlane),step(10.5,gcAtlas));\n' +
                'transformed*=gcPlaneOn;\n'
              : '') +
            'float gcWinter = 1.0 - 0.85 * smoothstep(0.62, 1.0, uSeason);\n' +   // deep-winter bury: ~15% stubble left
            (this.v2
              ? 'float gcType=floor(gcAtlas+0.5);\n' +
                'float gcSage=step(5.5,gcType)*(1.0-step(7.5,gcType));\n' +
                'float gcFloor=max(step(7.5,gcType)*(1.0-step(8.5,gcType)),step(9.5,gcType));\n' +
                'vec3 gcIW=instanceMatrix[3].xyz;\n' +
                'float gcShapeHash=fract(gcIW.x*0.1031+gcIW.z*0.11369);\n' +
                // Three profiles from the same six triangles: upright grass, low/broad sage and
                // narrow sparse woody floor. Per-instance bend breaks their shared card outline.
                'transformed.xz*=mix(1.0,1.18,gcSage)*mix(1.0,0.76,gcFloor);\n' +
                'transformed.y*=mix(1.0,0.76,gcSage)*mix(1.0,1.16,gcFloor);\n' +
                'transformed.x+=(gcShapeHash-0.5)*transformed.y*0.16;\n' +
                'transformed.z+=(fract(gcShapeHash*7.13)-0.5)*transformed.y*0.10;\n' +
                'float gcFar=mix(68.0,84.0,step(5.5,gcType));\n' +
                'gcFar=mix(gcFar,58.0,step(8.5,gcType)*(1.0-step(9.5,gcType)));\n' +
                (this.grassLod ? 'gcFar=mix(gcFar,48.0,step(10.5,gcType));\n' : '') +
                'transformed *= (1.0-smoothstep(gcFar-24.0,gcFar,gcD))*gcWinter;\n'
              : 'transformed *= (1.0 - smoothstep(52.0, 78.0, gcD)) * gcWinter;\n') +
            (this.v2 ? '' : 'vec3 gcIW = instanceMatrix[3].xyz;\n') +
            'float gcPh = gcIW.x*0.16 + gcIW.z*0.13;\n' +
            'float gcSway = sin(uTime*1.7 + gcPh)*0.62 + sin(uTime*3.3 + gcPh*1.7)*0.24;\n' +
            'transformed.x += gcSway * position.y*position.y * ' +
              (this.v2 ? '(0.07+0.09*(1.0-step(5.5,gcAtlas)))' : '0.16') +
              ' * gcWinter;\n' +   // woody sage moves less than grass
            (this.v2
              ? 'transformed.z+=gcSway*position.y*position.y*(0.035+0.045*(1.0-step(5.5,gcAtlas)))*gcWinter;\n'
              : '') +
            '#endif');
      };

      this.mesh = new THREE.InstancedMesh(geo, mat, cap);
      this.mesh.count = cap;                     // zero-scaled slots rasterize nothing
      this.mesh.frustumCulled = false;           // ring is around the camera by construction
      this.mesh.visible = !this.disabled;
      // instances carry world translations; the carpet mesh itself never moves
      this.mesh.matrixAutoUpdate = false; this.mesh.updateMatrix();
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) this.mesh.setMatrixAt(i, this._zero);
      this.scene.add(this.mesh);

      this.free = [];
      for (let b = this.blocks - 1; b >= 0; b--) this.free.push(b);
      this.cells = new Map();                    // "ix,iz" -> {block, used}
      this._lastCell = null;
      this._pending = null;                      // queued cell fills, amortized across frames
      this._fillBudgetMs = o.fillBudgetMs || 2.0;
      this._sampleBudgetMs = o.sampleBudgetMs === undefined ? 1.0 :
        Math.max(0.1, +o.sampleBudgetMs || 1.0);
      this._candidateGeneration = 0;
      this._candidateSeq = 0;
      this._candidateJobs = new Map();
      this._candidateReady = new Map();
      this._candidateWorker = null;
      this._workerStats = {
        submitted: 0, cancelled: 0, stale: 0, completed: 0,
        transferredBytes: 0, queueHighWater: 0, cellsBuilt: 0,
        fillMs: 0, worstFillMs: 0, snapshotMs: 0, worstSnapshotMs: 0,
        worldIndexSubmitted: 0, worldIndexCompleted: 0, worldIndexFallbacks: 0,
        worldIndexCancelled: 0, worldIndexFailures: 0, worldIndexSampledCandidates: 0,
        spatialExclusionBatches: 0, spatialExclusionFallbacks: 0,
        spatialRoadExclusions: 0, spatialBuildingExclusions: 0,
        waterIndexBatches: 0, waterIndexFallbacks: 0, waterIndexExclusions: 0,
      };
      if (this.worldIndex && this.lc.worldIndexInstall) {
        Promise.resolve(this.lc.worldIndexInstall).then(() => {
          this._worldLandcoverReady = !!(this.worldIndex.ready && !this.worldIndex.failed);
        }).catch(() => {});
      }
      try {
        const workersEnabled =
          new URLSearchParams(global.location?.search || '').get('noWorkers') !== '1';
        if (workersEnabled && typeof Worker !== 'undefined') {
          this._candidateWorker = new Worker(
            new URL('terrain/src/workers/ground-cover-worker.js', document.baseURI),
            { type: 'module', name: 'ground-cover-candidates' });
          this._candidateWorker.onmessage = (e) => this._candidateReply(e.data);
          this._candidateWorker.onerror = () => {
            this._candidateWorker?.terminate();
            this._candidateWorker = null;
            for (const job of this._candidateJobs.values()) job.worldAbort?.abort();
            this._candidateJobs.clear();
          };
        }
      } catch (e) { this._candidateWorker = null; }
      this._dummy = new THREE.Object3D();
      this._col = new THREE.Color();
      this._viewDir = new THREE.Vector3(0, 0, -1);
      this._lastViewDir = new THREE.Vector3(0, 0, -1);
      this._dirtyLo = Infinity; this._dirtyHi = -1;   // touched slot range for partial uploads
    }

    _rasterInstallOptions(id, source, data, extra) {
      const m = source.m;
      return Object.assign({
        id, data, width: m.width, height: m.height,
        originE: m.originE, originN: m.originN, res: m.res,
        centerEasting: m.world.centerEasting, centerNorthing: m.world.centerNorthing,
      }, extra || {});
    }

    _installWorldTint(tint) {
      const client = this.worldIndex;
      if (!client) return;
      client.initialized?.then(() => {
        if (!client.ready || client.failed || this._worldTintReady) return;
        const descriptors = [0, 1, 2].map((channel) =>
          this._rasterInstallOptions(
            [WORLD_INDEX_IDS.tintR, WORLD_INDEX_IDS.tintG, WORLD_INDEX_IDS.tintB][channel],
            tint, extractRasterChannel(tint.data, channel), { scale: 1 / 255 }));
        return Promise.all(descriptors.map(options => client.installRaster(options)));
      }).then((replies) => {
        if (replies) this._worldTintReady = true;
      }).catch(() => {});
    }

    _markDirty(lo, hi) {
      if (lo < this._dirtyLo) this._dirtyLo = lo;
      if (hi > this._dirtyHi) this._dirtyHi = hi;
    }

    /* Authoritative water rejection: true where the baked water surface (S+bias) sits above the
       local terrain by more than 0.15 m (open water at the current LOD) — no tufts on the live
       river/lake. Once the bake is resident this replaces the old lc.waterAt NHD mask so grass
       returns to marsh the rebake de-flooded; before it loads, fall back to lc.waterAt. No rng. */
    _underWater(x, z, h) {
      if (this.water && this.water._surf) {
        const s = this._waterS(x, z);
        return s !== null && s > h + 0.15;
      }
      return this.lc.waterAt(x, z);
    }

    update(camPos) {
      this._windU.value = performance.now() * 0.001;   // advance the wind clock
      if (this.disabled) return;
      // High-altitude early-out: the fade shrinks every card to zero by 78 m of ground
      // distance, so once the camera is well above the terrain the whole ring is invisible —
      // skip the draw call AND the vertex work for 38k instances. Hysteresis avoids flicker
      // when hovering at the threshold.
      const gy = this.terrain.heightAt(camPos.x, camPos.z);
      const above = camPos.y - gy;
      if (this.mesh.visible) {
        if (above > 420) { this.mesh.visible = false; return; }
      } else {
        if (above > 380) return;
        this.mesh.visible = true;
        this._lastCell = null;                   // re-check cells after flying while hidden
      }

      const ix = Math.floor(camPos.x / this.cellSize), iz = Math.floor(camPos.z / this.cellSize);
      const key = ix + ',' + iz;
      if (this.camera && this.camera.getWorldDirection) this.camera.getWorldDirection(this._viewDir);
      const fl = Math.hypot(this._viewDir.x, this._viewDir.z) || 1;
      this._viewDir.x /= fl; this._viewDir.y = 0; this._viewDir.z /= fl;
      const turned = this._sectorCull && this._viewDir.dot(this._lastViewDir) < 0.91;
      if (key !== this._lastCell || turned) {     // cell crossing or a meaningful change of view
        this._lastCell = key;
        this._lastViewDir.copy(this._viewDir);
        this._retireAndQueue(ix, iz, this._viewDir.x, this._viewDir.z);
      }
      // fills wait for the road/building indexes (built async by the app): filling first
      // would grow grass on carriageways and visibly cull it later
      if (this._exclusionReady()) this._fillBudget();
      this._flushDirty();                        // one partial upload of whatever changed
      let live = 0, maxBlock = -1;
      for (const cell of this.cells.values()) {
        live += cell.used;
        if (cell.block > maxBlock) maxBlock = cell.block;
      }
      // Blocks allocate from zero upward. Avoid submitting the permanently empty tail blocks;
      // recycled holes inside the active span remain zero-scaled exactly as before.
      this.mesh.count = (maxBlock + 1) * this.perCell;
      global.__GROUND_COVER_COUNT = live;
      global.__GROUND_COVER_CAP = this.blocks * this.perCell;
      this._publishWorkerTelemetry(live);
    }

    /* roadQuery/buildingBlocked readiness gate — same contract as ScatterManager: defer cell
       fills until both indexes answer; a grace timeout covers a subsystem that never arrives
       (data file absent) so the carpet still grows, just without that exclusion. */
    _exclusionReady() {
      if (this._exclOk) return true;
      if (this._exclT0 === undefined) this._exclT0 = performance.now();
      const timedOut = performance.now() - this._exclT0 > 15000;
      const roads = (typeof RoadIndex === 'undefined') || RoadIndex.ready || timedOut;
      const bldgs = !!global.buildingBlocked || timedOut;
      if (roads && bldgs) this._exclOk = true;
      return this._exclOk;
    }

    /* On a crossing: zero + free the blocks of cells that left the ring (cheap), then rebuild the
       nearest-first pending fill queue. Fills are deferred to _fillBudget so a ring shift never
       spikes; the ~80-96 m ring tolerates a 1-2 frame fill latency invisibly. */
    _retireAndQueue(ix, iz, fx, fz) {
      this._candidateGeneration++;
      this._workerStats.cancelled += this._candidateJobs.size;
      for (const [id, job] of this._candidateJobs) {
        if (job.worldAbort) {
          job.worldAbort.abort();
          this._workerStats.worldIndexCancelled++;
        }
        // Sampling jobs are parked on this thread, so dropping their typed arrays is cancellation.
        // Only notify the worker for work it may actually own, avoiding orphan cancel IDs there.
        if (job.phase !== 'sampling' && job.phase !== 'worldSampling')
          this._candidateWorker?.postMessage({ id, kind: 'cancel' });
      }
      this._candidateJobs.clear();
      this._candidateReady.clear();
      const r = this.ringCells, r2 = r * r;
      const want = new Set();
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        if (this._sectorCull && dx * dx + dz * dz > 1) {
          const dl = Math.hypot(dx, dz) || 1;
          if ((dx * fx + dz * fz) / dl < -0.42) continue;
        }
        want.add((ix + dx) + ',' + (iz + dz));
      }
      this._desired = want;
      for (const [k, cell] of this.cells) {      // retire cells out of range
        if (!want.has(k)) {
          // Camera-sector changes build their newly visible cells first. Old cells are harmless
          // behind the view and are retired once the queue drains, preventing turn-in gaps.
          if (this._sectorCull) continue;
          const s0 = cell.block * this.perCell;
          for (let i = 0; i < cell.used; i++) this.mesh.setMatrixAt(s0 + i, this._zero);
          if (cell.used > 0) this._markDirty(s0, s0 + cell.used - 1);
          this.free.push(cell.block);            // LIFO: growers below reuse this block, so the
          this.cells.delete(k);                  // dirty span stays tight on a cell crossing
        }
      }
      const q = [];                              // queue missing cells, pop() takes the nearest
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const k = (ix + dx) + ',' + (iz + dz);
        if (!want.has(k)) continue;
        if (!this.cells.has(k)) q.push({ cx: ix + dx, cz: iz + dz, d2 });
      }
      q.sort((a, b) => b.d2 - a.d2);
      this._pending = q;
    }

    _requestCandidates(c) {
      const k = c.cx + ',' + c.cz;
      if (!this._candidateWorker) return null;
      for (const job of this._candidateJobs.values()) if (job.key === k) return undefined;
      // A tiny bound prevents fast camera turns from accumulating obsolete cell buffers.
      if (this._candidateJobs.size + this._candidateReady.size >= 4) return undefined;
      const id = ++this._candidateSeq;
      this._candidateJobs.set(id, {
        key: k, cx: c.cx, cz: c.cz, generation: this._candidateGeneration, phase: 'candidates'
      });
      this._workerStats.submitted++;
      this._workerStats.queueHighWater =
        Math.max(this._workerStats.queueHighWater, this._candidateJobs.size);
      this._candidateWorker.postMessage({
        id, kind: 'groundCoverCandidates', generation: this._candidateGeneration, priority: c.d2,
        payload: { cx: c.cx, cz: c.cz, candidates: this.candidates, v2: this.v2 },
      });
      return undefined;
    }

    _candidateReply(reply) {
      const job = this._candidateJobs.get(reply.id);
      if (!job) return;
      if (!reply.ok || reply.generation !== this._candidateGeneration ||
          job.generation !== this._candidateGeneration) {
        this._candidateJobs.delete(reply.id);
        this._workerStats.stale++;
        return;
      }
      if (reply.meta?.phase === 'candidates') {
        job.randoms = new Float64Array(reply.buffers.randoms);
        // Use resident indexes for initial coverage too: one batch returns substantially sooner
        // than thousands of live heightAt calls on a cold terrain cache. If the service or a
        // required tile is unavailable, the existing incremental sampler starts immediately.
        if (this._worldSamplingReady()) this._startWorldSnapshot(reply.id, job);
        else this._startFallbackSnapshot(job, 'index-not-ready');
        return;
      }
      this._candidateJobs.delete(reply.id);
      this._workerStats.completed++;
      this._workerStats.transferredBytes += reply.buffers.matrices.byteLength +
        reply.buffers.colors.byteLength + reply.buffers.atlas.byteLength;
      this._candidateReady.set(job.key, {
        used: reply.meta.used,
        matrices: new Float32Array(reply.buffers.matrices),
        colors: new Float32Array(reply.buffers.colors),
        atlas: new Float32Array(reply.buffers.atlas),
      });
    }

    _worldSamplingReady() {
      const client = this.worldIndex;
      return !!(client && client.ready && !client.failed && this._worldLandcoverReady &&
        client.snapshot?.().memory?.heightTiles > 0);
    }

    _startFallbackSnapshot(job, reason) {
      job.worldAbort = null;
      job.phase = 'sampling';
      job.snapshot = this._createCellSnapshot();
      job.sampleCursor = 0;
      job.sampleStartedAt = performance.now();
      job.sampleCpuMs = 0;
      job.fallbackReason = reason;
      this._workerStats.worldIndexFallbacks++;
    }

    _startWorldSnapshot(id, job) {
      const controller = new AbortController();
      job.phase = 'worldSampling';
      job.worldAbort = controller;
      job.sampleStartedAt = performance.now();
      this._workerStats.worldIndexSubmitted++;
      const count = this.candidates, points = new Float64Array(count * 2);
      const heightPoints = new Float64Array(count * (this.v2 ? 10 : 2));
      const x0 = job.cx * this.cellSize, z0 = job.cz * this.cellSize;
      for (let i = 0; i < count; i++) {
        const ro = i * 10, p = i * 2;
        const x = x0 + job.randoms[ro] * this.cellSize;
        const z = z0 + job.randoms[ro + 1] * this.cellSize;
        points[p] = x; points[p + 1] = z;
        if (this.v2) {
          const h = i * 10;
          heightPoints.set([x, z, x + 2.5, z, x - 2.5, z, x, z + 2.5, x, z - 2.5], h);
        } else {
          heightPoints[p] = x; heightPoints[p + 1] = z;
        }
      }
      const sample = (options) => this.worldIndex.sample(
        Object.assign({ signal: controller.signal }, options));
      const requests = {
        heights: sample({ method: 'height', points: heightPoints }),
        classes: sample({ index: WORLD_INDEX_IDS.landcover, method: 'nearest', points }),
      };
      if (this._worldTintReady) {
        [requests.tintR, requests.tintG, requests.tintB] =
          [WORLD_INDEX_IDS.tintR, WORLD_INDEX_IDS.tintG, WORLD_INDEX_IDS.tintB]
            .map(index => sample({ index, method: 'bilinear', points }));
      }
      const spatialTypes = this.worldIndex.snapshot?.().memory?.spatialTypes || [];
      const waterReady = !!this.worldIndex.snapshot?.().memory?.waterSurface &&
        typeof this.worldIndex.sampleWaterSurface === 'function';
      if (waterReady) {
        requests.water = this.worldIndex.sampleWaterSurface(
          points, { signal: controller.signal });
        this._workerStats.waterIndexBatches++;
      } else {
        this._workerStats.waterIndexFallbacks++;
      }
      const spatialReady = spatialTypes.includes('roads') && spatialTypes.includes('buildings') &&
        typeof this.worldIndex.sampleRoad === 'function' &&
        typeof this.worldIndex.sampleBuildings === 'function';
      if (spatialReady) {
        requests.roads = this.worldIndex.sampleRoad(points, { signal: controller.signal });
        requests.buildings = this.worldIndex.sampleBuildings(
          points, { signal: controller.signal });
        this._workerStats.spatialExclusionBatches++;
      } else {
        this._workerStats.spatialExclusionFallbacks++;
      }
      const names = Object.keys(requests);
      Promise.all(Object.values(requests)).then((responses) => {
        if (!this._candidateJobs.has(id) || job.generation !== this._candidateGeneration) return;
        this._finishWorldSnapshot(id, job,
          Object.fromEntries(names.map((name, index) => [name, responses[index]])));
      }).catch((error) => {
        if (!this._candidateJobs.has(id) || job.generation !== this._candidateGeneration) return;
        if (error?.name === 'AbortError') return;
        this._workerStats.worldIndexFailures++;
        this._startFallbackSnapshot(job, 'sample-failed');
      });
    }

    _finishWorldSnapshot(id, job, values) {
      const { heights, classes, tintR, tintG, tintB, roads, buildings, water } = values;
      const snapshot = this._createCellSnapshot(), randoms = job.randoms;
      const S = this.cellSize, x0 = job.cx * S, z0 = job.cz * S;
      if ((roads && !roads.installed) || (buildings && !buildings.installed))
        this._workerStats.spatialExclusionFallbacks++;
      if (water && !water.installed) this._workerStats.waterIndexFallbacks++;
      for (let i = 0; i < this.candidates; i++) {
        const ro = i * 10, p = i * 8;
        const x = x0 + randoms[ro] * S, z = z0 + randoms[ro + 1] * S;
        const clsValue = classes[i], cls = Number.isFinite(clsValue) ? clsValue : -1;
        if (cls < 0) {
          this._workerStats.worldIndexFailures++;
          this._startFallbackSnapshot(job, 'landcover-miss');
          return;
        }
        snapshot.samples[p] = x; snapshot.samples[p + 1] = z;
        snapshot.classes[i] = cls;
        if (!(DENSITY[cls] || (this.v2 &&
            (cls === 71 || cls === 90 || cls === 95 || cls === 52 ||
             cls === 41 || cls === 42 || cls === 43)))) continue;
        const ho = this.v2 ? i * 5 : i;
        const h = heights[ho];
        if (!Number.isFinite(h) ||
            (this.v2 && (!Number.isFinite(heights[ho + 1]) ||
              !Number.isFinite(heights[ho + 2]) || !Number.isFinite(heights[ho + 3]) ||
              !Number.isFinite(heights[ho + 4])))) {
          this._workerStats.worldIndexFailures++;
          this._startFallbackSnapshot(job, 'height-miss');
          return;
        }
        snapshot.samples[p + 2] = h;
        if (this.v2) {
          snapshot.samples[p + 3] = heights[ho + 1] - heights[ho + 2];
          snapshot.samples[p + 4] = heights[ho + 3] - heights[ho + 4];
        }
        let f = 0;
        if (water?.installed) {
          if (water.valid[i] &&
              water.values[i * 2] + water.values[i * 2 + 1] > h + 0.15) {
            f = 1;
            this._workerStats.waterIndexExclusions++;
          }
        } else if (this._underWater(x, z, h)) {
          f = 1;
        }
        if (roads?.installed) {
          if (roads.values[i * 2 + 1] < ROAD_SURF_M) {
            f |= 2;
            this._workerStats.spatialRoadExclusions++;
          }
        } else {
          const rdq = global.roadQuery ? global.roadQuery(x, z) : null;
          if (rdq && rdq.dist < (ROAD_SURF_HW[rdq.class] || 0) + ROAD_SURF_M) f |= 2;
        }
        if (buildings?.installed) {
          if (buildings.blocked[i]) {
            f |= 4;
            this._workerStats.spatialBuildingExclusions++;
          }
        } else {
          if (global.buildingBlocked && global.buildingBlocked(x, z)) f |= 4;
        }
        if (tintR && Number.isFinite(tintR[i]) && Number.isFinite(tintG[i]) &&
            Number.isFinite(tintB[i])) {
          f |= 8;
          snapshot.samples[p + 5] = tintR[i];
          snapshot.samples[p + 6] = tintG[i];
          snapshot.samples[p + 7] = tintB[i];
        }
        snapshot.flags[i] = f;
      }
      const elapsed = performance.now() - job.sampleStartedAt;
      this._workerStats.worldIndexCompleted++;
      this._workerStats.worldIndexSampledCandidates += this.candidates;
      this._workerStats.snapshotLatencyMs =
        (this._workerStats.snapshotLatencyMs || 0) + elapsed;
      this._submitFinalSnapshot(id, job, snapshot);
    }

    /* Snapshot layout shared by the persistent world-index batch path and the incremental local
       fallback. Baked water surface and packed road/building exclusions come from worker indexes
       when installed, otherwise their exact live queries remain available. The final immutable
       arrays transfer to the presentation worker without exposing Three.js. */
    _createCellSnapshot() {
      return {
        // Float64 preserves the historical world-coordinate/noise decisions exactly. Matrices are
        // narrowed only at the final GPU-buffer boundary, as Three.js did through setMatrixAt().
        samples: new Float64Array(this.candidates * 8),
        classes: new Uint8Array(this.candidates),
        flags: new Uint8Array(this.candidates),
      };
    }

    _sampleCellSnapshotRange(cx, cz, randoms, snapshot, begin, end) {
      const { samples, classes, flags } = snapshot;
      const S = this.cellSize, x0 = cx * S, z0 = cz * S;
      for (let i = begin; i < end; i++) {
        const ro = i * 10, p = i * 8;
        const x = x0 + randoms[ro] * S, z = z0 + randoms[ro + 1] * S;
        const cls = this.lc.classAt(x, z);
        samples[p] = x; samples[p + 1] = z;
        classes[i] = cls;
        // Unsupported NLCD classes are rejected before any live query in both historical paths.
        // Preserve that short-circuit here; it materially reduces terrain/index sampling on rock,
        // snow, developed ground and open water.
        if (!(DENSITY[cls] || (this.v2 &&
            (cls === 71 || cls === 90 || cls === 95 || cls === 52 ||
             cls === 41 || cls === 42 || cls === 43)))) continue;
        const h = this.terrain.heightAt(x, z);
        samples[p + 2] = h;
        if (this.v2) {
          samples[p + 3] = this.terrain.heightAt(x + 2.5, z) -
            this.terrain.heightAt(x - 2.5, z);
          samples[p + 4] = this.terrain.heightAt(x, z + 2.5) -
            this.terrain.heightAt(x, z - 2.5);
        }
        let f = this._underWater(x, z, h) ? 1 : 0;
        const rdq = global.roadQuery ? global.roadQuery(x, z) : null;
        if (rdq && rdq.dist < (ROAD_SURF_HW[rdq.class] || 0) + ROAD_SURF_M) f |= 2;
        if (global.buildingBlocked && global.buildingBlocked(x, z)) f |= 4;
        if (this.tint && this.tint.colorAt(x, z, this._tintRGB)) {
          f |= 8;
          samples[p + 5] = this._tintRGB[0];
          samples[p + 6] = this._tintRGB[1];
          samples[p + 7] = this._tintRGB[2];
        }
        flags[i] = f;
      }
    }

    _sampleCellSnapshot(cx, cz, randoms) {
      const snapshot = this._createCellSnapshot();
      this._sampleCellSnapshotRange(cx, cz, randoms, snapshot, 0, this.candidates);
      return snapshot;
    }

    _submitFinalSnapshot(id, job, snapshot) {
      if (job.generation !== this._candidateGeneration || !this._candidateJobs.has(id)) return;
      const randoms = job.randoms;
      job.phase = 'final';
      job.worldAbort = null;
      delete job.randoms; delete job.snapshot;
      this._candidateWorker.postMessage({
        id, kind: 'groundCoverFinalize', generation: job.generation,
        payload: {
          cx: job.cx, cz: job.cz, candidates: this.candidates, perCell: this.perCell,
          v2: this.v2, grassLod: this.grassLod, densityScale: this.densityScale,
          randoms: randoms.buffer, samples: snapshot.samples.buffer,
          classes: snapshot.classes.buffer, flags: snapshot.flags.buffer,
        },
      }, [randoms.buffer, snapshot.samples.buffer, snapshot.classes.buffer, snapshot.flags.buffer]);
    }

    _advanceSnapshotJobs() {
      if (!this._candidateWorker) return;
      const frameStart = performance.now();
      // Establish the first nearby coverage promptly even on a slow GPU, then return to the
      // conservative streaming budget. The boost remains bounded well below the old 25–40 ms
      // one-shot snapshot and stops as soon as one cell is resident.
      const hasNearbyCoverage = [...this.cells.keys()].some(k => this._desired?.has(k));
      const sampleBudget = hasNearbyCoverage ? this._sampleBudgetMs :
        Math.max(this._sampleBudgetMs, 3);
      const deadline = frameStart + sampleBudget;
      // Map insertion order is request order, which keeps candidate sampling deterministic and
      // makes completion predictable. A minimum one-candidate slice guarantees forward progress
      // even when a single live query overruns the requested deadline.
      for (const [id, job] of this._candidateJobs) {
        if (job.phase !== 'sampling') continue;
        const cpuStart = performance.now();
        do {
          const next = Math.min(job.sampleCursor + 1, this.candidates);
          this._sampleCellSnapshotRange(
            job.cx, job.cz, job.randoms, job.snapshot, job.sampleCursor, next);
          job.sampleCursor = next;
        } while (job.sampleCursor < this.candidates && performance.now() < deadline);
        job.sampleCpuMs += performance.now() - cpuStart;
        if (job.sampleCursor < this.candidates) break;
        if (job.generation !== this._candidateGeneration || !this._candidateJobs.has(id)) continue;
        const elapsed = performance.now() - job.sampleStartedAt;
        this._workerStats.snapshotMs += job.sampleCpuMs;
        this._workerStats.worstSnapshotMs =
          Math.max(this._workerStats.worstSnapshotMs, job.sampleCpuMs);
        this._workerStats.snapshotLatencyMs =
          (this._workerStats.snapshotLatencyMs || 0) + elapsed;
        this._submitFinalSnapshot(id, job, job.snapshot);
        if (performance.now() >= deadline) break;
      }
    }

    _applyCellBuffers(block, result) {
      const s0 = block * this.perCell;
      const matrixArray = this.mesh.instanceMatrix.array;
      const colorArray = this.mesh.instanceColor.array;
      const atlasArray = this.mesh.geometry.attributes.gcAtlas.array;
      matrixArray.set(result.matrices.subarray(0, result.used * 16), s0 * 16);
      colorArray.set(result.colors.subarray(0, result.used * 3), s0 * 3);
      atlasArray.set(result.atlas.subarray(0, result.used), s0);
      for (let i = result.used; i < this.perCell; i++) this.mesh.setMatrixAt(s0 + i, this._zero);
      return result.used;
    }

    _fillBudget() {
      const q = this._pending;
      if (!q) return;
      this._advanceSnapshotJobs();
      if (!q.length) {
        if (this.grassLod) this._retireUndesired();
        this._pending = null;
        return;
      }
      const t0 = performance.now();
      let built = 0;
      while (q.length) {
        let c;
        if (this._candidateWorker) {
          let readyIndex = -1;
          // Preserve nearest-first consumption, while opportunistically filling the four-slot
          // worker window. Never remove a cell from the authoritative queue until its buffer lands.
          for (let i = q.length - 1; i >= 0; i--) {
            const probe = q[i], probeKey = probe.cx + ',' + probe.cz;
            if (this._candidateReady.has(probeKey)) { readyIndex = i; break; }
            if (this._candidateJobs.size + this._candidateReady.size < 4)
              this._requestCandidates(probe);
          }
          if (readyIndex < 0) break;
          c = q.splice(readyIndex, 1)[0];
        } else {
          c = q.pop();
        }
        const k = c.cx + ',' + c.cz;
        if (this.cells.has(k)) continue;
        let result = this._candidateReady.get(k);
        if (result) this._candidateReady.delete(k);
        let block = this.free.pop();
        if (block === undefined && this.grassLod) {
          this._retireUndesired(1);
          block = this.free.pop();
        }
        if (block === undefined) break;
        const fillStart = performance.now();
        const used = result
          ? this._applyCellBuffers(block, result)
          : this._fillCell(c.cx, c.cz, block);
        const fillMs = performance.now() - fillStart;
        this._workerStats.cellsBuilt++;
        this._workerStats.fillMs += fillMs;
        this._workerStats.worstFillMs = Math.max(this._workerStats.worstFillMs, fillMs);
        this.cells.set(k, { block, used });
        this._markDirty(block * this.perCell, (block + 1) * this.perCell - 1);
        built++;
        if (built >= 1 && performance.now() - t0 > this._fillBudgetMs) break;
      }
      if (!q.length && this.grassLod) this._retireUndesired();
    }

    _publishWorkerTelemetry(liveInstances) {
      const now = performance.now();
      if (now - (this._workerTelemetryAt || 0) < 500) return;
      this._workerTelemetryAt = now;
      const stats = this._workerStats;
      let samplingCells = 0, sampledCandidates = 0, worldIndexSamplingCells = 0;
      for (const job of this._candidateJobs.values()) {
        if (job.phase === 'sampling') {
          samplingCells++;
          sampledCandidates += job.sampleCursor;
        } else if (job.phase === 'worldSampling') {
          worldIndexSamplingCells++;
        }
      }
      const worldSnapshot = this.worldIndex?.snapshot?.() || null;
      global.GT_GROUND_COVER_STREAMING = {
        quality: this._quality,
        submittedInstances: this.mesh.count,
        perCell: this.perCell,
        generation: this._candidateGeneration,
        candidateWorker: !!this._candidateWorker,
        snapshotSource: this._worldSamplingReady() ? 'world-index' : 'main-thread-fallback',
        worldIndexReady: this._worldSamplingReady(),
        worldIndexSamplingCells,
        worldIndexMemory: worldSnapshot?.memory || null,
        pendingJobs: this._candidateJobs.size,
        readyCells: this._candidateReady.size,
        queuedCells: this._pending?.length || 0,
        samplingCells,
        sampledCandidates,
        samplingTotalCandidates: samplingCells * this.candidates,
        sampleBudgetMs: this._sampleBudgetMs,
        effectiveSampleBudgetMs: [...this.cells.keys()].some(k => this._desired?.has(k)) ?
          this._sampleBudgetMs :
          Math.max(this._sampleBudgetMs, 3),
        residentCells: this.cells.size,
        liveInstances,
        ...stats,
        averageFillMs: stats.cellsBuilt ? stats.fillMs / stats.cellsBuilt : 0,
        averageSnapshotMs: stats.completed ? stats.snapshotMs / stats.completed : 0,
        averageSnapshotLatencyMs: stats.completed ?
          (stats.snapshotLatencyMs || 0) / stats.completed : 0,
      };
    }

    _retireUndesired(limit) {
      const want = this._desired;
      if (!want) return;
      let retired = 0;
      for (const [k, cell] of this.cells) {
        if (want.has(k)) continue;
        const s0 = cell.block * this.perCell;
        for (let i = 0; i < cell.used; i++) this.mesh.setMatrixAt(s0 + i, this._zero);
        if (cell.used > 0) this._markDirty(s0, s0 + cell.used - 1);
        this.free.push(cell.block);
        this.cells.delete(k);
        if (limit && ++retired >= limit) break;
      }
    }

    _flushDirty() {
      if (this._dirtyHi < 0) return;
      // Partial upload: only the touched slot span, not the whole 2.4 MB instance buffer.
      // r184 takes MULTIPLE ranges per attribute via addUpdateRange (offset/count in ARRAY
      // ELEMENTS) and does not clear them itself, so clear before adding on every dirty pass
      // or the ranges accumulate. (r128's single `updateRange`, which self-reset, is gone.)
      const lo = this._dirtyLo, cnt = this._dirtyHi - this._dirtyLo + 1;
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(lo * 16, cnt * 16);
      im.needsUpdate = true;
      const ic = this.mesh.instanceColor;
      ic.clearUpdateRanges(); ic.addUpdateRange(lo * 3, cnt * 3);
      ic.needsUpdate = true;
      const ga = this.mesh.geometry.attributes.gcAtlas;
      ga.clearUpdateRanges(); ga.addUpdateRange(lo, cnt);
      ga.needsUpdate = true;
      this._dirtyLo = Infinity; this._dirtyHi = -1;
    }

    _fillCell(cx, cz, block, randoms) {
      if (this.v2) return this._fillCellV2(cx, cz, block, randoms);
      const rng = mulberry32(((cx * 73856093) ^ (cz * 19349663) ^ 0x6C0FFEE) >>> 0);
      const S = this.cellSize, x0 = cx * S, z0 = cz * S;
      const s0 = block * this.perCell;
      const atlas = this.mesh.geometry.attributes.gcAtlas;
      let n = 0;
      for (let i = 0; i < this.candidates && n < this.perCell; i++) {
        // fixed draws per candidate so placement never depends on rejection order
        const o = i * 10;
        const draw = (j) => randoms ? randoms[o + j] : rng();
        const rx = draw(0), rz = draw(1), rd = draw(2), rv = draw(3), rs = draw(4),
              ry = draw(5), rr = draw(6), rt = draw(7), rq = draw(8), rh = draw(9);
        const x = x0 + rx * S, z = z0 + rz * S;
        const cls = this.lc.classAt(x, z);
        let d = DENSITY[cls] || 0;
        if (!d) continue;
        d *= 0.88 + 0.22 * clumpNoise(x, z);     // fluffy near-continuous carpet, gentle density variation
        if (rd > d) continue;
        const h = this.terrain.heightAt(x, z);
        if (this._underWater(x, z, h)) continue;   // authoritative wet field (no tuft on water)
        // no tufts on the carriageway (grass may still reach the shoulder) or in buildings —
        // pure point queries, no rng consumed, so the seeded sequence is unchanged
        const rdq = global.roadQuery ? global.roadQuery(x, z) : null;
        if (rdq && rdq.dist < (ROAD_SURF_HW[rdq.class] || 0) + ROAD_SURF_M) continue;
        if (global.buildingBlocked && global.buildingBlocked(x, z)) continue;
        if (rh < sstep(this.topY0, this.topY1, h)) continue;

        let v, cr, cg, cb, s, tintK;
        // wildflowers dotted through meadow (71) + sage flats (52) — deterministic by position (no rng
        // draw, so the seeded tuft sequence is unchanged), near-white tint so painted petals read.
        const flower = (cls === 71 || cls === 52) && vhash(x * 2.3 + 11, z * 1.9 - 7) < 0.14;
        if (flower) {
          v = 4; const t = 0.90 + rq * 0.20; cr = t; cg = t; cb = t;
          s = 0.50 + rs * 0.45; tintK = 0;       // keep the painted petal colours (no imagery pull)
        } else if (cls === 71 || cls === 90 || cls === 95) {   // LUSH TALL green meadow (grass/riparian/marsh)
          v = 0;
          const t = 0.85 + rq * 0.30; cr = t * 0.86; cg = t; cb = t * 0.64;   // green-forward
          s = 0.55 + rs * 0.55;                  // tall, up to ~1.1 m with the y-scale
          tintK = TINT_LUSH;
        } else if (cls === 52) {                 // SHORT DRY pale meadow, occasional woody sage sprig
          if (rv < 0.30) {
            v = 2;                               // sage accent
            const t = 0.74 + rq * 0.28; cr = t * 0.98; cg = t; cb = t * 0.86;
            s = 0.32 + rs * 0.34;
          } else {
            v = 1;                               // pale dry grass
            const t = 0.80 + rq * 0.26; cr = t * 1.02; cg = t; cb = t * 0.90;
            s = 0.30 + rs * 0.30;                // short
          }
          tintK = TINT_DRY;                      // let it wash toward the pale tan flats
        } else {                                 // 41/42/43: sparse dark forest understory
          v = 3;
          const t = 0.65 + rq * 0.35; cr = t * 0.90; cg = t; cb = t * 0.90;
          s = 0.30 + rs * 0.40;
          tintK = TINT_LUSH;
        }
        // Imagery tint: pull the class swatch toward the true local ground HUE without changing the
        // sprite's brightness (a naive imageryColour/columnRef multiplier runs >1 over bright tan
        // ground and Lambert lighting then clips it to white). So rescale the sampled colour to the
        // column's own luminance first — the multiplier then averages ~1 and only shifts hue/sat.
        if (tintK > 0 && this.tint && this.tint.colorAt(x, z, this._tintRGB)) {
          const t = this._tintRGB, ref = COL_REF[v];
          const tl = 0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2];
          const rl = 0.299 * ref[0] + 0.587 * ref[1] + 0.114 * ref[2];
          const k = tl > 1e-3 ? rl / tl : 1;          // imagery colour rescaled to the sprite's brightness
          const jit = 0.9 + rq * 0.2;
          const clmp = (m) => (m < 0.6 ? 0.6 : m > 1.5 ? 1.5 : m) * jit;
          const mr = clmp(t[0] * k / ref[0]), mg = clmp(t[1] * k / ref[1]), mb = clmp(t[2] * k / ref[2]);
          cr += (mr - cr) * tintK; cg += (mg - cg) * tintK; cb += (mb - cb) * tintK;
          // Cap at the sprite's native brightness: up-facing tufts already catch near-full midday
          // irradiance, so any channel >1 clips to white. Tint may recolour/darken, never brighten.
          if (cr > 1) cr = 1; if (cg > 1) cg = 1; if (cb > 1) cb = 1;
        }
        const slot = s0 + n;
        this._dummy.position.set(x, h - 0.03, z);
        this._dummy.scale.set(s, s * (0.80 + ry * 0.45), s);
        this._dummy.rotation.set(0, rr * Math.PI * 2, (rt - 0.5) * 0.14);
        this._dummy.updateMatrix();
        this.mesh.setMatrixAt(slot, this._dummy.matrix);
        this._col.setRGB(cr, cg, cb);
        this.mesh.setColorAt(slot, this._col);
        atlas.setX(slot, v);
        n++;
      }
      for (let i = n; i < this.perCell; i++) this.mesh.setMatrixAt(s0 + i, this._zero);
      return n;
    }

    _fillCellV2(cx, cz, block, randoms) {
      const rng = mulberry32(((cx * 73856093) ^ (cz * 19349663) ^ 0x62B10E) >>> 0);
      const S = this.cellSize, x0 = cx * S, z0 = cz * S, s0 = block * this.perCell;
      const atlas = this.mesh.geometry.attributes.gcAtlas;
      let n = 0;
      for (let i = 0; i < this.candidates && n < this.perCell; i++) {
        // Fixed draw count keeps the world deterministic even as ecological rejection changes.
        const o = i * 10;
        const draw = (j) => randoms ? randoms[o + j] : rng();
        const rx = draw(0), rz = draw(1), rd = draw(2), rv = draw(3), rs = draw(4),
              ry = draw(5), rr = draw(6), rt = draw(7), rq = draw(8), rh = draw(9);
        const x = x0 + rx * S, z = z0 + rz * S, cls = this.lc.classAt(x, z);
        const lush = cls === 71 || cls === 90 || cls === 95;
        const sageSteppe = cls === 52;
        const forest = cls === 41 || cls === 42 || cls === 43;
        if (!lush && !sageSteppe && !forest) continue;

        const h = this.terrain.heightAt(x, z);
        if (this._underWater(x, z, h)) continue;
        const rdq = global.roadQuery ? global.roadQuery(x, z) : null;
        if (rdq && rdq.dist < (ROAD_SURF_HW[rdq.class] || 0) + ROAD_SURF_M) continue;
        if (global.buildingBlocked && global.buildingBlocked(x, z)) continue;
        if (rh < sstep(this.topY0, this.topY1, h)) continue;

        const hx = this.terrain.heightAt(x + 2.5, z) - this.terrain.heightAt(x - 2.5, z);
        const hz = this.terrain.heightAt(x, z + 2.5) - this.terrain.heightAt(x, z - 2.5);
        const sx = hx / 5, sz = hz / 5, slope = Math.hypot(sx, sz);
        if (slope > (sageSteppe ? 0.62 : lush ? 0.40 : 0.52)) continue;

        // Broad zones decide where a community can exist; stands cut unmistakable openings; fine
        // bunch noise groups neighbours. Thresholds differ by biome rather than making one lawn.
        const zone = patchNoise(x, z, 68, cls * 0.13);
        const stand = patchNoise(x, z, lush ? 13 : 17, cls * 0.31 + 2);
        const bunch = patchNoise(x, z, 3.8, cls * 0.47 + 7);
        const openCut = lush ? 0.13 : sageSteppe ? 0.22 : 0.34;
        const base = lush ? 1.08 : sageSteppe ? 0.94 : 0.58;
        const standEdge = sstep(openCut - 0.09, openCut + 0.13, stand);
        const zoneEdge = sageSteppe ? sstep(0.16, 0.34, zone) :
          forest ? sstep(0.25, 0.45, zone) : 1;
        const community = this.densityScale * base * standEdge * zoneEdge *
          (0.30 + 0.88 * sstep(openCut, 0.82, stand)) *
          (0.48 + 0.72 * sstep(0.22, 0.82, bunch));
        const inCommunity = rd <= community;
        // A quiet straw matrix bridges the photographed soil between sage communities. It is
        // intentionally incomplete, short and one-plane: enough parallax to break flatness while
        // retaining real bare ground and avoiding the old continuous carpet.
        const straw = this.grassLod && sageSteppe && !inCommunity &&
          rd < 0.46 * this.densityScale && bunch > 0.20 && zone > 0.10;
        if (!inCommunity && !straw) continue;

        let v, cr, cg, cb, s, wide = 1, tall = 1;
        const pick = vhash(x * 1.71 + 5, z * 1.37 - 9);
        if (straw) {
          v = 11;
          const t = 0.94 + rq * 0.06;
          cr = t; cg = t * 0.97; cb = t * 0.87;
          s = 0.28 + rs * 0.24; wide = 0.76 + rv * 0.24; tall = 0.50 + ry * 0.18;
        } else if (lush) {
          // Flowers form rare colonies, not evenly distributed white noise.
          const flowerPatch = patchNoise(x, z, 9, 19) > 0.78;
          if (flowerPatch && vhash(x * 2.1, z * 2.3) < 0.055) {
            v = 9; cr = 0.93; cg = 0.94; cb = 0.88;
            s = 0.30 + rs * 0.27; wide = 0.72;
          } else {
            v = pick < 0.42 ? 0 : pick < 0.84 ? 1 : 2;
            const t = 0.88 + rq * 0.12;
            cr = t * 0.94; cg = t; cb = t * 0.86;
            s = 0.42 + rs * 0.48; tall = 0.82 + ry * 0.24;
          }
        } else if (sageSteppe) {
          const sageColony = patchNoise(x, z, 11, 31) > 0.54;
          if (sageColony && pick < 0.34) {
            v = pick < 0.16 ? 6 : 7;
            const t = 0.86 + rq * 0.12;
            cr = t * 0.94; cg = t * 0.98; cb = t * 0.88;
            s = 0.34 + rs * 0.34; wide = 1.35 + rv * 0.32; tall = 0.68 + ry * 0.18;
          } else {
            v = pick < 0.45 ? 3 : pick < 0.83 ? 4 : 5;
            const t = 0.87 + rq * 0.12;
            cr = t; cg = t * 0.98; cb = t * 0.88;
            s = 0.27 + rs * 0.32; wide = 0.86 + rv * 0.25;
          }
        } else {
          v = pick < 0.76 ? 8 : 10;
          const t = 0.80 + rq * 0.14;
          cr = t * 0.93; cg = t * 0.97; cb = t * 0.84;
          s = 0.27 + rs * 0.34; wide = 0.78 + rv * 0.30;
        }

        // Imagery contributes local hue at low strength; saturation and luminance remain bounded so
        // bright NAIP texels cannot turn up-facing cards fluorescent.
        if (this.tint && this.tint.colorAt(x, z, this._tintRGB)) {
          const t = this._tintRGB;
          const lum = 0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2];
          const tr = Math.min(0.88, t[0] * (0.62 / Math.max(0.25, lum)));
          const tg = Math.min(0.88, t[1] * (0.62 / Math.max(0.25, lum)));
          const tb = Math.min(0.82, t[2] * (0.62 / Math.max(0.25, lum)));
          const k = lush ? 0.18 : 0.30;
          cr += (tr - cr) * k; cg += (tg - cg) * k; cb += (tb - cb) * k;
        }

        const slot = s0 + n;
        this._dummy.position.set(x, h - 0.065, z);
        this._dummy.scale.set(s * wide, s * tall, s * wide);
        // Follow gentle terrain slope but cap the tilt: plants grow upward rather than normal to
        // steep ground, while their bases still meet rolling terrain instead of floating.
        this._dummy.rotation.set(
          Math.max(-0.14, Math.min(0.14, sz * 0.32)),
          rr * Math.PI * 2,
          Math.max(-0.14, Math.min(0.14, -sx * 0.32)) + (rt - 0.5) * 0.05);
        this._dummy.updateMatrix();
        this.mesh.setMatrixAt(slot, this._dummy.matrix);
        this._col.setRGB(cr, cg, cb);
        this.mesh.setColorAt(slot, this._col);
        atlas.setX(slot, v);
        n++;
      }
      for (let i = n; i < this.perCell; i++) this.mesh.setMatrixAt(s0 + i, this._zero);
      return n;
    }
  }

  global.GroundCover = GroundCover;
})(window);
