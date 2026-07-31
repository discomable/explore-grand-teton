import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QueryFlags,
  buildQuerySnapshot,
  querySnapshotTransferList,
  validateQuerySnapshot,
} from '../terrain/src/workers/query-snapshot.js';

const positions = new Float64Array([1.25, -2.5, 9, 4]);

function makeSnapshot() {
  return buildQuerySnapshot({
    positions,
    generation: 7,
    sampleHeight: (x, z) => x * 2 + z,
    sampleLandcover: (x) => x < 2 ? 42 : 71,
    sampleWater: (x, z, h) => h < 1,
    sampleExclusion: (x) => x > 5,
    sampleVegetation: (x, z) => ({ height: x + 10, cover: z + 20 }),
    sampleTint: (x, z) => [x / 10, 0.5, z / 10],
  });
}

test('builds deterministic exact per-candidate samples', () => {
  const a = makeSnapshot();
  const b = makeSnapshot();
  assert.equal(a.generation, 7);
  assert.equal(a.count, 2);
  assert.deepEqual(a.points, positions);
  assert.deepEqual(a.heights, new Float64Array([0, 22]));
  assert.deepEqual(a.landcover, new Int16Array([42, 71]));
  assert.deepEqual(a.vegetation, new Float64Array([11.25, 17.5, 19, 24]));
  assert.deepEqual(a.tint, new Float64Array([0.125, 0.5, -0.25, 0.9, 0.5, 0.4]));
  assert.equal(a.flags[0], QueryFlags.HEIGHT_VALID | QueryFlags.LANDCOVER_VALID |
    QueryFlags.WATER | QueryFlags.VEGETATION_VALID | QueryFlags.TINT_VALID);
  assert.equal(a.flags[1], QueryFlags.HEIGHT_VALID | QueryFlags.LANDCOVER_VALID |
    QueryFlags.EXCLUDED | QueryFlags.VEGETATION_VALID | QueryFlags.TINT_VALID);
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.flags, b.flags);
  assert.ok(Object.isFrozen(a));
});

test('has a unique transferable layout that survives structured clone transfer', () => {
  const snapshot = makeSnapshot();
  const transfers = querySnapshotTransferList(snapshot);
  assert.equal(transfers.length, 6);
  assert.equal(new Set(transfers).size, transfers.length);

  const clone = structuredClone(snapshot, { transfer: transfers });
  validateQuerySnapshot(clone);
  assert.equal(snapshot.points.byteLength, 0);
  assert.deepEqual(clone.landcover, new Int16Array([42, 71]));
  assert.equal(clone.tint.length, 6);
});

test('supports optional channels, invalid samples and cancellation', () => {
  const sparse = buildQuerySnapshot({
    positions: [0, 0],
    sampleHeight: () => undefined,
    sampleLandcover: () => undefined,
  });
  assert.equal(sparse.vegetation, null);
  assert.equal(sparse.tint, null);
  assert.equal(sparse.flags[0], 0);
  assert.ok(Number.isNaN(sparse.heights[0]));
  assert.equal(querySnapshotTransferList(sparse).length, 4);

  assert.throws(() => buildQuerySnapshot({
    positions: new Float64Array(514),
    sampleHeight: () => 0,
    sampleLandcover: () => 1,
    cancelled: () => true,
  }), { name: 'AbortError' });
});

test('rejects malformed layouts', () => {
  const snapshot = makeSnapshot();
  assert.throws(() => validateQuerySnapshot({ ...snapshot, flags: new Uint8Array(1) }),
    /invalid query snapshot layout/);
});
