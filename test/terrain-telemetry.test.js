import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountTerrainOwnership, counterDelta, labelTimerSample, mergeCounterKinds, requestRates,
} from '../terrain/src/terrain-telemetry.js';

test('terrain ownership is inclusive and mutually exclusive without double counting', () => {
  const result = accountTerrainOwnership([
    { cpuBytes: 10, gpuBytes: 20, active: true },
    { cpuBytes: 3, gpuBytes: 7, active: true, query: true },
    { cpuBytes: 5, gpuBytes: 0, warm: true },
    { cpuBytes: 2, gpuBytes: 1 },
  ]);
  assert.deepEqual(result.inclusive.active, { sources: 2, cpuBytes: 13, gpuBytes: 27, totalBytes: 40 });
  assert.equal(result.inclusive.query.totalBytes, 10);
  assert.equal(result.exclusive.activeOnly.totalBytes, 30);
  assert.equal(result.exclusive.warmOnly.totalBytes, 5);
  assert.equal(result.exclusive.shared.totalBytes, 10);
  assert.equal(result.exclusive.unprotected.totalBytes, 3);
  assert.equal(Object.values(result.exclusive).reduce((sum, item) => sum + item.totalBytes, 0), 48);
});

test('counter deltas and request rates use cumulative counters', () => {
  const start = { hits: 10, misses: 2, uploads: 2 };
  const end = { hits: 18, misses: 4, uploads: 5, cancellations: 1 };
  assert.deepEqual(counterDelta(start, end), {
    hits: 8, misses: 2, uploads: 3, cancellations: 1,
  });
  const rates = requestRates(start, end, 2000);
  assert.equal(rates.cacheHitRate, 0.8);
  assert.equal(rates.requestsPerSecond, 5);
  assert.equal(rates.uploadsPerSecond, 1.5);
  assert.equal(rates.cancellationsPerSecond, 0.5);
  assert.deepEqual(mergeCounterKinds({ height: { hits: 2 }, imagery: { hits: 3, misses: 4 } }),
    { hits: 5, misses: 4 });
});

test('CPU timer fallback is never exposed as a GPU sample', () => {
  const cpu = labelTimerSample(1, 'cpu-fallback', 16.2);
  assert.equal(cpu.sample.backend, 'cpu-fallback');
  assert.equal(cpu.gpuSample, null);
  const gpu = labelTimerSample(2, 'gpu-timer', 4.5);
  assert.deepEqual(gpu.gpuSample, { id: 2, backend: 'gpu-timer', ms: 4.5 });
  assert.throws(() => labelTimerSample(3, 'cpu', 1), /backend/);
});
