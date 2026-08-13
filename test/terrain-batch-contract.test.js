import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AtomicTerrainFramePublisher,
  TERRAIN_INSTANCE_LAYOUT,
  buildTerrainFrame,
  compareTerrainSubmissions,
  gridTriangleCount,
  nextPowerOfTwoCapacity,
  packTerrainInstance,
  terrainEdgeRatios,
  terrainSourceWindow,
} from '../terrain/src/terrain-batch-contract.js';

function instance(overrides = {}) {
  const node = overrides.node || { z: 4, x: 9, y: 6, bounds: { minX: -320, minZ: 640, size: 1280 } };
  const height = overrides.height || { key: '2/2/1', z: 2, x: 2, y: 1, layer: 7 };
  const imagery = Object.hasOwn(overrides, 'imagery') ? overrides.imagery :
    { key: '3/4/3', z: 3, x: 4, y: 3, layer: 11 };
  return {
    node, gridN: 64, uvMax: [0.875, 1],
    height: { ...height, window: height.window || terrainSourceWindow(node, height) },
    imagery: imagery && { ...imagery, window: imagery.window || terrainSourceWindow(node, imagery) },
    sourceTexelMeters: 10, skirt: 42.5, morphBase: 2600,
    morphLattice: [0.03125, 0.125, 0.25, 0.5], edgeRatios: [0, 4, 0, 2],
    ...overrides,
  };
}

test('ancestor source windows retain the rendered node quadrant exactly', () => {
  assert.deepEqual(terrainSourceWindow(
    { z: 5, x: 19, y: 12 }, { z: 2, x: 2, y: 1 },
  ), [3 / 8, 4 / 8, 1 / 8]);
  assert.deepEqual(terrainSourceWindow(
    { z: 4, x: 9, y: 6 }, { z: 4, x: 9, y: 6 },
  ), [0, 0, 1]);
});

test('instance packing has a stable complete layout and preserves absent imagery', () => {
  const item = instance();
  const packed = packTerrainInstance(item);
  assert.equal(packed.length, TERRAIN_INSTANCE_LAYOUT.stride);
  assert.deepEqual(Array.from(packed.slice(0, 10)), [
    -320, 640, 1280, 42.5, 0.875, 1, 0.25, 0.5, 0.25, 7,
  ]);
  assert.deepEqual(Array.from(packed.slice(10, 17)), [0.5, 0, 0.5, 11, 10, 2600, 64]);
  assert.deepEqual(Array.from(packed.slice(17)), [0.03125, 0.125, 0.25, 0.5, 0, 4, 0, 2]);

  const noImage = packTerrainInstance(instance({ imagery: null }));
  assert.deepEqual(Array.from(noImage.slice(10, 14)), [0, 0, 1, -1]);
});

test('edge ratios match the restricted-quadtree 2:1 stitch contract', () => {
  const node = { z: 4, x: 4, y: 4 };
  const nodes = new Map([
    ['4/3/4', { z: 4, x: 3, y: 4 }],                 // west: same level
    ['3/2/2', { z: 3, x: 2, y: 2, internal: false }], // east/south: coarse leaf
    ['3/2/1', { z: 3, x: 2, y: 1, internal: true }],  // north: finer subtree/unrendered
  ]);
  const context = {
    tileCountsAtZoom: () => [16, 16],
    getNode: (z, x, y) => nodes.get(`${z}/${x}/${y}`),
    gridNForZoom: z => z === 3 ? 32 : 64,
  };
  assert.deepEqual(terrainEdgeRatios(node, 64, context), [0, 4, 0, 4]);
  assert.deepEqual(terrainEdgeRatios({ z: 4, x: 0, y: 0 }, 64, {
    ...context, getNode: () => undefined,
  }), [0, 0, 0, 0]);
});

test('batched frame preserves leaf/source/stitch equivalence and submitted triangles', () => {
  const legacy = [
    instance(),
    instance({
      node: { z: 5, x: 19, y: 12, bounds: { minX: 960, minZ: 640, size: 640 } },
      gridN: 160,
      height: { key: '4/9/6', z: 4, x: 9, y: 6, layer: 8, window: [0.5, 0, 0.5] },
      imagery: null,
      edgeRatios: [2, 0, 0, 0],
    }),
  ];
  const frame = buildTerrainFrame(legacy, { frameId: 17 });
  assert.equal(frame.drawCalls, 2);
  assert.equal(frame.triangles, gridTriangleCount(64) + gridTriangleCount(160));
  assert.deepEqual(compareTerrainSubmissions(legacy, frame), {
    equivalent: true, missing: [], unexpected: [], mismatched: [],
    legacyTriangles: frame.triangles, batchedTriangles: frame.triangles,
  });

  const changed = buildTerrainFrame([
    legacy[0], { ...legacy[1], edgeRatios: [0, 0, 0, 0] },
  ]);
  assert.deepEqual(compareTerrainSubmissions(legacy, changed).mismatched, [
    { key: '5/19/12', fields: ['edgeRatios'] },
  ]);
});

test('frame publication is atomic and capacity only grows by powers of two', () => {
  assert.equal(nextPowerOfTwoCapacity(4, 5), 8);
  assert.equal(nextPowerOfTwoCapacity(8, 3), 8);
  const original = buildTerrainFrame([instance()], { frameId: 1 });
  const publisher = new AtomicTerrainFramePublisher(original);
  const activePacked = publisher.active.batches.get(64).packed;

  const stagedItems = Array.from({ length: 3 }, (_, index) => instance({
    node: { z: 4, x: 9 + index, y: 6, bounds: { minX: -320 + index * 1280, minZ: 640, size: 1280 } },
  }));
  const staged = publisher.stage(stagedItems, 2);
  assert.equal(staged.batches.get(64).capacity, 4);
  assert.equal(publisher.active, original);
  assert.equal(publisher.active.batches.get(64).count, 1);
  assert.equal(publisher.active.batches.get(64).packed, activePacked);
  assert.throws(() => publisher.publish(3), /frame id mismatch/);

  const previous = publisher.publish(2);
  assert.equal(previous, original);
  assert.equal(publisher.active, staged);
  assert.equal(publisher.active.batches.get(64).count, 3);
  assert.equal(publisher.staging, null);
});
