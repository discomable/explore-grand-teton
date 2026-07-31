/* BridgeBuilder — DERIVED bridge decks where roads cross water (three.js r184). M6 v2.
 *
 * WHY v1 FAILED (twice, reverted): it computed its OWN bank-interpolated deck datum and handed the
 * ribbons a deckOverride they re-graded ON TOP OF, while the car physics still read raw DEM — THREE
 * height computations that never agreed (floating deck, separate road, car in the lakebed, 90° flip
 * at the deck edge). See docs/ROADMAP-DESIGN-DOCS.html §01.
 *
 * v2 — ONE SURFACE, READ EVERYWHERE. BridgeBuilder owns NO height. It only:
 *   1) DETECTS crossings: dry-bounded over-water runs, MERGED across short dry mid-channel bars (a
 *      braided river is ONE crossing), with an opposite-banks test (the straight bank-to-bank chord
 *      must be mostly OVER water) so a road clipping a pond edge is rejected.
 *   2) exposes bridgeFloor(x,z): a CLEARANCE FLOOR (not an elevation) shaped as a FLAT, ELEVATED,
 *      CONSTANT-level deck over the water plus a smooth RAMP down to the bank on each side. RoadRibbon
 *      folds this into its ONE grading pass (max(ground,floor)) — because the floor sits above the
 *      terrain across the whole bridge+ramp region, the graded profile BECOMES the floor there: a
 *      dead-level deck with gently ramped approaches. The ribbon then publishes drivableSurfaceAt(x,z)
 *      and sampleGround (physics) folds THAT in over the WHOLE region (deck AND ramps) — so the car
 *      rides the raised road onto the deck instead of clipping through the rise.
 *   3) build(roadRibbon) draws the visible deck/curb/metal guardrails/piers PINNED to
 *      roadRibbon.drivableSurfaceAt. Deck top ≡ the running surface; no independent datum.
 *      deckEdgeBlocked(x,z) gives the guardrails real collision so a vehicle can't go over the side.
 *
 *   const bb = await new BridgeBuilder({scene, terrain, sampleGround, water, roadsUrl}).detect();
 *   const rr = await new RoadRibbon({..., bridgeFloor: bb.bridgeFloor}).build();
 *   bb.build(rr);   // AFTER the ribbons
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const SPAN_MIN  = 6;     // m
  const MERGE_GAP = 90;    // m — dry gaps shorter than this are mid-channel BARS of ONE braided
                           // crossing (the Snake at Moose): merge the wet runs into a single span so
                           // the whole thing gets ONE flat deck, not a per-channel patchwork
  const MERGE_MAX = 400;   // m — a merged crossing longer than this is lakeshore-parallel → reject
  const BAR_CLEAR = 0.6;   // m — the flat deck must clear the tallest mid-channel bar by this, so no
                           // terrain pokes up through the level deck
  const STEP      = 6.0;   // m — centreline densify spacing for the water test
  const CHORD_WET = 0.5;   // opposite-banks gate: >=50% of the straight bank-to-bank chord over water
                           // (braided crossings interleave water + bars, so not ~100%)
  const FREEBOARD = 3.0;   // m — pre-LIFT clearance of the flat deck above the water surface
  const RAMP_LEN  = 24;    // m — approach ramp each side: deck level eases down to the bank road here
  const RAMP_DROP = 1.5;   // m — floor dips this far below bank terrain at the ramp's outer end so the
                           // natural road grade cleanly resumes past it (no step)
  const FLOOR_PAD = 5.0;   // m — bridgeFloor match tolerance past the carriageway half (splined drift)
  const CURB_W    = 0.28;  // m — deck edge past the carriageway (thin concrete curb under the rail)
  const DECK_THICK= 0.85;  // m — deck slab depth
  const TOP_INSET = 0.04;  // m — deck top set just below the ribbon running surface (anti z-fight)
  const RAIL_H    = 0.95;  // m — guardrail height above the deck top
  const RAIL_MID  = 0.52;  // m — lower rail height
  const POST_SPAN = 3.2;   // m — guardrail post spacing
  const PIER_SPAN = 30;    // m — spacing of intermediate piers
  const PIER_HW   = 0.6;   // m — pier half-width
  const CAR_HALF  = 1.0;   // m — vehicle half-width used for guardrail collision
  const LIFT      = 0.25;  // MIRRORS RoadRibbon.LIFT — asphalt (thus deck top) rides this above the
                           // pre-LIFT graded profile that drivableSurfaceAt returns
  const CELL      = 32;

  // carriageway width per class (identical to RoadRibbon CLS.w) → deck half = w/2 + curb
  const CW = { highway: 9.0, park_paved: 7.5, gravel: 5.0, track: 3.0 };

  const d2 = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

  class BridgeBuilder {
    constructor(o) {
      this.scene = o.scene; this.terrain = o.terrain;
      // RAW bed height, bypassing any bridge fold-in in the app's sampleGround — piers and bank
      // references must read the real ground under the water, never the deck they hold up.
      this._raw = this.terrain ? (x, z) => this.terrain.heightAt(x, z)
                                : (o.sampleGround || ((x, z) => 0));
      this.water = o.water || null;
      this.roadsUrl = o.roadsUrl || 'terrain/public/roads.json';
      this.spans = [];
      this._floorGrid = new Map();   // CELL-hashed floor segments → bridgeFloor(x,z)
      this._deckGrid = new Map();    // CELL-hashed deck segments → deckEdgeBlocked(x,z)
      this.group = new THREE.Group(); this.group.name = 'transportStructures'; this.scene.add(this.group);
      this.matDeck = new THREE.MeshStandardMaterial({ color: 0x8a8c8f, roughness: 0.9, metalness: 0.0 });   // pale concrete
      this.matPier = new THREE.MeshStandardMaterial({ color: 0x7f7c78, roughness: 1.0, metalness: 0.0 });   // grey concrete
      this.matRail = new THREE.MeshStandardMaterial({ color: 0xacb2b8, roughness: 0.4,
        metalness: 0.85, side: THREE.DoubleSide });  // galvanised steel
      this.matJoint = new THREE.MeshStandardMaterial({ color: 0x25282a, roughness: 0.72, metalness: 0.18 });
      this.stats = { bridges: 0, tris: 0 };
      // stable bound identities handed out (must not be re-created per call)
      this.bridgeFloor = (x, z) => this._floorAt(x, z);
    }

    async detect() {
      if (this.water && this.water._ready) { try { await this.water._ready; } catch (e) {} }
      let list;
      try { list = await this._json(this.roadsUrl); }
      catch (e) { console.info('[BridgeBuilder] roads.json unavailable — no bridges.', e && e.message || e); return this; }
      if (!this.water) { console.info('[BridgeBuilder] no water builder — no bridges.'); return this; }
      for (const w of list || []) this._scan(w);
      this._indexFloor();
      this._indexDeck();
      console.info('[BridgeBuilder] detected', this.spans.length, 'bridge crossing(s)');
      return this;
    }

    _wet(x, z) { return this.water.surfaceAt(x, z) !== null; }

    /* densify a way, find dry-bounded wet runs, MERGE runs split by short dry bars into one braided
       crossing, and add each merged crossing that passes the opposite-banks test */
    _scan(way) {
      const cls = (way.class in CW) ? way.class : 'track';
      const P = this._densify(way.pts);
      if (!P) return;
      const wet = P.map(p => this._wet(p[0], p[1]));
      const n = P.length;
      const cum = new Float64Array(n);
      for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + d2(P[k - 1][0], P[k - 1][1], P[k][0], P[k][1]);
      // dry-bounded wet runs [i, j): wet on i..j-1, dry anchors at i-1 and j
      const runs = []; let i = 0;
      while (i < n) {
        if (!wet[i]) { i++; continue; }
        let j = i; while (j < n && wet[j]) j++;
        if (i > 0 && j < n) runs.push({ i, j });
        i = j;
      }
      if (!runs.length) return;
      // merge runs separated by a dry gap < MERGE_GAP (mid-channel bars belong to one crossing)
      let cur = { i: runs[0].i, j: runs[0].j };
      for (let r = 1; r < runs.length; r++) {
        if (cum[runs[r].i - 1] - cum[cur.j] < MERGE_GAP) cur.j = runs[r].j;   // extend over the bar
        else { this._tryAdd(cls, P, cum, cur); cur = { i: runs[r].i, j: runs[r].j }; }
      }
      this._tryAdd(cls, P, cum, cur);
    }

    _tryAdd(cls, P, cum, run) {
      const a = P[run.i - 1], b = P[run.j], L = cum[run.j] - cum[run.i - 1];
      if (L >= SPAN_MIN && L <= MERGE_MAX && this._chordWet(a, b) >= CHORD_WET)
        this._addSpan(cls, P.slice(run.i - 1, run.j + 1));   // dry anchor + crossing (water+bars) + dry anchor
    }

    /* fraction of the STRAIGHT chord a→b over water. A genuine crossing spans open water (high);
       a road clipping a pond edge keeps its chord along the dry bank (low). */
    _chordWet(a, b) {
      const L = d2(a[0], a[1], b[0], b[1]); if (L < 1) return 0;
      const steps = Math.max(2, Math.ceil(L / STEP)); let wet = 0;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        if (this._wet(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) wet++;
      }
      return wet / (steps + 1);
    }

    /* build a span: a FLAT deck level over the crossing + a ramp node each side. The floor profile is
       deckY across the whole deck (dead level), easing down to (bank-RAMP_DROP) over RAMP_LEN. */
    _addSpan(cls, arc) {
      const half = CW[cls] * 0.5;
      const a = arc[0], b = arc[arc.length - 1];               // dry bank anchors
      const hA = this._raw(a[0], a[1]), hB = this._raw(b[0], b[1]);
      // ONE water level for the whole crossing (highest sample) + the tallest mid-channel bar, so the
      // single flat deck clears water AND every bar — nothing pokes up through the level deck.
      let wY = -Infinity, barY = -Infinity;
      for (let k = 0; k < arc.length; k++) {
        const p = arc[k], s = this.water.surfaceAt(p[0], p[1]);
        if (s !== null && s > wY) wY = s;
        if (k > 0 && k < arc.length - 1) { const g = this._raw(p[0], p[1]); if (g > barY) barY = g; }
      }
      if (wY === -Infinity) wY = Math.min(hA, hB);
      let deckY = Math.max(wY + FREEBOARD, hA, hB);             // flat, elevated, >= both banks
      if (barY > -Infinity) deckY = Math.max(deckY, barY + BAR_CLEAR);   // …and clears mid-channel bars

      // outward ramp anchors (extend the road line past each bank away from the deck)
      const dirA = this._unit(a[0] - arc[1][0], a[1] - arc[1][1]);
      const dirB = this._unit(b[0] - arc[arc.length - 2][0], b[1] - arc[arc.length - 2][1]);
      const rampA = [a[0] + dirA[0] * RAMP_LEN, a[1] + dirA[1] * RAMP_LEN];
      const rampB = [b[0] + dirB[0] * RAMP_LEN, b[1] + dirB[1] * RAMP_LEN];

      // full centreline (floor index): rampA → [deck nodes] → rampB, with a floor value per node
      const nodes = [];
      nodes.push({ x: rampA[0], z: rampA[1], floor: hA - RAMP_DROP, deck: false });
      for (const p of arc) nodes.push({ x: p[0], z: p[1], floor: deckY, deck: true });
      nodes.push({ x: rampB[0], z: rampB[1], floor: hB - RAMP_DROP, deck: false });
      let s = 0;
      for (let k = 0; k < nodes.length; k++) { if (k > 0) s += d2(nodes[k - 1].x, nodes[k - 1].z, nodes[k].x, nodes[k].z); nodes[k].s = s; }

      const deckCl = nodes.filter(nd => nd.deck).map(nd => ({ x: nd.x, z: nd.z }));
      let ds = 0; for (let k = 0; k < deckCl.length; k++) { if (k > 0) ds += d2(deckCl[k - 1].x, deckCl[k - 1].z, deckCl[k].x, deckCl[k].z); deckCl[k].s = ds; }

      this.spans.push({ cls, deckY, cl: nodes, deckCl,
        hwFloor: half + FLOOR_PAD, hwDeck: half + CURB_W, hwBlock: half + CURB_W });
    }

    /* ---- bridgeFloor(x,z): interpolated floor along any span centreline, null elsewhere ---- */
    _indexFloor() {
      this._floorGrid.clear();
      for (const span of this.spans) {
        for (let k = 0; k + 1 < span.cl.length; k++) {
          const A = span.cl[k], B = span.cl[k + 1];
          this._raster(this._floorGrid, A.x, A.z, B.x, B.z,
            { ax: A.x, az: A.z, bx: B.x, bz: B.z, fa: A.floor, fb: B.floor, hw: span.hwFloor });
        }
      }
    }

    _floorAt(x, z) {
      if (!this._floorGrid.size) return null;
      let best = null, bd = Infinity;
      this._each(this._floorGrid, x, z, (s) => {
        const r = this._project(x, z, s.ax, s.az, s.bx, s.bz);
        if (r.d <= s.hw && r.d < bd) { bd = r.d; best = s.fa + (s.fb - s.fa) * r.t; }
      });
      return best;
    }

    /* ---- deckEdgeBlocked(x,z): true just inside the guardrail line, over the deck (collision) ---- */
    _indexDeck() {
      this._deckGrid.clear();
      for (const span of this.spans) {
        for (let k = 0; k + 1 < span.deckCl.length; k++) {
          const A = span.deckCl[k], B = span.deckCl[k + 1];
          this._raster(this._deckGrid, A.x, A.z, B.x, B.z,
            { ax: A.x, az: A.z, bx: B.x, bz: B.z, hw: span.hwBlock });
        }
      }
    }

    deckEdgeBlocked(x, z) {
      if (!this._deckGrid.size) return false;
      let blocked = false;
      this._each(this._deckGrid, x, z, (s) => {
        const r = this._project(x, z, s.ax, s.az, s.bx, s.bz);
        // block a band from the lane edge out past the rail — keeps the car body inside the barrier
        if (r.t > 0 && r.t < 1 && r.d > s.hw - CAR_HALF && r.d < s.hw + 3) blocked = true;
      });
      return blocked;
    }

    /* Sweep the vehicle centre against both deck rails.  The returned normal always points
       toward the usable deck interior and safeX/safeZ are already separated from the rail.
       Fixed-step driving normally travels only a few centimetres per call, but subdividing by
       radius also prevents tunnelling when a stalled frame consumes its catch-up steps. */
    sweepDeckBarrier(from, to, shape, outHit = {}) {
      if (!this._deckGrid.size) return false;
      const radius = Math.max(0.1, Number(shape && shape.radius) || CAR_HALF);
      const dx = to.x - from.x, dz = to.z - from.z;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / Math.max(.25, radius * .5)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, x = from.x + dx * t, z = from.z + dz * t;
        let best = null;
        this._each(this._deckGrid, x, z, (s) => {
          const sx = s.bx - s.ax, sz = s.bz - s.az, len = Math.hypot(sx, sz);
          if (!len) return;
          const along = ((x - s.ax) * sx + (z - s.az) * sz) / (len * len);
          // Rails stop at the bridge ends; approaches must remain open.
          if (along <= 0 || along >= 1) return;
          const leftX = -sz / len, leftZ = sx / len;
          const lateral = (x - (s.ax + along * sx)) * leftX +
            (z - (s.az + along * sz)) * leftZ;
          const limit = Math.max(.05, s.hw - radius);
          const penetration = Math.abs(lateral) - limit;
          if (penetration < 0 || (best && penetration <= best.penetration)) return;
          const side = lateral < 0 ? -1 : 1;
          best = { s, along, leftX, leftZ, limit, side, penetration };
        });
        if (!best) continue;
        const cx = best.s.ax + best.along * (best.s.bx - best.s.ax);
        const cz = best.s.az + best.along * (best.s.bz - best.s.az);
        const normalX = -best.leftX * best.side, normalZ = -best.leftZ * best.side;
        Object.assign(outHit, {
          t, x, z, normalX, normalZ,
          safeX: cx + best.leftX * best.side * (best.limit - .02),
          safeZ: cz + best.leftZ * best.side * (best.limit - .02),
          penetration: best.penetration,
          kind: 'bridge_rail',
        });
        return true;
      }
      return false;
    }

    /* ---- visible geometry: deck top ≡ roadRibbon.drivableSurfaceAt + LIFT (never a new datum) ---- */
    build(roadRibbon) {
      if (!this.spans.length) return this;
      const rr = roadRibbon || null;
      for (const span of this.spans) {
        for (const v of span.deckCl) {
          let run = rr && rr.drivableSurfaceAt ? rr.drivableSurfaceAt(v.x, v.z) : null;
          if (run === null || run === undefined) run = span.deckY;   // flat fallback
          v.y = run + LIFT;                                          // running-surface (asphalt) top
        }
      }
      const D = { p: [], i: [] }, P = { p: [], i: [] }, R = { p: [], i: [] }, J = { p: [], i: [] };
      for (const span of this.spans) {
        this._emitDeck(span, D); this._emitBarrier(span, R); this._emitPiers(span, P);
        this._emitExpansionJoints(span, J);
      }
      this._mesh(D, this.matDeck, 3); this._mesh(P, this.matPier, 2);
      this._mesh(R, this.matRail, 4); this._mesh(J, this.matJoint, 5);
      this.stats = { bridges: this.spans.length,
        tris: (D.i.length + P.i.length + R.i.length + J.i.length) / 3 };
      console.info('[BridgeBuilder] built', this.stats.bridges, 'bridge(s),', this.stats.tris, 'tris');
      return this;
    }

    _perp(cl, k) {
      const a = cl[Math.max(0, k - 1)], b = cl[Math.min(cl.length - 1, k + 1)];
      return this._unit(-(b.z - a.z), b.x - a.x);
    }

    _emitDeck(span, B) {
      const cl = span.deckCl, hw = span.hwDeck, base = B.p.length / 3;
      for (let k = 0; k < cl.length; k++) {
        const v = cl[k], pp = this._perp(cl, k), top = v.y - TOP_INSET, bot = v.y - DECK_THICK;
        B.p.push(v.x + pp[0] * hw, top, v.z + pp[1] * hw);  // 0 Ltop
        B.p.push(v.x - pp[0] * hw, top, v.z - pp[1] * hw);  // 1 Rtop
        B.p.push(v.x + pp[0] * hw, bot, v.z + pp[1] * hw);  // 2 Lbot
        B.p.push(v.x - pp[0] * hw, bot, v.z - pp[1] * hw);  // 3 Rbot
      }
      for (let k = 0; k + 1 < cl.length; k++) {
        const o = base + k * 4, o2 = base + (k + 1) * 4;
        B.i.push(o, o2, o2 + 1, o, o2 + 1, o + 1);              // top
        B.i.push(o + 2, o + 3, o2 + 3, o + 2, o2 + 3, o2 + 2);  // underside
        B.i.push(o, o + 2, o2 + 2, o, o2 + 2, o2);              // left fascia
        B.i.push(o + 1, o2 + 1, o2 + 3, o + 1, o2 + 3, o + 3);  // right fascia
      }
    }

    /* Narrow dark expansion joints at both deck ends. They sit millimetres above the wearing
       surface, so they read visually without introducing a physics step or competing datum. */
    _emitExpansionJoints(span, B) {
      const cl = span.deckCl;
      if (cl.length < 2) return;
      for (const k of [0, cl.length - 1]) {
        const v = cl[k], pp = this._perp(cl, k);
        const nb = cl[k === 0 ? 1 : k - 1];
        let dx = nb.x - v.x, dz = nb.z - v.z;
        if (k !== 0) { dx = -dx; dz = -dz; }
        const dl = Math.hypot(dx, dz) || 1, tx = dx / dl * .10, tz = dz / dl * .10;
        const hw = span.hwDeck - .08, y = v.y + .008, base = B.p.length / 3;
        B.p.push(v.x + pp[0] * hw - tx, y, v.z + pp[1] * hw - tz);
        B.p.push(v.x - pp[0] * hw - tx, y, v.z - pp[1] * hw - tz);
        B.p.push(v.x + pp[0] * hw + tx, y, v.z + pp[1] * hw + tz);
        B.p.push(v.x - pp[0] * hw + tx, y, v.z - pp[1] * hw + tz);
        B.i.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }

    /* metal guardrail: two horizontal steel beams + posts along each deck edge */
    _emitBarrier(span, B) {
      const cl = span.deckCl, hw = span.hwDeck, total = cl[cl.length - 1].s;
      for (const sgn of [1, -1]) {
        // beam ribbons at RAIL_MID and RAIL_H (a thin vertical strip reads as a beam at distance)
        for (const rh of [RAIL_MID, RAIL_H]) {
          const beamBase = B.p.length / 3;
          for (let k = 0; k < cl.length; k++) {
            const v = cl[k], pp = this._perp(cl, k), ex = v.x + pp[0] * hw * sgn, ez = v.z + pp[1] * hw * sgn;
            B.p.push(ex, v.y + rh - 0.05, ez); B.p.push(ex, v.y + rh + 0.05, ez);
          }
          for (let k = 0; k + 1 < cl.length; k++) { const o = beamBase + k * 2, o2 = beamBase + (k + 1) * 2;
            B.i.push(o, o + 1, o2 + 1, o, o2 + 1, o2); }
        }
      }
      // posts (both edges) every POST_SPAN along the deck
      const at = (s) => {
        for (let k = 0; k + 1 < cl.length; k++) { const A = cl[k], C = cl[k + 1];
          if (s <= C.s || k + 2 === cl.length) { const t = (C.s - A.s) > 0 ? (s - A.s) / (C.s - A.s) : 0;
            return { x: A.x + (C.x - A.x) * t, z: A.z + (C.z - A.z) * t, y: A.y + (C.y - A.y) * t, k }; } }
        const L = cl[cl.length - 1]; return { x: L.x, z: L.z, y: L.y, k: cl.length - 2 };
      };
      for (let s = 0; s <= total + 0.01; s += POST_SPAN) {
        const p = at(Math.min(s, total)), pp = this._perp(cl, p.k);
        for (const sgn of [1, -1])
          this._box(B, p.x + pp[0] * hw * sgn, p.y + RAIL_H * 0.5, p.z + pp[1] * hw * sgn, 0.06, RAIL_H * 0.5, 0.06);
      }
    }

    _box(B, cx, cy, cz, sx, sy, sz) {
      const b = B.p.length / 3;
      for (const yy of [cy - sy, cy + sy]) for (const zz of [cz - sz, cz + sz]) for (const xx of [cx - sx, cx + sx])
        B.p.push(xx, yy, zz);
      const q = (a, c, d, e) => B.i.push(b + a, b + c, b + d, b + a, b + d, b + e);
      q(0, 1, 3, 2); q(4, 6, 7, 5); q(0, 4, 5, 1); q(2, 3, 7, 6); q(0, 2, 6, 4); q(1, 5, 7, 3);
    }

    /* piers + abutments dropped from the deck underside to the bed (raw terrain) at PIER_SPAN spacing */
    _emitPiers(span, B) {
      const cl = span.deckCl, total = cl[cl.length - 1].s;
      const at = (s) => {
        for (let k = 0; k + 1 < cl.length; k++) { const A = cl[k], C = cl[k + 1];
          if (s <= C.s || k + 2 === cl.length) { const t = (C.s - A.s) > 0 ? (s - A.s) / (C.s - A.s) : 0;
            return { x: A.x + (C.x - A.x) * t, z: A.z + (C.z - A.z) * t, y: (A.y + (C.y - A.y) * t) - DECK_THICK }; } }
        const L = cl[cl.length - 1]; return { x: L.x, z: L.z, y: L.y - DECK_THICK };
      };
      for (let s = 0; s <= total + 0.01; s += PIER_SPAN) {
        const p = at(Math.min(s, total)), g = this._raw(p.x, p.z);
        const isBank = (s < 0.01 || s > total - 0.01), hw = isBank ? PIER_HW * 1.8 : PIER_HW;
        const h = Math.max(0.5, p.y - g);
        this._box(B, p.x, g + h * 0.5, p.z, hw, h * 0.5 + 0.1, hw);
      }
    }

    _mesh(B, mat, ro) {
      if (!B.p.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
      g.setIndex(B.i); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = ro; m.frustumCulled = false; m.receiveShadow = true;
      this.group.add(m);
    }

    /* ---- small shared helpers ---- */
    _unit(dx, dz) { const l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; }

    _project(x, z, ax, az, bx, bz) {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      return { t, d: Math.hypot(x - (ax + t * dx), z - (az + t * dz)) };
    }

    _raster(grid, ax, az, bx, bz, payload) {
      const steps = Math.max(1, Math.ceil(d2(ax, az, bx, bz) / CELL));
      let last = null;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const key = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
        if (key === last) continue; last = key;
        let a = grid.get(key); if (!a) { a = []; grid.set(key, a); }
        a.push(payload);
      }
    }

    _each(grid, x, z, fn) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const arr = grid.get((cx + di) + ',' + (cz + dj)); if (!arr) continue;
        for (const s of arr) fn(s);
      }
    }

    _densify(pts) {
      if (!pts || pts.length < 2) return null;
      const out = [[pts[0][0], pts[0][1]]];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], L = d2(a[0], a[1], b[0], b[1]);
        const steps = Math.max(1, Math.ceil(L / STEP));
        for (let s = 1; s <= steps; s++) { const t = s / steps; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      return out;
    }

    async _json(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  }

  global.BridgeBuilder = BridgeBuilder;
})(window);
