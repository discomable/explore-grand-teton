/* WildlifeManager — sparse, believable animal herds placed by habitat (Three.js r184, global
 * THREE). "wildlife" lane. Instanced low-poly herds streamed in coarse deterministic cells around
 * the camera, exactly like PropScatter/ScatterManager but with a live wander/graze animation and a
 * mesh→billboard distance LOD:
 *
 *   • BISON      — dark humped bovid, big loose herds on the open sage/grass flats (NLCD 52/71/81).
 *   • PRONGHORN  — slender tan-and-white, small skittish bands on the same sage flats.
 *   • ELK        — tan body / dark neck, mid herds along the meadow⇄forest edge (open cell with a
 *                  conifer/aspen mass within ~130 m).
 *   • MOOSE      — tall dark browser, solitary or a cow+calf pair in the willow riparian right by
 *                  authoritative water (Snake River / lake margins).
 *
 * DISCIPLINE (mirrors ScatterManager/PropScatter):
 *   — deterministic per-cell seeding: same world → same herds in the same places. Only the wander
 *     PHASE runs on live time (the roadmap explicitly allows animated herds over seeded placement),
 *     so two frames apart differ (animation) while nothing about WHERE a herd lives is random.
 *   — herd centres are validated once at spawn against authoritative water (WaterBuilder.surfaceAt),
 *     carriageway (global.roadQuery), building footprints (global.buildingBlocked) and slope; each
 *     animal is additionally clamped every frame so a wandering beast can never walk onto a road,
 *     into water, into a wall or up a cliff (revert-and-reflect, never place-then-clip).
 *   — spawns DEFER until the road/building indexes can answer (grace timeout so a missing subsystem
 *     never blanks the herds) and until the terrain tile under the centre is decoded (real height).
 *   — cell scan is amortized on a per-frame millisecond budget; animation touches only active herds
 *     and only EMITS instances that pass a real camera-frustum test (off-screen herds keep wandering
 *     but cost no draw).
 *   — ONE InstancedMesh per species per LOD → 8 draw calls total, hard-capped instance counts.
 *
 * ASSETS: 100% procedural — low-poly geometry merged from THREE box primitives, billboard silhouettes
 * hand-drawn to a small canvas at boot. Nothing downloaded, nothing on disk, original authorship →
 * CC0-equivalent; nothing to license or vendor.
 *
 *   const w = new WildlifeManager({ scene, terrain, landcover, water }).init();
 *   w.update(camera.position, dt);   // per frame
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- baked low-poly geometry ---------------- */
  // Each species is a handful of merged boxes, feet at y≈0, nose toward local +X. A per-part vertex
  // colour lets ONE shared MeshLambert material shade every family; per-instance instanceColor then
  // adds a subtle coat tint so a herd isn't a row of clones.

  function part(list, size, pos, rot, col) {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(pos[0], pos[1], pos[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0)),
      new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    const ng = g.toNonIndexed(); g.dispose();
    list.push({ g: ng, col });
  }
  function finalize(list) {
    let total = 0; for (const p of list) total += p.g.attributes.position.count;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
    let o = 0;
    for (const p of list) {
      const bp = p.g.attributes.position.array, bn = p.g.attributes.normal.array, n = p.g.attributes.position.count;
      pos.set(bp, o * 3); nor.set(bn, o * 3);
      for (let i = 0; i < n; i++) { col[(o + i) * 3] = p.col[0]; col[(o + i) * 3 + 1] = p.col[1]; col[(o + i) * 3 + 2] = p.col[2]; }
      o += n; p.g.dispose();
    }
    const G = new THREE.BufferGeometry();
    G.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    G.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    G.setAttribute('color', new THREE.BufferAttribute(col, 3));
    G.computeBoundingSphere();
    return G;
  }
  // shared four-legger core; `o.leg` etc. drive proportions (metres).
  function legs(L, bl, bw, legH, legT, col) {
    const lx = bl * 0.34, lz = bw * 0.5 - legT * 0.6;
    for (const sx of [1, -1]) for (const sz of [1, -1])
      part(L, [legT, legH, legT], [sx * lx, legH * 0.5, sz * lz], null, col);
  }

  function makeBison() {
    const L = [], dk = [0.20, 0.155, 0.125], hd = [0.12, 0.095, 0.08], lg = [0.14, 0.11, 0.09];
    const legH = 0.9, bl = 2.5, bh = 1.25, bw = 1.15, by = legH + bh * 0.5;
    legs(L, bl, bw, legH, 0.17, lg);
    part(L, [bl, bh, bw], [0, by, 0], null, dk);                       // barrel
    part(L, [1.0, 0.85, bw * 1.05], [bl * 0.42, by + 0.42, 0], null, dk); // shoulder hump
    part(L, [0.55, 0.7, 0.7], [bl * 0.62, by + 0.15, 0], null, hd);    // woolly head/bonnet
    part(L, [0.35, 0.4, 0.4], [bl * 0.78, by - 0.15, 0], null, hd);    // muzzle
    part(L, [0.16, 0.5, 0.16], [bl * 0.62, by - 0.42, 0], null, hd);   // beard
    for (const s of [1, -1]) part(L, [0.28, 0.09, 0.09], [bl * 0.72, by + 0.32, s * 0.28], [0, 0, 0.3], [0.1, 0.09, 0.08]); // horns
    return finalize(L);
  }
  function makeElk() {
    const L = [], bd = [0.42, 0.32, 0.24], nk = [0.24, 0.18, 0.13], lg = [0.40, 0.30, 0.22], an = [0.30, 0.24, 0.14];
    const legH = 1.15, bl = 2.1, bh = 0.95, bw = 0.85, by = legH + bh * 0.5;
    legs(L, bl, bw, legH, 0.11, lg);
    part(L, [bl, bh, bw], [0, by, 0], null, bd);
    part(L, [0.42, 0.24, 0.42], [-bl * 0.42, by + 0.05, 0], null, [0.72, 0.66, 0.5]); // pale rump
    part(L, [0.7, 0.85, 0.5], [bl * 0.5, by + 0.55, 0], [0, 0, -0.5], nk);   // raised neck
    part(L, [0.5, 0.32, 0.32], [bl * 0.72, by + 0.95, 0], null, nk);          // head
    part(L, [0.34, 0.2, 0.2], [bl * 0.9, by + 0.88, 0], null, nk);            // muzzle
    for (const s of [1, -1]) {                                                 // simple swept antlers
      part(L, [0.09, 0.7, 0.09], [bl * 0.68, by + 1.35, s * 0.15], [0, 0, s * 0.35], an);
      part(L, [0.09, 0.4, 0.09], [bl * 0.5, by + 1.7, s * 0.28], [0, 0, s * 0.6], an);
    }
    return finalize(L);
  }
  function makePronghorn() {
    const L = [], tn = [0.66, 0.55, 0.36], wh = [0.86, 0.83, 0.74], hn = [0.12, 0.10, 0.08];
    const legH = 0.85, bl = 1.3, bh = 0.6, bw = 0.5, by = legH + bh * 0.5;
    legs(L, bl, bw, legH, 0.07, [0.5, 0.42, 0.3]);
    part(L, [bl, bh, bw], [0, by, 0], null, tn);
    part(L, [bl * 0.9, 0.22, bw * 1.02], [0, by - bh * 0.42, 0], null, wh); // white belly band
    part(L, [0.34, 0.24, 0.5], [-bl * 0.48, by + 0.02, 0], null, wh);       // white rump
    part(L, [0.34, 0.55, 0.28], [bl * 0.48, by + 0.4, 0], [0, 0, -0.55], tn); // neck
    part(L, [0.34, 0.24, 0.24], [bl * 0.66, by + 0.66, 0], null, tn);         // head
    part(L, [0.2, 0.16, 0.16], [bl * 0.8, by + 0.6, 0], null, wh);            // muzzle
    for (const s of [1, -1]) part(L, [0.05, 0.3, 0.05], [bl * 0.6, by + 0.9, s * 0.1], null, hn); // short prongs
    return finalize(L);
  }
  function makeMoose() {
    const L = [], dk = [0.14, 0.11, 0.09], lg = [0.10, 0.085, 0.07], an = [0.5, 0.44, 0.3];
    const legH = 1.7, bl = 2.6, bh = 1.15, bw = 1.0, by = legH + bh * 0.5;
    legs(L, bl, bw, legH, 0.13, lg);
    part(L, [bl, bh, bw], [0, by, 0], null, dk);
    part(L, [0.9, 0.95, bw * 0.95], [bl * 0.4, by + 0.5, 0], null, dk);  // shoulder hump
    part(L, [0.6, 1.05, 0.55], [bl * 0.55, by + 0.5, 0], [0, 0, -0.35], dk); // long neck
    part(L, [0.55, 0.42, 0.42], [bl * 0.78, by + 0.95, 0], null, dk);    // head
    part(L, [0.5, 0.42, 0.3], [bl * 0.98, by + 0.78, 0], null, dk);      // bulbous muzzle
    part(L, [0.14, 0.4, 0.14], [bl * 0.62, by + 0.2, 0], null, dk);      // dewlap/bell
    for (const s of [1, -1]) part(L, [0.5, 0.08, 0.42], [bl * 0.7, by + 1.35, s * 0.4], [0, 0, s * 0.25], an); // palmate antlers
    return finalize(L);
  }

  // Side-profile silhouette for the distant billboard, drawn to a 64×48 canvas in the coat colour.
  function silhouette(kind, base) {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48;
    const g = cv.getContext('2d');
    const col = `rgb(${(base[0] * 210) | 0},${(base[1] * 210) | 0},${(base[2] * 210) | 0})`;
    g.fillStyle = col; g.strokeStyle = col; g.lineCap = 'round';
    const body = (x, y, w, h) => { g.beginPath(); g.ellipse(x, y, w, h, 0, 0, 7); g.fill(); };
    const leg = (x, y0, y1, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); };
    if (kind === 'bison') {
      body(30, 30, 18, 9); body(20, 24, 8, 7);              // barrel + hump
      g.beginPath(); g.ellipse(46, 30, 6, 5, 0, 0, 7); g.fill();  // head low
      [16, 24, 38, 44].forEach((x, i) => leg(x, 34, 44, i < 2 ? 4 : 4));
    } else if (kind === 'elk') {
      body(28, 28, 16, 7);
      g.lineWidth = 5; g.beginPath(); g.moveTo(40, 26); g.lineTo(48, 14); g.stroke(); // neck up
      body(49, 12, 5, 4);                                    // head high
      g.lineWidth = 2; g.beginPath(); g.moveTo(49, 10); g.lineTo(44, 2); g.moveTo(49, 10); g.lineTo(54, 3); g.stroke(); // antlers
      [18, 26, 36, 42].forEach(x => leg(x, 33, 46, 3));
    } else if (kind === 'pronghorn') {
      body(28, 30, 12, 5);
      g.lineWidth = 4; g.beginPath(); g.moveTo(37, 28); g.lineTo(43, 20); g.stroke();
      body(44, 18, 4, 3);
      [20, 26, 34, 40].forEach(x => leg(x, 34, 45, 2));
    } else { // moose
      body(28, 26, 17, 8); body(20, 21, 8, 7);
      g.lineWidth = 6; g.beginPath(); g.moveTo(40, 22); g.lineTo(48, 12); g.stroke();
      body(50, 11, 6, 5);
      g.lineWidth = 3; g.beginPath(); g.moveTo(50, 8); g.lineTo(43, 4); g.moveTo(50, 8); g.lineTo(57, 5); g.stroke(); // palmate
      [16, 24, 38, 44].forEach(x => leg(x, 30, 47, 3));
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  }

  const FOREST = { 41: 1, 42: 1, 43: 1, 90: 1 };
  const OPEN = { 52: 1, 71: 1, 81: 1, 82: 1, 21: 1, 31: 1 };  // sage / grass / pasture / crop / dev-open / barren

  // species tuning. herd = [min,max] members · spread = mill radius (m) · speed (m/s) · sep (m)
  const SPECIES = {
    bison:     { herd: [8, 18],  spread: 55, speed: 0.55, sep: 6.5, size: 1.0, nearCap: 44, farCap: 130, tri: 0 },
    pronghorn: { herd: [4, 8],   spread: 70, speed: 1.5,  sep: 9,   size: 0.9, nearCap: 30, farCap: 90,  tri: 0 },
    elk:       { herd: [6, 13],  spread: 45, speed: 0.9,  sep: 6,   size: 1.0, nearCap: 40, farCap: 100, tri: 0 },
    moose:     { herd: [1, 2],   spread: 18, speed: 0.45, sep: 10,  size: 1.0, nearCap: 8,  farCap: 16,  tri: 0 },
  };

  class WildlifeManager {
    constructor(o) {
      this.scene = o.scene; this.terrain = o.terrain; this.lc = o.landcover;
      this.water = o.water || null;
      this.cellSize = o.cellSize || 340;
      this.radius = o.radius || 1350;         // herds active/animated within this ring
      this.lodNear = o.lodNear || 340;        // full mesh inside, billboard beyond
      this.budgetMs = o.budgetMs || 1.5;
      this.group = new THREE.Group();
      this.scene.add(this.group);

      this.nearMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x000000 });
      this._geo = { bison: makeBison(), pronghorn: makePronghorn(), elk: makeElk(), moose: makeMoose() };
      for (const k in SPECIES) SPECIES[k].tri = this._geo[k].attributes.position.count / 3;

      this.near = {}; this.far = {};
      for (const k in SPECIES) {
        this.near[k] = this._instMesh(this._geo[k], this.nearMat, SPECIES[k].nearCap, true);
        const tex = silhouette(k, this._geoBaseColor(k));
        const fmat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.5,
          side: THREE.DoubleSide, color: 0xffffff, emissive: 0x000000 });
        const quad = new THREE.PlaneGeometry(1, 1); quad.translate(0, 0.5, 0);   // pivot at feet
        this.far[k] = this._instMesh(quad, fmat, SPECIES[k].farCap, false);
      }

      this._dummy = new THREE.Object3D();
      this._cache = new Map();      // cellKey -> herd|null
      this._queue = null; this._lastCell = null; this._exclOk = false; this._t0 = undefined;
      this._frustum = new THREE.Frustum(); this._pm = new THREE.Matrix4();
      this._time = 0;
      this._dump = typeof location !== 'undefined' && /[?&]wilddump/.test(location.search);
      this.stats = { herds: 0, animals: 0, near: 0, far: 0, drawCalls: 0, tris: 0 };
    }
    init() { return this; }

    _geoBaseColor(k) {
      return { bison: [0.22, 0.17, 0.14], pronghorn: [0.66, 0.55, 0.36], elk: [0.46, 0.36, 0.26], moose: [0.16, 0.13, 0.11] }[k];
    }
    _instMesh(geo, mat, cap, color) {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;          // we cull per-animal against the real frustum ourselves
      if (color) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      this.group.add(m);
      return m;
    }

    /* road/building indexes arrive async — defer spawns until both can answer (grace timeout). */
    _exclusionReady() {
      if (this._exclOk) return true;
      if (this._t0 === undefined) this._t0 = performance.now();
      const timedOut = performance.now() - this._t0 > 15000;
      const roads = (typeof RoadIndex === 'undefined') || RoadIndex.ready || timedOut;
      const bldgs = !!global.buildingBlocked || timedOut;
      if (roads && bldgs) this._exclOk = true;
      return this._exclOk;
    }
    _heightReady(x, z) {
      // heightAt returns (elevation.min - datum) sentinel where no tile is decoded yet — defer then.
      const h = this.terrain.heightAt(x, z);
      const floor = this.terrain.m.elevation.min - this.terrain.datum;
      return Math.abs(h - floor) > 0.02 ? h : null;
    }
    _slope(x, z, h) {
      const sx = (this.terrain.heightAt(x + 6, z) - h) / 6, sz = (this.terrain.heightAt(x, z + 6) - h) / 6;
      return Math.sqrt(sx * sx + sz * sz);
    }
    _onWater(x, z) {
      if (this.water && this.water.surfaceAt) return this.water.surfaceAt(x, z) !== null;
      return this.lc.waterAt ? this.lc.waterAt(x, z) : false;
    }
    _waterNear(x, z, r) {
      const w = this.water; if (!w || !w.surfaceAt) return false;
      return w.surfaceAt(x + r, z) !== null || w.surfaceAt(x - r, z) !== null ||
             w.surfaceAt(x, z + r) !== null || w.surfaceAt(x, z - r) !== null;
    }
    _forestNear(x, z, r) {
      for (let a = 0; a < 6; a++) {
        const th = a / 6 * Math.PI * 2;
        if (FOREST[this.lc.classAt(x + Math.cos(th) * r, z + Math.sin(th) * r)]) return true;
      }
      return false;
    }
    // valid standing ground for an animal: dry, off the road corridor, clear of buildings, not steep.
    _valid(x, z) {
      if (this._onWater(x, z)) return false;
      const rq = global.roadQuery;
      if (rq) { const r = rq(x, z); const pad = ({ track: 2, gravel: 3, park_paved: 4, highway: 6 })[r.class] || 0; if (r.dist < pad + 2.5) return false; }
      if (global.buildingBlocked && global.buildingBlocked(x, z)) return false;
      const h = this._heightReady(x, z); if (h === null) return false;
      if (this._slope(x, z, h) > 0.5) return false;
      return true;
    }

    update(camPos, dt) {
      this._time += dt;
      const ix = Math.floor(camPos.x / this.cellSize), iz = Math.floor(camPos.z / this.cellSize);
      const key = ix + ',' + iz;
      if (key !== this._lastCell) { this._lastCell = key; this._reconcile(ix, iz); }
      if (this._exclusionReady()) this._drainQueue();
      this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._pm);
      this._animateAndEmit(camPos, dt);
    }

    _reconcile(ix, iz) {
      const r = Math.ceil(this.radius / this.cellSize), r2 = r * r;
      const want = new Set();
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        want.add((ix + dx) + ',' + (iz + dz));
      }
      for (const k of this._cache.keys()) if (!want.has(k)) this._cache.delete(k);
      const q = [];
      for (const k of want) {
        if (this._cache.has(k)) continue;
        const [cx, cz] = k.split(',').map(Number);
        const ddx = cx - ix, ddz = cz - iz;
        q.push({ k, cx, cz, d2: ddx * ddx + ddz * ddz });
      }
      q.sort((a, b) => b.d2 - a.d2);   // pop() = nearest first
      this._queue = q;
    }

    _drainQueue() {
      const q = this._queue; if (!q || !q.length) return;
      const t0 = performance.now();
      while (q.length) {
        const c = q.pop();
        if (this._cache.has(c.k)) continue;
        const herd = this._spawnCell(c.cx, c.cz);
        // if the tile wasn't decoded yet, leave the cell unresolved so it retries on a later frame
        if (herd === undefined) { continue; }
        this._cache.set(c.k, herd);
        if (performance.now() - t0 > this.budgetMs) break;
      }
    }

    /* Deterministic cell → at most one herd. Returns a herd object, null (barren cell) or undefined
       (terrain not ready — retry later). No scene writes. */
    _spawnCell(cx, cz) {
      const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x9E3779B1);
      const S = this.cellSize, x0 = cx * S, z0 = cz * S;
      // probe the cell centre-ish; if the tile isn't decoded, retry later
      const px = x0 + S * (0.3 + rng() * 0.4), pz = z0 + S * (0.3 + rng() * 0.4);
      if (this._heightReady(px, pz) === null) return undefined;
      const cls = this.lc.classAt(px, pz);
      const water = this._waterNear(px, pz, 45);
      const open = !!OPEN[cls];
      const forestEdge = open && this._forestNear(px, pz, 130);

      let species = null;
      const roll = rng();
      if (water && (open || FOREST[cls])) { if (roll < 0.7) species = 'moose'; }
      else if (forestEdge) { if (roll < 0.34) species = 'elk'; }
      else if (open) { species = roll < 0.14 ? 'bison' : (roll < 0.26 ? 'pronghorn' : null); }
      if (!species) return null;

      // find a valid herd centre by a few seeded probes around the sample point
      let hx = null, hz = null;
      for (let t = 0; t < 8; t++) {
        const ax = px + (rng() - 0.5) * S * 0.7, az = pz + (rng() - 0.5) * S * 0.7;
        if (this._valid(ax, az)) { hx = ax; hz = az; break; }
      }
      if (hx === null) return null;

      const spec = SPECIES[species];
      const n = spec.herd[0] + Math.floor(rng() * (spec.herd[1] - spec.herd[0] + 1));
      const animals = [];
      for (let i = 0; i < n; i++) {
        const ang = rng() * Math.PI * 2, rad = Math.sqrt(rng()) * spec.spread * 0.8;
        let ax = hx + Math.cos(ang) * rad, az = hz + Math.sin(ang) * rad;
        if (!this._valid(ax, az)) { ax = hx; az = hz; }         // fall back to the (valid) centre
        animals.push({ x: ax, z: az, head: rng() * Math.PI * 2, ph: rng() * 6.28,
                       tint: 0.86 + rng() * 0.28, sz: spec.size * (0.9 + rng() * 0.25) });
      }
      return { species, cx: hx, cz: hz, animals };
    }

    /* Animate every active herd (cheap, small counts) and emit only frustum-visible animals into the
       per-species near/far InstancedMeshes. LOD by camera distance; billboards yaw to face camera. */
    _animateAndEmit(camPos, dt) {
      const nCount = {}, fCount = {}, col = {};
      for (const k in SPECIES) { nCount[k] = 0; fCount[k] = 0; col[k] = this.near[k].instanceColor.array; }
      const t = this._time;
      let herds = 0, total = 0;

      for (const herd of this._cache.values()) {
        if (!herd) continue;
        herds++;
        const spec = SPECIES[herd.species];
        const near = this.near[herd.species], far = this.far[herd.species];
        const A = herd.animals, cxh = herd.cx, czh = herd.cz;
        for (let i = 0; i < A.length; i++) {
          const a = A[i];
          // —— wander: slow heading drift, cohesion when past the mill radius, light separation ——
          a.head += Math.sin(t * 0.5 + a.ph) * 0.9 * dt;
          let hx = Math.cos(a.head), hz = Math.sin(a.head);
          const dcx = cxh - a.x, dcz = czh - a.z, dc = Math.hypot(dcx, dcz);
          if (dc > spec.spread) { hx += dcx / dc * 1.4; hz += dcz / dc * 1.4; }   // steer home
          for (let j = 0; j < A.length; j++) {
            if (j === i) continue; const b = A[j];
            const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz);
            if (d > 0.01 && d < spec.sep) { hx += dx / d * (spec.sep - d) / spec.sep * 1.6; hz += dz / d * (spec.sep - d) / spec.sep * 1.6; }
          }
          const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
          // grazing beasts amble slowly and pause; a per-animal gait gate keeps the herd from marching
          const gait = 0.35 + 0.65 * Math.max(0, Math.sin(t * 0.6 + a.ph * 1.7));
          const step = spec.speed * gait * dt;
          const nx = a.x + hx * step, nz = a.z + hz * step;
          if (this._valid(nx, nz)) { a.x = nx; a.z = nz; a.head = Math.atan2(hz, hx); }
          else { a.head += 2.2; }                                 // hit an edge → turn away, stay put
          total++;

          const gy = this.terrain.heightAt(a.x, a.z);
          const bob = Math.sin(t * 2.1 + a.ph) * 0.04;            // subtle graze bob
          const graze = 0.15 * Math.max(0, Math.sin(t * 0.35 + a.ph));   // periodic head-down lean
          const dxc = a.x - camPos.x, dzc = a.z - camPos.z, dist = Math.hypot(dxc, dzc);

          // real frustum cull (point + generous radius for the body/antlers)
          if (!this._frustum.intersectsSphere(_sphere.set(_v.set(a.x, gy + 1.2, a.z), 4 * a.sz))) continue;

          const yaw = Math.atan2(-hz, hx);                        // local +X → heading
          const d = this._dummy;
          if (dist < this.lodNear && nCount[herd.species] < spec.nearCap) {
            d.position.set(a.x, gy + bob, a.z);
            d.rotation.set(graze, yaw, 0);                        // pitch nose down slightly to graze
            d.scale.set(a.sz, a.sz, a.sz);
            d.updateMatrix();
            const slot = nCount[herd.species]++;
            near.setMatrixAt(slot, d.matrix);
            const c = a.tint; col[herd.species][slot * 3] = c; col[herd.species][slot * 3 + 1] = c * 0.98; col[herd.species][slot * 3 + 2] = c * 0.95;
          } else if (dist >= this.lodNear && fCount[herd.species] < spec.farCap) {
            // billboard: face the camera about vertical; scale to the animal's rough bbox
            const byaw = Math.atan2(dxc, dzc);
            const w = spec.size * (herd.species === 'bison' || herd.species === 'moose' ? 3.4 : 2.4) * a.sz;
            const h = spec.size * (herd.species === 'moose' ? 3.2 : herd.species === 'elk' ? 2.6 : herd.species === 'bison' ? 2.2 : 1.8) * a.sz;
            d.position.set(a.x, gy, a.z);
            d.rotation.set(0, byaw, 0);
            d.scale.set(w, h, 1);
            d.updateMatrix();
            far.setMatrixAt(fCount[herd.species]++, d.matrix);
          }
        }
      }

      let calls = 0, tris = 0;
      for (const k in SPECIES) {
        const nm = this.near[k], fm = this.far[k];
        nm.count = nCount[k]; nm.instanceMatrix.needsUpdate = true; if (nm.instanceColor) nm.instanceColor.needsUpdate = true;
        fm.count = fCount[k]; fm.instanceMatrix.needsUpdate = true;
        if (nCount[k]) { calls++; tris += nCount[k] * SPECIES[k].tri; }
        if (fCount[k]) { calls++; tris += fCount[k] * 2; }
      }
      // Diagnostic (opt-in via ?wilddump): keep one live 'WILD …' entry in the PAGE_ERRS→meta.errors
      // channel reflecting the CURRENT ring — budget actuals + herd centres for headless view aiming.
      // Off by default, so normal captures carry a clean (null) errors field.
      if (this._dump && herds && typeof PAGE_ERRS !== 'undefined') {
        const s2 = this.stats, list = [];
        for (const h of this._cache.values()) if (h) list.push(h.species[0] + ':' + (h.cx | 0) + ',' + (h.cz | 0) + '(' + h.animals.length + ')');
        const str = 'WILD calls=' + s2.drawCalls + ' tris=' + s2.tris + ' near=' + s2.near + ' far=' + s2.far + ' herds=' + s2.herds + ' | ' + list.join(' ');
        let idx = -1; for (let i = 0; i < PAGE_ERRS.length; i++) if (String(PAGE_ERRS[i]).startsWith('WILD ')) { idx = i; break; }
        if (idx >= 0) PAGE_ERRS[idx] = str; else PAGE_ERRS.push(str);
      }
      const s = this.stats;
      s.herds = herds; s.animals = total; s.near = Object.values(nCount).reduce((a, b) => a + b, 0);
      s.far = Object.values(fCount).reduce((a, b) => a + b, 0); s.drawCalls = calls; s.tris = tris;
      global.WILDLIFE_STATS = s;
    }
  }

  // scratch (module-scope, reused every frame — no per-frame allocation)
  const _v = new THREE.Vector3(), _sphere = new THREE.Sphere();

  global.WildlifeManager = WildlifeManager;
})(window);
