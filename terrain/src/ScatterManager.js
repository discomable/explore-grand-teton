/* ScatterManager — streams real-landcover vegetation around the camera (Three.js r184).
 *
 * The world is divided into scatter cells (~256 m). Only cells within `radius` of the camera
 * exist; each is filled deterministically (seeded by cell coords), so the same forest grows in
 * the same place every visit and memory stays constant.
 *
 * Trees are PHOTOGRAPHIC: a runtime-baked 2048x512 atlas (8 columns of 256x512) composited from
 * the license-verified CC0 cutouts in terrain/public/atlas-candidates/
 * (see terrain/pipeline/VEG-ATLAS-SOURCES.md).
 *   conifer     3 spruce/pine cutouts from the OGA rubberduck sheet   (NLCD 42/43)
 *   spire       narrow subalpine-fir spire (sheet tree6)              (above ~2400 m ASL)
 *   aspen       2 slender broadleafs tinted yellow-green              (41/43, below ~2380 m)
 *   cottonwood  2 big broadleaf crowns                                (90 woody wetlands)
 * Near band: hybrid impostors — 3D trunk + contact-shadow skirt (vertex-colored, UV-pinned to a
 * white utility patch in the atlas) + 3 crossed photo cards. Far bands: 2-card billboards, ALL
 * species merged into ONE InstancedMesh per cell via a per-instance aUvOff column offset.
 * Every photo tree (near hybrid AND far billboard) also carries a horizontal TOP CAP card at
 * ~55% height so canopies stay visible from overhead instead of degenerating to an X of edges.
 * Low-poly holdouts: snag (dead trunk) and sagebrush domes, both near-band understory.
 *
 * Placement per candidate point: NLCD class -> density, stand/glade clump noise, water and
 * slope rejection, treeline fade with krummholz shrinking, per-instance scale/tilt/tint.
 * Cloud shade: all vegetation materials adopt the shared CLOUD_UNIFORMS contract and darken
 * with the same drifting fbm cover field as the terrain shader.
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  /* ---------------- SEASON (0 summer .. 0.45 autumn .. 1 winter) ----------------
   * Settable global window.SEASON (deterministic default: summer, or the ?season= URL param).
   * Re-read every frame so it is fully live. One shared uniform object (SEASON_UNIFORMS.uSeason)
   * is adopted by every vegetation material AND, in update(), by every terrain tile material — so
   * a single per-frame write drives the whole world's snow/veg tint. Winter: deciduous crowns go
   * bare + snow-dusted, conifers snow-frosted; autumn midpoint: aspens/cottonwoods turn gold. */
  function seasonNow() {
    let s = (global.SEASON == null) ? 0 : +global.SEASON;
    if (!isFinite(s)) s = 0;
    return s < 0 ? 0 : (s > 1 ? 1 : s);
  }
  if (global.SEASON == null) {
    let sp = null;
    try { sp = new URLSearchParams(global.location.search).get('season'); } catch (e) {}
    global.SEASON = (sp != null && isFinite(+sp)) ? Math.max(0, Math.min(1, +sp)) : 0;
  }
  const SEASON_UNIFORMS = global.SEASON_UNIFORMS =
    global.SEASON_UNIFORMS || { uSeason: { value: seasonNow() } };

  /* Deciduous (aspen/cottonwood) crowns: green -> autumn gold -> winter bare/desaturated + snow-
     dusted, thinning the crown alpha so it reads barer. Conifers: keep needles, gain snow frost
     (stronger high on the crown). Gated on foliage greenness so trunks/bark/shade skirts (low
     green, pinned to the white util block) are never touched. Atlas columns: 0-3 conifer, 4-5
     aspen, 6-7 cottonwood — recovered from vMapUv.x (already column-shifted by aUvOff in injectPhoto).
     Var names avoid the GLSL reserved-ish patch/filter/sample. */
  const SEASON_NEAR_FRAG = [
    '{',
    '  float sCol = floor(vMapUv.x * 8.0 + 0.5);',            // atlas column 0-7
    '  float decid = step(3.5, sCol);',                    // 4,5 aspen · 6,7 cottonwood
    '  float conif = 1.0 - decid;',
    '  float grnS = clamp(diffuseColor.g - 0.5*(diffuseColor.r + diffuseColor.b), 0.0, 1.0);',
    '  float leafS = smoothstep(0.015, 0.16, grnS);',      // leafy foliage vs bark/trunk/shade
    // The source conifers contain baked blue-grey illumination. Preserve their photographic
    // luminance detail but steer non-bark pixels toward a restrained lodgepole/spruce green.
    // Painted 3D trunks sample the white utility block above the drawable photo region.
    // Protect that block explicitly; color-based "bark" detection misclassified brown needles.
    '  float photoS = 1.0 - step(0.975, vMapUv.y);',
    '  float conLumS = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
    '  vec3 evergreenS = conLumS * vec3(0.46, 0.80, 0.56);',
    '  diffuseColor.rgb = mix(diffuseColor.rgb, evergreenS, 0.82 * conif * photoS);',
    // The atlas carries a photographed trunk down the centre of each cell. Push that lower
    // central strip back into crown shadow, with a stable per-column value difference so the
    // trunks do not repeat as identical bright flat lines.
    '  float cellUS = fract(vMapUv.x * 8.0);',
    '  float trunkXS = 1.0 - smoothstep(0.055, 0.17, abs(cellUS - 0.5));',
    '  float trunkYS = 1.0 - smoothstep(0.22, 0.68, vMapUv.y / 0.96875);',
    '  float trunkShadeS = mix(0.46, 0.62, fract((sCol + 1.0) * 0.6180339));',
    '  diffuseColor.rgb *= mix(1.0, trunkShadeS, trunkXS * trunkYS * photoS);',
    '  float autumnS = clamp(1.0 - abs(uSeason - 0.45) * 2.4, 0.0, 1.0);',
    '  float winterS = smoothstep(0.5, 1.0, uSeason);',
    '  if(decid > 0.5){',
    '    vec3 goldS = diffuseColor.rgb * vec3(1.55, 1.05, 0.30);',
    '    diffuseColor.rgb = mix(diffuseColor.rgb, goldS, 0.72 * autumnS * leafS);',
    '    float lumS = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
    '    vec3 bareS = mix(vec3(lumS), vec3(0.40, 0.34, 0.28), 0.5);',   // greyed leaf-off bark tone
    '    diffuseColor.rgb = mix(diffuseColor.rgb, bareS, 0.8 * winterS * leafS);',
    '    diffuseColor.a *= 1.0 - 0.45 * winterS * leafS;',              // thinner, barer crown
    '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.0), 0.35 * winterS * leafS);',
    '  } else {',
    '    float frostS = winterS * leafS * (0.22 + 0.4 * clamp((vMapUv.y - 0.42) / 0.5, 0.0, 1.0));',
    '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.99), frostS);',
    '  }',
    '}',
  ].join('\n');

  /* Far forest patches sample the single darkest atlas column and stand in for distant CONIFER
     masses, so they get winter frost only — never the deciduous gold/bare path. */
  const SEASON_FAR_FRAG = [
    '{',
    '  float winterS = smoothstep(0.45, 1.0, uSeason);',
    '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.98), 0.28 * winterS);',
    '}',
  ].join('\n');

  function injectSeason(shader, farBand) {
    shader.uniforms.uSeason = SEASON_UNIFORMS.uSeason;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uSeason;\nvoid main() {')
      .replace('#include <map_fragment>',
        '#include <map_fragment>\n' + (farBand ? SEASON_FAR_FRAG : SEASON_NEAR_FRAG));
  }

  // NLCD class -> tree density 0..1. Shrub/grass are near-zero for TREES (bare sage flats with
  // stray cones read as mistakes) but carry the sagebrush understory instead.
  // 190 is an internal-only authored cottonwood pocket marker; it never enters landcover data.
  const TREE_DENSITY  = { 41: 0.65, 42: 0.90, 43: 0.75, 52: 0.02, 71: 0.006,
    90: 0.50, 95: 0.03, 190: 0.18 };
  const SHRUB_DENSITY = { 41: 0.10, 42: 0.06, 43: 0.10, 52: 0.80, 71: 0.30, 90: 0.25, 95: 0.45 };

  /* Placement exclusion (Milestone 1): trees keep clear of every road's carriageway by the
   * class half-width + 3 m (big trees up to +2 m more, scaling in over s0 0.9..1.4); shrubs
   * may approach the shoulder edge; nothing grows inside a building footprint + 2 m.
   * Half-widths mirror the app's ROAD_HW grip table (carriageway + shoulder, metres from the
   * centerline) — kept as a local copy so this module stays standalone. All queries are pure
   * point lookups that consume NO rng draws, so the seeded candidate sequence is unchanged. */
  const ROAD_CLEAR = { trail: 1.7, track: 1.8, gravel: 3.0, park_paved: 4.0, highway: 6.0 };
  const TREE_ROAD_M = 3.0, TREE_ROAD_BIG = 2.0;   // base margin; extra for big trees (by scale)
  const SHRUB_ROAD_M = 0.5;                       // sage stops at the shoulder edge
  const BLDG_PAD = 2.0;                           // building footprint buffer (m)
  // Historic open-field setting around model-backed Mormon Row landmarks. The
  // source canopy raster contains a false conifer cluster here; reject trees
  // without rejecting the sage/grass understory that belongs in the meadow.
  // Keep only the immediate working yard open. A former 180 m circular mask erased the
  // documented cottonwoods beside the corral and made the ranch sit in an artificial void.
  // The ellipse follows the barn/yard proportions while leaving the surrounding field data
  // free to place trees again.
  const TREE_CLEARINGS = [{ x: 4830.2, z: 8264.4, radiusX: 78, radiusZ: 62 }];
  const COTTONWOOD_PRESERVES = [
    // Dark canopy mark at the near corral corner in the Mormon Row ground imagery.
    // The baked canopy detector has several nearby points; retain the strongest point on the
    // patch rather than turning the whole corner into a grove that screens the façade.
    { x: 4861, z: 8286, radius: 2.5 },
    { x: 4940, z: 8335, radius: 32 },
    { x: 4715, z: 8190, radius: 24 },
  ];

  const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------------- authoritative water-surface point query (M1-2 water lane) ----------------
   * The old lc.waterAt is the 10 m NHD mask baked against 10 m heights; it floods the
   * Oxbow/Willow Flats wetland (a green marsh) and, coupled with the flat Jackson pool rebake,
   * pooled trees half-submerged and let tufts sit on the live river. The ground truth for
   * what's WET at the current LOD is WaterBuilder's baked surface (terrain/public/
   * water-surface.png): per pixel a surface elevation S (0.1 m steps above elevMin, 0 = none)
   * + a wet-rule bias. A point is under water when S+bias rises above the local terrain — the
   * exact field WaterBuilder renders and clips its shorelines to. We reject vegetation against
   * that same field so de-flooded marsh (terrain back above the rebaked surface) grows again,
   * while genuinely wet river/lake/pool cells stay bare.
   *
   * Reuses WaterBuilder's already-decoded typed arrays (water._surf/_bias, water.wm) — no
   * second PNG decode, no extra resident copy — and consumes NO rng, so the seeded candidate
   * sequence is byte-identical. Returns S+bias as a world-Y, or null outside the baked band
   * (or before the bake has loaded). Bilinear, pixel-center registered, weight-dropping missing
   * neighbours so the band edge doesn't smear toward zero — identical math to WaterBuilder's
   * own _surfaceSampler, kept local so this module stays standalone. */
  function makeWaterSurfaceSampler(water) {
    return (x, z) => {
      const surf = water && water._surf;
      if (!surf) return null;                       // bake not loaded yet
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
  /* ~90 m value noise: real forests grow in stands with glades between them */
  function clumpNoise(x, z) {
    const gx = x / 90, gz = z / 90, ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return lerp(lerp(vhash(ix, iz), vhash(ix + 1, iz), u),
                lerp(vhash(ix, iz + 1), vhash(ix + 1, iz + 1), u), v);
  }

  /* ---------------- photo atlas ----------------
   * 8 columns x 256x512 = 2048x512 (power of two). The top 16 px of every cell is a reserved
   * strip holding a small solid-white "utility" block: trunk/shade/sage geometry pins ALL its
   * UVs to that block so painted vertex colors pass through the (white) map — which lets photo
   * cards and vertex-colored parts share ONE material and ONE draw call per species per cell. */
  const ATLAS = {
    cellW: 256, cellH: 512, cols: 8, padTop: 16,
    sources: {
      conif: 'terrain/public/atlas-candidates/oga_rubberduck_conifers_2K_atlas.png',
      dec01: 'terrain/public/atlas-candidates/cgbookcase_tree01_deciduous_3K.png',
      dec04: 'terrain/public/atlas-candidates/cgbookcase_tree04_deciduous_3K.png',
      dec05: 'terrain/public/atlas-candidates/cgbookcase_tree05_deciduous_3K.png',
      dec07: 'terrain/public/atlas-candidates/cgbookcase_tree07_deciduous_3K.png',
    },
    cells: [ // x-ranges from VEG-ATLAS-SOURCES.md alpha scan of the 6315x2048 conifer sheet
      // conifer cells get a mild lift: the raw spruce photos read near-black against sunlit NAIP
      { src: 'conif', sx0: 5474, sx1: 6283, tint: [1.48, 1.52, 1.40] }, // 0 tree7: tall regular spire
      { src: 'conif', sx0: 2948, sx1: 3955, tint: [1.48, 1.52, 1.40] }, // 1 tree4: open irregular lodgepole
      { src: 'conif', sx0: 997,  sx1: 1866, tint: [1.48, 1.52, 1.40] }, // 2 tree2: sparse, leaning tip
      { src: 'conif', sx0: 4892, sx1: 5458, tint: [1.40, 1.46, 1.42] }, // 3 tree6: narrow subalpine spire
      { src: 'dec05', tint: [1.12, 1.18, 0.74] },   // 4 aspen (green-gold, subtler — was lime)
      { src: 'dec07', tint: [1.12, 1.18, 0.74] },   // 5 aspen 2
      { src: 'dec04' },                             // 6 cottonwood: broad dense crown
      { src: 'dec01' },                             // 7 cottonwood 2: darker crown
    ],
  };
  const VARIANTS = { conifer: [0, 1, 2], spire: [3], aspen: [4, 5], cottonwood: [6, 7] };
  const PHOTO = { conifer: 1, spire: 1, aspen: 1, cottonwood: 1 };
  const CELL_U = 1 / ATLAS.cols;
  const CELL_V = (ATLAS.cellH - ATLAS.padTop) / ATLAS.cellH;   // drawable v extent (flipY: v0 = bottom)
  const UTIL_U = 14 / (ATLAS.cellW * ATLAS.cols);              // white block center, column 0
  const UTIL_V = 1 - 8 / ATLAS.cellH;

  function drawUtilBlocks(ctx) {
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
    for (let i = 0; i < ATLAS.cols; i++) ctx.fillRect(i * ATLAS.cellW + 6, 4, 16, 8);
  }

  /* -- procedural placeholders: visible only for the few frames before the photos decode -- */
  function paintConiferSprite(ctx, x0, W, H, rng, o) {
    const cx = x0 + W / 2, base = H * 0.98, top = H * 0.06;
    ctx.strokeStyle = '#4a3826'; ctx.lineWidth = W * 0.035;
    ctx.beginPath(); ctx.moveTo(cx, base); ctx.lineTo(cx, H * 0.10); ctx.stroke();
    const tiers = 36;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y = base - H * 0.10 - t * (base - top - H * 0.10);
      const half = (1 - t * 0.92) * W * (o.narrow ? 0.24 : 0.40) * (0.7 + 0.5 * rng());
      const n = Math.floor(13 * (1 - t * 0.45)) + 3;
      for (let j = 0; j < n; j++) {
        const g = 55 + rng() * 70;
        ctx.fillStyle = `rgb(${(g * 0.42) | 0},${g | 0},${(g * o.blue) | 0})`;
        ctx.globalAlpha = 0.75 + rng() * 0.25;
        ctx.beginPath();
        ctx.arc(cx + (rng() * 2 - 1) * half, y + (rng() - 0.35) * H * 0.02,
                (W * 0.014 + rng() * W * 0.028) * (1.1 - t * 0.45), 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function paintBroadleafSprite(ctx, x0, W, H, rng, o) {
    const cx = x0 + W / 2, base = H * 0.985;
    const cy = H * 0.38, R = W * 0.36;
    ctx.strokeStyle = o.trunk; ctx.lineWidth = W * 0.045;
    ctx.beginPath(); ctx.moveTo(cx, base);
    ctx.quadraticCurveTo(cx + (rng() - 0.5) * W * 0.05, H * 0.62, cx + (rng() - 0.5) * W * 0.08, cy + R * 0.4);
    ctx.stroke();
    for (const [lx, ly, lr] of [[0, 0, 1], [0.55, -0.12, 0.62], [-0.5, 0.08, 0.66], [0.12, -0.45, 0.55]]) {
      const LX = cx + lx * R, LY = cy + ly * R * 1.2, LR = R * lr;
      for (let i = 0; i < 240; i++) {
        const a = rng() * 6.283, rr = Math.sqrt(rng()) * LR;
        const g = o.gBase + rng() * o.gVar;
        ctx.fillStyle = `rgb(${(g * o.rMul) | 0},${g | 0},${(g * o.bMul) | 0})`;
        ctx.globalAlpha = 0.5 + rng() * 0.5;
        ctx.beginPath();
        ctx.arc(LX + Math.cos(a) * rr, LY + Math.sin(a) * rr * 0.85,
                W * 0.012 + rng() * W * 0.02, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function paintPlaceholder(ctx) {
    const { cellW, cellH } = ATLAS;
    const rng = mulberry32(0xA71A5);
    for (let i = 0; i < 4; i++)
      paintConiferSprite(ctx, i * cellW, cellW, cellH, rng, { narrow: i === 3, blue: i === 3 ? 0.62 : 0.50 });
    for (let i = 4; i < 6; i++)
      paintBroadleafSprite(ctx, i * cellW, cellW, cellH, rng, { trunk: '#cfd0c2', gBase: 130, gVar: 70, rMul: 0.72, bMul: 0.35 });
    for (let i = 6; i < 8; i++)
      paintBroadleafSprite(ctx, i * cellW, cellW, cellH, rng, { trunk: '#5a4a38', gBase: 92, gVar: 55, rMul: 0.55, bMul: 0.35 });
    drawUtilBlocks(ctx);
  }

  /* bleed opaque RGB outward into transparent texels (alpha untouched) so bilinear/mip taps
     never mix in white-fringe or undefined color — the classic alpha-cutout halo killer */
  function dilateEdges(ctx, W, H) {
    const id = ctx.getImageData(0, 0, W, H), d = id.data;
    const solid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) solid[i] = d[i * 4 + 3] > 40 ? 1 : 0;
    for (let pass = 0; pass < 5; pass++) {
      const next = new Uint8Array(solid);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          if (solid[i]) continue;
          let r = 0, g = 0, b = 0, n = 0, j;
          if (x > 0 && solid[i - 1])     { j = (i - 1) * 4;  r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
          if (x < W - 1 && solid[i + 1]) { j = (i + 1) * 4;  r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
          if (y > 0 && solid[i - W])     { j = (i - W) * 4;  r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
          if (y < H - 1 && solid[i + W]) { j = (i + W) * 4;  r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
          if (!n) continue;
          j = i * 4;
          d[j] = r / n; d[j + 1] = g / n; d[j + 2] = b / n;
          next[i] = 1;
        }
      }
      solid.set(next);
    }
    ctx.putImageData(id, 0, 0);
  }

  /* The source conifer sheet contains pale blue/white baked illumination. Compress it once in the
     atlas canvas so scene lighting, rather than photographed lighting, controls the result. Brown
     trunk pixels are protected; transparent-edge RGB is pulled slightly toward the same neutral
     forest tone before dilation. This is deterministic, boot-only and has zero per-frame cost. */
  function conditionAtlas(ctx, W, H) {
    const id = ctx.getImageData(0, 0, W, H), d = id.data;
    const coniferW = ATLAS.cellW * 4;
    for (let y = ATLAS.padTop; y < H; y++) for (let x = 0; x < coniferW; x++) {
      const i = (y * W + x) * 4, a = d[i + 3];
      if (!a) continue;
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const bark = r > g * 1.13 && r > b * 1.22;
      if (bark) continue;
      const lum = 0.213 * r + 0.715 * g + 0.072 * b;
      if (lum < 0.015) continue;
      const targetLum = 0.035 + 0.61 * Math.pow(lum, 1.18);
      const scale = targetLum / lum;
      r *= scale; g *= scale; b *= scale;
      const edge = 1 - a / 255;
      const neutral = 0.28 + 0.12 * edge;
      r = r * (1 - neutral) + targetLum * 0.70 * neutral;
      g = g * (1 - neutral) + targetLum * 0.91 * neutral;
      b = b * (1 - neutral) + targetLum * 0.73 * neutral;
      d[i] = Math.min(255, Math.max(0, r * 255));
      d[i + 1] = Math.min(255, Math.max(0, g * 255));
      d[i + 2] = Math.min(255, Math.max(0, b * 255));
    }
    ctx.putImageData(id, 0, 0);
  }

  const wantAtlasClean = () =>
    !/[?&]atlasclean=0(?:&|$)/.test(global.location ? global.location.search : '');

  /* async photo bake: loads the CC0 cutouts, composites them into the atlas canvas (bottom-
     aligned, aspect-preserving with a little tolerated squeeze), tints the aspens, redraws the
     utility blocks, dilates edges, and flips tex.needsUpdate. Deterministic — no rng. */
  function bakePhotoAtlas(tex, cv, ctx, onDone) {
    const { cellW, cellH, padTop, sources, cells } = ATLAS;
    const imgs = {};
    let waiting = 0;
    for (const k of Object.keys(sources)) {
      waiting++;
      const im = new Image();
      im.onload = () => { imgs[k] = im; if (--waiting === 0) compose(); };
      im.onerror = () => { if (--waiting === 0) compose(); };   // missing file -> placeholder cell survives
      im.src = sources[k];
    }
    function alphaBBox(im, sx, sy, sw, sh) {
      const pw = 96, ph = 192;
      const p = document.createElement('canvas'); p.width = pw; p.height = ph;
      const px = p.getContext('2d');
      px.drawImage(im, sx, sy, sw, sh, 0, 0, pw, ph);
      const d = px.getImageData(0, 0, pw, ph).data;
      let x0 = pw, x1 = -1, y0 = ph, y1 = -1;
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        if (d[(y * pw + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return [sx, sy, sw, sh];
      return [sx + x0 / pw * sw, sy + y0 / ph * sh,
              (x1 - x0 + 1) / pw * sw, (y1 - y0 + 1) / ph * sh];
    }
    function compose() {
      cells.forEach((c, i) => {
        const im = imgs[c.src];
        if (!im) return;
        const box = c.sx0 !== undefined
          ? alphaBBox(im, c.sx0, 0, c.sx1 - c.sx0, im.height)
          : alphaBBox(im, 0, 0, im.width, im.height);
        const x0 = i * cellW, availH = cellH - padTop;
        ctx.clearRect(x0, 0, cellW, cellH);
        // fit height; tolerate up to 25% horizontal squeeze, otherwise fit width instead
        let dh = availH, dw = box[2] / box[3] * dh;
        if (dw > cellW) {
          if (cellW / dw >= 0.75) dw = cellW;
          else { dw = cellW; dh = cellW * box[3] / box[2]; }
        }
        ctx.drawImage(im, box[0], box[1], box[2], box[3],
                      x0 + (cellW - dw) / 2, cellH - dh, dw, dh);
        if (c.tint) {
          const id = ctx.getImageData(x0, 0, cellW, cellH), d = id.data;
          for (let k = 0; k < d.length; k += 4) {
            if (!d[k + 3]) continue;
            d[k]     = Math.min(255, d[k]     * c.tint[0]);
            d[k + 1] = Math.min(255, d[k + 1] * c.tint[1]);
            d[k + 2] = Math.min(255, d[k + 2] * c.tint[2]);
          }
          ctx.putImageData(id, x0, 0);
        }
      });
      if (wantAtlasClean()) conditionAtlas(ctx, cv.width, cv.height);
      drawUtilBlocks(ctx);
      dilateEdges(ctx, cv.width, cv.height);
      tex.needsUpdate = true;
      if (onDone) onDone();
    }
  }

  /* Pre-baked single atlas: one ~small PNG (2048x512) that already IS the composited result of the
     ~52 MB of candidate photos. Preferred at boot so nothing large is decoded — mips are built on
     the GPU from this POT texture. Fallback to the runtime candidate bake if the file is absent. */
  const BAKED_ATLAS_URL = 'terrain/public/veg-atlas.png';
  const wantBakeExport = () => /[?&]bakeatlas=1(?:&|$)/.test(global.location ? global.location.search : '');

  /* one-time export: POST the finished atlas canvas to serve.py's /shot inbox (named), which lands
     at shots/auto-vegatlas.png; install it as terrain/public/veg-atlas.png out-of-band. */
  function postBakedAtlas(cv) {
    cv.toBlob(b => {
      if (!b) return;
      fetch('/shot?meta=' + encodeURIComponent(JSON.stringify({ name: 'vegatlas' })),
            { method: 'POST', body: b })
        .then(() => console.info('[veg-atlas] exported runtime bake -> shots/auto-vegatlas.png'))
        .catch(() => {});
    }, 'image/png');
  }

  function buildAtlasTexture() {
    const cv = document.createElement('canvas');
    cv.width = ATLAS.cellW * ATLAS.cols; cv.height = ATLAS.cellH;
    const ctx = cv.getContext('2d');
    paintPlaceholder(ctx);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;   // photos are sRGB; renderer outputs sRGB

    if (wantBakeExport()) {
      // export mode: force the runtime candidate bake, then POST the composited canvas
      bakePhotoAtlas(tex, cv, ctx, () => postBakedAtlas(cv));
      return tex;
    }
    // PREFER the pre-baked atlas; fall back to the runtime candidate bake only if it's missing
    const im = new Image();
    im.onload = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(im, 0, 0, cv.width, cv.height);
      if (wantAtlasClean()) conditionAtlas(ctx, cv.width, cv.height);
      drawUtilBlocks(ctx);
      dilateEdges(ctx, cv.width, cv.height);
      tex.needsUpdate = true;
      console.info('[veg-atlas] using pre-baked ' + BAKED_ATLAS_URL + ' (no candidate decode)');
    };
    im.onerror = () => {
      console.info('[veg-atlas] pre-baked absent — runtime candidate bake (~52 MB decode)');
      bakePhotoAtlas(tex, cv, ctx);
    };
    im.src = BAKED_ATLAS_URL;
    return tex;
  }

  /* ---------------- shared cloud-shade + uv-offset shader hooks ---------------- */

  const CLOUD_GLSL = [
    'uniform float uCloudTime;',
    'uniform float uCloudAmt;',
    'varying vec2 vCloudXZ;',
    'float hashC(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }',
    'float vnoiseC(vec2 p){',
    '  vec2 ic=floor(p), fc=fract(p); fc=fc*fc*(3.0-2.0*fc);',
    '  return mix(mix(hashC(ic),hashC(ic+vec2(1,0)),fc.x),',
    '             mix(hashC(ic+vec2(0,1)),hashC(ic+vec2(1,1)),fc.x), fc.y);',
    '}',
    'float fbmSkyC(vec2 p){',
    '  float s=0.0, a=0.5;',
    '  for(int i=0;i<5;i++){ s+=a*vnoiseC(p); p=p*2.13+vec2(31.4,17.7); a*=0.5; }',
    '  return s;',
    '}',
    'float cloudCoverV(){',
    '  vec2 cuv = vCloudXZ / 2680.0;',
    '  vec2 dr = vec2(uCloudTime*0.006, uCloudTime*0.0022);',
    '  float c = fbmSkyC(cuv*1.35 + dr) + 0.45*fbmSkyC(cuv*3.4 - dr*2.0);',
    '  return smoothstep(0.72, 1.06, c);',
    '}',
  ].join('\n');

  /* terrain fragment's exact cloud recipe (terrain-shaders.js): same field, same drift, same
     ~0.28 darkening, gated day-only by the owner-driven uCloudAmt */
  function injectClouds(shader) {
    const CU = global.CLOUD_UNIFORMS = global.CLOUD_UNIFORMS ||
      { uCloudTime: { value: 0 }, uCloudAmt: { value: 0 } };
    shader.uniforms.uCloudTime = CU.uCloudTime;
    shader.uniforms.uCloudAmt = CU.uCloudAmt;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec2 vCloudXZ;\nvoid main() {')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n' +
        'vec4 cwp4 = vec4( transformed, 1.0 );\n' +
        '#ifdef USE_INSTANCING\n\tcwp4 = instanceMatrix * cwp4;\n#endif\n' +
        'vCloudXZ = ( modelMatrix * cwp4 ).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', CLOUD_GLSL + '\nvoid main() {')
      .replace('#include <tonemapping_fragment>',
        'gl_FragColor.rgb *= (1.0 - 0.28 * cloudCoverV() * uCloudAmt);\n#include <tonemapping_fragment>');
  }

  function injectPhoto(shader) {   // per-instance atlas-column offset + cap rim fade, then clouds
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float aUvOff;\nattribute float aCap;\nvarying float vCapFlag;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv.x += aUvOff;\n#endif\nvCapFlag = aCap;');
    // Top-cap texels (aCap=1) fade out radially toward the card rim BEFORE the alpha test, so the
    // cutout thins into ragged foliage instead of ending on the quad's straight edge — from above
    // caps read as organic crowns, never square plates. Cards/trunks (aCap=0) are untouched.
    const cu = (CAP_U0 + CAP_U1) / 2, hu = (CAP_U1 - CAP_U0) / 2;
    const cv = (CAP_V0 + CAP_V1) / 2 * CELL_V, hv = (CAP_V1 - CAP_V0) / 2 * CELL_V;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vCapFlag;\nvoid main() {')
      .replace('#include <alphatest_fragment>',
        'if (vCapFlag > 0.5) {\n' +
        `  vec2 capRC = vec2((fract(vMapUv.x * ${ATLAS.cols.toFixed(1)}) - ${cu.toFixed(4)}) / ${hu.toFixed(4)},\n` +
        `                    (vMapUv.y - ${cv.toFixed(4)}) / ${hv.toFixed(4)});\n` +
        '  diffuseColor.rgb *= 0.42;\n' +
        '  diffuseColor.a *= smoothstep(1.35, 0.45, length(capRC));\n' +
        '}\n#include <alphatest_fragment>');
    injectSeason(shader, false);
    injectClouds(shader);
  }

  /* ---------------- species geometry ---------------- */

  function paint(geom, rgb, rng, opts) {
    opts = opts || {};
    const p = geom.attributes.position, n = p.count;
    geom.computeBoundingBox();
    const y0 = geom.boundingBox.min.y, y1 = geom.boundingBox.max.y;
    const jit = opts.jitter !== undefined ? opts.jitter : 0.28;
    const lit = opts.lighten || 0;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const j = 1 + (rng() - 0.5) * jit;
      const t = (p.getY(i) - y0) / Math.max(1e-6, y1 - y0);
      const f = j * (1 + lit * t);           // sunlit tips, shaded skirts
      c[i * 3] = rgb[0] * f; c[i * 3 + 1] = rgb[1] * f; c[i * 3 + 2] = rgb[2] * f;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geom;
  }

  /* break up the perfect-primitive silhouette (sagebrush) */
  function jitterVerts(geom, rng, amt, keepTop) {
    const p = geom.attributes.position;
    geom.computeBoundingBox();
    const y0 = geom.boundingBox.min.y, y1 = geom.boundingBox.max.y;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (keepTop && y > y0 + (y1 - y0) * 0.92) continue;
      p.setXYZ(i, p.getX(i) + (rng() - 0.5) * amt, y + (rng() - 0.5) * amt * 0.7,
               p.getZ(i) + (rng() - 0.5) * amt);
    }
    return geom;
  }

  /* pin every UV of a painted (vertex-colored) part to the atlas's white utility block */
  function utilUV(geom) {
    const n = geom.attributes.position.count, u = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { u[i * 2] = UTIL_U; u[i * 2 + 1] = UTIL_V; }
    geom.setAttribute('uv', new THREE.BufferAttribute(u, 2));
    return geom;
  }

  function mergeParts(parts) {
    // Icosahedron/Polyhedron geometries are NON-indexed in three — synthesize sequential indices
    let vCount = 0, iCount = 0;
    for (const g of parts) {
      const n = g.attributes.position.count;
      vCount += n; iCount += g.index ? g.index.count : n;
    }
    const P = new Float32Array(vCount * 3), N = new Float32Array(vCount * 3), C = new Float32Array(vCount * 3);
    const U = new Float32Array(vCount * 2), A = new Float32Array(vCount);   // aCap defaults to 0
    const I = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const g of parts) {
      if (!g.userData.keepNormals) g.computeVertexNormals();
      P.set(g.attributes.position.array, vo * 3);
      N.set(g.attributes.normal.array, vo * 3);
      C.set(g.attributes.color.array, vo * 3);
      if (g.attributes.uv) U.set(g.attributes.uv.array, vo * 2);
      if (g.attributes.aCap) A.set(g.attributes.aCap.array, vo);
      const n = g.attributes.position.count;
      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) I[io + i] = idx[i] + vo;
        io += idx.length;
      } else {
        for (let i = 0; i < n; i++) I[io + i] = vo + i;
        io += n;
      }
      vo += n;
      g.dispose();
    }
    const m = new THREE.BufferGeometry();
    m.setAttribute('position', new THREE.BufferAttribute(P, 3));
    m.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    m.setAttribute('color', new THREE.BufferAttribute(C, 3));
    m.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    m.setAttribute('aCap', new THREE.BufferAttribute(A, 1));
    m.setIndex(new THREE.BufferAttribute(I, 1));
    return m;
  }

  /* ground-contact shade: a squat open cone hugging the trunk base so near trees sit IN the
     ground instead of on it. Trees are sunk 0.3+0.35*s at placement, so it spans local y
     0.25..1.15 — whatever the terrain cut, the visible part is a dark skirt, never a floating
     pancake. Dark olive-grey, not black, so it reads as shade. Not used for billboards/sage. */
  function contactShade(r, rng) {
    // Real near-field CAST SHADOWS now ground the trees, so the old wide grey collar-disc that
    // this cone drew from above just double-shadowed as an ugly base decal. Shrunk to near-nothing:
    // a tiny dark ring hugging the very base of the trunk (was ~r wide + 0.9 tall). Kept at 8
    // radial segments / 1 height segment so the vertex count — and therefore the paint() rng draw
    // count — is byte-identical to before, leaving the shared buildFlora rng sequence unchanged.
    const d = new THREE.CylinderGeometry(r * 0.06, r * 0.28, 0.4, 8, 1, true);
    d.translate(0, 0.26, 0);
    paint(d, [0.03, 0.035, 0.03], rng, { jitter: 0.12 });
    return d;
  }

  /* one vertical photo card: white vertex color (tint comes from the map * per-instance color),
     up-normals for even Lambert lighting, uv spans the drawable part of atlas column 0 —
     aUvOff slides it to the instance's variant column */
  function cardGeom(w, h, ang) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-w / 2, 0, 0,  w / 2, 0, 0,  w / 2, h, 0,  -w / 2, h, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(
      [0, 0, CELL_U, 0, CELL_U, CELL_V, 0, CELL_V], 2));
    // M7.1 baked base-cavity AO: darken the two base verts (0,1 at y=0) so trunk bases read grounded
    // instead of pancaked/floating; tips (2,3) stay full. Multiplies with map + per-instance tint,
    // baked into geometry → world-anchored, stable, zero cost (no crawl, unlike screen-space AO).
    g.setAttribute('color', new THREE.Float32BufferAttribute(
      [0.72, 0.72, 0.72,  0.72, 0.72, 0.72,  1, 1, 1,  1, 1, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    if (ang) g.rotateY(ang);          // Y-rotation leaves the up-normals up
    g.userData.keepNormals = true;
    return g;
  }

  const CARD_W = 7.2, CARD_H = 14.4;   // silhouette height ~14 m at scale 1, cell aspect 1:2

  /* TOP CAP: one horizontal card at ~55% tree height so canopies survive overhead views —
     vertical crossed cards degenerate to an X of edges from above, which read as bare ground
     against the dense NAIP forest beneath (ref shot-003). The cap samples the crown band of the
     SAME atlas column (v 0.40..0.55 of the drawable cell — measured: every column, conifer
     through cottonwood, has 0.4..0.9 alpha coverage there, so the cutout rim stays ragged and
     organic, never a solid square plate). 48% height keeps the cap INSIDE every species'
     silhouette (cottonwood photos top out at ~0.50-0.55 of the cell — at 0.55 isolated flats
     trees wore a visible floating "beret"), and dead-horizontal means zero projected area
     edge-on — eye-level views are unchanged. Cap verts are tinted a touch above white so a
     crown seen from above reads sunlit, not as a dark disk. +2 tris per tree. */
  const CAP_W = 6.0, CAP_Y = 0.48;                 // world width (m at scale 1), height fraction
  const CAP_LIT = 1.15;                            // vertex-color lift: sunlit-from-above crowns
  const CAP_U0 = 0.28, CAP_U1 = 0.72;              // crown sample window, fraction of cell
  const CAP_V0 = 0.40, CAP_V1 = 0.55;
  function capGeom() {
    const g = new THREE.BufferGeometry();
    const hw = CAP_W / 2, y = CAP_Y * CARD_H;
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-hw, y, -hw,  hw, y, -hw,  hw, y, hw,  -hw, y, hw], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(
      [CAP_U0 * CELL_U, CAP_V0 * CELL_V,  CAP_U1 * CELL_U, CAP_V0 * CELL_V,
       CAP_U1 * CELL_U, CAP_V1 * CELL_V,  CAP_U0 * CELL_U, CAP_V1 * CELL_V], 2));
    const L = CAP_LIT;
    g.setAttribute('color', new THREE.Float32BufferAttribute(
      [L, L, L, L, L, L, L, L, L, L, L, L], 3));
    g.setAttribute('aCap', new THREE.Float32BufferAttribute([1, 1, 1, 1], 1));  // rim-fade flag
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.userData.keepNormals = true;
    return g;
  }

  /* near-band photographic impostor: contact shade + 3 crossed photo cards + top cap. The added
     procedural cylinder trunk was removed: it duplicated the photographed trunk and repeated as
     a uniformly bright, flat pole through every species. */
  function hybridTree(rng, o) {
    const parts = [];
    if (o.shadeR) parts.push(utilUV(contactShade(o.shadeR, rng)));
    for (let k = 0; k < 3; k++)
      parts.push(cardGeom(CARD_W, CARD_H, Math.PI * (k / 3) + (rng() - 0.5) * 0.15));
    parts.push(capGeom());
    return mergeParts(parts);
  }

  function billboardGeometry() {       // far bands 1-2: TWO crossed cards + top cap, 6 tris.
    // NOTE: a 3rd crossed card (60° spacing) reads slightly less flat on ridgelines, but bands 1-2
    // hold the LARGEST instance counts, and looking across dense forest from altitude their
    // alpha-tested cards overdraw heavily — the 3rd card added ~50% fragment cost there and dropped
    // the frame rate low enough that the forest streamer couldn't keep up (bare-imagery "fuzz" at
    // altitude). Two cards keep the cross silhouette at a third less overdraw; the top cap still
    // fills the edge-on gap from above.
    return mergeParts([
      cardGeom(CARD_W, CARD_H, 0), cardGeom(CARD_W, CARD_H, Math.PI / 2),
      capGeom()]);
  }

  /* CLOSE DETAIL OVERLAY: six crown-only depth slices sampled from the SAME atlas column add
     parallax without duplicating the photographed trunk. Pool exhaustion can only remove extra
     detail, never the tree. */
  function crownSlice(w, h, y, ang, radial, u0, u1, v0, v1) {
    const g = new THREE.BufferGeometry(), hw = w * 0.5;
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-hw, y, 0, hw, y, 0, hw, y + h, 0, -hw, y + h, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(
      [u0 * CELL_U, v0 * CELL_V, u1 * CELL_U, v0 * CELL_V,
       u1 * CELL_U, v1 * CELL_V, u0 * CELL_U, v1 * CELL_V], 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(
      [0.92, 0.92, 0.92, 0.92, 0.92, 0.92, 1, 1, 1, 1, 1, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.rotateY(ang);
    g.translate(Math.sin(ang) * radial, 0, Math.cos(ang) * radial);
    g.userData.keepNormals = true;
    return g;
  }

  function closeTreeDetail() {
    const parts = [];
    const slices = [
      [5.8, 3.8, 1.8, 0.18, 0.34, 0.05, 0.95, 0.08, 0.36],
      [5.2, 3.7, 3.0, 2.22, 0.42, 0.07, 0.93, 0.18, 0.47],
      [4.7, 3.5, 4.6, 4.25, 0.30, 0.10, 0.90, 0.30, 0.58],
      [4.0, 3.2, 6.3, 1.18, 0.28, 0.14, 0.86, 0.43, 0.69],
      [3.3, 2.9, 8.0, 3.28, 0.20, 0.19, 0.81, 0.56, 0.80],
      [2.5, 2.6, 9.7, 5.18, 0.12, 0.24, 0.76, 0.68, 0.91],
    ];
    for (const s of slices) parts.push(crownSlice(...s));
    return mergeParts(parts);
  }

  /* ---------------- FAR FOREST BAND (band 3) ----------------
   * Beyond the scatter radius the moraine forests were bald 3D against painted NAIP, and the
   * rim crawled as a hard line. This 4th ultra-cheap band fills radius..~6 km with irregular
   * multi-tree stand impostors. Each clump contains separated, differently sized/oriented trees
   * from several conditioned atlas columns; deterministic 128 m microcells preserve meadow gaps
   * and forest fingers instead of turning every accepted area into a continuous canopy surface.
   * ALL clumps share ONE InstancedMesh (+1 draw call, bounded by FAR.cap).
   * A screen-door (interleaved-gradient-noise) fade dissolves patches in from ~5.8 km and back
   * out below ~2.3 km where the real billboard cells take over, so neither edge is a line. */
  const FAR = {
    cell: 512, radius: 6000, inner: 1400, cap: 4096,
    cardW: 38, cardH: 21, sink: 2.5,
    fadeIn0: 1650, fadeIn1: 2350,    // dissolve OUT toward the camera (billboards own < 2.1 km)
    fadeOut0: 4800, fadeOut1: 5800,  // dissolve IN from the horizon (NAIP owns beyond)
    coverMin: 40, colDark: 7,        // LANDFIRE canopy % gate (fallback); darkest atlas column
    micro: 128, maskMin: 0.28,       // stand microcells + soft multi-sample forest-prob gate
    rowCand: 14,                     // exact old random-candidate count for ?farRows=1 comparison
    shellStep: 64, shellMaskMin: 0.34,
  };

  function injectFarShell(shader) {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {',
        'varying vec3 vCanopyWorld;\nvarying float vFarD;\nvoid main() {')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\n' +
        'vFarD = length(mvPosition.xyz);\n' +
        'vCanopyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        'varying vec3 vCanopyWorld;\nvarying float vFarD;\nvoid main() {')
      .replace('#include <alphatest_fragment>',
        `float farF = smoothstep(${FAR.fadeIn0.toFixed(1)}, ${FAR.fadeIn1.toFixed(1)}, vFarD)\n` +
        `           * (1.0 - smoothstep(${FAR.fadeOut0.toFixed(1)}, ${FAR.fadeOut1.toFixed(1)}, vFarD));\n` +
        // Two world-space octaves break up the shell without camera-relative crawling.
        'float canopyN = fract(sin(dot(floor(vCanopyWorld.xz * 0.115), vec2(12.9898,78.233))) * 43758.5453);\n' +
        'float canopyFine = fract(sin(dot(floor(vCanopyWorld.xz * 0.31), vec2(39.346,11.135))) * 24634.6345);\n' +
        'float canopyKeep = farF * (0.88 + 0.12 * canopyN);\n' +
        'float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056,0.00583715))));\n' +
        'if (ign >= canopyKeep || canopyFine < 0.055) discard;\n' +
        '#include <alphatest_fragment>');
    injectSeason(shader, true);
    injectClouds(shader);
  }

  function farStandGeometry() {
    const rng = mulberry32(0xFA57);
    const parts = [];
    // One instance represents a stand, not one enormous tree or a pair of ruler-straight rows.
    // The Poisson-like fixed layout leaves real holes through which terrain remains visible.
    const trees = [
      [-31, -20, .72], [ -8, -28, .91], [ 20, -23, .68],
      [-24,   3, .96], [  4,  -1, 1.12], [ 31,   5, .78],
      [-13,  25, .76], [ 17,  24, .94],
    ];
    for (let k = 0; k < trees.length; k++) {
      const [x, z, base] = trees[k];
      const scale = base * (0.91 + rng() * 0.18);
      const g = cardGeom(FAR.cardW * scale, FAR.cardH * scale * (0.9 + rng() * 0.2),
        (k % 4) * Math.PI / 4 + (rng() - .5) * .24);
      // Mix the healthy conifer columns within one coherent stand. Mirroring plus height and
      // azimuth variation prevents the atlas from re-forming a repeated picket-fence silhouette.
      const col = k % 5 === 4 ? 3 : (k % 3);
      const uv = g.attributes.uv, flip = rng() < 0.5;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i) / CELL_U;
        uv.setX(i, (col + (flip ? 1 - u : u)) * CELL_U);
      }
      g.translate(x + (rng() - .5) * 3.5, 0, z + (rng() - .5) * 3.5);
      parts.push(g);
    }
    return mergeParts(parts);
  }

  function farRowGeometry() {        // matched pre-stand control: two crossed rows of three cards
    const rng = mulberry32(0xFA57), parts = [];
    for (let d = 0; d < 2; d++) for (let k = -1; k <= 1; k++) {
      const g = cardGeom(FAR.cardW, FAR.cardH * (0.82 + rng() * 0.36), 0);
      const uv = g.attributes.uv, flip = rng() < 0.5;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i) / CELL_U;
        uv.setX(i, (FAR.colDark + (flip ? 1 - u : u)) * CELL_U);
      }
      g.translate((k * .94 + (rng() - .5) * .1) * FAR.cardW, 0, (rng() - .5) * 5);
      if (d) g.rotateY(Math.PI / 2);
      parts.push(g);
    }
    return mergeParts(parts);
  }

  function injectFar(shader) {   // cap rim fade + distance dither-fade at both band edges + clouds
    shader.vertexShader = shader.vertexShader
      .replace('void main() {',
        'attribute float aCap;\nvarying float vCapFlag;\nvarying float vCapFacing;\nvarying float vFarD;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCapFlag = aCap;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvFarD = length(mvPosition.xyz);\n' +
        // Horizontal canopy caps are useful from the air, but at grazing angles they used
        // to read as bright repeated dashes across distant slopes. Fade them by projected
        // facing while retaining the vertical photo cards that carry the forest silhouette.
        'vCapFacing = abs(dot(normalize(normalMatrix * objectNormal), normalize(-mvPosition.xyz)));');
    const cu = (CAP_U0 + CAP_U1) / 2, hu = (CAP_U1 - CAP_U0) / 2;
    const cv = (CAP_V0 + CAP_V1) / 2 * CELL_V, hv = (CAP_V1 - CAP_V0) / 2 * CELL_V;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        'varying float vCapFlag;\nvarying float vCapFacing;\nvarying float vFarD;\nvoid main() {')
      .replace('#include <alphatest_fragment>',
        'if (vCapFlag > 0.5) {\n' +
        // Legacy crown-window caps remain visible as pale islands in high aerial views.
        // Omit them until the terrain-conforming canopy shell replaces this representation;
        // upright cards still preserve the distant forest silhouette from the ground.
        '  discard;\n' +
        '}\n' +
        `float farF = smoothstep(${FAR.fadeIn0.toFixed(1)}, ${FAR.fadeIn1.toFixed(1)}, vFarD)\n` +
        `           * (1.0 - smoothstep(${FAR.fadeOut0.toFixed(1)}, ${FAR.fadeOut1.toFixed(1)}, vFarD));\n` +
        'if (farF < 0.997) {\n' +
        '  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n' +
        '  if (ign >= farF) discard;\n' +
        '}\n#include <alphatest_fragment>');
    injectSeason(shader, true);
    injectClouds(shader);
  }

  function sagebrush(rng) {
    // A single faceted dome read as a boulder at ground level. Instead cluster a few small
    // SMOOTH-shaded lobes into a low wide multi-lobe brush silhouette: smaller, flatter, olive.
    // Smooth sphere-direction normals (kept through the merge) kill the hard facets that made it
    // read as rock; the lobe offsets give a soft irregular shrub outline. ~60 tris, still cheap.
    // sage is the LAST template built in buildFlora, so its rng draw count affects no other mesh.
    const parts = [];
    const lobes = [
      [ 0.00, 0.13,  0.00, 0.30],
      [ 0.20, 0.09,  0.05, 0.21],
      [-0.16, 0.10, -0.13, 0.22],
    ];
    for (const [ox, oy, oz, r] of lobes) {
      const b = new THREE.IcosahedronGeometry(r, 0);
      b.scale(1, 0.58, 1);                            // flatten each lobe: low brush, not a dome
      const p = b.attributes.position, nn = b.attributes.normal;
      for (let k = 0; k < p.count; k++) {             // smooth sphere-direction normals (no facets)
        const vx = p.getX(k), vy = p.getY(k), vz = p.getZ(k), l = Math.hypot(vx, vy, vz) || 1;
        nn.setXYZ(k, vx / l, vy / l, vz / l);
      }
      nn.needsUpdate = true;
      b.translate(ox, oy, oz);
      jitterVerts(b, rng, 0.05, false);
      paint(b, [0.150, 0.180, 0.100], rng, { jitter: 0.28, lighten: 0.40 });  // muted olive
      b.userData.keepNormals = true;                  // keep the smooth normals through mergeParts
      parts.push(b);
    }
    return mergeParts(parts);
  }

  function buildFlora() {
    const rng = mulberry32(0xC0FFEE);
    const snagT = new THREE.CylinderGeometry(0.12, 0.55, 11, 5);
    snagT.translate(0, 5.5, 0);
    return {
      conifer: hybridTree(rng, {                 // lodgepole/spruce, ~14 m at scale 1
        trunkR: 0.30, trunkH: 5.6, trunkC: [0.16, 0.11, 0.06], shadeR: 1.7 }),
      spire: hybridTree(rng, {                   // engelmann / subalpine fir
        trunkR: 0.24, trunkH: 5.2, trunkC: [0.14, 0.10, 0.06], shadeR: 1.3 }),
      snag: mergeParts([paint(snagT, [0.30, 0.26, 0.20], rng, { jitter: 0.25, lighten: -0.25 }),
                        contactShade(0.8, rng)]),
      aspen: hybridTree(rng, {                   // pale slim trunk under the photo crown
        trunkR: 0.20, trunkH: 5.2, trunkC: [0.62, 0.63, 0.55], shadeR: 1.5 }),
      cottonwood: hybridTree(rng, {              // big riparian broadleaf
        trunkR: 0.44, trunkH: 4.2, trunkC: [0.22, 0.17, 0.11], shadeR: 2.6 }),
      sage: sagebrush(rng),
    };
  }

  /* ---------------- measured vegetation raster (LANDFIRE EVH+EVC) ----------------
   * Small baked raster (terrain/public/vegheight.png, ~1.8 MB @ 20 m): R = veg height metres
   * (0..50 -> 0..250), G = canopy cover percent (0..100 -> 0..200). Same world mapping style as
   * landcover. Fully resident, point-queried like Landcover. Absent/failed load -> null, and the
   * manager falls back to its original procedural behaviour. */
  class VegData {
    constructor(url) { this.url = url; }
    async init() {
      this.m = await (await fetch(this.url)).json();
      const base = this.url.replace(/[^/]+$/, '');
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('vegheight.png failed to load'));
        img.src = base + this.m.url;
      });
      const cv = document.createElement('canvas');
      cv.width = this.m.width; cv.height = this.m.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      this.data = ctx.getImageData(0, 0, this.m.width, this.m.height).data;
      this.cE = this.m.world.centerEasting; this.cN = this.m.world.centerNorthing;
      const e = this.m.encode || { heightR: { maxM: 50, scale: 250 }, coverG: { maxPct: 100, scale: 200 } };
      this._hMul = e.heightR.maxM / e.heightR.scale;      // R -> metres
      this._cMul = e.coverG.maxPct / e.coverG.scale;      // G -> percent
      this._installWorldIndexes();
      return this;
    }
    _installWorldIndexes() {
      const client = global.GT_APP?.worldIndex;
      if (!client?.initialized || typeof client.installRaster !== 'function') return;
      const install = async () => {
        await client.initialized;
        if (!client.ready || client.failed) return;
        const meta = {
          width: this.m.width, height: this.m.height,
          originE: this.m.originE, originN: this.m.originN, res: this.m.res,
          centerEasting: this.cE, centerNorthing: this.cN,
        };
        const channel = (offset) => {
          const out = new Uint8Array(this.m.width * this.m.height);
          for (let i = 0, p = offset; i < out.length; i++, p += 4) out[i] = this.data[p];
          return out;
        };
        await client.installRaster({
          id: 'vegetation-height', data: channel(0), scale: this._hMul, ...meta,
        });
        await client.installRaster({
          id: 'vegetation-cover', data: channel(1), scale: this._cMul, ...meta,
        });
      };
      this.worldIndexInstall = install().catch(error => {
        console.warn('[world-index] vegetation raster install failed; retaining local queries.', error);
      });
    }
    _idx(x, z) {
      const E = x + this.cE, N = this.cN - z;
      const px = ((E - this.m.originE) / this.m.res) | 0, py = ((this.m.originN - N) / this.m.res) | 0;
      if (px < 0 || py < 0 || px >= this.m.width || py >= this.m.height) return -1;
      return (py * this.m.width + px) * 4;
    }
    heightAt(x, z) { const i = this._idx(x, z); return i < 0 ? -1 : this.data[i] * this._hMul; }
    coverAt(x, z)  { const i = this._idx(x, z); return i < 0 ? -1 : this.data[i + 1] * this._cMul; }
  }

  /* ---------------- NAIP forest-likelihood mask (M2 land-cover-driven foliage) ----------------
   * terrain/public/forestmask.png (~1.5 MB @ 20 m, park-wide): R = forest probability 0..1 baked
   * OFFLINE from the aerial imagery pyramid (z3 NAIP). A pixel is "woodland" when the imagery is
   * dark AND green-dominant — smoothstep(bright 155->100) * smoothstep(G/(R+B) 0.56->0.60) — the
   * exact discriminator measured against NLCD (evergreen ~0.72, riparian/mixed ~0.65-0.80; shrub
   * 0.19, grassland 0.02, rock/snow ~0, water 0.14). Multiplied into tree acceptance so scatter
   * ALIGNS with the visible imagery woodland and thins where the imagery isn't wooded — the fix
   * for trees disagreeing with the NAIP forest pattern / stray spikes on bare slopes. Fully
   * resident, point-queried (bilinear), consumes NO rng (seeded sequence unchanged). Absent /
   * failed load -> null everywhere and the manager keeps its NLCD+LANDFIRE behaviour. */
  class ForestMask {
    constructor(url) { this.url = url; }
    async init() {
      this.m = await (await fetch(this.url)).json();
      const base = this.url.replace(/[^/]+$/, '');
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('forestmask.png failed to load'));
        img.src = base + this.m.url;
      });
      const cv = document.createElement('canvas');
      cv.width = this.m.width; cv.height = this.m.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      this.data = ctx.getImageData(0, 0, this.m.width, this.m.height).data;
      this.cE = this.m.world.centerEasting; this.cN = this.m.world.centerNorthing;
      this._installWorldIndex();
      return this;
    }
    _installWorldIndex() {
      const client = global.GT_APP?.worldIndex;
      if (!client?.initialized || typeof client.installRaster !== 'function') return;
      const install = async () => {
        await client.initialized;
        if (!client.ready || client.failed) return;
        const data = new Uint8Array(this.m.width * this.m.height);
        for (let i = 0, p = 0; i < data.length; i++, p += 4) data[i] = this.data[p];
        await client.installRaster({
          id: 'forest-probability', data, scale: 1 / 255,
          width: this.m.width, height: this.m.height,
          originE: this.m.originE, originN: this.m.originN, res: this.m.res,
          centerEasting: this.cE, centerNorthing: this.cN,
        });
      };
      this.worldIndexInstall = install().catch(error => {
        console.warn('[world-index] forest raster install failed; retaining local queries.', error);
      });
    }
    /* bilinear forest probability 0..1; null outside the baked band (caller falls back). Same
       world->pixel registration as VegData/landcover; edge texels clamp so the band rim reads
       woodland-consistent rather than smearing to zero. */
    probAt(x, z) {
      const m = this.m, W = m.width, H = m.height, d = this.data;
      const u = (x + this.cE - m.originE) / m.res - 0.5;
      const v = (m.originN - (this.cN - z)) / m.res - 0.5;
      if (u < -1 || v < -1 || u > W || v > H) return null;
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const s = (ii, jj) => {
        ii = ii < 0 ? 0 : ii >= W ? W - 1 : ii;
        jj = jj < 0 ? 0 : jj >= H ? H - 1 : jj;
        return d[(jj * W + ii) * 4] / 255;
      };
      return lerp(lerp(s(i, j), s(i + 1, j), fu), lerp(s(i, j + 1), s(i + 1, j + 1), fu), fv);
    }
  }

  /* ---------------- manager ---------------- */

  class ScatterManager {
    constructor(o) {
      this.scene = o.scene; this.terrain = o.terrain; this.lc = o.landcover;
      this.water = o.water || null;              // WaterBuilder — authoritative wet field (M1-2)
      this._waterS = makeWaterSurfaceSampler(this.water);
      this.veg = null;                           // measured LANDFIRE raster, set by init() (optional)
      this.vegUrl = o.vegUrl || 'terrain/public/vegheight.json';
      this.fmask = null;                         // NAIP forest-likelihood mask, set by init() (optional)
      this.fmaskUrl = o.forestMaskUrl || 'terrain/public/forestmask.json';
      this.baseMeshM = o.baseMeshM || 14;        // silhouette height (m) of the tree meshes at scale 1
      let quality = 'ultra';
      try { quality = new URLSearchParams(global.location?.search || '').get('quality') || quality; }
      catch (_) {}
      this._quality = quality;
      const high = quality === 'high', balanced = quality === 'balanced', low = quality === 'low';
      this.cellSize = o.cellSize || 256;
      // The one-draw far canopy already overlaps from 1.4 km. On non-Ultra presets, stop paying
      // hundreds of per-cell billboard draws beneath it out to 2.1 km.
      this.radius = o.radius || (low ? 1400 : balanced ? 1550 : 2100);
      this.maxTrees = o.maxTrees || (low ? 170 : balanced ? 210 : 300);
      this.treeCandidates = o.treeCandidates || (low ? 360 : balanced ? 420 : 560);
      this.maxShrubs = o.maxShrubs || (low ? 420 : balanced ? 560 : 900);
      this.shrubCandidates = o.shrubCandidates || (low ? 760 : balanced ? 980 : 1500);
      this.flora = buildFlora();
      this.material = new THREE.MeshLambertMaterial({ vertexColors: true });   // snag + sage
      this.material.onBeforeCompile = injectClouds;
      this.bbGeo = billboardGeometry();
      this.photoMat = new THREE.MeshLambertMaterial({
        map: buildAtlasTexture(), vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide,
        // Fixed emissive made crowns remain legible after the sky and terrain went dark.
        // Forest now follows the same live sun/moon/ambient lights as the environment.
        emissive: new THREE.Color(0, 0, 0) });
      this.photoMat.onBeforeCompile = injectPhoto;
      this.cells = new Map();                    // "ix,iz" -> {meshes:[{sp,mesh}], band}
      this.pools = new Map();                    // species -> InstancedMesh[]
      this.group = new THREE.Group();
      this.group.name = 'vegetationScatter';
      this.scene.add(this.group);
      let detailOverride = null;
      try {
        const qp = new URLSearchParams(global.location.search);
        if (qp.has('treedetail') && isFinite(+qp.get('treedetail')))
          detailOverride = Math.max(0, +qp.get('treedetail') | 0);
      } catch (e) {}
      const qualityCap = quality === 'low' ? 8 : quality === 'balanced' ? 20 : 32;
      this.detailCap = detailOverride != null ? detailOverride :
        (o.detailTrees == null ? qualityCap : Math.max(0, o.detailTrees | 0));
      this._detailSelected = new Set();
      this._detailAnchor = new THREE.Vector3(1e9, 0, 1e9);
      this._detailNext = 0;
      this._detailDirty = true;
      this._detailM = new THREE.Matrix4();
      this._detailForward = new THREE.Vector3();
      this._detailLook = new THREE.Vector3(0, 0, -1);
      if (this.detailCap) {
        this._detailMat = new THREE.MeshLambertMaterial({
          map: this.photoMat.map, vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide,
          color: new THREE.Color(0.78, 0.86, 0.77),
          emissive: new THREE.Color(0, 0, 0),
        });
        this._detailMat.onBeforeCompile = injectPhoto;
        const base = closeTreeDetail();
        const geo = new THREE.BufferGeometry();
        for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
        geo.setIndex(base.index);
        geo.setAttribute('aUvOff',
          new THREE.InstancedBufferAttribute(new Float32Array(this.detailCap), 1));
        this._detailMesh = new THREE.InstancedMesh(geo, this._detailMat, this.detailCap);
        this._detailMesh.count = 0;
        this._detailMesh.frustumCulled = false;
        this.group.add(this._detailMesh);
      }
      this._lastCell = null;
      this._queue = null;                        // pending cell fills, amortized across frames
      this._queueLook = new THREE.Vector3(0, 0, -1);
      this._queueForward = new THREE.Vector3();
      this._queueSortAt = 0;
      this._streamStats = {
        cellsBuilt: 0, cellsReplaced: 0, fillMs: 0, worstFillMs: 0,
        candidateSubmitted: 0, candidateCompleted: 0, candidateCancelled: 0,
        candidateStale: 0, candidateTransferredBytes: 0, candidateQueueHighWater: 0,
        snapshotCellsStarted: 0, snapshotCellsCompleted: 0, snapshotSamples: 0,
        snapshotMs: 0, snapshotWorstSliceMs: 0,
        worldIndexCells: 0, worldIndexValues: 0, worldIndexFallbackValues: 0,
        worldIndexFailures: 0,
      };
      this._fillBudgetMs = o.fillBudgetMs || (high ? 4.5 : 2.5);
      this._snapshotBudgetMs = o.snapshotBudgetMs || 0.75;
      // Candidate RNG is independent of terrain/landcover queries, so prepare its exact Float64
      // stream off-thread. Keeping queries and Three.js objects here preserves visual placement.
      this._candidateGeneration = 0;
      this._candidateNextId = 1;
      this._candidateReady = new Map();
      this._candidatePending = new Map();
      this._candidateWorker = null;
      this._worldIndex = o.worldIndex || global.GT_APP?.worldIndex ||
        global.GT_APP?.services?.worldIndex || null;
      let workersEnabled = true;
      try { workersEnabled = new URLSearchParams(global.location.search).get('noWorkers') !== '1'; }
      catch (_) {}
      if (workersEnabled && typeof Worker !== 'undefined' && o.vegetationWorker !== false) {
        try {
          this._candidateWorker = new Worker(
            new URL('terrain/src/workers/vegetation-worker.js', document.baseURI),
            { type: 'module', name: 'teton-vegetation' });
          this._candidateWorker.onmessage = e => this._onCandidateMessage(e.data);
          this._candidateWorker.onerror = () => this._disableCandidateWorker();
        } catch (err) { this._candidateWorker = null; }
      }
      // fade-in: freshly filled cells grow over ~0.6 s instead of popping (set fadeIn:false to revert)
      this.fadeIn = o.fadeIn !== false;
      this.fadeMs = o.fadeMs || 600;
      this._fading = [];                         // {cell, orig:[Float32Array], t0}
      // far forest band (band 3): merged patch impostors radius..~6 km (farBand:false to revert)
      this.farBand = o.farBand !== false;
      this._farRadius = o.farRadius || FAR.radius;
      this._farCache = new Map();                // "cx,cz" -> deterministic patch list
      this._farWant = [];                        // current wanted far cell keys (build order)
      this._farQueue = null;                     // cache misses pending, drained on a time budget
      this._farAnchor = null; this._farDirty = false;
      this._farPending = new Map();
      this._farGeneration = 0;
      this._farBuiltSinceRepack = 0;
      this._farLastRepackAt = 0;
      // The worker-sampled canopy shell remains an explicit experiment until it can populate a
      // full moving ring within the streaming budget. The bounded legacy patches are the safe
      // production path; `?canopyShell=1` opts into continued shell development.
      try { this._legacyFarPatches = new URLSearchParams(global.location.search).get('canopyShell') !== '1'; }
      catch (_) { this._legacyFarPatches = true; }
      try { this._farRows = new URLSearchParams(global.location.search).get('farRows') === '1'; }
      catch (_) { this._farRows = false; }
      this._farStats = { cellsBuilt: 0, rebuilds: 0, vertices: 0, triangles: 0,
        workerCells: 0, fallbackCells: 0, cancelled: 0, worstBuildMs: 0, buildMs: 0 };
      if (this.farBand) {
        this._farMat = new THREE.MeshLambertMaterial(this._legacyFarPatches ? {
          map: this.photoMat.map, vertexColors: true, alphaTest: .35, side: THREE.DoubleSide,
          emissive: this.photoMat.emissive.clone(),
        } : {
          vertexColors: true, side: THREE.DoubleSide,
          color: new THREE.Color(.72, .82, .67),
          emissive: new THREE.Color(0, 0, 0),
        });
        this._farMat.onBeforeCompile = this._legacyFarPatches ? injectFar : injectFarShell;
      this._farMesh = this._legacyFarPatches
          ? new THREE.InstancedMesh(this._farRows ? farRowGeometry() : farStandGeometry(),
            this._farMat, FAR.cap)
          : new THREE.Mesh(new THREE.BufferGeometry(), this._farMat);
        if (this._legacyFarPatches) this._farMesh.count = 0;
        this._farMesh.frustumCulled = false;     // the ring always straddles the frustum; 1 draw
        this.group.add(this._farMesh);
      }
      this._dummy = new THREE.Object3D();
      this._col = new THREE.Color();
      // ASL thresholds -> world y (heights are datum-relative)
      const D = (o.terrain && o.terrain.datum) || 1897;
      this.treelineY = 3040 - D;                 // trees give out ~3040 m ASL
      this.spireY0 = 2400 - D; this.spireY1 = 2800 - D;
      this.aspenMaxY = 2380 - D;
      this.sageY0 = 2600 - D; this.sageY1 = 2850 - D;
    }

    /* Load the measured vegetation raster (graceful: on any failure the manager keeps its original
       procedural behaviour). Cells built after this resolves are driven by the data. Boot awaits
       it before the first fill, so the world is data-driven from frame one. */
    async init() {
      try { this.veg = await new VegData(this.vegUrl).init(); }
      catch (err) { this.veg = null; }           // absent file / decode error -> fallback
      try { this.fmask = await new ForestMask(this.fmaskUrl).init(); }
      catch (err) { this.fmask = null; }          // absent file / decode error -> fallback
      // HYBRID tree placement (park-wide): edge/scattered trees are placed ON the detected imagery
      // tree-dots; the dense closed-canopy core keeps the cheap procedural scatter (see _fillCell +
      // terrain/pipeline/bake_treepoints_full.py). Load the compact binary point set (int16 x,z +
      // uint8 strength) into flat typed arrays and bucket point INDICES by 256 m cell — never arrays
      // of {x,z} objects (8 M pts would blow the JS heap). Absent/failed -> pure procedural fallback.
      try {
        // treepoints.bin (~20 MB) lives off-origin on R2 like the tile pyramids — resolve it through
        // window.GT_TILE_CDN when set (deployed), else same-origin local dev. The tiny meta json
        // stays local (ships in the bundle), matching TerrainStreamer's "big->CDN, small->local" split.
        const cdn = (typeof window !== 'undefined' && window.GT_TILE_CDN) || 'terrain/public/';
        const meta = await (await fetch(this.treePointsMeta || 'terrain/public/treepoints_meta.json')).json();
        const buf = await (await fetch(cdn + 'treepoints.bin')).arrayBuffer();
        const n = new DataView(buf).getUint32(0, true);
        this._dotX = new Int16Array(buf, 4, n);
        this._dotZ = new Int16Array(buf, 4 + n * 2, n);
        this._dotS = new Uint8Array(buf, 4 + n * 4, n);
        const S = this.cellSize, tmp = new Map();
        for (let i = 0; i < n; i++) {
          const k = this._dotKey(Math.floor(this._dotX[i] / S), Math.floor(this._dotZ[i] / S));  // int key, no string alloc
          let a = tmp.get(k); if (!a) { a = []; tmp.set(k, a); }
          a.push(i);
        }
        this._dotByCell = new Map();
        for (const [k, a] of tmp) this._dotByCell.set(k, Int32Array.from(a));   // compact per-cell index
        this._dotCoreMin = meta.coreMin != null ? meta.coreMin : 0.55;          // fp split; >1 => FULL (points everywhere)
        this._dotFull = this._dotCoreMin > 1;                                   // FULL: points own ALL trees, procedural off
        if (meta.cellCap) this.maxTrees = Math.max(this.maxTrees, meta.cellCap); // render up to the baked per-cell cap
      } catch (err) { this._dotByCell = null; }                                 // -> pure procedural scatter
      return this;
    }

    /* distance bands: full forest near, thinning toward the rim so there's no hard treeline wall.
       Beyond the rim the NAIP imagery itself carries the forest color. */
    _band(dx, dz, r) { const rr = Math.hypot(dx, dz) / r; return rr < 0.55 ? 0 : rr < 0.82 ? 1 : 2; }

    // integer cell key for the dot-point buckets (world is ~±90 cells, so ±2048 is ample headroom)
    _dotKey(cx, cz) { return ((cx + 2048) << 12) | (cz + 2048); }

    update(camPos, viewCamera) {
      // SEASON: refresh the shared uniform from the live global, then adopt it onto every terrain
      // tile material. Boot order is terrain.update() -> scatter.update() -> render, so a tile
      // created THIS frame is patched here before its first render (three's seqWithValue then keeps
      // uSeason in the tile's uniform list). If ScatterManager never runs, terrain simply omits the
      // uniform and defaults to summer — no crash. Vegetation materials share the same object.
      SEASON_UNIFORMS.uSeason.value = seasonNow();
      const tstream = this.terrain;
      if (tstream && tstream.meshes && tstream.meshes.forEach) {
        tstream.meshes.forEach(rec => {
          const u = rec && rec.mesh && rec.mesh.material && rec.mesh.material.uniforms;
          if (u && u.uSeason !== SEASON_UNIFORMS.uSeason) u.uSeason = SEASON_UNIFORMS.uSeason;
        });
      }
      const ix = Math.floor(camPos.x / this.cellSize), iz = Math.floor(camPos.z / this.cellSize);
      const key = ix + ',' + iz;
      if (key !== this._lastCell) {               // recompute the wanted set only on crossings
        this._lastCell = key;
        this._reconcile(ix, iz, viewCamera);
      }
      this._prioritizeQueue(ix, iz, viewCamera);
      // cells wait for the road/building indexes (built async by the app) — filling before
      // they can answer would place trees on carriageways and cull them visibly later
      if (this._exclusionReady()) this._drainQueue();
      this._updateFades();                         // grow freshly filled cells (~0.6 s each)
      this._updateCloseDetail(camPos, viewCamera);
      if (this.farBand) this._updateFar(camPos);   // band-3 forest patches out to ~6 km
      this._publishStreamTelemetry();
    }

    _updateCloseDetail(camPos, viewCamera) {
      const out = this._detailMesh;
      if (!out) return;
      const now = performance.now();
      const moved = Math.hypot(camPos.x - this._detailAnchor.x, camPos.z - this._detailAnchor.z);
      if (viewCamera && viewCamera.getWorldDirection) viewCamera.getWorldDirection(this._detailForward);
      else this._detailForward.set(0, 0, -1);
      const turned = this._detailForward.dot(this._detailLook) < 0.96;
      if (!this._detailDirty && moved < 4 && !turned) return;
      if (now < this._detailNext) return;
      this._detailNext = now + 220;
      this._detailAnchor.copy(camPos);
      this._detailLook.copy(this._detailForward);
      this._detailDirty = false;
      const fl = Math.hypot(this._detailForward.x, this._detailForward.z) || 1;
      const fx = this._detailForward.x / fl, fz = this._detailForward.z / fl;

      /* Candidate collection runs every ~220 ms over every conifer/spire instance in the cells
         under the camera — thousands of them. The old shape allocated one object AND one
         template-string identity key per candidate, plus a fresh Set of those strings, which
         showed up as a recurring hitch roughly every dozen frames. Same scan, same predicates,
         same scores and the same stable ordering; the payload now lives in reusable packed
         arrays and identity is an exact integer. */
      const enter2 = 46 * 46, exit2 = 58 * 58;
      const C = this._detailCand || (this._detailCand = {
        n: 0, cap: 0, score: null, d2: null, key: null, src: null, inst: null,
        srcMa: [], srcUv: [], srcCa: [], kept: [], fresh: [],
      });
      C.n = 0; C.srcMa.length = 0; C.srcUv.length = 0; C.srcCa.length = 0;
      const grow = () => {
        const cap = C.cap ? C.cap * 2 : 4096;
        const score = new Float64Array(cap), d2a = new Float64Array(cap);
        const key = new Float64Array(cap), src = new Int32Array(cap), inst = new Int32Array(cap);
        if (C.cap) { score.set(C.score); d2a.set(C.d2); key.set(C.key); src.set(C.src); inst.set(C.inst); }
        C.score = score; C.d2 = d2a; C.key = key; C.src = src; C.inst = inst; C.cap = cap;
      };
      if (!C.cap) grow();
      for (const [cellKey, cell] of this.cells) {
        if (cell.fading) continue;
        const comma = cellKey.indexOf(',');
        const ccx = +cellKey.slice(0, comma), ccz = +cellKey.slice(comma + 1);
        const mx = (ccx + 0.5) * this.cellSize, mz = (ccz + 0.5) * this.cellSize;
        if (Math.abs(mx - camPos.x) > this.cellSize * 0.65 ||
            Math.abs(mz - camPos.z) > this.cellSize * 0.65) continue;
        // exact integer identity for (cell, species, instance) — replaces "cx,cz|sp|i"
        const cellId = (ccx + 2048) * 4096 + (ccz + 2048);
        for (const rec of cell.meshes) {
          if (rec.sp !== 'conifer' && rec.sp !== 'spire') continue;
          const mesh = rec.mesh, ma = mesh.instanceMatrix.array;
          const uv = mesh.geometry.getAttribute('aUvOff');
          const ca = mesh.instanceColor && mesh.instanceColor.array;
          const srcIdx = C.srcMa.length;
          C.srcMa.push(ma); C.srcUv.push(uv ? uv.array : null); C.srcCa.push(ca || null);
          const base = (cellId * 2 + (rec.sp === 'spire' ? 1 : 0)) * 65536;
          for (let i = 0; i < mesh.count; i++) {
            const o = i * 16, dx = ma[o + 12] - camPos.x, dz = ma[o + 14] - camPos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > exit2) continue;
            const d = Math.sqrt(d2) || 1, facing = (dx * fx + dz * fz) / d;
            if (facing < -0.12) continue;
            if (C.n === C.cap) grow();
            const k = C.n++;
            C.score[k] = d2 / (0.28 + Math.max(0, facing));
            C.d2[k] = d2; C.key[k] = base + i; C.src[k] = srcIdx; C.inst[k] = i;
          }
        }
      }
      // Plain (packed-SMI) index arrays: Array.prototype.sort is specified stable, so ties keep
      // scan order exactly as the old array-of-objects sort did.
      const kept = C.kept, fresh = C.fresh, selected = this._detailSelected;
      kept.length = 0; fresh.length = 0;
      for (let k = 0; k < C.n; k++) {
        if (selected.has(C.key[k])) kept.push(k);
        else if (C.d2[k] <= enter2) fresh.push(k);
      }
      const score = C.score, byScore = (a, b) => score[a] - score[b];
      kept.sort(byScore); fresh.sort(byScore);
      const total = Math.min(kept.length + fresh.length, this.detailCap);
      selected.clear();
      const uvOut = out.geometry.getAttribute('aUvOff');
      for (let n = 0; n < total; n++) {
        const k = n < kept.length ? kept[n] : fresh[n - kept.length];
        selected.add(C.key[k]);
        const i = C.inst[k];
        this._detailM.fromArray(C.srcMa[C.src[k]], i * 16);
        out.setMatrixAt(n, this._detailM);
        const ca = C.srcCa[C.src[k]];
        this._col.setRGB(ca ? ca[i * 3] : 1, ca ? ca[i * 3 + 1] : 1, ca ? ca[i * 3 + 2] : 1);
        out.setColorAt(n, this._col);
        const uvArr = C.srcUv[C.src[k]];
        uvOut.array[n] = uvArr ? uvArr[i] : 0;
      }
      out.count = total;
      global.__TREE_DETAIL_COUNT = total;
      global.__TREE_DETAIL_CAP = this.detailCap;
      out.instanceMatrix.needsUpdate = true;
      if (out.instanceColor) out.instanceColor.needsUpdate = true;
      uvOut.needsUpdate = true;
    }

    /* roadQuery/buildingBlocked come up asynchronously (roads.json fetch, OSM footprint build).
       Cell fills DEFER until both can answer — never place-then-cull. If a subsystem never
       arrives (data file absent, module unused) a grace timeout lets vegetation proceed without
       that exclusion rather than leaving the world bare. Deterministic per run once ready: every
       cell is filled with the same indexes available. */
    _exclusionReady() {
      if (this._exclOk) return true;
      if (this._exclT0 === undefined) this._exclT0 = performance.now();
      const timedOut = performance.now() - this._exclT0 > 15000;
      // RoadIndex is a top-level const in the app scripts (global lexical binding, not on
      // window) — typeof keeps this module standalone-safe
      const roads = (typeof RoadIndex === 'undefined') || RoadIndex.ready || timedOut;
      const bldgs = !!global.buildingBlocked || timedOut;
      if (roads && bldgs) this._exclOk = true;
      return this._exclOk;
    }

    /* true when (x,z) is within ~pad of a building footprint. 4-point pad probe: footprints
       are 10-40 m boxes, so a 2 m buffer around them can't slip past the cardinal probes in
       any way that matters visually. */
    _nearBuilding(x, z, pad) {
      const bb = global.buildingBlocked;
      if (!bb) return false;
      return bb(x, z) || bb(x + pad, z) || bb(x - pad, z) || bb(x, z + pad) || bb(x, z - pad);
    }

    _inTreeClearing(x, z) {
      if (this._inCottonwoodPreserve(x, z)) return false;
      for (const clearing of TREE_CLEARINGS) {
        const dx = (x - clearing.x) / clearing.radiusX;
        const dz = (z - clearing.z) / clearing.radiusZ;
        if (dx * dx + dz * dz < 1) return true;
      }
      return false;
    }

    _inCottonwoodPreserve(x, z) {
      for (const preserve of COTTONWOOD_PRESERVES) {
        const dx = x - preserve.x, dz = z - preserve.z;
        if (dx * dx + dz * dz < preserve.radius * preserve.radius) return true;
      }
      return false;
    }

    /* Authoritative water rejection: true where the baked water surface (S+bias) sits above the
       local terrain by more than 0.15 m, i.e. the point is open water at the current LOD. Trees
       pass dryMargin=2 so they also clear a 2 m dry band above the waterline (no wading conifers
       at the fluctuating pool edge); shrubs/grass pass 0. Once the bake is resident this is the
       ONLY water gate — the old lc.waterAt NHD mask is dropped so vegetation returns to marsh the
       rebake de-flooded. Before the bake loads (a brief boot window) fall back to lc.waterAt so
       nothing flashes onto water. Pure point query, no rng consumed. h = terrain height there. */
    _underWater(x, z, h, dryMargin) {
      if (this.water && this.water._surf) {
        const s = this._waterS(x, z);
        return s !== null && s > h + 0.15 - dryMargin;
      }
      return this.lc.waterAt(x, z);
    }

    /* On a crossing: recompute the wanted cell set, retire out-of-range / band-changed cells
       immediately (cheap — pool return only, no fill), and rebuild the nearest-first pending fill
       queue. Band hysteresis keeps a cell in its current band until rr crosses the 0.55 / 0.82
       edge by a margin, so the crescent straddling a band boundary stops flipping band (and
       rebuilding the same forest) on every crossing — the main driving/fast-motion hitch. */
    _reconcile(ix, iz, viewCamera) {
      this._candidateGeneration++;
      this._streamStats.candidateCancelled += this._candidatePending.size;
      for (const id of this._candidatePending.keys())
        this._candidateWorker?.postMessage({ kind: 'cancel', id });
      this._candidatePending.clear();
      for (const prepared of this._candidateReady.values())
        prepared.worldAbort?.abort();
      this._candidateReady.clear();
      const r = Math.ceil(this.radius / this.cellSize), r2 = r * r;
      const want = new Map();                      // key -> band
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const k = (ix + dx) + ',' + (iz + dz);
        const rr = Math.sqrt(d2) / r;
        let band = rr < 0.55 ? 0 : rr < 0.82 ? 1 : 2;
        const cur = this.cells.get(k);
        if (cur) {                                 // hysteresis around the band edges
          const b = cur.band, m = 0.04;
          if (b === 0 && band === 1 && rr < 0.55 + m) band = 0;
          else if (b === 1 && band === 0 && rr > 0.55 - m) band = 1;
          else if (b === 1 && band === 2 && rr < 0.82 + m) band = 1;
          else if (b === 2 && band === 1 && rr > 0.82 - m) band = 2;
        }
        want.set(k, band);
      }
      // Retire out-of-range cells immediately. For an LOD band change, KEEP the current cell
      // visible until its replacement is fully built; removing it here and growing the queued
      // replacement from zero caused the conspicuous "tree vanishes, then fades back in" event.
      const replacements = [];
      for (const [k, cell] of this.cells) {
        const band = want.get(k);
        if (band === undefined) {
          cell.dead = true;                      // mid-fade retire: _updateFades drops it untouched
          for (const m of cell.meshes) { this.group.remove(m.mesh); this.pools.get(m.sp).push(m.mesh); }
          this.cells.delete(k);
          this._detailDirty = true;
        } else if (band !== cell.band) {
          const [cx, cz] = k.split(',').map(Number);
          const ddx = cx - ix, ddz = cz - iz;
          cell.pendingBand = band;
          replacements.push({ k, cx, cz, band, d2: ddx * ddx + ddz * ddz, replace: true });
        }
      }
      // queue cells still missing, sorted so pop() takes the nearest one first
      const q = replacements;
      for (const [k, band] of want) {
        if (this.cells.has(k)) continue;
        const [cx, cz] = k.split(',').map(Number);
        const ddx = cx - ix, ddz = cz - iz;
        q.push({ k, cx, cz, band, d2: ddx * ddx + ddz * ddz });
      }
      q.sort((a, b) => b.d2 - a.d2);
      this._queue = q;
      this._prioritizeQueue(ix, iz, viewCamera, true);
      this._primeCandidateWorker();
    }

    /* Keep expensive cell construction focused in the current view without changing the wanted
       radial resident set. Rotation only re-sorts missing work; it never evicts or regenerates a
       built cell. This prevents a long nearest-only backlog from producing visible empty wedges
       after driving and turning, while preserving deterministic cell contents. */
    _prioritizeQueue(ix, iz, viewCamera, force) {
      const q = this._queue;
      if (!q || q.length < 2 || !viewCamera?.getWorldDirection) return;
      if (this._quality === 'high' || this._quality === 'ultra') {
        q.sort((a,b)=>b.d2-a.d2);
        this._primeCandidateWorker();
        return;
      }
      viewCamera.getWorldDirection(this._queueForward);
      this._queueForward.y = 0;
      if (this._queueForward.lengthSq() < 1e-5) return;
      this._queueForward.normalize();
      const now = performance.now();
      if (!force && now - this._queueSortAt < 180 &&
          this._queueForward.dot(this._queueLook) > 0.95) return;
      this._queueSortAt = now;
      this._queueLook.copy(this._queueForward);
      const radiusCells = Math.ceil(this.radius / this.cellSize);
      const turnPenalty = radiusCells * radiusCells * 0.65;
      for (const c of q) {
        const dx = c.cx - ix, dz = c.cz - iz;
        const len = Math.hypot(dx, dz) || 1;
        const facing = (dx * this._queueForward.x + dz * this._queueForward.z) / len;
        c.viewScore = c.d2 + (facing < -0.15 ? turnPenalty * -facing
                                             : -turnPenalty * 0.18 * Math.max(0, facing));
        if (c.replace) c.viewScore -= turnPenalty * 0.35;
      }
      q.sort((a, b) => b.viewScore - a.viewScore);
      this._primeCandidateWorker();
    }

    _primeCandidateWorker() {
      if (!this._candidateWorker || !this._queue) return;
      const pendingKeys = new Set([...this._candidatePending.values()].map(v => v.key));
      for (let i = this._queue.length - 1;
           i >= 0 && this._candidatePending.size + this._candidateReady.size < 8; i--) {
        const c = this._queue[i];
        if (this._candidateReady.has(c.k) || pendingKeys.has(c.k)) continue;
        const id = this._candidateNextId++;
        this._candidatePending.set(id, { key: c.k, generation: this._candidateGeneration, phase: 'randoms' });
        this._streamStats.candidateSubmitted++;
        this._streamStats.candidateQueueHighWater = Math.max(
          this._streamStats.candidateQueueHighWater, this._candidatePending.size);
        pendingKeys.add(c.k);
        this._candidateWorker.postMessage({
          id, kind: 'candidateRandoms', generation: this._candidateGeneration,
          priority: this._queue.length - i,
          payload: {
            cx: c.cx, cz: c.cz,
            cellSize: this.cellSize,
            treeCandidates: this.treeCandidates,
            shrubCandidates: c.band === 0 ? this.shrubCandidates : 0,
          },
        });
      }
    }

    _onCandidateMessage(message) {
      const pending = this._candidatePending.get(message.id);
      if (!pending) return;
      this._candidatePending.delete(message.id);
      if (!message.ok) {
        this._disableCandidateWorker();
        return;
      }
      if (message.generation === this._candidateGeneration &&
          pending.generation === this._candidateGeneration) {
        this._streamStats.candidateCompleted++;
        if (message.phase === 'instances') {
          this._streamStats.candidateTransferredBytes +=
            message.buffers.instances.byteLength + message.buffers.shrubInstances.byteLength +
            message.buffers.dotInstances.byteLength;
          this._candidateReady.set(pending.key, {
            phase: 'instances',
            instances: new Float64Array(message.buffers.instances),
            shrubInstances: new Float64Array(message.buffers.shrubInstances),
            dotInstances: new Float64Array(message.buffers.dotInstances),
          });
        } else {
          this._streamStats.candidateTransferredBytes +=
            message.buffers.tree.byteLength + message.buffers.treeSpatial.byteLength +
            message.buffers.shrub.byteLength + message.buffers.shrubSpatial.byteLength;
          this._candidateReady.set(pending.key, {
            phase: 'randoms',
            tree: new Float64Array(message.buffers.tree),
            treeSpatial: new Float64Array(message.buffers.treeSpatial),
            shrub: new Float64Array(message.buffers.shrub),
            shrubSpatial: new Float64Array(message.buffers.shrubSpatial),
          });
        }
      } else this._streamStats.candidateStale++;
      this._primeCandidateWorker();
    }

    _submitTreeSnapshot(c, prepared) {
      prepared.phase = 'sampling';
      prepared.snapshot = new Float64Array(this.treeCandidates * 10);
      prepared.snapshotAt = 0;
      prepared.shrubSnapshot = new Float64Array(
        (c.band === 0 ? this.shrubCandidates : 0) * 6);
      prepared.shrubSnapshotAt = 0;
      const dotIdx = this._dotByCell && this._dotByCell.get(this._dotKey(c.cx, c.cz));
      prepared.dotIdx = dotIdx || null;
      prepared.dotSnapshot = new Float64Array((dotIdx?.length || 0) * 10);
      prepared.dotSnapshotAt = 0;
      prepared.snapshotGeneration = this._candidateGeneration;
      prepared.snapshotCell = c;
      this._streamStats.snapshotCellsStarted++;
      this._startWorldSnapshot(c, prepared);
    }

    _startWorldSnapshot(c, prepared) {
      const client = this._worldIndex || global.GT_APP?.worldIndex ||
        global.GT_APP?.services?.worldIndex;
      if (!client?.ready || client.failed || typeof client.sample !== 'function') return;
      this._worldIndex = client;
      const treeN = this.treeCandidates;
      const shrubN = c.band === 0 ? this.shrubCandidates : 0;
      const dotN = prepared.dotIdx?.length || 0;
      const points = new Float64Array((treeN + shrubN + dotN) * 2);
      const slopes = new Float64Array(treeN * 4);
      let p = 0;
      for (let i = 0; i < treeN; i++) {
        const so = i * 5, x = prepared.treeSpatial[so], z = prepared.treeSpatial[so + 1];
        points[p++] = x; points[p++] = z;
        slopes[i * 4] = x + 8; slopes[i * 4 + 1] = z;
        slopes[i * 4 + 2] = x; slopes[i * 4 + 3] = z + 8;
      }
      for (let i = 0; i < shrubN; i++) {
        points[p++] = prepared.shrubSpatial[i * 2];
        points[p++] = prepared.shrubSpatial[i * 2 + 1];
      }
      for (let i = 0; i < dotN; i++) {
        const pi = prepared.dotIdx[i];
        points[p++] = this._dotX[pi]; points[p++] = this._dotZ[pi];
      }
      const generation = this._candidateGeneration;
      const indexGeneration = client.generation;
      const controller = new AbortController();
      prepared.worldAbort = controller;
      prepared.phase = 'worldSampling';
      const sample = (index, method = 'nearest', source = points) =>
        client.sample({ index, method, points: source, signal: controller.signal });
      const roadSample = typeof client.sampleRoad === 'function'
        ? client.sampleRoad(points, { signal: controller.signal })
        : Promise.resolve({ installed: false });
      const buildingSample = typeof client.sampleBuildings === 'function'
        ? client.sampleBuildings(points, { pad: BLDG_PAD, signal: controller.signal })
        : Promise.resolve({ installed: false });
      const waterSample = typeof client.sampleWaterSurface === 'function'
        ? client.sampleWaterSurface(points, { signal: controller.signal })
        : Promise.resolve({ installed: false });
      Promise.all([
        sample('landcover'), sample(null, 'height'),
        sample('vegetation-height'), sample('vegetation-cover'),
        sample('forest-probability', 'bilinear'), sample(null, 'height', slopes),
        roadSample, buildingSample, waterSample,
      ]).then(([landcover, height, vegHeight, vegCover, forest, slopeHeight,
        road, buildings, waterSurface]) => {
        if (generation !== this._candidateGeneration ||
            indexGeneration !== client.generation ||
            this._candidateReady.get(c.k) !== prepared) return;
        prepared.worldSamples = { landcover, height, vegHeight, vegCover, forest, slopeHeight,
          road, buildings, waterSurface, treeN, shrubN, dotN };
        prepared.phase = 'sampling';
        this._streamStats.worldIndexCells++;
      }).catch(error => {
        controller.abort();
        if (error?.name !== 'AbortError') this._streamStats.worldIndexFailures++;
        if (generation === this._candidateGeneration &&
            this._candidateReady.get(c.k) === prepared) prepared.phase = 'sampling';
      });
    }

    _advanceTreeSnapshot(c, prepared) {
      if (prepared.snapshotGeneration !== this._candidateGeneration) {
        this._candidateReady.delete(c.k);
        this._streamStats.candidateStale++;
        return;
      }
      const n = this.treeCandidates, snapshot = prepared.snapshot;
      const world = prepared.worldSamples;
      const worldValue = (values, at, fallback) => {
        const value = values?.[at];
        if (Number.isFinite(value)) {
          this._streamStats.worldIndexValues++;
          return value;
        }
        if (values) this._streamStats.worldIndexFallbackValues++;
        return fallback();
      };
      const worldRoad = (at, fallback) => {
        if (world?.road?.installed) {
          this._streamStats.worldIndexValues += 2;
          // Store clearance directly with zero class half-width. All downstream margins are
          // unchanged: distance-halfWidth < margin is algebraically identical.
          return { dist: world.road.values[at * 2 + 1], clear: 0 };
        }
        if (world?.road) this._streamStats.worldIndexFallbackValues += 2;
        const road = fallback();
        return { dist: road ? road.dist : Infinity,
          clear: road ? (ROAD_CLEAR[road.class] || 0) : 0 };
      };
      const worldBuilding = (at, fallback) => {
        if (world?.buildings?.installed) {
          this._streamStats.worldIndexValues++;
          return world.buildings.blocked[at] ? 1 : 0;
        }
        if (world?.buildings) this._streamStats.worldIndexFallbackValues++;
        return fallback() ? 1 : 0;
      };
      const worldWater = (at, h, dryMargin, fallback) => {
        if (world?.waterSurface?.installed) {
          this._streamStats.worldIndexValues++;
          if (!world.waterSurface.valid[at]) return 0;
          const surface = world.waterSurface.values[at * 2] +
            world.waterSurface.values[at * 2 + 1];
          return surface > h + .15 - dryMargin ? 1 : 0;
        }
        if (world?.waterSurface) this._streamStats.worldIndexFallbackValues++;
        return fallback() ? 1 : 0;
      };
      const t0 = performance.now();
      const sliceBudget = this.cells.size >= 4 ? this._snapshotBudgetMs :
        Math.max(this._snapshotBudgetMs, this.cells.size ? 2 : 4);
      let i = prepared.snapshotAt;
      for (; i < n; i++) {
        const so = i * 5, q = i * 10;
        const x = prepared.treeSpatial[so], z = prepared.treeSpatial[so + 1];
        const preserve = this._inCottonwoodPreserve(x, z);
        const cls = preserve ? 190 :
          worldValue(world?.landcover, i, () => this.lc.classAt(x, z));
        const evh = worldValue(world?.vegHeight, i,
          () => this.veg ? this.veg.heightAt(x, z) : -1);
        const evc = worldValue(world?.vegCover, i,
          () => this.veg ? this.veg.coverAt(x, z) : -1);
        const h = worldValue(world?.height, i, () => this.terrain.heightAt(x, z));
        const fpValue = worldValue(world?.forest, i,
          () => this.fmask ? this.fmask.probAt(x, z) : null);
        const fp = preserve ? 1 : (Number.isFinite(fpValue) ? fpValue : null);
        const sxh = worldValue(world?.slopeHeight, i * 2,
          () => this.terrain.heightAt(x + 8, z));
        const szh = worldValue(world?.slopeHeight, i * 2 + 1,
          () => this.terrain.heightAt(x, z + 8));
        const sx = (sxh - h) / 8;
        const sz = (szh - h) / 8;
        const road = worldRoad(i, () => global.roadQuery ? global.roadQuery(x, z) : null);
        snapshot[q] = cls; snapshot[q + 1] = evh; snapshot[q + 2] = evc;
        snapshot[q + 3] = h; snapshot[q + 4] = fp === null ? -2 : fp;
        snapshot[q + 5] = worldWater(i, h, 2,
          () => this._underWater(x, z, h, 2));
        snapshot[q + 6] = sx * sx + sz * sz;
        snapshot[q + 7] = road.dist;
        snapshot[q + 8] = road.clear;
        snapshot[q + 9] = this._inTreeClearing(x, z) ? 1 : worldBuilding(i,
          () => this._nearBuilding(x, z, BLDG_PAD));
        // Check after a complete sample, so slicing cannot alter query order or leave a partial
        // row. The same candidate sequence and Float64 values are produced at every budget.
        if ((i & 7) === 7 && performance.now() - t0 >= sliceBudget) {
          i++;
          break;
        }
      }
      prepared.snapshotAt = i;
      const elapsed = performance.now() - t0;
      this._streamStats.snapshotSamples += i - (prepared.snapshotSliceAt || 0);
      prepared.snapshotSliceAt = i;
      this._streamStats.snapshotMs += elapsed;
      this._streamStats.snapshotWorstSliceMs =
        Math.max(this._streamStats.snapshotWorstSliceMs, elapsed);
      if (i < n) return;

      const shrubN = prepared.shrubSnapshot.length / 6;
      const shrubSnapshot = prepared.shrubSnapshot;
      let si = prepared.shrubSnapshotAt;
      for (; si < shrubN; si++) {
        const so = si * 2, q = si * 6;
        const x = prepared.shrubSpatial[so], z = prepared.shrubSpatial[so + 1];
        const wi = n + si;
        const cls = worldValue(world?.landcover, wi, () => this.lc.classAt(x, z));
        const h = worldValue(world?.height, wi, () => this.terrain.heightAt(x, z));
        const road = worldRoad(wi,
          () => global.roadQuery ? global.roadQuery(x, z) : null);
        shrubSnapshot[q] = cls;
        shrubSnapshot[q + 1] = h;
        shrubSnapshot[q + 2] = worldWater(wi, h, 0,
          () => this._underWater(x, z, h, 0));
        shrubSnapshot[q + 3] = road.dist;
        shrubSnapshot[q + 4] = road.clear;
        shrubSnapshot[q + 5] = worldBuilding(wi,
          () => this._nearBuilding(x, z, BLDG_PAD));
        if ((si & 7) === 7 && performance.now() - t0 >= sliceBudget) {
          si++;
          break;
        }
      }
      this._streamStats.snapshotSamples += si - prepared.shrubSnapshotAt;
      prepared.shrubSnapshotAt = si;
      if (si < shrubN) {
        const shrubElapsed = performance.now() - t0;
        this._streamStats.snapshotMs += shrubElapsed - elapsed;
        this._streamStats.snapshotWorstSliceMs =
          Math.max(this._streamStats.snapshotWorstSliceMs, shrubElapsed);
        return;
      }

      const dotN = prepared.dotSnapshot.length / 10;
      const dotSnapshot = prepared.dotSnapshot;
      let di = prepared.dotSnapshotAt;
      for (; di < dotN; di++) {
        const q = di * 10, pi = prepared.dotIdx[di];
        const x = this._dotX[pi], z = this._dotZ[pi];
        const wi = n + shrubN + di;
        const fpValue = worldValue(world?.forest, wi,
          () => this.fmask ? this.fmask.probAt(x, z) : null);
        const fp = Number.isFinite(fpValue) ? fpValue : null;
        const h = worldValue(world?.height, wi, () => this.terrain.heightAt(x, z));
        const road = worldRoad(wi,
          () => global.roadQuery ? global.roadQuery(x, z) : null);
        dotSnapshot[q] = pi;
        dotSnapshot[q + 1] = x;
        dotSnapshot[q + 2] = z;
        dotSnapshot[q + 3] = this._dotS[pi] / 255;
        // -3 marks an imagery-detected tree inside an authored cottonwood pocket. The worker
        // keeps the authoritative dot position but changes its species and scale.
        dotSnapshot[q + 4] = this._inCottonwoodPreserve(x, z) ? -3 :
          (fp === null ? -2 : fp);
        dotSnapshot[q + 5] = h;
        dotSnapshot[q + 6] = worldWater(wi, h, 2,
          () => this._underWater(x, z, h, 2));
        dotSnapshot[q + 7] = road.dist;
        dotSnapshot[q + 8] = road.clear;
        dotSnapshot[q + 9] = this._inTreeClearing(x, z) ? 1 : worldBuilding(wi,
          () => this._nearBuilding(x, z, BLDG_PAD));
        if ((di & 7) === 7 && performance.now() - t0 >= sliceBudget) {
          di++;
          break;
        }
      }
      this._streamStats.snapshotSamples += di - prepared.dotSnapshotAt;
      prepared.dotSnapshotAt = di;
      if (di < dotN) return;

      const id = this._candidateNextId++;
      this._candidatePending.set(id, {
        key: c.k, generation: this._candidateGeneration, phase: 'instances',
      });
      this._candidateReady.delete(c.k);
      this._streamStats.snapshotCellsCompleted++;
      const buffers = {
        tree: prepared.tree.buffer, treeSpatial: prepared.treeSpatial.buffer,
        snapshot: snapshot.buffer, shrub: prepared.shrub.buffer,
        shrubSpatial: prepared.shrubSpatial.buffer,
        shrubSnapshot: shrubSnapshot.buffer,
        dotSnapshot: dotSnapshot.buffer,
      };
      this._candidateWorker.postMessage({
        id, kind: 'processTreeSnapshot', generation: this._candidateGeneration,
        payload: {
          ...buffers, band: c.band, coreMin: this._dotCoreMin || .55,
          hasDotData: !!this._dotByCell,
          bandDensity: [1, .55, .28][c.band],
          bandScale: [1, 1, .85][c.band],
          treelineY: this.treelineY, spireY0: this.spireY0, spireY1: this.spireY1,
          aspenMaxY: this.aspenMaxY, baseMeshM: this.baseMeshM,
          maxShrubs: this.maxShrubs, sageY0: this.sageY0, sageY1: this.sageY1,
          maxTrees: this.maxTrees,
        },
      }, Object.values(buffers));
    }

    _disableCandidateWorker() {
      this._candidateWorker?.terminate();
      this._candidateWorker = null;
      this._candidatePending.clear();
      for (const prepared of this._candidateReady.values())
        prepared.worldAbort?.abort();
      this._candidateReady.clear();
    }

    /* Amortize fills: build at most a small time budget of cells per frame (always ≥1 so the
       queue drains), nearest cells first. The deterministic seeded fill is unchanged, so a cell's
       content is identical regardless of which frame it is built on. Trees may pop in a frame or
       two late at the far edge when moving fast — imperceptible, and far better than a 37-58 ms
       spike. */
    _drainQueue() {
      const q = this._queue;
      if (!q || !q.length) return;
      const t0 = performance.now();
      let built = 0;
      while (q.length) {
        this._primeCandidateWorker();
        // Preserve view-priority: wait for the next visible cell's preparation instead of
        // skipping around it. If workers fail, _disableCandidateWorker restores synchronous RNG.
        if (this._candidateWorker && !this._candidateReady.has(q[q.length - 1].k)) break;
        const next = q[q.length - 1];
        const ready = this._candidateReady.get(next.k);
        if (this._candidateWorker && ready?.phase === 'randoms') {
          this._submitTreeSnapshot(next, ready);
          break;
        }
        if (this._candidateWorker && ready?.phase === 'worldSampling') break;
        if (this._candidateWorker && ready?.phase === 'sampling') {
          this._advanceTreeSnapshot(next, ready);
          break;
        }
        const c = q.pop();
        const old = this.cells.get(c.k);
        if (old && !c.replace) continue;
        if (c.replace && (!old || old.pendingBand !== c.band)) continue; // stale queued transition
        const fillStart = performance.now();
        const prepared = this._candidateReady.get(c.k);
        this._candidateReady.delete(c.k);
        const cell = { meshes: this._fillCell(c.cx, c.cz, c.band, prepared), band: c.band };
        const fillMs = performance.now() - fillStart;
        this._streamStats.cellsBuilt++;
        if (c.replace) this._streamStats.cellsReplaced++;
        this._streamStats.fillMs += fillMs;
        this._streamStats.worstFillMs = Math.max(this._streamStats.worstFillMs, fillMs);
        if (old) {
          old.dead = true;
          for (const m of old.meshes) {
            this.group.remove(m.mesh);
            this.pools.get(m.sp).push(m.mesh);
          }
        }
        this.cells.set(c.k, cell);
        this._detailDirty = true;
        // A replacement is already covered by the old LOD up to this atomic swap. Growing the new
        // matrices would reintroduce a coverage hole; only genuinely new edge cells fade in.
        if (!c.replace) this._beginFade(cell);
        built++;
        if (built >= 1 && performance.now() - t0 > this._fillBudgetMs) break;
      }
    }

    _publishStreamTelemetry() {
      const now = performance.now();
      if (now - (this._streamTelemetryAt || 0) < 500) return;
      this._streamTelemetryAt = now;
      const built = this._streamStats.cellsBuilt;
      const worldTotal = this._streamStats.worldIndexValues +
        this._streamStats.worldIndexFallbackValues;
      global.GT_VEGETATION_STREAMING = {
        quality: this._quality,
        radius: this.radius,
        maxTreesPerCell: this.maxTrees,
        residentCells: this.cells.size,
        queuedCells: this._queue?.length || 0,
        fadingCells: this._fading.length,
        detailTrees: global.__TREE_DETAIL_COUNT || 0,
        ...this._streamStats,
        averageFillMs: built ? this._streamStats.fillMs / built : 0,
        candidateWorker: !!this._candidateWorker,
        candidateJobs: this._candidatePending.size,
        candidateReadyCells: this._candidateReady.size,
        snapshotActiveCells: [...this._candidateReady.values()]
          .reduce((n, v) => n + (v.phase === 'sampling' ? 1 : 0), 0),
        snapshotProgressSamples: [...this._candidateReady.values()]
          .reduce((n, v) => n + (v.phase === 'sampling' ? v.snapshotAt : 0), 0),
        snapshotBudgetMs: this._snapshotBudgetMs,
        snapshotEffectiveBudgetMs: this.cells.size >= 4 ? this._snapshotBudgetMs :
          Math.max(this._snapshotBudgetMs, this.cells.size ? 2 : 4),
        worldIndexReady: !!(this._worldIndex?.ready && !this._worldIndex.failed),
        worldIndexGeneration: this._worldIndex?.generation ?? null,
        worldIndexAdoptionPercent: worldTotal
          ? 100 * this._streamStats.worldIndexValues / worldTotal : 0,
        farCanopyMode: this._legacyFarPatches ? 'patches' : 'shell',
        farCanopyCachedCells: this._farCache.size,
        farCanopyQueuedCells: this._farQueue?.length || 0,
        farCanopyPendingCells: this._farPending.size,
        farCanopy: { ...this._farStats },
        generation: this._candidateGeneration,
      };
    }

    /* FADE-IN: a freshly filled cell used to POP its whole forest in one frame — worst at the
       far rim, and a frame late under amortized fills. Instead each new cell GROWS: every
       instance matrix's basis columns (0..11 — rotation*scale; translation 12..14 untouched)
       are scaled 0 -> 1 over fadeMs, so trees rise around their own base points. Pure CPU on
       the already-uploaded matrices — no shader/material change, zero cost when idle. Retiring
       cells still pop OUT: they are out of range / band-changed behind the camera. */
    _beginFade(cell) {
      if (!this.fadeIn) return;
      cell.fading = true;
      const orig = cell.meshes.map(m => m.mesh.instanceMatrix.array.slice(0, m.mesh.count * 16));
      const f = { cell, orig, t0: performance.now() };
      this._fading.push(f);
      this._applyFade(f, 0.001);                 // present but sub-pixel on the fill frame
    }

    _applyFade(f, g) {
      for (let mi = 0; mi < f.cell.meshes.length; mi++) {
        const mesh = f.cell.meshes[mi].mesh, src = f.orig[mi], dst = mesh.instanceMatrix.array;
        for (let o = 0; o < src.length; o += 16)
          for (let c = 0; c < 12; c++) dst[o + c] = src[o + c] * g;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    _updateFades() {
      if (!this._fading.length) return;
      const now = performance.now();
      for (let i = this._fading.length - 1; i >= 0; i--) {
        const f = this._fading[i];
        if (f.cell.dead) { this._fading.splice(i, 1); continue; }    // pooled away mid-fade
        let t = (now - f.t0) / this.fadeMs;
        if (t >= 1) {
          this._applyFade(f, 1);
          f.cell.fading = false;
          this._detailDirty = true;
          this._fading.splice(i, 1);
          continue;
        }
        t = t * t * (3 - 2 * t);                                     // ease both ends
        this._applyFade(f, Math.max(t, 0.001));
      }
    }

    /* ---------------- far forest band (band 3) ---------------- */

    /* Recompute the wanted far-cell ring only every ~240 m of travel; per-cell patch lists are
       deterministic and cached, so a rebuild is mostly Float32 copies. Cache misses (fresh
       terrain) drain on the same time budget as near fills; new cells enter at ~5.5+ km where
       the dither fade holds them invisible, so a few frames of latency cannot pop. */
    _updateFar(camPos) {
      const a = this._farAnchor;
      if (!a || (camPos.x - a.x) * (camPos.x - a.x) + (camPos.z - a.z) * (camPos.z - a.z) > 240 * 240) {
        this._farGeneration++;
        for (const pending of this._farPending.values()) {
          pending.controller.abort();
          this._farStats.cancelled++;
        }
        this._farPending.clear();
        this._farAnchor = { x: camPos.x, z: camPos.z };
        const cs = FAR.cell, nr = Math.ceil(this._farRadius / cs);
        const icx = Math.floor(camPos.x / cs), icz = Math.floor(camPos.z / cs);
        const want = [];
        for (let dz = -nr; dz <= nr; dz++) for (let dx = -nr; dx <= nr; dx++) {
          const cx = icx + dx, cz = icz + dz;
          const d = Math.hypot((cx + 0.5) * cs - camPos.x, (cz + 0.5) * cs - camPos.z);
          if (d > this._farRadius + cs * 0.71 || d < FAR.inner - cs * 0.71) continue;
          want.push(cx + ',' + cz);
        }
        // Drain the inner overlap first. Array#pop consumes the end, so retain far-to-near
        // ordering here. This makes an incomplete initial shell grow radially out through its
        // distance fade instead of sweeping across the landscape from an arbitrary grid edge.
        want.sort((a, b) => {
          const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number);
          const ad = Math.hypot((ax + .5) * cs - camPos.x, (az + .5) * cs - camPos.z);
          const bd = Math.hypot((bx + .5) * cs - camPos.x, (bz + .5) * cs - camPos.z);
          return bd - ad;
        });
        this._farWant = want;
        const keep = new Set(want);
        for (const k of this._farCache.keys()) if (!keep.has(k)) this._farCache.delete(k);
        this._farQueue = want.filter(k => !this._farCache.has(k));
        this._farBuiltSinceRepack = 0;
        this._farDirty = true;
      }
      const fq = this._farQueue;
      if (fq && fq.length) {
        const worldCanopy = !this._legacyFarPatches && this._worldIndex?.ready &&
          !this._worldIndex.failed && typeof this._worldIndex.sampleCanopyShell === 'function';
        if (worldCanopy) {
          while (fq.length && this._farPending.size < 2) {
            const k = fq.pop();
            const [cx, cz] = k.split(',').map(Number);
            this._requestFarShellCell(k, cx, cz);
          }
          // Do not hold a usable shell hostage to the complete 6 km ring. Publishing in bounded
          // batches gives fast first paint while avoiding a geometry upload for every cell.
          if (this._farDirty && this._farCache.size >= 16 &&
              (this._farBuiltSinceRepack >= 12 ||
               performance.now() - this._farLastRepackAt >= 750)) this._repackFar();
          return;
        }
        const t0 = performance.now();
        while (fq.length) {
          const k = fq.pop();
          const [cx, cz] = k.split(',').map(Number);
          const buildStart = performance.now();
          this._farCache.set(k, this._buildFarCell(cx, cz));
          const buildMs = performance.now() - buildStart;
          this._farStats.cellsBuilt++;
          if (!this._legacyFarPatches) this._farStats.fallbackCells++;
          this._farStats.buildMs += buildMs;
          this._farStats.worstBuildMs = Math.max(this._farStats.worstBuildMs, buildMs);
          if (performance.now() - t0 > this._fillBudgetMs) break;
        }
        this._farDirty = true;
        if (fq.length) return;                   // repack once, when the set is complete
      }
      if (!this._farPending.size && this._farDirty) this._repackFar();
    }

    _requestFarShellCell(key, cx, cz) {
      const step = FAR.shellStep, n = Math.round(FAR.cell / step);
      const points = new Float64Array(((n + 1) * (n + 1) + n * n) * 2);
      let p = 0;
      for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
        points[p++] = cx * FAR.cell + ix * step;
        points[p++] = cz * FAR.cell + iz * step;
      }
      for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
        points[p++] = cx * FAR.cell + (ix + .5) * step;
        points[p++] = cz * FAR.cell + (iz + .5) * step;
      }
      const controller = new AbortController();
      const generation = this._farGeneration, indexGeneration = this._worldIndex.generation;
      const started = performance.now();
      this._farPending.set(key, { controller, generation });
      this._worldIndex.sampleCanopyShell(points, { signal: controller.signal }).then(samples => {
        if (generation !== this._farGeneration ||
            indexGeneration !== this._worldIndex.generation ||
            !this._farPending.has(key)) return;
        this._farPending.delete(key);
        this._farCache.set(key, this._buildFarShellCell(cx, cz, samples));
        this._farBuiltSinceRepack++;
        const elapsed = performance.now() - started;
        this._farStats.cellsBuilt++;
        this._farStats.workerCells++;
        this._farStats.buildMs += elapsed;
        this._farStats.worstBuildMs = Math.max(this._farStats.worstBuildMs, elapsed);
        this._farDirty = true;
      }).catch(error => {
        const pending = this._farPending.get(key);
        if (pending?.generation === generation) this._farPending.delete(key);
        if (error?.name === 'AbortError' || generation !== this._farGeneration) return;
        // Exact local fallback keeps the shell available after a recoverable index failure.
        const fallbackStart = performance.now();
        this._farCache.set(key, this._buildFarShellCell(cx, cz));
        this._farBuiltSinceRepack++;
        const fallbackMs = performance.now() - fallbackStart;
        this._farStats.cellsBuilt++;
        this._farStats.fallbackCells++;
        this._farStats.buildMs += fallbackMs;
        this._farStats.worstBuildMs = Math.max(this._farStats.worstBuildMs, fallbackMs);
        this._farDirty = true;
      });
    }

    /* Deterministic stand candidates on world-anchored microcells. Five forest samples distinguish
       closed interiors from mixed edges: dense interiors keep coherent clumps, while partial
       microcells thin probabilistically and preserve meadow fingers/clearings. This avoids both
       the old independent random rows and the canopy shell's continuous raised carpet. */
    _buildFarCell(cx, cz) {
      if (!this._legacyFarPatches) return this._buildFarShellCell(cx, cz);
      if (this._farRows) return this._buildFarRowCell(cx, cz);
      const rng = mulberry32(((cx * 2246822519) ^ (cz * 3266489917) ^ 0xF04E57) >>> 0);
      const S = FAR.cell, x0 = cx * S, z0 = cz * S, out = [];
      const M = FAR.micro, n = Math.round(S / M), probe = M * .28;
      const forestAt = (x, z) => {
        const fp = this.fmask ? this.fmask.probAt(x, z) : null;
        if (fp !== null) return fp;
        const cov = this.veg ? this.veg.coverAt(x, z)
                             : (TREE_DENSITY[this.lc.classAt(x, z)] || 0) * 100;
        return Math.max(0, Math.min(1, cov / 100));
      };
      for (let mz = 0; mz < n; mz++) for (let mx = 0; mx < n; mx++) {
        const rs = rng(), rr = rng(), ry = rng(), rc = rng(), keep = rng();
        // Jitter stays well inside its microcell, so neighbouring stands remain separated and a
        // camera-ring rebuild can never reshuffle which side of a cell owns a clump.
        const x = x0 + (mx + .5) * M + (rng() - .5) * M * .28;
        const z = z0 + (mz + .5) * M + (rng() - .5) * M * .28;
        const centre = forestAt(x, z);
        const neighbourhood = (forestAt(x - probe, z) + forestAt(x + probe, z) +
          forestAt(x, z - probe) + forestAt(x, z + probe)) * .25;
        const strength = centre * .68 + neighbourhood * .32;
        if (strength < FAR.maskMin || keep > sstep(FAR.maskMin, .72, strength)) continue;
        const h = this.terrain.heightAt(x, z);
        if (this._underWater(x, z, h, 2.0)) continue;   // authoritative wet field (2 m tree margin)
        if (h > this.treelineY - 120) continue;
        // Interior stands are broader/taller; edge stands shrink rather than bridging the gap.
        const s = (.68 + strength * .48) * (.90 + rs * .18);
        this._dummy.position.set(x, h - FAR.sink, z);
        this._dummy.scale.set(s, s * (0.90 + ry * 0.20), s);
        this._dummy.rotation.set(0, rr * Math.PI * 2, 0);
        this._dummy.updateMatrix();
        out.push({ m: new Float32Array(this._dummy.matrix.elements),
          c: 0.88 + strength * .12 + rc * .10 });
      }
      return out;
    }

    _buildFarRowCell(cx, cz) {
      const rng = mulberry32(((cx * 2246822519) ^ (cz * 3266489917) ^ 0xF04E57) >>> 0);
      const S = FAR.cell, x0 = cx * S, z0 = cz * S, out = [];
      for (let i = 0; i < FAR.rowCand; i++) {
        const x = x0 + rng() * S, z = z0 + rng() * S;
        const rs = rng(), rr = rng(), ry = rng(), rc = rng();
        const fp = this.fmask ? this.fmask.probAt(x, z) : null;
        if (fp !== null) { if (fp < .42) continue; }
        else {
          const cov = this.veg ? this.veg.coverAt(x, z)
            : (TREE_DENSITY[this.lc.classAt(x, z)] || 0) * 100;
          if (cov < FAR.coverMin) continue;
        }
        const h = this.terrain.heightAt(x, z);
        if (this._underWater(x, z, h, 2) || h > this.treelineY - 120) continue;
        const s = .85 + rs * .5;
        this._dummy.position.set(x, h - FAR.sink, z);
        this._dummy.scale.set(s, s * (.85 + ry * .3), s);
        this._dummy.rotation.set(0, rr * Math.PI * 2, 0);
        this._dummy.updateMatrix();
        out.push({ m: new Float32Array(this._dummy.matrix.elements), c: .92 + rc * .24 });
      }
      return out;
    }

    /* Terrain-conforming canopy top. Every sample lies on a world-anchored 64 m lattice, so
       neighbouring cells share identical edge positions/heights and camera movement cannot
       reshuffle the silhouette. Forest probability owns the footprint where available; measured
       canopy cover is the fallback. A noisy threshold and the elevation fade make the perimeter
       ragged without discrete clumps. */
    _buildFarShellCell(cx, cz, samples = null) {
      const step = FAR.shellStep, S = FAR.cell, n = Math.round(S / step);
      const x0 = cx * S, z0 = cz * S;
      const vertexCount = (n + 1) * (n + 1);
      const heights = new Float64Array((n + 1) * (n + 1));
      const tones = new Float32Array(heights.length);
      const at = (ix, iz) => iz * (n + 1) + ix;
      for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
        const x = x0 + ix * step, z = z0 + iz * step;
        const sampleAt = at(ix, iz);
        const ground = Number.isFinite(samples?.terrainHeight[sampleAt])
          ? samples.terrainHeight[sampleAt] : this.terrain.heightAt(x, z);
        const evh = Number.isFinite(samples?.vegetation[sampleAt * 2])
          ? samples.vegetation[sampleAt * 2] : (this.veg ? this.veg.heightAt(x, z) : -1);
        const evc = Number.isFinite(samples?.vegetation[sampleAt * 2 + 1])
          ? samples.vegetation[sampleAt * 2 + 1] : (this.veg ? this.veg.coverAt(x, z) : -1);
        const crown = evh > 0 ? Math.max(4, Math.min(24, evh)) :
          Math.max(5, Math.min(17, 8 + Math.max(0, evc) * .08));
        const variation = (vhash(Math.floor(x / step), Math.floor(z / step)) - .5) * 2.4;
        heights[at(ix, iz)] = ground + crown * .68 + variation;
        tones[at(ix, iz)] = .84 + vhash(Math.floor(x / 31), Math.floor(z / 31)) * .22;
      }
      const pos = [], col = [];
      const push = (ix, iz) => {
        const o = at(ix, iz), t = tones[o];
        pos.push(x0 + ix * step, heights[o], z0 + iz * step);
        col.push(t * .84, t, t * .78);
      };
      for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
        const x = x0 + (ix + .5) * step, z = z0 + (iz + .5) * step;
        const sampleAt = vertexCount + iz * n + ix;
        const ground = Number.isFinite(samples?.terrainHeight[sampleAt])
          ? samples.terrainHeight[sampleAt] : this.terrain.heightAt(x, z);
        const sampledFp = samples?.forestProbability[sampleAt];
        const fp = Number.isFinite(sampledFp) ? sampledFp :
          (this.fmask ? this.fmask.probAt(x, z) : null);
        const sampledCover = samples?.vegetation[sampleAt * 2 + 1];
        const cover = Number.isFinite(sampledCover) ? sampledCover :
          (this.veg ? this.veg.coverAt(x, z) :
            (TREE_DENSITY[this.lc.classAt(x, z)] || 0) * 100);
        const forest = fp === null ? Math.max(0, cover) / 100 : fp;
        const ragged = (vhash(Math.floor(x / step), Math.floor(z / step)) - .5) * .18;
        const treelineFade = 1 - sstep(this.treelineY - 220, this.treelineY - 45, ground);
        if (forest * treelineFade < FAR.shellMaskMin + ragged) continue;
        if (this._underWater(x, z, ground, 2)) continue;
        // Alternate the diagonal on the world lattice to avoid long directional creases.
        if (((cx * n + ix) ^ (cz * n + iz)) & 1) {
          push(ix, iz); push(ix + 1, iz); push(ix, iz + 1);
          push(ix + 1, iz); push(ix + 1, iz + 1); push(ix, iz + 1);
        } else {
          push(ix, iz); push(ix + 1, iz); push(ix + 1, iz + 1);
          push(ix, iz); push(ix + 1, iz + 1); push(ix, iz + 1);
        }
      }
      return { positions: Float32Array.from(pos), colors: Float32Array.from(col) };
    }

    _repackFar() {
      this._farDirty = false;
      this._farBuiltSinceRepack = 0;
      this._farLastRepackAt = performance.now();
      if (!this._legacyFarPatches) {
        let vertexCount = 0;
        for (const k of this._farWant) vertexCount +=
          (this._farCache.get(k)?.positions.length || 0) / 3;
        const positions = new Float32Array(vertexCount * 3);
        const colors = new Float32Array(vertexCount * 3);
        let at = 0;
        for (const k of this._farWant) {
          const cell = this._farCache.get(k);
          if (!cell) continue;
          positions.set(cell.positions, at * 3);
          colors.set(cell.colors, at * 3);
          at += cell.positions.length / 3;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const normals = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) normals[i * 3 + 1] = 1;
        // A shared upward normal makes the coarse lattice read as one soft canopy, not terrain
        // facets. Terrain heights still determine the silhouette and occlusion.
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        this._farMesh.geometry.dispose();
        this._farMesh.geometry = geometry;
        this._farStats.rebuilds++;
        this._farStats.vertices = vertexCount;
        this._farStats.triangles = vertexCount / 3;
        return;
      }
      const mesh = this._farMesh, arr = mesh.instanceMatrix.array;
      let n = 0;
      for (const k of this._farWant) {
        const list = this._farCache.get(k);
        if (!list) continue;
        for (const p of list) {
          if (n >= FAR.cap) break;
          arr.set(p.m, n * 16);
          this._col.setRGB(p.c, p.c * 1.04, p.c * 0.98);   // faint green lift, distance-forest tone
          mesh.setColorAt(n, this._col);
          n++;
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this._farStats.rebuilds++;
      this._farStats.vertices = n * mesh.geometry.attributes.position.count;
      this._farStats.triangles = n * mesh.geometry.index.count / 3;
    }

    /* Reusable packed staging for one cell fill: _fillCell runs to completion synchronously and
       the contents are copied into the InstancedMesh before it returns, so one buffer per species
       for the whole app is enough. Sized to the same cap _acquire allocates; maxTrees can be
       raised once by the baked-point metadata (see meta.cellCap), hence the grow check. */
    _putBuffer(sp) {
      const want = sp === 'sage' ? this.maxShrubs : this.maxTrees;
      const buffers = this._putBuffers || (this._putBuffers = new Map());
      let rec = buffers.get(sp);
      if (!rec || rec.cap < want) {
        rec = { cap: want, n: 0, mats: new Float32Array(want * 16),
                cols: new Float32Array(want * 3), uvs: new Float32Array(want) };
        buffers.set(sp, rec);
      }
      return rec;
    }

    _acquire(sp) {
      let pool = this.pools.get(sp);
      if (!pool) { pool = []; this.pools.set(sp, pool); }
      if (pool.length) return pool.pop();
      const cap = sp === 'sage' ? this.maxShrubs : this.maxTrees;
      let geo, mat;
      if (sp === 'bb' || PHOTO[sp]) {
        // photo species need a per-INSTANCE atlas-column offset, and instanced attributes live
        // on the geometry — so each pooled mesh wraps the shared base attributes in its own
        // BufferGeometry and adds its own aUvOff buffer. Base arrays are not duplicated.
        const base = sp === 'bb' ? this.bbGeo : this.flora[sp];
        geo = new THREE.BufferGeometry();
        for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
        geo.setIndex(base.index);
        geo.setAttribute('aUvOff', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
        mat = this.photoMat;
      } else {
        // wrap the shared base geometry so each pooled mesh owns its own boundingSphere (below)
        const base = this.flora[sp];
        geo = new THREE.BufferGeometry();
        for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
        geo.setIndex(base.index);
        mat = this.material;
      }
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      // r184 frustum-tests InstancedMesh.boundingSphere (and computes it from every instance when
      // null). Instances contain absolute world translations, so keep the geometry's bounds LOCAL
      // and install one explicit world-space cell sphere on the InstancedMesh in _fillCell.
      // Putting the cell centre on geometry.boundingSphere, as the r128 path did, makes r184 apply
      // every instance translation to that already-world-space centre a second time. Cells then
      // appear/disappear when the camera rotates.
      mesh.frustumCulled = true;
      // Instances hold absolute world translations, so the mesh transform is identity for life.
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      geo.computeBoundingSphere();
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      return mesh;
    }

    _fillCell(cx, cz, band, prepared) {
      const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x9E3779B9);
      let treeRandomAt = 0;
      const nextTreeRandom = prepared?.tree
        ? () => prepared.tree[treeRandomAt++]
        : rng;
      const S = this.cellSize, x0 = cx * S, z0 = cz * S;
      const bandDensity = [1.0, 0.55, 0.28][band];
      const bandScale = [1.0, 1.0, 0.85][band];
      // species -> reusable packed scratch (see _putBuffer). The previous shape pushed a CLONED
      // Matrix4 per plant, i.e. up to maxTrees + maxShrubs = 1200 fresh objects for every cell
      // fill, and cells fill continuously while you move. The bytes written into instanceMatrix
      // are identical: both paths round the same float64 elements to float32 once.
      const put = new Map();
      const add = (sp, r, g, b, uv) => {
        let rec = put.get(sp);
        if (!rec) { rec = this._putBuffer(sp); rec.n = 0; put.set(sp, rec); }
        const i = rec.n++;
        if (i >= rec.cap) return;                // over-capacity cells are clamped + warned below
        rec.mats.set(this._dummy.matrix.elements, i * 16);
        rec.cols[i * 3] = r; rec.cols[i * 3 + 1] = g; rec.cols[i * 3 + 2] = b;
        rec.uvs[i] = uv || 0;
      };
      let yLo = Infinity, yHi = -Infinity;         // vertical extent for the per-cell cull sphere

      /* —— trees —— HYBRID: edge/scattered trees are placed AT the detected imagery dots (this cell's
         baked point bucket); the dense closed-canopy core (forest-mask fp >= coreMin) is left to the
         procedural scatter below. Each side only fills its own fp-zone, so no double-placement and no
         gap. If no point set loaded, coreMin is unused and the procedural path runs everywhere. */
      let trees = 0;
      const coreMin = this._dotCoreMin || 0.55;
      const dotIdx = this._dotByCell && this._dotByCell.get(this._dotKey(cx, cz));
      if (prepared?.dotInstances) {
        const species = ['conifer', 'spire', 'aspen', 'cottonwood', 'snag', 'bb'];
        const a = prepared.dotInstances;
        for (let o = 0; o < a.length && trees < this.maxTrees; o += 12) {
          const x = a[o], z = a[o + 1], h = a[o + 2], sp = species[a[o + 3]];
          const s = a[o + 4], yb = h - .3 - .35 * s;
          if (yb < yLo) yLo = yb;
          if (h + 20 * s > yHi) yHi = h + 20 * s;
          this._dummy.position.set(x, yb, z);
          this._dummy.scale.set(s, a[o + 5], s);
          this._dummy.rotation.set(0, a[o + 6], a[o + 7]);
          this._dummy.updateMatrix();
          add(sp, a[o + 8], a[o + 9], a[o + 10], a[o + 11]);
          trees++;
        }
      } else if (dotIdx) {
        for (let k = 0; k < dotIdx.length && trees < this.maxTrees; k++) {
          const pi = dotIdx[k], px = this._dotX[pi], pz = this._dotZ[pi], str = this._dotS[pi] / 255;
          // gentler far thinning than the procedural bandDensity: the dots ARE the forest now, so
          // keep more of them at distance or dense canopy reads as sparse over the (bright) imagery.
          const pKeep = band === 0 ? 1.0 : band === 1 ? 0.82 : 0.64;
          if (band > 0 && ((pi * 2654435761) >>> 0) % 1024 >= pKeep * 1024) continue;
          const fp = this.fmask ? this.fmask.probAt(px, pz) : null;
          if (fp !== null && fp >= coreMin) continue;     // dense core -> procedural handles it (edge mode only; FULL: coreMin>1)
          const h = this.terrain.heightAt(px, pz);
          if (this._underWater(px, pz, h, 2.0)) continue;
          const rdq = global.roadQuery ? global.roadQuery(px, pz) : null;
          if (rdq && rdq.dist < (ROAD_CLEAR[rdq.class] || 0) + TREE_ROAD_M) continue;
          if (this._inTreeClearing(px, pz) || this._nearBuilding(px, pz, BLDG_PAD)) continue;
          const prng = mulberry32(((Math.round(px * 8) * 73856093) ^ (Math.round(pz * 8) * 19349663) ^ 0xD07) >>> 0);
          const rr = prng(), ry = prng(), rb = prng(), rc = prng(), rw = prng(), rq = prng();
          const preserve = this._inCottonwoodPreserve(px, pz);
          let sp = preserve ? 'cottonwood' :
            (rb < sstep(this.spireY0, this.spireY1, h) ? 'spire' : 'conifer');
          const vs = VARIANTS[sp], col = vs[(rc * vs.length) | 0];
          let s = (preserve ? 0.46 + str * 0.20 : 1.05 + str * 0.9) * bandScale;
          let tilt = (ry - 0.5) * 0.09;
          if (band > 0) { sp = 'bb'; tilt = 0; }          // far bands: one merged billboard species
          const yb = h - 0.3 - 0.35 * s;
          if (yb < yLo) yLo = yb;
          if (h + 20 * s > yHi) yHi = h + 20 * s;
          this._dummy.position.set(px, yb, pz);
          this._dummy.scale.set(s, s * (0.85 + ry * 0.4), s);
          this._dummy.rotation.set(0, rr * Math.PI * 2, tilt);
          this._dummy.updateMatrix();
          const t = 0.93 + rw * 0.14;
          add(sp, t * (0.97 + rq * 0.06), t, t * (0.95 + rq * 0.08), col * CELL_U);
          trees++;
        }
      }
      if (!this._dotFull && prepared?.instances) {
        const species = ['conifer', 'spire', 'aspen', 'cottonwood', 'snag', 'bb'];
        const a = prepared.instances;
        for (let o = 0; o < a.length && trees < this.maxTrees; o += 12) {
          const x = a[o], z = a[o + 1], h = a[o + 2], sp = species[a[o + 3]];
          const s = a[o + 4], yb = h - 0.3 - 0.35 * s;
          if (yb < yLo) yLo = yb;
          if (h + 20 * s > yHi) yHi = h + 20 * s;
          this._dummy.position.set(x, yb, z);
          this._dummy.scale.set(s, a[o + 5], s);
          this._dummy.rotation.set(0, a[o + 6], a[o + 7]);
          this._dummy.updateMatrix();
          add(sp, a[o + 8], a[o + 9], a[o + 10], a[o + 11]);
          trees++;
        }
      }
      for (let i = 0; !this._dotFull && !prepared?.instances &&
           i < this.treeCandidates && trees < this.maxTrees; i++) {
        // procedural scatter — runs for the dense CORE in edge mode, or everywhere with no point set.
        // FULL mode (_dotFull) turns it off completely: the baked dots own every tree.
        // fixed number of draws per candidate: the sequence is band-independent, so a cell's
        // band-0 forest is a strict superset of its band-1/2 forest — trees never teleport
        const rx = nextTreeRandom(), rz = nextTreeRandom(), rd = nextTreeRandom(),
              rs = nextTreeRandom(), ry = nextTreeRandom(), rr = nextTreeRandom(),
              rp = nextTreeRandom(), rt = nextTreeRandom(), ru = nextTreeRandom(),
              rv = nextTreeRandom(), rw = nextTreeRandom(), rq = nextTreeRandom(),
              rb = nextTreeRandom();
        // band thinning via a stable per-candidate hash
        if (((i * 2654435761) >>> 0) % 1024 >= bandDensity * 1024) continue;
        const so = i * 5;
        const x = prepared?.treeSpatial ? prepared.treeSpatial[so] : x0 + rx * S;
        const z = prepared?.treeSpatial ? prepared.treeSpatial[so + 1] : z0 + rz * S;
        const preserve = this._inCottonwoodPreserve(x, z);
        const cls = preserve ? 190 : this.lc.classAt(x, z);
        let d = TREE_DENSITY[cls] || 0;
        if (!d) continue;
        // measured LANDFIRE vegetation (metres / percent), or -1 where absent/out-of-bounds
        const evh = this.veg ? this.veg.heightAt(x, z) : -1;
        const evc = this.veg ? this.veg.coverAt(x, z) : -1;
        const h = this.terrain.heightAt(x, z);
        // treeline emerges from the DATA, but ONLY up in the treeline zone: at 30 m a single
        // sub-shrub pixel over a valley-floor pond/meadow would otherwise wipe a whole real grove,
        // so measured sub-shrub only suppresses trees near the elevation treeline (its intent).
        // Down in the valleys, landcover + measured cover drive the forest. (No rng consumed ->
        // seeded sequence unchanged; the elevation fade below stays as the backstop.)
        if (evh >= 0 && evh < 3 && h > this.treelineY - 450) continue;
        // stands & glades: real forest is clumped, not white noise
        if (d > 0.2) d *= 0.15 + 0.85 * sstep(0.30, 0.62,
          prepared?.treeSpatial ? prepared.treeSpatial[so + 2] : clumpNoise(x, z));
        // flats (stray trees on sage/grassland): at these densities the ~90 m octave alone
        // reads as even white noise from the air — a second, broader (~260 m) octave gathers
        // the strays into loose groves with real gaps between them
        else if (d > 0) d *= 0.06 + 2.1 * sstep(0.38, 0.80,
          prepared?.treeSpatial ? prepared.treeSpatial[so + 3] :
            clumpNoise(x * 0.35 + 57.3, z * 0.35 - 113.7));
        // density follows measured canopy cover: full where cover is high, thinning where it's low
        if (evc >= 0) d *= Math.max(0.2, Math.min(1.15, evc / 55));
        // NAIP forest mask: trees ALIGN with the imagery woodland — full where the aerial photo is
        // dark green forest, thinning hard where it isn't (kills stray spikes on bare/sage slopes
        // and the ragged over-the-treeline dots). Null (outside the baked band) -> no change.
        if (this.fmask) {
          const fp = preserve ? 1 : this.fmask.probAt(x, z);
          if (fp !== null) {
            if (this._dotByCell && fp < coreMin) continue;   // edge zone is dot-placed above; core stays procedural
            d *= sstep(0.12, 0.50, fp);
          }
        }
        if (rd > d) continue;
        if (this._underWater(x, z, h, 2.0)) continue;   // authoritative wet field (2 m tree margin)
        const tl = 1 - sstep(this.treelineY - 150, this.treelineY, h);   // treeline fade
        if (tl <= 0 || rv > tl) continue;
        // slope rejection: trees don't grow on cliffs
        const sx = (this.terrain.heightAt(x + 8, z) - h) / 8;
        const sz = (this.terrain.heightAt(x, z + 8) - h) / 8;
        if (sx * sx + sz * sz > 0.55) continue;

        // —— species ——
        let sp = 'conifer';
        if (cls === 41) sp = rp < 0.80 ? 'aspen' : 'conifer';
        else if (cls === 43) sp = rp < 0.45 ? 'aspen' : 'conifer';
        else if (cls === 90) sp = rp < 0.50 ? 'cottonwood' : (rp < 0.82 ? 'spire' : 'aspen');
        else if (cls === 190) sp = 'cottonwood';
        if (sp === 'conifer') {
          if (rt < sstep(this.spireY0, this.spireY1, h)) sp = 'spire';   // firs take the high ground
          else if (rt > 0.968 && (cls === 42 || cls === 43)) sp = 'snag'; // deadfall inside forest only
        }
        if (sp === 'aspen') {
          if (h > this.aspenMaxY) sp = 'spire';
          else if ((prepared?.treeSpatial ? prepared.treeSpatial[so + 4] :
                    clumpNoise(x + 1731, z - 917)) < 0.42) sp = 'conifer'; // aspens grow in tight clonal groves
        }
        // atlas variant column — same rb near and far, so a tree keeps its texture across bands
        const vs = VARIANTS[sp];
        // Prefer the full lodgepole crown while retaining open/irregular variants. The old
        // equal thirds overrepresented sparse grey silhouettes and made healthy stands look dead.
        const col = sp === 'conifer' ? (rb < 0.52 ? 0 : rb < 0.82 ? 1 : 2) :
          (vs ? vs[(rb * vs.length) | 0] : 0);

        // —— scale / pose / tint ——
        const krum = lerp(1, 0.55, sstep(this.treelineY - 260, this.treelineY - 30, h)); // krummholz
        // scale follows measured EVH: map metres to the base-mesh silhouette (clamped 0.5..2.0),
        // with a small seeded variation; fall back to the procedural size where data is absent.
        let base = 0.72 + rs * 0.85;
        if (evh > 0) base = Math.max(0.5, Math.min(2.0, evh / this.baseMeshM)) * (0.85 + rs * 0.30);
        let s0 = base * krum;                      // band-FREE scale, used for exclusion tests
        if (sp === 'aspen') s0 *= 0.72;
        if (sp === 'cottonwood') s0 *= 1.30;       // wide crown fills ~half its cell height
        if (cls === 190) s0 *= 0.62;               // modest ranch-yard cottonwoods, not a screen
        if (cls === 52 || cls === 71) s0 *= 0.55;  // stray trees on the open flats stay modest
        // —— exclusion: roads (class-aware clearance) + buildings ——
        // uses s0, not the banded scale, so far cells stay strict subsets of near cells and a
        // tree can never appear or vanish when its cell flips band
        const rdq = global.roadQuery ? global.roadQuery(x, z) : null;
        if (rdq && rdq.dist < (ROAD_CLEAR[rdq.class] || 0) + TREE_ROAD_M +
            TREE_ROAD_BIG * Math.min(1, Math.max(0, (s0 - 0.9) * 2))) continue;
        if (this._inTreeClearing(x, z) || this._nearBuilding(x, z, BLDG_PAD)) continue;
        const s = s0 * bandScale;
        let tilt = (ru - 0.5) * 0.09;
        if (band > 0) {                            // far bands: ONE merged billboard mesh per cell
          if (sp === 'snag') continue;             // invisible at that range anyway
          sp = 'bb';
          tilt = 0;                                // leaning sprites read as glitches
        }
        const yb = h - 0.3 - 0.35 * s;                        // sunk in — no floating trunks
        if (yb < yLo) yLo = yb;
        if (h + 20 * s > yHi) yHi = h + 20 * s;               // generous crown top (CARD_H·scale)
        this._dummy.position.set(x, yb, z);
        // Deterministic crown-width variation breaks the repeated pencil-tree profile.
        // Column 0 is the full spruce/lodgepole; the high-altitude spire remains appropriately narrow.
        const crownW = col === 0 ? 1.10 : col === 1 ? 0.98 : col === 2 ? 0.91 :
          col === 3 ? 0.78 : 1.0;
        this._dummy.scale.set(s * crownW, s * (0.85 + ry * 0.4), s * crownW);
        this._dummy.rotation.set(0, rr * Math.PI * 2, tilt);
        this._dummy.updateMatrix();
        // photo textures carry their own color: keep the per-instance tint jitter subtle
        const t = 0.93 + rw * 0.14;
        add(sp, t * (0.97 + rq * 0.06), t, t * (0.95 + rq * 0.08), col * CELL_U);
        trees++;
      }

      /* —— sagebrush understory (near band only; sub-pixel beyond ~1 km) —— */
      if (band === 0) {
        if (prepared?.shrubInstances) {
          const a = prepared.shrubInstances;
          for (let o = 0; o < a.length; o += 9) {
            const x = a[o], z = a[o + 1], h = a[o + 2], s = a[o + 3];
            if (h - .05 < yLo) yLo = h - .05;
            if (h + 2 * s > yHi) yHi = h + 2 * s;
            this._dummy.position.set(x, h - .05, z);
            this._dummy.scale.set(s, a[o + 4], s);
            this._dummy.rotation.set(0, a[o + 5], 0);
            this._dummy.updateMatrix();
            add('sage', a[o + 6], a[o + 7], a[o + 8]);
          }
        } else {
        const srng = mulberry32(((cx * 83492791) ^ (cz * 297121507) ^ 0x51AB1E) >>> 0);
        let shrubRandomAt = 0;
        const nextShrubRandom = prepared?.shrub
          ? () => prepared.shrub[shrubRandomAt++]
          : srng;
        let shrubs = 0;
        for (let i = 0; i < this.shrubCandidates && shrubs < this.maxShrubs; i++) {
          const rx = nextShrubRandom(), rz = nextShrubRandom(), rd = nextShrubRandom(),
                rs = nextShrubRandom(), rr = nextShrubRandom(), rw = nextShrubRandom(),
                rq = nextShrubRandom(), rh = nextShrubRandom();
          const so = i * 2;
          const x = prepared?.shrubSpatial ? prepared.shrubSpatial[so] : x0 + rx * S;
          const z = prepared?.shrubSpatial ? prepared.shrubSpatial[so + 1] : z0 + rz * S;
          const sd = SHRUB_DENSITY[this.lc.classAt(x, z)] || 0;
          if (!sd || rd > sd) continue;
          const h = this.terrain.heightAt(x, z);
          if (this._underWater(x, z, h, 0)) continue;   // authoritative wet field (no tuft on water)
          // sage stops at the shoulder edge; never inside a building footprint + 2 m
          const rdq = global.roadQuery ? global.roadQuery(x, z) : null;
          // Low shrubs should press close to a foot tread as they do on the Jenny/Cascade
          // references. Keep the wider clearance for trunks and every vehicle corridor.
          const shrubRoadClear=rdq&&rdq.class==='trail'?.9:(rdq?(ROAD_CLEAR[rdq.class]||0):0);
          if (rdq && rdq.dist < shrubRoadClear + SHRUB_ROAD_M) continue;
          if (this._nearBuilding(x, z, BLDG_PAD)) continue;
          if (rh > 1 - sstep(this.sageY0, this.sageY1, h)) continue;     // sage gives out up high
          const s = 0.5 + rs * 0.55;               // visible but never boulder-sized
          if (h - 0.05 < yLo) yLo = h - 0.05;
          if (h + 2 * s > yHi) yHi = h + 2 * s;
          this._dummy.position.set(x, h - 0.05, z);
          this._dummy.scale.set(s, s * (0.8 + rw * 0.4), s);
          this._dummy.rotation.set(0, rr * Math.PI * 2, 0);
          this._dummy.updateMatrix();
          const t = 0.75 + rw * 0.5;
          if (rq > 0.88) add('sage', t * 1.08, t, t * 0.55); // rabbitbrush
          else add('sage', t * (0.94 + rq * 0.12), t, t * (0.9 + rq * 0.15));
          shrubs++;
        }
        }
      }

      /* per-cell cull sphere: centre at the cell's XZ centre + measured mid-height, radius to the
         farthest padded corner (pad covers card half-width & tilt). Shared by every species mesh
         in the cell — safe because each mesh has its own geometry (see _acquire). */
      const half = S / 2 + 12;
      const cyw = isFinite(yLo) ? (yLo + yHi) / 2 : 0;
      const hy = isFinite(yLo) ? (yHi - yLo) / 2 : 1;
      const sphC = new THREE.Vector3(x0 + S / 2, cyw, z0 + S / 2);
      const sphR = Math.sqrt(2 * half * half + hy * hy);

      /* —— one InstancedMesh per species actually present (all far billboards are ONE species) —— */
      const meshes = [];
      for (const [sp, rec] of put) {
        const mesh = this._acquire(sp);
        mesh.boundingSphere.center.copy(sphC);
        mesh.boundingSphere.radius = sphR;
        // CLAMP to the mesh's allocated instance capacity. rec.mats can exceed cap in an unusually
        // dense cell; setting mesh.count past the instanceMatrix/aUvOff length made the draw request
        // more instances than the buffers hold → glDrawElementsInstanced "vertex buffer not big
        // enough", spammed every frame, degrading the whole GL context (it was blanking the water
        // reflection's render target). Dropping a few excess instances in a dense cell is invisible.
        const cap = mesh.instanceMatrix.count;          // allocated capacity (never changes)
        const n = Math.min(rec.n, cap);
        if (rec.n > cap && !this._overCapWarned) {
          this._overCapWarned = true;
          console.warn('[scatter] cell instances', rec.n, '>', sp, 'cap', cap, '— clamped');
        }
        const uvA = mesh.geometry.getAttribute('aUvOff');
        mesh.instanceMatrix.array.set(rec.mats.subarray(0, n * 16));
        for (let i = 0; i < n; i++) {
          this._col.setRGB(rec.cols[i * 3], rec.cols[i * 3 + 1], rec.cols[i * 3 + 2]);
          mesh.setColorAt(i, this._col);
          if (uvA) uvA.array[i] = rec.uvs[i];
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (uvA) uvA.needsUpdate = true;
        this.group.add(mesh);
        meshes.push({ sp, mesh });
      }
      return meshes;
    }
  }

  global.ScatterManager = ScatterManager;
})(window);
