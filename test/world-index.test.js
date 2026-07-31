import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldIndex, createRasterDescriptor, createHeightTileDescriptor,
  extractChannel, worldIndexTransferList,
} from '../terrain/src/workers/world-index.js';
import { createWorldIndexMessageHandler } from '../terrain/src/workers/world-index-worker.js';

const geo = {
  width: 2, height: 2, originE: 100, originN: 200, res: 10,
  centerEasting: 100, centerNorthing: 200,
};

test('resident rasters preserve nearest and ForestMask bilinear semantics', () => {
  const index = new WorldIndex();
  index.install(createRasterDescriptor({
    id: 'landcover', data: new Uint8Array([11, 42, 90, 95]), ...geo,
  }));
  assert.equal(index.sampleNearest('landcover', 1, 1), 11);
  assert.equal(index.sampleNearest('landcover', 11, 1), 42);
  // Existing Landcover uses `| 0`, so a fractional negative coordinate
  // truncates into the edge texel; a whole pixel beyond is outside.
  assert.equal(index.sampleNearest('landcover', -11, 1), null);
  assert.equal(index.sampleBilinear('landcover', 10, 10), 59.5);
  assert.equal(index.sampleBilinear('landcover', -6, 0, 'outside'), 'outside');
});

test('scale, no-data, channel extraction and memory accounting are exact', () => {
  const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual([...extractChannel(rgba, 1)], [2, 5]);
  const index = new WorldIndex();
  index.install(createRasterDescriptor({
    id: 'veg-height', data: new Uint8Array([0, 250, 100, 50]),
    scale: 0.2, noData: 0, ...geo,
  }));
  assert.equal(index.sampleNearest('veg-height', 11, 1), 50);
  assert.equal(index.sampleNearest('veg-height', 1, 1), null);
  assert.deepEqual(index.memory(), {
    bytes: 4, rasterBytes: 4, heightTileBytes: 0, spatialBytes: 0, waterSurfaceBytes: 0,
    rasters: 1, heightTiles: 0, spatialIndexes: 0, spatialTypes: [], generation: 0,
    waterSurface: false,
  });
});

test('height index selects the finest current-generation tile and interpolates', () => {
  const index = new WorldIndex({ generation: 7 });
  index.install(createHeightTileDescriptor({
    id: 'coarse', generation: 7, z: 3, x: 0, y: 0, size: 2,
    data: new Float32Array([0, 10, 20, 30]),
    minX: 0, minZ: 0, width: 100, height: 100,
  }));
  index.install(createHeightTileDescriptor({
    id: 'fine', generation: 7, z: 5, x: 0, y: 0, size: 2,
    data: new Float32Array([100, 110, 120, 130]),
    minX: 0, minZ: 0, width: 50, height: 50,
  }));
  assert.equal(index.sampleHeight(25, 25), 115);
  assert.equal(index.sampleHeight(75, 75), 22.5);
  assert.equal(worldIndexTransferList([...index.heightTiles.values()]).length, 2);
});

test('worker protocol initializes, samples, accounts memory and rejects stale work', async () => {
  const replies = [];
  const handle = createWorldIndexMessageHandler((message, transfer) =>
    replies.push({ message, transfer }));
  const descriptor = createRasterDescriptor({
    id: 'lc', data: new Uint8Array([1, 2, 3, 4]), ...geo,
  });
  await handle({ id: 1, kind: 'init', generation: 4,
    payload: { descriptors: [descriptor] } });
  await handle({ id: 2, kind: 'sample', generation: 4,
    payload: { index: 'lc', method: 'nearest',
      points: new Float64Array([1, 1, 11, 11]) } });
  assert.deepEqual([...replies[1].message.buffers.values], [1, 4]);
  assert.deepEqual(replies[1].transfer, [replies[1].message.buffers.values.buffer]);
  await handle({ id: 3, kind: 'memory', generation: 3 });
  assert.equal(replies[2].message.ok, false);
  assert.match(replies[2].message.error, /stale/);
});

test('worker cancellation suppresses queued work', async () => {
  const replies = [];
  const handle = createWorldIndexMessageHandler((message) => replies.push(message));
  await handle({ id: 9, kind: 'cancel', payload: { id: 8 } });
  await handle({ id: 8, kind: 'memory', generation: 0 });
  assert.equal(replies.length, 0);
});
