/* SignBuilder — deterministic, topology-aware park road signs.  Deliberately uses
   canvas textures on fixed planes: these are roadside objects, not billboards. */
(function () {
  'use strict';
  const PAVED = new Set(['highway', 'park_paved']);
  const TOL = 11, CELL = 80, MAX_GUIDES = 20, MAX_PLAQUES = 42, MAX_STOPS = 12;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const key = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
  const bearing = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
  const angle = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  // Lazily-built resources shared by every sign (and every SignBuilder instance): the post is
  // one geometry + one material, plane geometries are keyed by size, and sign faces are keyed by
  // their drawn content so the 12 STOPs and any repeated road name resolve to one texture.
  const SHARED = { postGeo: null, postMat: null, planes: new Map(), faces: new Map() };

  class SignBuilder {
    constructor(o) {
      o = o || {}; this.scene = o.scene; this.terrain = o.terrain || null;
      this.transportSurface = o.transportSurface || window.transportSurface || null;
      this.sampleGround = o.sampleGround || (() => 0); this.roadsUrl = o.roadsUrl || 'terrain/public/roads.json';
      this.labelsUrl = o.labelsUrl || 'terrain/public/labels.json'; this.debug = o.debug !== undefined ? o.debug : /[?&]signDebug(?:=1|&|$)/.test(location.search);
      this.group = new THREE.Group(); this.group.name = 'parkRoadSigns'; this.stats = { junctions: 0, guides: 0, plaques: 0, stops: 0 };
      this._posts = [];   // world transforms collected by _panel, instanced once in _buildPosts
    }
    async build() {
      try {
        const shared = this.transportSurface && window.GT_transportFeatures
          ? window.GT_transportFeatures(this.transportSurface.snapshot(), s => s.vehicleAllowed) : null;
        const roadsPromise = shared && shared.length ? Promise.resolve(shared.map(f => ({
          id: f.featureId, class: f.classification, kind: f.kind, name: f.name, pts: f.pts,
        }))) : fetch(this.roadsUrl).then(r => { if (!r.ok) throw Error(r.status); return r.json(); });
        const [roads, labelData] = await Promise.all([roadsPromise, fetch(this.labelsUrl).then(r => r.json())]);
        this._makeGraph(roads); this.labels = (labelData.labels || []).filter(l => /^(place|lake)$/.test(l.cls) || (l.imp || 0) >= 3);
        this._place(); this._buildPosts(); this.scene.add(this.group);
        console.info('[SignBuilder]', this.stats.junctions + ' junctions,', this.stats.guides + ' guides,', this.stats.plaques + ' plaques,', this.stats.stops + ' stops');
      } catch (e) { console.info('[SignBuilder] unavailable — skipping signs.', e && e.message || e); }
      return this;
    }
    _makeGraph(roads) {
      const ends = [], buckets = new Map();
      roads.forEach((road, ri) => {
        if (!PAVED.has(road.class) || !road.pts || road.pts.length < 2) return;
        [[0, 1], [road.pts.length - 1, road.pts.length - 2]].forEach(([i, j]) => {
          const p = road.pts[i], q = road.pts[j], e = { x: p[0], z: p[1], tx: q[0] - p[0], tz: q[1] - p[1], road, ri };
          ends.push(e); const k = key(e.x, e.z); (buckets.get(k) || (buckets.set(k, []), buckets.get(k))).push(e);
        });
      });
      // Union nearby endpoints.  This tolerates small OSM cracks while ensuring one node per cluster.
      const parent = ends.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
      const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
      ends.forEach((e, i) => { const cx = Math.floor(e.x / CELL), cz = Math.floor(e.z / CELL); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const f of buckets.get((cx + dx) + ',' + (cz + dz)) || []) { const j = ends.indexOf(f); if (j > i && dist(e, f) <= TOL) join(i, j); } });
      const groups = new Map(); ends.forEach((e, i) => { const r = find(i); (groups.get(r) || (groups.set(r, []), groups.get(r))).push(e); });
      this.nodes = [...groups.values()].map(es => ({ x: es.reduce((s, e) => s + e.x, 0) / es.length, z: es.reduce((s, e) => s + e.z, 0) / es.length, ends: es, links: [] }));
      const byRoad = new Map(); this.nodes.forEach((n, ni) => n.ends.forEach(e => { const a = byRoad.get(e.ri) || []; a.push({ n: ni, e }); byRoad.set(e.ri, a); }));
      byRoad.forEach(a => { if (a.length !== 2 || a[0].n === a[1].n) return; const A = this.nodes[a[0].n], B = this.nodes[a[1].n], d = dist(A, B); A.links.push({ to: a[1].n, d, road: a[0].e.road }); B.links.push({ to: a[0].n, d, road: a[1].e.road }); });
      this.nodes.forEach(n => { n.links.sort((a, b) => a.to - b.to); n.bearings = n.links.map(l => bearing(n, this.nodes[l.to])); n.robust = n.links.length >= 3 && n.bearings.filter((v, i, a) => a.some((w, j) => j !== i && angle(v, w) > 0.45)).length >= 3; });
      this.stats.junctions = this.nodes.filter(n => n.robust).length;
    }
    _routes(start) { // compact Dijkstra; graph has only road mouths/junctions
      const d = Array(this.nodes.length).fill(Infinity); d[start] = 0; const used = new Set();
      for (;;) { let u = -1, best = Infinity; for (let i = 0; i < d.length; i++) if (!used.has(i) && d[i] < best) { best = d[i]; u = i; } if (u < 0) break; used.add(u); for (const l of this.nodes[u].links) if (d[l.to] > best + l.d) d[l.to] = best + l.d; }
      return d;
    }
    _place() {
      // Keep the sparse deployment repeatable while reserving the two principal visitor
      // approaches for review.  The hash (rather than source-array order) prevents a dense
      // subdivision from consuming the cap, while Moose and Jenny Lake remain signed.
      const focus = this.labels.filter(l => l.name === 'Moose' || l.name === 'Jenny Lake');
      const rank = x => ((Math.imul((Math.round(x.n.x) ^ Math.round(x.n.z)), 1103515245) >>> 0) / 4294967296);
      const junctions = this.nodes.map((n, i) => ({ n, i })).filter(x => x.n.robust).sort((a, b) => {
        const da = focus.length ? Math.min(...focus.map(l => Math.hypot(a.n.x - l.x, a.n.z - l.z))) : Infinity;
        const db = focus.length ? Math.min(...focus.map(l => Math.hypot(b.n.x - l.x, b.n.z - l.z))) : Infinity;
        // Only the closest source for each review destination is promoted; the rest use hash order.
        const pa = focus.some(l => da === Math.min(...this.nodes.filter(n => n.robust).map(n => Math.hypot(n.x-l.x,n.z-l.z))));
        const pb = focus.some(l => db === Math.min(...this.nodes.filter(n => n.robust).map(n => Math.hypot(n.x-l.x,n.z-l.z))));
        return (pb - pa) || rank(a) - rank(b) || a.i - b.i;
      });
      for (const { n, i } of junctions.slice(0, MAX_GUIDES)) {
        // A GNIS point need not land precisely on a road endpoint.  Attach it to the
        // closest *reachable* graph node, rather than accidentally dropping an entire
        // disconnected component because another component happens to be closer in a line.
        const routes = this._routes(i), candidates = this.labels.map(l => { let d = Infinity; this.nodes.forEach((q, qi) => { if (isFinite(routes[qi])) d = Math.min(d, routes[qi] + Math.hypot(q.x - l.x, q.z - l.z)); }); return { l, d }; }).filter(x => x.d < 35000).sort((a, b) => a.d - b.d || a.l.name.localeCompare(b.l.name));
        const picks = []; for (const c of candidates) if (!picks.some(p => p.l.name === c.l.name) && picks.length < 2) picks.push(c);
        if (!picks.length) continue; const out = n.links.slice().sort((a, b) => a.road.class.localeCompare(b.road.class) || a.to - b.to)[0]; this._guide(n, bearing(n, this.nodes[out.to]), picks); this.stats.guides++;
        // A stop at every graph meeting is visually noisy; retain a stable one-in-three
        // subset, selected from the sorted junction order, and never place one at a mouth.
        if (i % 3 === 0 && this.stats.stops < MAX_STOPS) { this._stop(n, bearing(n, this.nodes[out.to])); this.stats.stops++; }
      }
      const mouths = this.nodes.filter(n => n.links.length === 1 && n.ends.some(e => e.road.name)).sort((a, b) => a.z - b.z || a.x - b.x);
      for (const n of mouths.slice(0, MAX_PLAQUES)) { const e = n.ends.find(x => x.road.name); this._plaque(n, bearing(n, this.nodes[n.links[0].to]), e.road.name); this.stats.plaques++; }
      if (this.debug) this._debug(junctions);
    }
    _y(x, z) { return (this.terrain ? this.terrain.heightAt(x, z) : this.sampleGround(x, z)) + 0.04; }
    /* Shared sign assets. Every panel used to mint its own post geometry, post material, plane
       geometry and 1024xN canvas texture — ~74 of each, and a CanvasTexture pins its canvas for
       the lifetime of the app, so the roadside furniture alone cost on the order of 100 MB on
       the GPU and as much again on the heap. The face only depends on (lines, brown): _canvas
       ignores w/h and always draws at 1024 wide, so identical text is byte-identical and safe to
       share. Same pixels, a handful of resources. */
    _postGeometry() { return SHARED.postGeo || (SHARED.postGeo = new THREE.CylinderGeometry(.09, .11, 2.4, 8)); }
    _postMaterial() { return SHARED.postMat || (SHARED.postMat = new THREE.MeshStandardMaterial({ color: 0x6c6a5d, roughness: .9 })); }
    _planeGeometry(w, h) { const k = w + 'x' + h; let g = SHARED.planes.get(k); if (!g) SHARED.planes.set(k, g = new THREE.PlaneGeometry(w, h)); return g; }
    _canvas(lines, w, h, brown) { const key = (brown ? 'b|' : 'r|') + lines.join('\n'); const hit = SHARED.faces.get(key); if (hit) return hit; const c = document.createElement('canvas'); c.width = 1024; c.height = 256 * lines.length; const x = c.getContext('2d'); x.fillStyle = brown ? '#5b391d' : '#a21c17'; x.fillRect(0, 0, c.width, c.height); x.strokeStyle = '#f7edd2'; x.lineWidth = 20; x.strokeRect(10, 10, c.width - 20, c.height - 20); x.fillStyle = '#fff8dc'; x.font = 'bold 118px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; lines.forEach((s, i) => x.fillText(s, 512, 128 + i * 256)); const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; const m = new THREE.MeshBasicMaterial({ map: t, transparent: false, side: THREE.FrontSide }); SHARED.faces.set(key, m); return m; }
    /* Each sign used to be a Group holding a post Mesh and a face Mesh — three scene objects per
       sign, ~220 in all, for ~2.4k triangles. The posts are identical, so they collapse into one
       InstancedMesh (_buildPosts); the face keeps its own draw because its canvas texture is
       unique. Transforms are baked into world space, reproducing exactly what the nested group
       produced: translate to the post, rotate about Y, face lifted 2.45 + h/2. */
    _panel(n, yaw, lines, w, h, brown) {
      const side = 4.2;
      const px = n.x + Math.cos(yaw + Math.PI / 2) * side;
      const py = this._y(n.x, n.z);
      const pz = n.z - Math.sin(yaw + Math.PI / 2) * side;
      this._posts.push({ x: px, y: py + 1.2, z: pz, yaw });
      const face = new THREE.Mesh(this._planeGeometry(w, h), this._canvas(lines, w, h, brown));
      face.position.set(px, py + 2.45 + h / 2, pz);
      face.rotation.y = yaw;
      face.matrixAutoUpdate = false; face.updateMatrix();   // roadside furniture never moves
      this.group.add(face);
    }
    _buildPosts() {
      const count = this._posts.length;
      if (!count) return;
      const mesh = new THREE.InstancedMesh(this._postGeometry(), this._postMaterial(), count);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
      for (let i = 0; i < count; i++) {
        const p = this._posts[i];
        e.set(0, p.yaw, 0); q.setFromEuler(e); pos.set(p.x, p.y, p.z);
        mesh.setMatrixAt(i, m.compose(pos, q, one));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      this.group.add(mesh);
      this.stats.posts = count;
    }
    _guide(n, yaw, picks) { this._panel(n, yaw + Math.PI, picks.map(x => x.l.name.toUpperCase() + '  ' + Math.max(1, Math.round(x.d / 1609)) + ' MI'), 5.8, .68 * picks.length, true); }
    _plaque(n, yaw, name) { this._panel(n, yaw + Math.PI, [name.toUpperCase()], 3.5, .52, true); }
    _stop(n, yaw) { this._panel(n, yaw, ['STOP'], 1.05, 1.05, false); }
    _debug(junctions) { const m = new THREE.MeshBasicMaterial({ color: 0x00ffff }); junctions.forEach(({ n }) => { const s = new THREE.Mesh(new THREE.SphereGeometry(.75, 8, 6), m); s.position.set(n.x, this._y(n.x, n.z) + .8, n.z); this.group.add(s); }); const el = document.createElement('div'); el.textContent = 'SIGNS: ' + this.stats.guides + ' guide · ' + this.stats.plaques + ' plaque · ' + this.stats.stops + ' stop / ' + this.stats.junctions + ' junctions'; el.style.cssText = 'position:fixed;right:10px;bottom:32px;z-index:20;color:#9ff;background:#002b2b;padding:5px;font:12px monospace'; document.body.appendChild(el); }
  }
  window.SignBuilder = SignBuilder;
})();
