import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldIndex, SPATIAL_INDEX_VERSION, packBuckets,
} from '../terrain/src/workers/world-index.js';

test('packed road index returns exact distance, class code and edge clearance', () => {
  const index = new WorldIndex();
  index.installSpatial({
    version: SPATIAL_INDEX_VERSION, type: 'roads', cell: 48,
    segments: new Float32Array([0, 0, 20, 0, 0, 10, 20, 10]),
    classCodes: new Uint8Array([4, 1]),
    halfWidths: new Float32Array([6, 1.8]),
    ...packBuckets(new Map([['0,0', [0, 1]]])),
  });
  assert.deepEqual(index.queryRoad(10, 4), {
    distance: 4, clearance: -2, classCode: 4,
  });
});

test('packed building index preserves point-in-ring, height and pad semantics', () => {
  const index = new WorldIndex();
  index.installSpatial({
    version: SPATIAL_INDEX_VERSION, type: 'buildings', cell: 24,
    rings: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    ringOffsets: new Uint32Array([0, 4]),
    bboxes: new Float32Array([0, 10, 0, 10]),
    topY: new Float32Array([8]),
    ...packBuckets(new Map([['0,0', [0]]])),
  });
  assert.equal(index.queryBuilding(5, 5).blocked, true);
  assert.equal(index.queryBuilding(5, 5, 9).blocked, false);
  assert.equal(index.queryBuilding(11.5, 5, Number.NaN, 2).blocked, true);
  assert.equal(index.queryBuilding(13, 5, Number.NaN, 2).blocked, false);
});

test('packed spatial memory is included in accounting', () => {
  const index = new WorldIndex();
  const packed = packBuckets(new Map([['-1,2', [3, 4]], ['0,2', [5]]]));
  assert.deepEqual([...packed.bucketKeys], [-1, 2, 0, 2]);
  index.installSpatial({
    version: SPATIAL_INDEX_VERSION, type: 'roads', cell: 48,
    segments: new Float32Array(0), classCodes: new Uint8Array(0),
    halfWidths: new Float32Array(0), ...packed,
  });
  assert.equal(index.memory().spatialBytes,
    packed.bucketKeys.byteLength + packed.bucketOffsets.byteLength +
    packed.bucketItems.byteLength);
});
