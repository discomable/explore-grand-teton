import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldIndex, createHeightTileDescriptor, createRasterDescriptor,
} from '../terrain/src/workers/world-index.js';
import { createWorldIndexMessageHandler } from
  '../terrain/src/workers/world-index-worker.js';

const geo = {
  width: 2, height: 2, originE: 0, originN: 20, res: 10,
  centerEasting: 0, centerNorthing: 20,
};

function populatedIndex() {
  const index = new WorldIndex({ generation: 3 });
  index.install(createHeightTileDescriptor({
    id: 'h', generation: 3, z: 4, x: 0, y: 0, size: 2,
    data: new Float64Array([100, 110, 120, 130]),
    minX: 0, minZ: 0, width: 20, height: 20,
  }));
  index.install(createRasterDescriptor({
    id: 'vegetation-height', data: new Uint8Array([10, 20, 30, 40]),
    scale: 0.2, ...geo,
  }));
  index.install(createRasterDescriptor({
    id: 'vegetation-cover', data: new Uint8Array([20, 40, 60, 80]),
    scale: 0.5, ...geo,
  }));
  index.install(createRasterDescriptor({
    id: 'forest-probability', data: new Uint8Array([0, 255, 255, 0]),
    scale: 1 / 255, ...geo,
  }));
  return index;
}

test('canopy batch samples all persistent indexes from one point array', () => {
  const result = populatedIndex().sampleCanopyShell(new Float64Array([5, 5, 15, 15]));
  assert.deepEqual(result.installed, { terrain: true, vegetation: true, forest: true });
  assert.deepEqual(result.coverage, { terrain: 2, vegetation: 2, forest: 2 });
  assert.deepEqual([...result.valid], [7, 7]);
  assert.deepEqual([...result.vegetation], [2, 10, 8, 40]);
  assert.equal(result.terrainHeight[0], 107.5);
  assert.equal(result.terrainHeight[1], 122.5);
});

test('canopy batch reports channel-level installation and coverage', () => {
  const index = new WorldIndex();
  const result = index.sampleCanopyShell(new Float64Array([0, 0]));
  assert.deepEqual(result.installed, { terrain: false, vegetation: false, forest: false });
  assert.deepEqual(result.coverage, { terrain: 0, vegetation: 0, forest: 0 });
  assert.equal(result.valid[0], 0);
  assert.equal(Number.isNaN(result.terrainHeight[0]), true);
});

test('worker canopy protocol transfers four result buffers', async () => {
  const replies = [];
  const index = populatedIndex();
  const handle = createWorldIndexMessageHandler((message, transfer) =>
    replies.push({ message, transfer }));
  await handle({ id: 1, kind: 'init', generation: 3, payload: {
    descriptors: [...index.rasters.values(), ...index.heightTiles.values()],
  } });
  await handle({ id: 2, kind: 'sampleCanopyShell', generation: 3,
    payload: { points: new Float64Array([5, 5]) } });
  assert.equal(replies[1].transfer.length, 4);
  assert.deepEqual(replies[1].message.meta.coverage,
    { terrain: 1, vegetation: 1, forest: 1 });
});
