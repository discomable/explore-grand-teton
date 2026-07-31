import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldIndex, WATER_SURFACE_INDEX_VERSION,
} from '../terrain/src/workers/world-index.js';
import { createWorldIndexMessageHandler } from
  '../terrain/src/workers/world-index-worker.js';

function descriptor(surface = new Uint16Array([11, 0, 21, 31])) {
  return {
    version: WATER_SURFACE_INDEX_VERSION,
    surface, bias: new Int8Array([10, 20, -10, 30]),
    width: 2, height: 2, originE: 100, originN: 200, res: 10,
    centerEasting: 100, centerNorthing: 200, elevMin: 100, datum: 90,
  };
}

test('water surface matches missing-neighbour weighted pixel-centre sampling', () => {
  const index = new WorldIndex();
  index.installWaterSurface(descriptor());
  const value = index.queryWaterSurface(10, 10);
  assert.equal(value.installed, true);
  assert.equal(value.valid, true);
  assert.ok(Math.abs(value.surface - 12) < 1e-12);
  assert.ok(Math.abs(value.bias - 0.1) < 1e-12);
});

test('water surface distinguishes uninstalled and no-surface samples', () => {
  const index = new WorldIndex();
  assert.deepEqual(index.queryWaterSurface(0, 0), {
    installed: false, valid: false, surface: Number.NaN, bias: Number.NaN,
  });
  index.installWaterSurface(descriptor(new Uint16Array(4)));
  const value = index.queryWaterSurface(10, 10);
  assert.equal(value.installed, true);
  assert.equal(value.valid, false);
  assert.equal(Number.isNaN(value.surface), true);
  assert.equal(index.memory().waterSurfaceBytes, 12);
});

test('worker water protocol transfers validity and reconstructed pairs', async () => {
  const replies = [];
  const handle = createWorldIndexMessageHandler((message, transfer) =>
    replies.push({ message, transfer }));
  await handle({ id: 1, kind: 'init', generation: 2, payload: { descriptors: [] } });
  await handle({ id: 2, kind: 'installWaterSurface', generation: 2,
    payload: { descriptor: descriptor() } });
  await handle({ id: 3, kind: 'sampleWaterSurface', generation: 2,
    payload: { points: new Float64Array([10, 10, 1000, 1000]) } });
  const reply = replies[2];
  assert.equal(reply.message.meta.installed, true);
  assert.deepEqual([...reply.message.buffers.valid], [1, 0]);
  assert.deepEqual([...reply.message.buffers.values.slice(0, 2)], [12, 0.1]);
  assert.equal(reply.transfer.length, 2);
});
