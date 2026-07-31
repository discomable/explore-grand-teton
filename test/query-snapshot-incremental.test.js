import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuerySnapshot,
  createIncrementalQuerySnapshot,
  querySnapshotTransferList,
} from '../terrain/src/workers/query-snapshot.js';

function fixture(count = 521, cancelled) {
  const positions = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = i * 0.125 - 17;
    positions[i * 2 + 1] = (i % 19) * -0.75;
  }
  return {
    positions,
    generation: 29,
    cancelled,
    sampleHeight: (x, z) => x * 1.25 - z * 0.5,
    sampleLandcover: (x, z) => (Math.abs(Math.trunc(x + z)) % 100),
    sampleWater: (x, z) => x + z < -10,
    sampleExclusion: (x, z) => x > 20 && z > -8,
    sampleVegetation: (x, z) => [x - z, (x * z) % 100],
    sampleTint: (x, z) => [x / 100, z / 100, (x - z) / 100],
  };
}

function assertSameSnapshot(actual, expected) {
  assert.equal(actual.version, expected.version);
  assert.equal(actual.generation, expected.generation);
  assert.equal(actual.count, expected.count);
  for (const field of ['points', 'heights', 'landcover', 'flags', 'vegetation', 'tint']) {
    assert.deepEqual(actual[field], expected[field], field);
  }
}

test('incremental sampling is exactly equal to one-shot across uneven boundaries', () => {
  const options = fixture();
  const expected = buildQuerySnapshot(options);
  for (const chunkSize of [1, 7, 255, 256, 257, 1000]) {
    const builder = createIncrementalQuerySnapshot(options);
    while (!builder.done) builder.step(chunkSize);
    assert.equal(builder.sampled, expected.count);
    assert.equal(builder.remaining, 0);
    const actual = builder.finish();
    assertSameSnapshot(actual, expected);
    assert.equal(querySnapshotTransferList(actual).length, 6);
  }
});

test('incremental builder owns positions across chunk boundaries', () => {
  const options = fixture(3);
  const expected = buildQuerySnapshot(options);
  const builder = createIncrementalQuerySnapshot(options);
  builder.step(1);
  options.positions.fill(9999);
  builder.step(2);
  assertSameSnapshot(builder.finish(), expected);
});

test('cancellation is observed between chunks without sampling the next chunk', () => {
  let cancelled = false;
  let calls = 0;
  const options = fixture(20, () => cancelled);
  const original = options.sampleHeight;
  options.sampleHeight = (x, z) => { calls++; return original(x, z); };
  const builder = createIncrementalQuerySnapshot(options);
  assert.equal(builder.step(6), 6);
  assert.equal(calls, 6);
  cancelled = true;
  assert.throws(() => builder.step(6), { name: 'AbortError' });
  assert.equal(builder.sampled, 6);
  assert.equal(calls, 6);
  assert.throws(() => builder.finish(), /incomplete/);
});

test('step validates its budget and safely handles empty snapshots', () => {
  const builder = createIncrementalQuerySnapshot(fixture(0));
  assert.equal(builder.done, true);
  assert.equal(builder.step(10), 0);
  assert.equal(builder.finish().count, 0);
  assert.throws(() => createIncrementalQuerySnapshot(fixture(1)).step(0), RangeError);
});
