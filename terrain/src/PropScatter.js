/* PropScatter — sparse deterministic environmental props for SCALE, not clutter (Three.js r184,
 * global THREE). Milestone 4 "environmental props" lane. Three instanced prop families, each ONE
 * global InstancedMesh (3 draw calls total) whose instance list is rebuilt from a per-cell cache
 * as the camera moves:
 *
 *   • BOULDERS — rounded low-poly rock (icosphere, seeded radial displacement, smooth normals so
 *     it reads as a weathered boulder, NOT the faceted grey gem-chunks that the M4 audit flagged).
 *     Sparse on dry non-cliff ground everywhere, denser on river gravel bars + near settlements.
 *   • DEADFALL LOGS — a tapered fallen trunk lying flat with a random yaw, near forest edges and
 *     riparian ground.
 *   • FENCE SEGMENTS — a post-and-rail buck fence segment (2 posts + 2 rails, merged), oriented
 *     along the local road tangent, placed just off gravel/track roads in pasture/grass so it
 *     lines Mormon Row and the park's dirt roads.
 *
 * DISCIPLINE (mirrors ScatterManager): deterministic per-cell seeding (same world → same props);
 * amortized cell fills on a per-frame time budget; every candidate is rejected on carriageway
 * (global.roadQuery), building footprint (global.buildingBlocked) and authoritative water
 * (WaterBuilder.surfaceAt) before placement; fills DEFER until the road/building indexes can
 * answer (never place-then-cull), with a grace timeout so a missing subsystem can't leave the
 * world bare. Instanced + frustum-culled (a camera-centred bounding sphere sized to the ring, so
 * the whole family is skipped only when the ring is entirely off-screen).
 *
 * ASSETS: 100% procedural geometry baked at boot from THREE primitives — no downloaded asset, no
 * texture, nothing on disk. Original authorship → public-domain (CC0-equivalent); nothing to
 * license or vendor.
 *
 *   const ps = new PropScatter({ scene, terrain, landcover, water }).init();
 *   ps.update(camera.position);   // per frame
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
  function vhash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // ~120 m value noise → boulders/logs gather in loose fields with bare gaps between them
  function clump(x, z) {
    const gx = x / 120, gz = z / 120, ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return lerp(lerp(vhash(ix, iz), vhash(ix + 1, iz), u),
                lerp(vhash(ix, iz + 1), vhash(ix + 1, iz + 1), u), v);
  }

  /* ---------------- baked geometries (once) ---------------- */

  // Paint a solid vertex-colour attribute so ONE MeshLambert material carries every family's
  // base look; per-instance instanceColor then multiplies a subtle tint for variety.
  function withColor(geo, r, g, b) {
    const n = geo.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Rounded boulder: an icosphere (detail 1 = 80 tris) with each vertex pushed in/out along its
  // own direction by seeded value noise, then normals set to the sphere direction so shading stays
  // SMOOTH — a lumpy river-rock, never the flat-facet gem look. Per-instance non-uniform scale
  // then makes each one a different shape from this single shared mesh.
  function makeBoulder() {
    // detail-2 icosphere (320 tris) subdivided ENOUGH to round off — detail 1 (80 tris) with
    // strong per-vertex noise read as the faceted "origami gem" the M4 audit flagged. Gentle
    // low-frequency, low-amplitude direction noise makes soft rounded lumps; the base is flattened
    // so the boulder seats on the ground instead of balancing on a point; smooth sphere-direction
    // normals (never computeVertexNormals, which on a non-indexed icosphere gives hard facets)
    // keep shading soft. Weathered grey-tan colour is baked per-vertex with a deterministic
    // direction-hashed mottle so no two facets read flat-uniform.
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position, n = g.attributes.normal, N = p.count;
    const c = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
      // direction-hashed displacement (duplicate seam verts share a direction → no cracks)
      const d = 0.90 + 0.13 * vhash(x * 1.5 + 3.7, z * 1.5 - y * 0.6)
                     + 0.06 * vhash(y * 2.7 - 1.1, x * 2.2 + z * 0.9);
      let px = x * d, py = y * d * 0.80, pz = z * d;   // squat slightly: rocks sit low
      if (py < -0.42) py = -0.42 + (py + 0.42) * 0.15; // flatten the base to seat it flat
      p.setXYZ(i, px, py, pz);
      n.setXYZ(i, x, y * 0.80, z);                     // smooth normals → weathered boulder, not gem
      const t = 0.86 + 0.26 * vhash(x * 4.1 + 7.3, z * 3.3 - y * 1.9);
      c[i * 3] = 0.50 * t; c[i * 3 + 1] = 0.475 * t; c[i * 3 + 2] = 0.44 * t;  // grey-tan granite
    }
    n.needsUpdate = true;
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.computeBoundingSphere();
    return g;
  }

  // Fallen trunk: a gently tapered cylinder lying along +X, base sunk a touch below origin.
  function makeLog() {
    const g = new THREE.CylinderGeometry(0.20, 0.28, 5.2, 6, 1);
    g.rotateZ(Math.PI / 2);                          // axis → X (lying down)
    g.translate(0, 0.24, 0);
    return withColor(g, 0.34, 0.255, 0.175);         // weathered bark brown
  }

  // Post-and-rail buck fence SEGMENT along local X (~2.6 m): 2 posts + 2 rails, merged.
  function makeFence() {
    const parts = [];
    const box = (cx, cy, cz, sx, sy, sz) => {
      const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(cx, cy, cz); parts.push(b);
    };
    box(-1.15, 0.55, 0, 0.11, 1.15, 0.11);           // left post
    box( 1.15, 0.55, 0, 0.11, 1.15, 0.11);           // right post
    box(0, 0.86, 0, 2.55, 0.09, 0.07);               // upper rail
    box(0, 0.46, 0, 2.55, 0.09, 0.07);               // lower rail
    // manual merge (no BufferGeometryUtils vendored): concat position + normal
    let total = 0; for (const b of parts) total += b.attributes.position.count;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
    let o = 0;
    for (const b of parts) {
      const bp = b.attributes.position.array, bn = b.attributes.normal.array;
      pos.set(bp, o * 3); nor.set(bn, o * 3); o += b.attributes.position.count; b.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.computeBoundingSphere();
    return withColor(g, 0.29, 0.24, 0.18);           // sun-greyed cedar
  }

  const CLASS = { FOREST: { 41: 1, 42: 1, 43: 1, 90: 1 }, PASTURE: { 71: 1, 81: 1, 82: 1 } };

  class PropScatter {
    constructor(o) {
      this.scene = o.scene; this.terrain = o.terrain; this.lc = o.landcover;
      this.water = o.water || null;
      this.cellSize = o.cellSize || 150;
      this.radius = o.radius || 900;                 // props are close-up scale cues only
      this.budgetMs = o.budgetMs || 2.0;
      this.caps = { boulder: 600, log: 300, fence: 500 };
      this.group = new THREE.Group();
      this.group.name = 'terrainProps';
      this.scene.add(this.group);
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      this._dummy = new THREE.Object3D();
      this._col = new THREE.Color();
      this._meshes = {
        boulder: this._makeMesh(makeBoulder(), this.caps.boulder),
        log: this._makeMesh(makeLog(), this.caps.log),
        fence: this._makeMesh(makeFence(), this.caps.fence),
      };
      this._cache = new Map();                        // cellKey -> { boulder:[], log:[], fence:[] }
      this._queue = null;
      this._lastCell = null;
      this._dirty = false;
      this._exclOk = false;
    }
    init() { return this; }                           // symmetry with the other managers (sync here)

    _makeMesh(geo, cap) {
      const m = new THREE.InstancedMesh(geo, this.mat, cap);
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = true;
      // instanceColor buffer (subtle per-prop tint); allocated up front
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      this.group.add(m);
      return m;
    }

    /* road/building indexes arrive async; defer fills until both can answer, grace-timeout so a
       missing subsystem never blanks the props. Same contract as ScatterManager. */
    _exclusionReady() {
      if (this._exclOk) return true;
      if (this._t0 === undefined) this._t0 = performance.now();
      const timedOut = performance.now() - this._t0 > 15000;
      const roads = (typeof RoadIndex === 'undefined') || RoadIndex.ready || timedOut;
      const bldgs = !!global.buildingBlocked || timedOut;
      if (roads && bldgs) this._exclOk = true;
      return this._exclOk;
    }

    _nearBuilding(x, z, pad) {
      const bb = global.buildingBlocked;
      if (!bb) return false;
      return bb(x, z) || bb(x + pad, z) || bb(x - pad, z) || bb(x, z + pad) || bb(x, z - pad);
    }
    _onWater(x, z) {
      if (this.water && this.water.surfaceAt) return this.water.surfaceAt(x, z) !== null;
      return this.lc.waterAt ? this.lc.waterAt(x, z) : false;
    }
    // is (x,z) within ~50 m of a building footprint? (settlement neighbourhood, cheap ring probe)
    _nearSettlement(x, z) {
      const bb = global.buildingBlocked; if (!bb) return false;
      for (let a = 0; a < 6; a++) {
        const th = a / 6 * Math.PI * 2;
        if (bb(x + Math.cos(th) * 42, z + Math.sin(th) * 42)) return true;
      }
      return false;
    }
    // road tangent from the gradient of the roadQuery distance field (perp to "away from road")
    _roadTangent(x, z) {
      const rq = global.roadQuery; if (!rq) return 0;
      const e = 3;
      const gx = rq(x + e, z).dist - rq(x - e, z).dist;
      const gz = rq(x, z + e).dist - rq(x, z - e).dist;
      const tx = -gz, tz = gx;                        // rotate gradient 90° → along the road
      if (Math.abs(tx) + Math.abs(tz) < 1e-4) return 0;
      return Math.atan2(-tz, tx);                     // Y-rot mapping local +X → (tx,·,tz)
    }

    update(camPos) {
      const ix = Math.floor(camPos.x / this.cellSize), iz = Math.floor(camPos.z / this.cellSize);
      const key = ix + ',' + iz;
      if (key !== this._lastCell) { this._lastCell = key; this._reconcile(ix, iz); }
      if (this._exclusionReady()) this._drainQueue();
      if (this._dirty) { this._rebuild(camPos); this._dirty = false; }
      else {                                          // keep the cull sphere on the camera
        for (const k in this._meshes) {
          const bs = this._meshes[k].geometry.boundingSphere;
          if (bs) bs.center.set(camPos.x, camPos.y, camPos.z);
        }
      }
    }

    _reconcile(ix, iz) {
      const r = Math.ceil(this.radius / this.cellSize), r2 = r * r;
      const want = new Set();
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        want.add((ix + dx) + ',' + (iz + dz));
      }
      for (const k of this._cache.keys()) if (!want.has(k)) { this._cache.delete(k); this._dirty = true; }
      const q = [];
      for (const k of want) {
        if (this._cache.has(k)) continue;
        const [cx, cz] = k.split(',').map(Number);
        const ddx = cx - ix, ddz = cz - iz;
        q.push({ k, cx, cz, d2: ddx * ddx + ddz * ddz });
      }
      q.sort((a, b) => b.d2 - a.d2);                  // pop() = nearest first
      this._queue = q;
    }

    _drainQueue() {
      const q = this._queue;
      if (!q || !q.length) return;
      const t0 = performance.now();
      let built = 0;
      while (q.length) {
        const c = q.pop();
        if (this._cache.has(c.k)) continue;
        this._cache.set(c.k, this._fillCell(c.cx, c.cz));
        this._dirty = true;
        if (++built >= 1 && performance.now() - t0 > this.budgetMs) break;
      }
    }

    /* Deterministic per-cell candidate loop. Returns instance records per family; NO scene writes
       here (kept pure so cells can be built on any frame with identical output). */
    _fillCell(cx, cz) {
      const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x51ED2C0F);
      const S = this.cellSize, x0 = cx * S, z0 = cz * S;
      const out = { boulder: [], log: [], fence: [] };
      const T = this.terrain, lc = this.lc, rq = global.roadQuery;
      const slopeAt = (x, z, h) => {
        const sx = (T.heightAt(x + 6, z) - h) / 6, sz = (T.heightAt(x, z + 6) - h) / 6;
        return Math.sqrt(sx * sx + sz * sz);
      };

      // —— boulders —— sparse everywhere off cliffs; richer on river gravel bars & at settlements
      for (let i = 0; i < 46; i++) {
        const rx = rng(), rz = rng(), ra = rng(), rs = rng(), ry = rng(),
              rtx = rng(), rtz = rng(), rc = rng();
        const x = x0 + rx * S, z = z0 + rz * S;
        const cls = lc.classAt(x, z);
        if (cls === 11) continue;                     // open-water class
        let dens = 0.05;                              // base scatter on the flats
        if (cls === 31) dens = 0.16;                  // barren/talus: more rock
        const nearWater = this.water && this.water.surfaceAt && this._nearWaterBar(x, z);
        if (nearWater) dens = 0.22;                   // gravel bars along the Snake
        const settle = this._nearSettlement(x, z);
        if (settle) dens = Math.max(dens, 0.12);      // a few dressing rocks around buildings
        dens *= 0.25 + 0.75 * clump(x + 12.3, z - 7.1);
        if (ra > dens) continue;
        const h = T.heightAt(x, z);
        if (this._onWater(x, z)) continue;
        if (slopeAt(x, z, h) > 0.6) continue;         // no boulders glued to cliffs
        if (rq && (() => { const r = rq(x, z); return r.dist < ({ track: 1.8, gravel: 3.0, park_paved: 4.0, highway: 6.0 }[r.class] || 0) + 1.5; })()) continue;
        if (this._nearBuilding(x, z, 2.0)) continue;
        const base = 0.35 + rs * (nearWater ? 0.9 : 1.25);
        this._dummy.position.set(x, h - base * 0.28, z);   // bury the foot — no floating rock
        this._dummy.rotation.set((rtx - 0.5) * 0.4, ry * Math.PI * 2, (rtz - 0.5) * 0.4);
        this._dummy.scale.set(base * (0.85 + rtx * 0.5), base * (0.7 + ry * 0.4), base * (0.85 + rtz * 0.5));
        this._dummy.updateMatrix();
        const t = 0.82 + rc * 0.32;
        out.boulder.push({ m: this._dummy.matrix.clone(), c: [t, t * (0.98 + rc * 0.04), t * (0.9 + rc * 0.06)] });
      }

      // —— deadfall logs —— near forest edges & riparian ground, low probability, lying flat
      for (let i = 0; i < 22; i++) {
        const rx = rng(), rz = rng(), ra = rng(), rs = rng(), ry = rng(), rc = rng();
        const x = x0 + rx * S, z = z0 + rz * S;
        const cls = lc.classAt(x, z);
        const forest = !!CLASS.FOREST[cls];
        if (!forest && !this._nearWaterBar(x, z)) continue;
        let dens = forest ? 0.05 : 0.04;
        dens *= 0.2 + 0.8 * clump(x - 33.7, z + 51.9);
        if (ra > dens) continue;
        const h = T.heightAt(x, z);
        if (this._onWater(x, z)) continue;
        if (slopeAt(x, z, h) > 0.45) continue;
        if (rq && (() => { const r = rq(x, z); return r.dist < ({ track: 1.8, gravel: 3.0, park_paved: 4.0, highway: 6.0 }[r.class] || 0) + 2.0; })()) continue;
        if (this._nearBuilding(x, z, 2.5)) continue;
        const s = 0.7 + rs * 0.7;
        this._dummy.position.set(x, h - 0.05, z);
        this._dummy.rotation.set((rc - 0.5) * 0.12, ry * Math.PI * 2, 0);
        this._dummy.scale.set(s, s, s);
        this._dummy.updateMatrix();
        const t = 0.85 + rc * 0.25;
        out.log.push({ m: this._dummy.matrix.clone(), c: [t, t * 0.95, t * 0.9] });
      }

      // —— fence segments —— just off gravel/track roads through pasture/grass (Mormon Row) ——
      if (rq && (typeof RoadIndex === 'undefined' || RoadIndex.ready)) {
        for (let i = 0; i < 70; i++) {
          const rx = rng(), rz = rng(), rc = rng();
          const x = x0 + rx * S, z = z0 + rz * S;
          const r = rq(x, z);
          if (r.class !== 'gravel' && r.class !== 'track') continue;
          if (r.dist < 3.4 || r.dist > 5.6) continue;      // beyond the shoulder, a fence line off
          const cls = lc.classAt(x, z);
          if (!CLASS.PASTURE[cls] && cls !== 52) continue; // ranch land only
          if (this._onWater(x, z)) continue;
          const h = T.heightAt(x, z);
          if (slopeAt(x, z, h) > 0.4) continue;
          if (this._nearBuilding(x, z, 2.0)) continue;
          const yaw = this._roadTangent(x, z);
          const s = 0.92 + rc * 0.18;
          this._dummy.position.set(x, h - 0.08, z);
          this._dummy.rotation.set(0, yaw, 0);
          this._dummy.scale.set(s, s, s);
          this._dummy.updateMatrix();
          const t = 0.72 + rc * 0.16;
          out.fence.push({ m: this._dummy.matrix.clone(), c: [t, t * 0.97, t * 0.92] });
        }
      }
      return out;
    }

    // river gravel bar: within a short reach of authoritative water but currently DRY here
    _nearWaterBar(x, z) {
      const w = this.water; if (!w || !w.surfaceAt) return false;
      if (w.surfaceAt(x, z) !== null) return false;   // this point is open water, not a bar
      return w.surfaceAt(x + 10, z) !== null || w.surfaceAt(x - 10, z) !== null ||
             w.surfaceAt(x, z + 10) !== null || w.surfaceAt(x, z - 10) !== null;
    }

    /* Concatenate the cache into the 3 InstancedMeshes. Cheap (sparse), runs only on a cell change.
       A camera-centred bounding sphere the size of the ring lets three frustum-cull the whole
       family when it's off-screen without ever culling a visible prop. */
    _rebuild(camPos) {
      const acc = { boulder: [], log: [], fence: [] };
      this._appendMormonRowCorral(acc.fence);
      for (const cell of this._cache.values())
        for (const k in acc) { const a = acc[k], s = cell[k]; for (let i = 0; i < s.length; i++) a.push(s[i]); }
      for (const k in this._meshes) {
        const mesh = this._meshes[k], list = acc[k], cap = this.caps[k];
        const n = Math.min(list.length, cap), ci = mesh.instanceColor.array;
        for (let i = 0; i < n; i++) {
          mesh.setMatrixAt(i, list[i].m);
          const c = list[i].c; ci[i * 3] = c[0]; ci[i * 3 + 1] = c[1]; ci[i * 3 + 2] = c[2];
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        mesh.geometry.boundingSphere.center.set(camPos.x, camPos.y, camPos.z);
        mesh.geometry.boundingSphere.radius = this.radius + 60;
      }
    }

    /* HABS-era ranch context around the T. A. Moulton barn. These records join the ordinary
       fence InstancedMesh, so the authored corral costs instances but no additional draw call. */
    _appendMormonRowCorral(out) {
      const addLine = (ax, az, bx, bz, gapStart, gapEnd) => {
        const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
        const count = Math.max(1, Math.ceil(length / 2.55));
        const yaw = Math.atan2(-dz, dx);
        for (let index = 0; index < count; index++) {
          const t = (index + 0.5) / count;
          if (gapStart !== undefined && t >= gapStart && t <= gapEnd) continue;
          const x = ax + dx * t, z = az + dz * t;
          const h = this.terrain.heightAt(x, z);
          const scale = length / count / 2.55;
          this._dummy.position.set(x, h - 0.07, z);
          this._dummy.rotation.set(0, yaw, 0);
          this._dummy.scale.set(scale, 1, 1);
          this._dummy.updateMatrix();
          const shade = 0.72 + 0.08 * ((index * 17 % 11) / 10);
          out.push({ m: this._dummy.matrix.clone(), c: [shade, shade * 0.96, shade * 0.88] });
        }
      };
      // Open gate faces the barn; the east enclosure and short west line match the documented
      // working-ranch reading without crowding the reconstructed footprint.
      addLine(4843, 8247, 4872, 8247);
      addLine(4872, 8247, 4872, 8284);
      addLine(4872, 8284, 4842, 8284, 0.38, 0.57);
      addLine(4842, 8284, 4842, 8275);
      addLine(4814, 8248, 4814, 8279, 0.42, 0.57);
    }
  }

  global.PropScatter = PropScatter;
})(window);
