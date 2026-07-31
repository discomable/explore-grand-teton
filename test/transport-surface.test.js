import test from 'node:test';
import assert from 'node:assert/strict';
import { TransportSurface, transportFeatures } from '../terrain/src/transport/TransportSurface.js';

function fixture() {
  const surface = new TransportSurface({ cellSize: 16 });
  surface.addPolyline([{ x: 0, y: 10, z: 0 }, { x: 100, y: 20, z: 0 }], {
    classification: 'park_paved', halfWidth: 4, featureId: 'osm-way-1', crossfall: .02,
  });
  surface.addPolyline([{ x: 0, y: 11, z: 20 }, { x: 100, y: 11, z: 20 }], {
    classification: 'trail', halfWidth: .6, featureId: 'osm-way-2',
  });
  return surface;
}

test('sample returns the complete final-surface contract', () => {
  const out = {};
  assert.equal(fixture().sample(50, 2, out), true);
  assert.equal(out.featureId, 'osm-way-1');
  assert.equal(out.kind, 'park_paved_road');
  assert.equal(out.vehicleAllowed, true);
  assert.equal(out.pedestrianAllowed, true);
  assert.ok(Math.abs(out.y - 15.04) < 1e-9);
  assert.ok(Math.abs(out.lateralOffset - 2) < 1e-9);
  assert.ok(out.normalY > .99);
  assert.ok(out.normalZ < 0);
});

test('vehicle contact margin holds shoulder wheels on the rendered edge profile', () => {
  const surface = new TransportSurface();
  surface.addPolyline([{ x: 0, y: 10, z: 0 }, { x: 20, y: 10, z: 0 }], {
    classification: 'park_paved', halfWidth: 3.75, crossfall: .04,
  });
  const strict = {}, wheel = {};
  assert.equal(surface.sample(10, 4.4, strict, { filter: s => s.vehicleAllowed }), false);
  assert.equal(surface.sample(10, 4.4, wheel,
    { filter: s => s.vehicleAllowed, margin: 1.25 }), true);
  assert.equal(wheel.lateralOffset, 4.4);
  assert.ok(Math.abs(wheel.y - (10 + .04 * 3.75)) < 1e-9);
});

test('drive filtering rejects foot trails while walk mode accepts them', () => {
  const surface = fixture();
  assert.equal(surface.heightAt(50, 20, 'drive'), null);
  assert.equal(surface.heightAt(50, 20, 'walk'), 11);
});

test('nearest works outside the rendered corridor and exclusion uses class clearance', () => {
  const surface = fixture(), nearest = {}, exclusion = {};
  assert.equal(surface.nearest(50, 8, 20, null, nearest), true);
  assert.equal(nearest.distance, 8);
  assert.equal(surface.exclusionAt(50, 5, exclusion), true);
  assert.equal(exclusion.featureId, 'osm-way-1');
});

test('snapshots are immutable and deterministic', () => {
  const surface = fixture(), a = surface.snapshot(), b = surface.snapshot();
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a.segments), true);
  assert.equal(Object.isFrozen(a.segments[0]), true);
});

test('class priority resolves coincident crossings deterministically', () => {
  const surface = new TransportSurface();
  surface.addPolyline([{ x: -10, y: 2, z: 0 }, { x: 10, y: 2, z: 0 }],
    { classification: 'trail', halfWidth: .6, featureId: 'trail' });
  surface.addPolyline([{ x: 0, y: 5, z: -10 }, { x: 0, y: 5, z: 10 }],
    { classification: 'highway', halfWidth: 4.5, featureId: 'road' });
  const out = {};
  assert.equal(surface.sample(0, 0, out), true);
  assert.equal(out.featureId, 'road');
  assert.equal(out.y, 5);
});

test('batched replacement publishes one atomic revision', () => {
  const surface = new TransportSurface();
  surface.beginUpdate();
  surface.clear();
  surface.addPolyline([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }],
    { classification: 'track', halfWidth: 1.5 });
  surface.addPolyline([{ x: 0, y: 0, z: 2 }, { x: 5, y: 0, z: 2 }],
    { classification: 'trail', halfWidth: .6 });
  assert.equal(surface.revision, 0);
  surface.endUpdate();
  assert.equal(surface.revision, 1);
  assert.equal(surface.snapshot().segments.length, 2);
});

test('consumer features preserve stable IDs, metadata, alignment, and access filtering', () => {
  const surface = fixture();
  const features = transportFeatures(surface.snapshot(), segment => segment.vehicleAllowed);
  assert.equal(features.length, 1);
  assert.deepEqual(features[0], {
    featureId: 'osm-way-1', classification: 'park_paved',
    kind: 'park_paved_road', surface: 'asphalt', name: null,
    vehicleAllowed: true, pedestrianAllowed: true, halfWidth: 4,
    pts: [[0, 0], [100, 0]],
  });
});

test('authored strips use exact rendered triangles and never extrapolate wheel margin', () => {
  const surface = new TransportSurface({ cellSize: 8 });
  surface.addStrip([
    [{ x: 0, y: 0, z: -2 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 2 }],
    [{ x: 10, y: 2, z: -2 }, { x: 10, y: 3, z: 0 }, { x: 10, y: 2, z: 2 }],
  ], { classification: 'track', halfWidth: 2, featureId: 'exact-track' });
  const crown = {}, outside = {};
  assert.equal(surface.sample(5, 0, crown, { filter: s => s.vehicleAllowed }), true);
  assert.ok(Math.abs(crown.y - 2) < 1e-9);
  assert.equal(crown.featureId, 'exact-track');
  assert.equal(surface.sample(5, 2.2, outside,
    { filter: s => s.vehicleAllowed, margin: 1.25 }), false);
  assert.equal(surface.snapshot({ includeTriangles: true }).triangles.length, 4);
});

test('patch priority owns exact junction overlap', () => {
  const surface = new TransportSurface();
  surface.addPatch([[{x:-2,y:1,z:-2},{x:2,y:1,z:-2},{x:0,y:1,z:2}]],
    { classification: 'trail', featureId: 'trail-patch' });
  surface.addPatch([[{x:-1,y:4,z:-1},{x:1,y:4,z:-1},{x:0,y:4,z:1}]],
    { classification: 'highway', featureId: 'road-patch' });
  const out = {};
  assert.equal(surface.sample(0, 0, out), true);
  assert.equal(out.featureId, 'road-patch');
  assert.equal(out.y, 4);
});

test('authored geometry synchronizes from render buffers without rebuilding topology', () => {
  const ys=[0,0,2,2], normals=[0,1,0, 0,1,0, 0,1,0, 0,1,0];
  const position={getY:i=>ys[i]}, normal={
    getX:i=>normals[i*3],getY:i=>normals[i*3+1],getZ:i=>normals[i*3+2],
  };
  const point=(x,z,i)=>({x,y:ys[i],z,_sourcePosition:position,_sourceNormal:normal,_sourceIndex:i});
  const surface=new TransportSurface();
  surface.addStrip([[point(0,-1,0),point(0,1,1)],[point(10,-1,2),point(10,1,3)]],
    {classification:'park_paved'});
  const triangleCount=surface._triangleCount, before={}, after={};
  assert.equal(surface.sample(5,0,before),true);
  ys[0]=ys[1]=4;ys[2]=ys[3]=6;
  assert.equal(surface.syncAuthoredGeometry(),true);
  assert.equal(surface.sample(5,0,after),true);
  assert.equal(after.y,5);
  assert.equal(surface._triangleCount,triangleCount);
});

/* The spatial index is now built once per mutation rather than incrementally per insert, so the
   invalidation edges are new failure modes: geometry added after a query must be visible to the
   next query, a cleared surface must stop answering, and querying an empty surface must not
   throw on the absent index. */
test('lazily built spatial index invalidates on every mutation path', () => {
  const surface = new TransportSurface();
  const out = {};
  assert.equal(surface.sample(0, 0, out), false, 'empty surface answers without an index');
  assert.equal(surface.nearest(0, 0, 50, null, out), false);

  const strip = (x0, x1) => [
    [{ x: x0, y: 1, z: -2 }, { x: x0, y: 1, z: 2 }],
    [{ x: x1, y: 1, z: -2 }, { x: x1, y: 1, z: 2 }],
  ];
  surface.addStrip(strip(0, 10), { classification: 'park_paved' });
  assert.equal(surface.sample(5, 0, out), true, 'first feature is queryable');

  // add AFTER a query has already sealed the index
  surface.addStrip(strip(100, 110), { classification: 'gravel' });
  assert.equal(surface.sample(105, 0, out), true, 'second feature is indexed after a prior query');
  assert.equal(out.kind, 'gravel_road');
  assert.equal(surface.sample(5, 0, out), true, 'first feature survives the rebuild');
  assert.equal(out.kind, 'park_paved_road');

  surface.clear();
  assert.equal(surface.sample(5, 0, out), false, 'cleared surface stops answering');
  assert.equal(surface._triangleCount, 0);
});

test('segment index dedupes members spanning many cells across repeated probes', () => {
  const surface = new TransportSurface();
  // one long polyline whose segments each straddle several 32 m cells
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push({ x: i * 40, y: 0, z: 0 });
  surface.addPolyline(pts, { classification: 'gravel', halfWidth: 3 });
  const a = {}, b = {};
  assert.equal(surface.nearest(400, 1, 60, null, a), true);
  // repeated probes must not accumulate state (generation stamps replaced a per-probe Set)
  for (let i = 0; i < 5; i++) assert.equal(surface.nearest(400, 1, 60, null, b), true);
  assert.equal(b.distance, a.distance);
  assert.equal(b.featureId, a.featureId);
});

/* v3 segments carry a shared `recipe` reference instead of a per-segment copy of the ~25 recipe
   fields. Two things that must not drift: query filters now receive the RECIPE (the object that
   actually holds vehicleAllowed / authoredStrip / halfWidth), and consumers must still be able
   to read a snapshot produced by an older publisher. */
test('query filters receive the recipe and still discriminate access', () => {
  const surface = fixture();
  const seen = [];
  surface.nearest(50, 8, 30, r => { seen.push(r); return true; }, {});
  assert.ok(seen.length > 0, 'filter must be called');
  for (const r of seen) {
    assert.equal(typeof r.classification, 'string', 'filter argument exposes recipe fields');
    assert.equal('ax' in r, false, 'filter argument is the recipe, not the segment');
  }
  // the access decision itself must be unchanged
  assert.equal(surface.heightAt(50, 20, 'drive'), null);
  assert.equal(surface.heightAt(50, 20, 'walk'), 11);
});

test('snapshot exposes v3 segments and consumers accept the older shape', () => {
  const snap = fixture().snapshot();
  assert.equal(snap.version, 3);
  const seg = snap.segments[0];
  assert.equal(Object.isFrozen(seg), true);
  assert.equal(typeof seg.ax, 'number');
  assert.equal(seg.recipe.classification, 'park_paved');
  assert.equal(Object.isFrozen(seg.recipe), true);
  // one recipe object is shared by every segment of the same feature
  const same = snap.segments.filter(s => s.recipe.featureId === 'osm-way-1');
  assert.ok(same.length > 0 && same.every(s => s.recipe === same[0].recipe));

  // a v2-shaped snapshot (recipe fields spread onto the segment) must still group correctly
  const legacy = { version: 2, cellSize: 32, segments: [
    { ax: 0, az: 0, bx: 10, bz: 0, featureId: 'legacy-1', classification: 'gravel',
      kind: 'gravel_road', surface: 'gravel', vehicleAllowed: true, pedestrianAllowed: true, halfWidth: 2 },
  ] };
  const [feature] = transportFeatures(legacy, s => s.vehicleAllowed);
  assert.equal(feature.featureId, 'legacy-1');
  assert.equal(feature.kind, 'gravel_road');
  assert.deepEqual(feature.pts, [[0, 0], [10, 0]]);
});
