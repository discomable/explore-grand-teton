import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DenseGroundCoverSubmission,
  normalizedCellRecords,
} from '../terrain/src/ground-cover-submission.js';

function buffers(capacity) {
  return {
    value: { array: new Float32Array(capacity), itemSize: 1 },
    pair: { array: new Float32Array(capacity * 2), itemSize: 2 },
  };
}

function write(cell, values, b) {
  values.forEach((value, i) => {
    b.value.array[cell.start + i] = value;
    b.pair.array.set([value, value + 0.5], (cell.start + i) * 2);
  });
}

test('dense insertion submits exactly the live prefix and enforces capacity', () => {
  const dense = new DenseGroundCoverSubmission(5);
  assert.deepEqual(dense.insert('a', 2), { start: 0, used: 2 });
  assert.deepEqual(dense.insert('b', 3), { start: 2, used: 3 });
  assert.equal(dense.live, 5);
  assert.equal(dense.available(), 0);
  assert.deepEqual(dense.takeUploadPlan(80), { start: 0, count: 5, bytes: 400 });
  assert.equal(dense.takeUploadPlan(80), null);
  assert.deepEqual(dense.telemetry(dense.live), {
    submittedInstances: 5,
    liveInstances: 5,
    capacityInstances: 5,
    dirtyRangeCount: 1,
    uploadBytes: 400,
    relocations: 0,
    turnoverCells: 2,
    turnoverInstances: 5,
  });
  assert.throws(() => dense.insert('c', 1), /capacity/);
});

test('removing the tail cell only shrinks the submitted prefix', () => {
  const dense = new DenseGroundCoverSubmission(8);
  dense.insert('a', 3);
  dense.insert('b', 2);
  assert.deepEqual(dense.remove('b'), {
    start: 3, previousEnd: 5, removed: 2, relocated: 0,
  });
  assert.equal(dense.live, 3);
  assert.deepEqual(dense.order, ['a']);
  assert.deepEqual(dense.takeUploadPlan(80), { start: 0, count: 5, bytes: 400 });
});

test('swap relocation preserves exact normalized cell records across unequal ranges', () => {
  const dense = new DenseGroundCoverSubmission(12);
  const b = buffers(12);
  write(dense.insert('a', 3), [10, 11, 12], b);
  write(dense.insert('b', 2), [20, 21], b);
  write(dense.insert('c', 4), [30, 31, 32, 33], b);
  const before = normalizedCellRecords(dense, b);

  const change = dense.remove('a', Object.values(b));
  assert.deepEqual(change, {
    start: 0, previousEnd: 9, removed: 3, relocated: 6,
  });
  assert.equal(dense.live, 6);
  assert.deepEqual(dense.order, ['c', 'b']);
  assert.deepEqual(dense.cells.get('c'), { start: 0, used: 4 });
  assert.deepEqual(dense.cells.get('b'), { start: 4, used: 2 });
  assert.deepEqual(
    normalizedCellRecords(dense, b),
    before.filter(record => record.key !== 'a'));
  // Insert dirtied [0,9); relocation is coalesced into that same bounded runtime upload.
  assert.deepEqual(dense.takeUploadPlan(80), { start: 0, count: 9, bytes: 720 });
  const telemetry = dense.telemetry(dense.live);
  assert.equal(telemetry.submittedInstances, telemetry.liveInstances);
  assert.equal(telemetry.relocations, 6);
  assert.equal(telemetry.turnoverCells, 4);
  assert.equal(telemetry.turnoverInstances, 12);
});

test('post-publication relocation reports only the changed dense prefix', () => {
  const dense = new DenseGroundCoverSubmission(12);
  const b = buffers(12);
  write(dense.insert('a', 3), [10, 11, 12], b);
  write(dense.insert('b', 2), [20, 21], b);
  write(dense.insert('c', 4), [30, 31, 32, 33], b);
  dense.takeUploadPlan(80);

  dense.remove('b', Object.values(b));
  assert.equal(dense.live, 7);
  assert.deepEqual(dense.takeUploadPlan(80), { start: 3, count: 4, bytes: 320 });
  assert.deepEqual(dense.telemetry(7), {
    submittedInstances: 7,
    liveInstances: 7,
    capacityInstances: 12,
    dirtyRangeCount: 2,
    uploadBytes: 1040,
    relocations: 4,
    turnoverCells: 4,
    turnoverInstances: 11,
  });
});

test('remove is a no-op for an unknown cell', () => {
  const dense = new DenseGroundCoverSubmission(2);
  assert.equal(dense.remove('missing'), null);
  assert.equal(dense.live, 0);
});
