const DEFAULTS = Object.freeze({
  highway: { priority: 40, kind: 'major_highway', surface: 'asphalt', grip: 1, roughness: .08, rollingResistance: .012, speedLimit: 24.6, vehicleAllowed: true, pedestrianAllowed: true },
  park_paved: { priority: 30, kind: 'park_paved_road', surface: 'asphalt', grip: .96, roughness: .1, rollingResistance: .014, speedLimit: 15.6, vehicleAllowed: true, pedestrianAllowed: true },
  gravel: { priority: 20, kind: 'gravel_road', surface: 'gravel', grip: .72, roughness: .3, rollingResistance: .035, speedLimit: 11.2, vehicleAllowed: true, pedestrianAllowed: true },
  track: { priority: 10, kind: 'vehicle_two_track', surface: 'dirt', grip: .58, roughness: .55, rollingResistance: .06, speedLimit: 8.9, vehicleAllowed: true, pedestrianAllowed: true },
  trail: { priority: 4, kind: 'maintained_trail', surface: 'packed_dirt', grip: .45, roughness: .4, rollingResistance: .08, speedLimit: 0, vehicleAllowed: false, pedestrianAllowed: true },
  primitive_trail: { priority: 3, kind: 'primitive_trail', surface: 'dirt', grip: .4, roughness: .6, rollingResistance: .1, speedLimit: 0, vehicleAllowed: false, pedestrianAllowed: true },
  steps: { priority: 6, kind: 'steps', surface: 'stone', grip: .75, roughness: .65, rollingResistance: 1, speedLimit: 0, vehicleAllowed: false, pedestrianAllowed: true },
  boardwalk: { priority: 7, kind: 'boardwalk', surface: 'wood', grip: .72, roughness: .2, rollingResistance: 1, speedLimit: 0, vehicleAllowed: false, pedestrianAllowed: true },
});

const resultDefaults = Object.freeze({
  y: 0, normalX: 0, normalY: 1, normalZ: 0, tangentX: 0, tangentZ: 1,
  lateralOffset: 0, halfWidth: 0, featureId: null, kind: null, surface: null,
  grip: 0, roughness: 0, rollingResistance: 0, speedLimit: 0, structureId: null,
  vehicleAllowed: false, pedestrianAllowed: false,
});

/* Populate a sample/nearest result from a segment and its recipe. Reproduces exactly what
   `Object.assign(out, resultDefaults, segment)` produced when every segment carried its own copy
   of the recipe: defaults, then the feature's recipe fields, then the segment's own geometry. */
function assignSegment(out, s, r) {
  Object.assign(out, resultDefaults, r);
  out.ax = s.ax; out.ay = s.ay; out.az = s.az;
  out.bx = s.bx; out.by = s.by; out.bz = s.bz;
  out.crossfall = s.crossfall;
  return out;
}

/* Triangles are stored as a struct of arrays over a deduplicated vertex pool, not as one JS
   object per triangle. The park publishes on the order of 1.4 M authored triangles (≈800 k road
   + ≈630 k trail), and the object-per-triangle form cost hundreds of megabytes of heap in
   headers and pointers alone before the spatial index was even counted. Vertices are shared
   exactly as before — adjacent strip triangles reference the same pool slot — so re-drape still
   moves one value and every triangle touching it follows.

   Both spatial indexes are CSR (compressed sparse row): a start offset per occupied cell plus
   one flat Int32Array of members, built once after a mutation instead of a Map of string keys
   holding millions of boxed array entries. Cell keys are exact integers, so a query no longer
   allocates a `${x},${z}` string per probed cell — that path runs several times per wheel per
   120 Hz physics substep. */
const VERTEX_STRIDE = 6;      // x, y, z, nx, ny, nz
const CELL_BIAS = 2097152;    // 2^21: cell coords are ±~650 at cellSize 32, so this never wraps
const CELL_SPAN = 4194304;    // 2^22; key stays well inside Number.MAX_SAFE_INTEGER

export class TransportSurface {
  constructor({ cellSize = 32 } = {}) {
    this.cellSize = cellSize;
    this._segments = [];
    this.revision = 0;
    this._batchDepth = 0;
    this._batchDirty = false;
    this._snapshotCache = null;
    this._resetGeometry();
  }

  _resetGeometry() {
    // Float32, not Float64: every authored coordinate and normal originates from a
    // Float32BufferAttribute on the rendered geometry (see publishTransportSurface), so the wider
    // slot stored a float32 value in 8 bytes and bought no precision. At 1.6 M vertices that is
    // ~50 MB of pure waste.
    this._vertexData = new Float32Array(0);   // VERTEX_STRIDE per vertex
    this._vertexSrc = new Int32Array(0);      // 3 per vertex: posAttrId, nrmAttrId, sourceIndex
    this._vertexCount = 0;
    this._vertexOf = new Map();               // source point object -> pool slot (build-time)
    this._srcAttrs = [];                      // distinct BufferAttributes referenced by vertices
    this._triVerts = new Int32Array(0);       // 3 per triangle
    this._triArea = new Float64Array(0);
    this._triMeta = new Int32Array(0);        // index into _recipes
    this._triCount = 0;
    this._recipes = [];
    this._recipeOf = new Map();
    this._segCells = null;                    // CSR: {index, start, items}
    this._triCells = null;
    this._indexDirty = true;
    this._seenStamp = new Int32Array(0);      // generation stamps replace a per-probe Set
    this._seenGen = 0;
  }

  clear() {
    this._snapshotCache = null;
    this._segments.length = 0;
    this._resetGeometry();
    this._touch();
  }

  // exact integer cell key; replaces `${x},${z}`
  _cellKey(cx, cz) { return (cx + CELL_BIAS) * CELL_SPAN + (cz + CELL_BIAS); }

  get _triangleCount() { return this._triCount; }

  beginUpdate() {
    this._batchDepth++;
  }

  endUpdate() {
    if (this._batchDepth <= 0) throw new Error('unbalanced TransportSurface.endUpdate');
    this._batchDepth--;
    if (!this._batchDepth && this._batchDirty) {
      this._batchDirty = false;
      this.revision++;
    }
    // Seal the spatial index while the publisher still holds the floor. _ensureIndex is a single
    // blocking pass over every member; letting it fire lazily on the first query would drop that
    // cost into an arbitrary later frame as a visible hitch instead of the boot publish window.
    if (!this._batchDepth) this._ensureIndex();
  }

  /* Segments hold geometry plus ONE shared reference to their feature's recipe, instead of
     spreading the ~25-property recipe into every one of them. At the park's ~384k segments that
     is 112 B each rather than 376 B, and it is also about twice as fast to query: the hot object
     is a third of the size and the recipe stays resident in cache across the whole feature.
     (A prototype would keep `segment.kind` working directly, but ~2000 distinct prototypes made
     the nearest-segment loop megamorphic and 47x slower — measured, not assumed.) */
  addPolyline(points, options = {}) {
    if (!points || points.length < 2) return;
    const recipe = Object.freeze({ ...(DEFAULTS[options.classification] || DEFAULTS.track), ...options });
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      if (dx * dx + dz * dz < 1e-8) continue;
      const crossfall = Number.isFinite(a.crossfall) && Number.isFinite(b.crossfall)
        ? (a.crossfall + b.crossfall) * .5 : recipe.crossfall || 0;
      // Frozen at birth: nothing mutates a segment after this point, so snapshot() can hand out
      // these very objects instead of cloning all ~384k of them per publish.
      const segment = Object.freeze({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
        crossfall, recipe });
      this._segments.push(segment);      // spatial index is (re)built lazily in _ensureIndex
      this._indexDirty = true;
    }
    this._touch();
  }

  // Publish the actual rendered cross-sections. Each section is ordered left-to-right
  // and contains {x,y,z}; adjacent sections must have the same vertex count.
  addStrip(crossSections, options = {}) {
    if (!crossSections || crossSections.length < 2) return;
    const recipe = { ...(DEFAULTS[options.classification] || DEFAULTS.track), ...options };
    const width = crossSections[0].length;
    if (width < 2 || crossSections.some(s => !s || s.length !== width))
      throw new Error('TransportSurface.addStrip requires equal cross-sections');
    // Retain a centreline solely for nearest/exclusion/map consumers. sample() never
    // consults it when authored triangles are present.
    const centers = crossSections.map(section => {
      const a = section[(width - 1) >> 1], b = section[width >> 1];
      return { x: (a.x + b.x) * .5, y: (a.y + b.y) * .5, z: (a.z + b.z) * .5 };
    });
    let halfWidth = recipe.halfWidth;
    if (!(halfWidth > 0)) {
      const s = crossSections[0], a = s[0], b = s[s.length - 1];
      halfWidth = Math.hypot(b.x - a.x, b.z - a.z) * .5;
    }
    this.addPolyline(centers, { ...recipe, halfWidth, authoredStrip: true });
    const metadata = Object.freeze(recipe);
    for (let r = 0; r + 1 < crossSections.length; r++) {
      const a = crossSections[r], b = crossSections[r + 1];
      for (let c = 0; c + 1 < width; c++) {
        this._addTriangle(a[c], b[c], a[c + 1], metadata);
        this._addTriangle(a[c + 1], b[c], b[c + 1], metadata);
      }
    }
    this._touch();
  }

  // Triangles may be [[a,b,c], ...] or a flat [a,b,c,...] array.
  addPatch(triangles, options = {}) {
    if (!triangles || !triangles.length) return;
    const recipe = Object.freeze({
      ...(DEFAULTS[options.classification] || DEFAULTS.track), ...options,
    });
    const nested = Array.isArray(triangles[0]);
    if (nested) for (const tri of triangles) {
      if (tri && tri.length === 3) this._addTriangle(tri[0], tri[1], tri[2], recipe);
    }
    else for (let i = 0; i + 2 < triangles.length; i += 3)
      this._addTriangle(triangles[i], triangles[i + 1], triangles[i + 2], recipe);
    this._touch();
  }

  // XZ topology is immutable during terrain re-drape. Refresh shared authored vertices in
  // place without rebuilding triangle objects or spatial buckets; JavaScript's run-to-
  // completion semantics make this an atomic publication to all query consumers.
  syncAuthoredGeometry() {
    if (!this._vertexCount) return false;
    const d = this._vertexData, s = this._vertexSrc, attrs = this._srcAttrs;
    let touched = false;
    for (let v = 0; v < this._vertexCount; v++) {
      const so = v * 3, posId = s[so], i = s[so + 2];
      if (posId < 0 || i < 0) continue;
      const o = v * VERTEX_STRIDE;
      d[o + 1] = attrs[posId].getY(i);
      const nrmId = s[so + 1];
      if (nrmId >= 0) {
        const normal = attrs[nrmId];
        d[o + 3] = normal.getX(i); d[o + 4] = normal.getY(i); d[o + 5] = normal.getZ(i);
      }
      touched = true;
    }
    if (!touched) return false;
    // XZ topology is unchanged by a re-drape, so the cell membership of every triangle and
    // segment still holds — only Y moved. The CSR indexes stay valid.
    this._touch();
    return true;
  }

  sample(x, z, out = {}, mask = null) {
    const exact = this._sampleTriangle(x, z, mask && mask.filter);
    if (exact) {
      Object.assign(out, resultDefaults, exact.tri.metadata);
      out.y = exact.y;
      out.normalX = exact.nx; out.normalY = exact.ny; out.normalZ = exact.nz;
      out.lateralOffset = exact.lateralOffset;
      out.halfWidth = exact.tri.metadata.halfWidth || 0;
      out.distance = Math.abs(exact.lateralOffset);
      return true;
    }
    // Legacy polylines remain supported for callers/tests, but authored strips never
    // extrapolate beyond their triangles (including when a wheel margin is supplied).
    const margin = Math.max(0, Number(mask && mask.margin) || 0);
    const filter = r => !r.authoredStrip && (!mask?.filter || mask.filter(r));
    const found = this._nearestSegment(x, z, mask && mask.radius, filter, true, margin);
    if (!found) return false;
    const { s, r, t, lateral, distance } = found;
    assignSegment(out, s, r);
    // A small vehicle-only margin covers rendered shoulders and junction mouths. Clamp the
    // profile evaluation at the carriageway edge so a wheel cannot inherit raw-terrain bumps
    // merely because its contact patch is a few centimetres beyond the centreline corridor.
    const surfaceLateral = Math.max(-r.halfWidth, Math.min(r.halfWidth, lateral));
    out.y = s.ay + (s.by - s.ay) * t + (s.crossfall || 0) * surfaceLateral;
    const dx = s.bx - s.ax, dz = s.bz - s.az, dy = s.by - s.ay;
    const len = Math.hypot(dx, dz);
    out.tangentX = dx / len; out.tangentZ = dz / len;
    const nx = out.tangentZ * (s.crossfall || 0) - out.tangentX * dy / len;
    const nz = -out.tangentX * (s.crossfall || 0) - out.tangentZ * dy / len;
    const nl = Math.hypot(nx, 1, nz);
    out.normalX = nx / nl; out.normalY = 1 / nl; out.normalZ = nz / nl;
    out.lateralOffset = lateral;
    out.halfWidth = r.halfWidth;
    out.distance = distance;
    return true;
  }

  heightAt(x, z, mode = 'any') {
    const out = {};
    const filter = mode === 'drive' ? s => s.vehicleAllowed : mode === 'walk' ? s => s.pedestrianAllowed : null;
    return this.sample(x, z, out, { filter }) ? out.y : null;
  }

  nearest(x, z, radius, filter, out = {}) {
    const found = this._nearestSegment(x, z, radius, filter, false);
    if (!found) return false;
    const { s, r, t, lateral, distance } = found;
    assignSegment(out, s, r);
    out.y = s.ay + (s.by - s.ay) * t + (s.crossfall || 0) * lateral;
    const dx = s.bx - s.ax, dz = s.bz - s.az, len = Math.hypot(dx, dz);
    out.tangentX = dx / len; out.tangentZ = dz / len;
    out.lateralOffset = lateral; out.halfWidth = r.halfWidth; out.distance = distance;
    return true;
  }

  exclusionAt(x, z, out = {}) {
    const found = this._nearestSegment(x, z, 20, null, false);
    if (!found) return false;
    out.featureId = found.r.featureId;
    out.kind = found.r.kind;
    out.distance = found.distance;
    out.halfWidth = found.r.halfWidth;
    out.clearance = found.r.halfWidth + (found.r.vehicleAllowed ? 2 : .45);
    return found.distance <= out.clearance;
  }

  sweepVehicle(fromPose, toPose, shape, outHit = {}) {
    const steps = Math.max(1, Math.ceil(Math.hypot(toPose.x - fromPose.x, toPose.z - fromPose.z) / Math.max(.5, shape.radius || 1)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, x = fromPose.x + (toPose.x - fromPose.x) * t, z = fromPose.z + (toPose.z - fromPose.z) * t;
      const hit = {};
      if (this.nearest(x, z, (shape.radius || 1) + 2, s => !s.vehicleAllowed, hit) && Math.abs(hit.lateralOffset) < hit.halfWidth + (shape.radius || 1)) {
        Object.assign(outHit, hit, { t, x, z });
        return true;
      }
    }
    return false;
  }

  snapshot({ includeTriangles = false } = {}) {
    // The result is deeply frozen, so every caller at a given revision can share one object.
    // Without this, boot alone rebuilt the full segment clone five times (SignBuilder, Minimap,
    // HeldMap and two publishes in 92-boot), and each rebuild is a copy of every segment with
    // its ~25-property recipe spread into a fresh object. Never cache mid-batch: _touch() defers
    // the revision bump while _batchDepth is open, so the key would not move under mutation.
    const cached = this._snapshotCache;
    if (cached && !this._batchDepth && cached.revision === this.revision &&
        (!includeTriangles || cached.value.triangles)) return cached.value;
    const snapshot = { version: 3, revision: this.revision, cellSize: this.cellSize,
      // Segments are frozen on creation and never mutated, so the snapshot shares them rather
      // than cloning. The old `.map(s => ({...s}))` built a second full set of ~384k objects,
      // each re-spreading its ~25-property recipe, for every publish.
      segments: Object.freeze(this._segments.slice()),
    };
    if (includeTriangles) {
      const d = this._vertexData, tv = this._triVerts;
      // NaN marks "no normal" in the pool; the public shape used undefined, so map it back
      const clonePoint = v => { const o = v * VERTEX_STRIDE, n = k => Number.isFinite(d[o+k]) ? d[o+k] : undefined;
        return Object.freeze({ x: d[o], y: d[o+1], z: d[o+2], nx: n(3), ny: n(4), nz: n(5) }); };
      const out = new Array(this._triCount);
      for (let i = 0; i < this._triCount; i++) out[i] = Object.freeze({
        a: clonePoint(tv[i*3]), b: clonePoint(tv[i*3+1]), c: clonePoint(tv[i*3+2]),
        metadata: Object.freeze({ ...this._recipes[this._triMeta[i]] }),
      });
      snapshot.triangles = Object.freeze(out);
    }
    Object.freeze(snapshot);
    if (!this._batchDepth) this._snapshotCache = { revision: this.revision, value: snapshot };
    return snapshot;
  }

  // Intern a source point into the shared vertex pool. Identity-keyed, so the strip/patch
  // publishers keep the exact vertex sharing they had when triangles held object references.
  _internVertex(p) {
    const known = this._vertexOf.get(p);
    if (known !== undefined) return known;
    const i = this._vertexCount++;
    if (i * VERTEX_STRIDE >= this._vertexData.length) {
      const cap = Math.max(4096, (i + 1) * 2);
      const data = new Float32Array(cap * VERTEX_STRIDE), src = new Int32Array(cap * 3);
      data.set(this._vertexData); src.set(this._vertexSrc);
      this._vertexData = data; this._vertexSrc = src;
    }
    const d = this._vertexData, o = i * VERTEX_STRIDE;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z;
    // undefined normals become NaN, which Number.isFinite rejects exactly as the old
    // `[a.nx, ...].every(Number.isFinite)` guard did
    d[o + 3] = p.nx === undefined ? NaN : p.nx;
    d[o + 4] = p.ny === undefined ? NaN : p.ny;
    d[o + 5] = p.nz === undefined ? NaN : p.nz;
    const s = this._vertexSrc, so = i * 3;
    s[so] = p._sourcePosition ? this._attrId(p._sourcePosition) : -1;
    s[so + 1] = p._sourceNormal ? this._attrId(p._sourceNormal) : -1;
    s[so + 2] = Number.isInteger(p._sourceIndex) ? p._sourceIndex : -1;
    this._vertexOf.set(p, i);
    return i;
  }

  _attrId(attr) {
    let id = this._srcAttrs.indexOf(attr);
    if (id < 0) id = this._srcAttrs.push(attr) - 1;
    return id;
  }

  _recipeId(metadata) {
    let id = this._recipeOf.get(metadata);
    if (id === undefined) {
      id = this._recipes.push(metadata) - 1;
      this._recipeOf.set(metadata, id);
    }
    return id;
  }

  _addTriangle(a, b, c, metadata) {
    if (![a, b, c].every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)))
      return;
    const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(area) < 1e-7) return;
    const i = this._triCount++;
    if (i * 3 >= this._triVerts.length) {
      const cap = Math.max(8192, (i + 1) * 2);
      const tv = new Int32Array(cap * 3), ta = new Float64Array(cap), tm = new Int32Array(cap);
      tv.set(this._triVerts); ta.set(this._triArea); tm.set(this._triMeta);
      this._triVerts = tv; this._triArea = ta; this._triMeta = tm;
    }
    const o = i * 3;
    this._triVerts[o] = this._internVertex(a);
    this._triVerts[o + 1] = this._internVertex(b);
    this._triVerts[o + 2] = this._internVertex(c);
    this._triArea[i] = area;
    // addStrip/addPatch recipes are immutable and identical across every authored triangle in a
    // feature, so one shared record per feature backs millions of triangles.
    this._triMeta[i] = this._recipeId(metadata);
    this._indexDirty = true;
  }

  /* Geometry arrays grow by doubling, so at rest up to half of each is slack — with 2.4 M
     triangles and 1.6 M vertices that is on the order of 100 MB held for nothing. The publish is
     append-then-seal, so shrink to the exact live length when the index is built. */
  _trimGeometry() {
    const v = this._vertexCount, t = this._triCount;
    if (this._vertexData.length !== v * VERTEX_STRIDE) {
      this._vertexData = this._vertexData.slice(0, v * VERTEX_STRIDE);
      this._vertexSrc = this._vertexSrc.slice(0, v * 3);
    }
    if (this._triVerts.length !== t * 3) {
      this._triVerts = this._triVerts.slice(0, t * 3);
      this._triArea = this._triArea.slice(0, t);
      this._triMeta = this._triMeta.slice(0, t);
    }
  }

  /* Build both CSR indexes. Two passes (count, then fill) over the members; cell ranges are
     recomputed from the vertex pool rather than stored, which is cheaper than 4 ints/triangle. */
  _ensureIndex() {
    if (!this._indexDirty) return;
    this._indexDirty = false;
    const cs = this.cellSize;
    this._trimGeometry();

    // pass 1 assigns a dense ordinal to each occupied cell and counts its members;
    // pass 2 fills the flat member array at the prefix-summed offsets
    const build = (count, rangeOf) => {
      const index = new Map(), counts = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const r = rangeOf(i);
        for (let z = r[2]; z <= r[3]; z++) for (let x = r[0]; x <= r[1]; x++) {
          const key = this._cellKey(x, z);
          let ci = index.get(key);
          if (ci === undefined) { ci = index.size; index.set(key, ci); counts.push(0); }
          counts[ci]++; total++;
        }
      }
      const start = new Int32Array(index.size + 1);
      for (let i = 0; i < counts.length; i++) start[i + 1] = start[i] + counts[i];
      const items = new Int32Array(total), cursor = start.slice(0, index.size);
      for (let i = 0; i < count; i++) {
        const r = rangeOf(i);
        for (let z = r[2]; z <= r[3]; z++) for (let x = r[0]; x <= r[1]; x++)
          items[cursor[index.get(this._cellKey(x, z))]++] = i;
      }
      return { index, start, items };
    };

    const segRange = [0, 0, 0, 0];
    this._segCells = build(this._segments.length, i => {
      const s = this._segments[i], pad = s.recipe.halfWidth || 0;
      segRange[0] = Math.floor((Math.min(s.ax, s.bx) - pad) / cs);
      segRange[1] = Math.floor((Math.max(s.ax, s.bx) + pad) / cs);
      segRange[2] = Math.floor((Math.min(s.az, s.bz) - pad) / cs);
      segRange[3] = Math.floor((Math.max(s.az, s.bz) + pad) / cs);
      return segRange;
    });

    const d = this._vertexData, tv = this._triVerts, triRange = [0, 0, 0, 0];
    this._triCells = build(this._triCount, i => {
      const oa = tv[i * 3] * VERTEX_STRIDE, ob = tv[i * 3 + 1] * VERTEX_STRIDE,
            oc = tv[i * 3 + 2] * VERTEX_STRIDE;
      triRange[0] = Math.floor(Math.min(d[oa], d[ob], d[oc]) / cs);
      triRange[1] = Math.floor(Math.max(d[oa], d[ob], d[oc]) / cs);
      triRange[2] = Math.floor(Math.min(d[oa + 2], d[ob + 2], d[oc + 2]) / cs);
      triRange[3] = Math.floor(Math.max(d[oa + 2], d[ob + 2], d[oc + 2]) / cs);
      return triRange;
    });

    if (this._seenStamp.length < this._segments.length)
      this._seenStamp = new Int32Array(this._segments.length);
    // the identity map is only needed while appending; drop it once the index is sealed
    this._vertexOf = new Map();
  }

  _sampleTriangle(x, z, filter) {
    this._ensureIndex();
    const cells = this._triCells;
    const ci = cells.index.get(this._cellKey(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize)));
    if (ci === undefined) return null;
    const d = this._vertexData, tv = this._triVerts;
    let best = null;
    for (let p = cells.start[ci]; p < cells.start[ci + 1]; p++) {
      const index = cells.items[p], m = this._recipes[this._triMeta[index]];
      if (filter && !filter(m)) continue;
      const oa = tv[index * 3] * VERTEX_STRIDE, ob = tv[index * 3 + 1] * VERTEX_STRIDE,
            oc = tv[index * 3 + 2] * VERTEX_STRIDE;
      const ax = d[oa], ay = d[oa + 1], az = d[oa + 2];
      const bx = d[ob], by = d[ob + 1], bz = d[ob + 2];
      const cx = d[oc], cy = d[oc + 1], cz = d[oc + 2];
      const area = this._triArea[index];
      const wb = ((x - ax) * (cz - az) - (z - az) * (cx - ax)) / area;
      const wc = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / area;
      const wa = 1 - wb - wc, eps = 1e-6;
      if (wa < -eps || wb < -eps || wc < -eps) continue;
      const y = wa * ay + wb * by + wc * cy;
      const ux = bx-ax, uy=by-ay, uz=bz-az;
      const vx = cx-ax, vy=cy-ay, vz=cz-az;
      const anx=d[oa+3], any=d[oa+4], anz=d[oa+5];
      const bnx=d[ob+3], bny=d[ob+4], bnz=d[ob+5];
      const cnx=d[oc+3], cny=d[oc+4], cnz=d[oc+5];
      let nx, ny, nz;
      if (Number.isFinite(anx) && Number.isFinite(any) && Number.isFinite(anz) &&
          Number.isFinite(bnx) && Number.isFinite(bny) && Number.isFinite(bnz) &&
          Number.isFinite(cnx) && Number.isFinite(cny) && Number.isFinite(cnz)) {
        nx=wa*anx+wb*bnx+wc*cnx;
        ny=wa*any+wb*bny+wc*cny;
        nz=wa*anz+wb*bnz+wc*cnz;
      } else {
        nx = uy*vz-uz*vy; ny = uz*vx-ux*vz; nz = ux*vy-uy*vx;
      }
      if (ny < 0) { nx=-nx; ny=-ny; nz=-nz; }
      const nl = Math.hypot(nx,ny,nz) || 1;
      nx/=nl; ny/=nl; nz/=nl;
      const priority = m.priority || 0;
      if (!best || priority > best.priority)
        best = { tri: { metadata: m }, y, nx, ny, nz, priority, lateralOffset: 0 };
    }
    return best;
  }

  _touch() {
    if (this._batchDepth) this._batchDirty = true;
    else this.revision++;
  }

  _nearestSegment(x, z, radius, filter, requireInside, margin = 0) {
    this._ensureIndex();
    const r = radius == null ? 0 : radius;
    const cells = Math.max(1, Math.ceil((r + 16) / this.cellSize));
    const cx = Math.floor(x / this.cellSize), cz = Math.floor(z / this.cellSize);
    let best = null, bestD = radius == null ? Infinity : radius;
    // generation stamps instead of a Set: this runs several times per wheel per 120 Hz substep
    const stamp = this._seenStamp, gen = ++this._seenGen;
    const grid = this._segCells;
    for (let j = -cells; j <= cells; j++) for (let i = -cells; i <= cells; i++) {
      const ci = grid.index.get(this._cellKey(cx + i, cz + j));
      if (ci === undefined) continue;
      for (let p = grid.start[ci]; p < grid.start[ci + 1]; p++) {
        const index = grid.items[p];
        if (stamp[index] === gen) continue;
        stamp[index] = gen;
        const s = this._segments[index], r = s.recipe;
        // Filters receive the RECIPE, which is where every field they test lives. This also makes
        // the segment path consistent with _sampleTriangle, which already passes triangle metadata.
        if (filter && !filter(r)) continue;
        const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
        let t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        const px = s.ax + dx * t, pz = s.az + dz * t;
        const lateral = ((x - px) * -dz + (z - pz) * dx) / Math.sqrt(l2);
        const distance = Math.abs(lateral);
        const priorityWins = best && Math.abs(distance - bestD) < .02 &&
          (r.priority || 0) > (best.r.priority || 0);
        if ((!requireInside || distance <= r.halfWidth + margin) &&
            (distance < bestD - .02 || priorityWins || (!best && distance <= bestD))) {
          bestD = distance; best = { s, r, t, lateral, distance };
        }
      }
    }
    return best;
  }
}

export const TRANSPORT_RECIPES = DEFAULTS;

// Consumer-facing view of the rendered/query snapshot. Segments are appended in
// feature order by the geometry publishers, but the stitcher also tolerates a
// reversed run. This keeps maps/signs on the same stable IDs and final alignment
// without exposing TransportSurface's mutable runtime index.
export function transportFeatures(snapshot, filter = null) {
  const grouped = new Map();
  for (const segment of snapshot?.segments || []) {
    // v3 segments carry a shared `recipe`; v1/v2 spread those fields onto the segment itself.
    const r = segment.recipe || segment;
    if (filter && !filter(r)) continue;
    const featureId = r.featureId || null;
    const key = featureId || `anonymous:${grouped.size}`;
    let feature = grouped.get(key);
    if (!feature) {
      feature = {
        featureId, classification: r.classification || null,
        kind: r.kind || null, surface: r.surface || null,
        name: r.name || null, vehicleAllowed: !!r.vehicleAllowed,
        pedestrianAllowed: !!r.pedestrianAllowed, halfWidth: r.halfWidth || 0,
        pts: [],
      };
      grouped.set(key, feature);
    }
    const a = [segment.ax, segment.az], b = [segment.bx, segment.bz];
    const pts = feature.pts, last = pts[pts.length - 1];
    if (!last) pts.push(a, b);
    else if (Math.hypot(last[0] - a[0], last[1] - a[1]) < .05) pts.push(b);
    else if (Math.hypot(last[0] - b[0], last[1] - b[1]) < .05) pts.push(a);
    else {
      // A stable OSM feature can contain disconnected authored pieces. Preserve
      // them as separate records rather than drawing a false connector.
      const pieceKey = `${key}:piece:${grouped.size}`;
      grouped.set(pieceKey, { ...feature, pts: [a, b] });
    }
  }
  return [...grouped.values()].filter(feature => feature.pts.length > 1);
}
