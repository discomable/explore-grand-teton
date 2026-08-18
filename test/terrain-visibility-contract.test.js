import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeTerrainErrorPyramid, parseTerrainErrorPyramid, predictTerrainPoses,
  projectedTerrainError, selectTerrainWarmSources, terrainShouldSubdivide,
} from '../terrain/src/terrain-visibility-contract.js';

test('terrain error pyramid round trips conservative values and row-major nodes', () => {
  const buffer = encodeTerrainErrorPyramid({ grids: [16, 64], levels: [
    { nx: 1, ny: 1, values: [1.01, 2.01] },
    { nx: 2, ny: 1, values: [3.01, 4.01, 5.01, null] },
  ] });
  const errors = parseTerrainErrorPyramid(buffer);
  assert.ok(Math.abs(errors.errorMeters(0, 0, 0, 16) - 1.1) < 1e-6);
  assert.ok(Math.abs(errors.errorMeters(1, 1, 0, 16) - 5.1) < 1e-6);
  assert.equal(errors.errorMeters(1, 1, 0, 64), null);
  assert.equal(errors.errorMeters(1, 2, 0, 16), null);
});

test('geometric selection falls back to legacy SSE when metadata is unavailable', () => {
  assert.equal(projectedTerrainError(2, 500, 100), 10);
  assert.deepEqual(terrainShouldSubdivide({ errorMeters: 2, projectionScale: 500,
    nearestDistance: 100, pixelThreshold: 2, legacySse: 0.5 }),
    { subdivide: true, mode: 'geometric', projectedError: 10 });
  assert.deepEqual(terrainShouldSubdivide({ errorMeters: null, projectionScale: 500,
    nearestDistance: 100, pixelThreshold: 2, legacySse: 3 }),
    { subdivide: true, mode: 'legacy', projectedError: 3 });
});

test('prediction horizons are mode adaptive and angular sweep is capped', () => {
  const drive = predictTerrainPoses({ mode: 'drive', position: [1, 2, 3], velocity: [10, 0, -5],
    yaw: 0, pitch: 0, yawRate: 100, pitchRate: 0 });
  assert.equal(drive.length, 3);
  assert.ok(Math.abs(drive[2].t - 0.8) < 1e-9);
  assert.ok(Math.abs(drive[2].position[0] - 9) < 1e-9);
  assert.equal(drive[2].position[1], 2);
  assert.ok(Math.abs(drive[2].position[2] + 1) < 1e-9);
  assert.equal(drive[2].yaw, Math.PI / 2);
  assert.ok(Math.abs(predictTerrainPoses({ mode: 'fly', position: [0, 0, 0], velocity: [0, 0, 0],
    yaw: 0, pitch: 0 })[2].t - 1.2) < 1e-9);
});

test('warm selection deduplicates and applies deterministic priority and capacity', () => {
  const selected = selectTerrainWarmSources([
    { key: 'b', time: 0.8, centrality: 0, distance: 1 },
    { key: 'a', time: 0.4, centrality: 2, distance: 4 },
    { key: 'b', time: 0.2, centrality: 3, distance: 9 },
    { key: 'c', time: 0.4, centrality: 1, distance: 7 },
  ], 2);
  assert.deepEqual(selected.map(v => v.key), ['b', 'c']);
});
