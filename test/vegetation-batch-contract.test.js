import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVegetationFade,
  buildVegetationBatchFrame,
  compactVegetationRecord,
  createVegetationSubmissionState,
  keepVegetationInstance,
  nextVegetationCapacity,
  reconcileVegetationSubmission,
  vegetationSlotIdentity,
} from '../terrain/src/vegetation-batch-contract.js';

function source(count) {
  const matrices = new Float32Array(count * 16);
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    matrices.fill(i + 1, i * 16, i * 16 + 16);
    colors.fill(i / 10, i * 3, i * 3 + 3);
    uvs[i] = i / 8;
  }
  return { matrices, colors, uvs };
}

test('vegetation capacity grows by powers of two without shrinking', () => {
  assert.equal(nextVegetationCapacity(0, 0), 0);
  assert.equal(nextVegetationCapacity(1, 0), 1);
  assert.equal(nextVegetationCapacity(17, 16), 32);
  assert.equal(nextVegetationCapacity(7, 16), 16);
});

test('near and middle vegetation records retain every authored instance', () => {
  for (const band of [0, 1]) {
    const input = source(8);
    const record = compactVegetationRecord({
      cellX: 4, cellZ: -3, band, species: 'conifer', count: 8, ...input,
    });
    assert.equal(record.count, 8);
    assert.equal(record.omitted, 0);
    assert.deepEqual(record.matrices, input.matrices);
    assert.deepEqual(record.colors, input.colors);
    assert.deepEqual(record.uvs, input.uvs);
  }
});

test('outer billboard thinning is stable and keeps exactly one hash parity', () => {
  const input = source(64);
  const a = compactVegetationRecord({
    cellX: 12, cellZ: 8, band: 2, species: 'bb', count: 64, ...input,
  });
  const b = compactVegetationRecord({
    cellX: 12, cellZ: 8, band: 2, species: 'bb', count: 64, ...input,
  });
  assert.deepEqual(a, b);
  assert.equal(a.count + a.omitted, 64);
  assert.ok(a.count >= 24 && a.count <= 40);
  assert.equal(keepVegetationInstance(12, 8, 'conifer', 1, 2), true);
});

test('batch frame groups only records from intersecting cells', () => {
  const record = species => ({ species, count: 2 });
  const cells = [
    { sphere: { visible: true }, records: [record('conifer'), record('bb')] },
    { sphere: { visible: false }, records: [record('conifer')] },
  ];
  const frame = buildVegetationBatchFrame(cells, sphere => sphere.visible);
  assert.equal(frame.visibleCells, 1);
  assert.equal(frame.visible.length, 1);
  assert.equal(frame.visible[0], cells[0]);
  assert.equal(frame.instances, 4);
  assert.equal(frame.batches.get('conifer').count, 2);
  assert.equal(frame.batches.get('bb').count, 2);
});

test('fade scales only matrix basis columns and preserves world translation', () => {
  const source = new Float32Array(16);
  for (let i = 0; i < source.length; i++) source[i] = i + 1;
  const output = new Float32Array(16);
  applyVegetationFade(source, output, 0.25);
  assert.deepEqual([...output.slice(0, 12)], [...source.slice(0, 12)].map(value => value * 0.25));
  assert.deepEqual([...output.slice(12)], [...source.slice(12)]);
});

function cell(key, species, count, seed = 0) {
  const values = source(count);
  for (let i = 0; i < values.matrices.length; i++) values.matrices[i] += seed * 1000;
  for (let i = 0; i < values.colors.length; i++) values.colors[i] += seed;
  for (let i = 0; i < values.uvs.length; i++) values.uvs[i] += seed / 100;
  return {
    key, cellX: seed, cellZ: -seed, batchDirty: false,
    records: [{ species, count, ...values }],
  };
}

function normalizedSlots(publication) {
  const records = [];
  for (const [species, batch] of publication.species) for (const slot of batch.slots) {
    const matrix = [...slot.record.matrices.subarray(slot.ordinal * 16, slot.ordinal * 16 + 16)];
    const color = [...slot.record.colors.subarray(slot.ordinal * 3, slot.ordinal * 3 + 3)];
    records.push({ id: vegetationSlotIdentity(slot, species), matrix, color,
      uv: slot.record.uvs?.[slot.ordinal] ?? null });
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

test('dense submission preserves every authored instance after swap removal', () => {
  const state = createVegetationSubmissionState();
  const initial = [cell('0,0', 'conifer', 3, 1), cell('1,0', 'conifer', 5, 2),
    cell('2,0', 'conifer', 4, 3)];
  reconcileVegetationSubmission(state, initial);
  const desired = [initial[1], initial[2], cell('3,0', 'conifer', 2, 4)];
  const changed = reconcileVegetationSubmission(state, desired);

  const expectedState = createVegetationSubmissionState();
  const expected = reconcileVegetationSubmission(expectedState, desired);
  assert.equal(changed.instances, 11);
  assert.equal(changed.species.get('conifer').slots.length, 11);
  assert.deepEqual(normalizedSlots(changed), normalizedSlots(expected));
  assert.ok(changed.compactions > 0);
});

test('one-cell traversal uploads less than half of a full species republish', () => {
  const state = createVegetationSubmissionState();
  const initial = Array.from({ length: 8 }, (_, i) => cell(`${i},0`, 'conifer', 10, i + 1));
  const first = reconcileVegetationSubmission(state, initial);
  assert.equal(first.uploadBytes, first.fullUploadBytes);

  const next = [...initial.slice(1), cell('8,0', 'conifer', 10, 9)];
  const transition = reconcileVegetationSubmission(state, next);
  assert.ok(transition.uploadBytes <= transition.fullUploadBytes * 0.5,
    `${transition.uploadBytes} partial bytes versus ${transition.fullUploadBytes} full bytes`);
  assert.equal(transition.dirtyInstances, 20);
  assert.equal(transition.instances, 80);
});

test('unchanged cells publish no bytes and a fade dirties only its cell slots', () => {
  const state = createVegetationSubmissionState();
  const cells = [cell('0,0', 'sage', 7, 1), cell('1,0', 'sage', 11, 2)];
  reconcileVegetationSubmission(state, cells);
  const unchanged = reconcileVegetationSubmission(state, cells);
  assert.equal(unchanged.uploadBytes, 0);
  assert.equal(unchanged.dirtyRanges, 0);

  cells[0].batchDirty = true;
  const faded = reconcileVegetationSubmission(state, cells);
  assert.equal(faded.dirtyInstances, 7);
  assert.equal(faded.uploadBytes, 7 * 19 * 4);
  assert.equal(faded.dirtyRanges, 1);
  assert.equal(cells[0].batchDirty, false);
});

test('dense packing is deterministic across identical traversal histories', () => {
  const route = [
    [cell('0,0', 'aspen', 3, 1), cell('1,0', 'aspen', 6, 2)],
    [cell('1,0', 'aspen', 6, 2), cell('2,0', 'aspen', 4, 3)],
  ];
  const run = () => {
    const state = createVegetationSubmissionState();
    let result;
    for (const cells of route) result = reconcileVegetationSubmission(state, cells);
    return normalizedSlots(result);
  };
  assert.deepEqual(run(), run());
});

test('multiple retirements discard dirty slots that were subsequently removed', () => {
  const state = createVegetationSubmissionState();
  const cells = Array.from({ length: 5 }, (_, i) => cell(`${i},0`, 'bb', i + 2, i + 1));
  reconcileVegetationSubmission(state, cells);
  const result = reconcileVegetationSubmission(state, [cells[2]]);
  assert.equal(result.instances, cells[2].records[0].count);
  for (const range of result.species.get('bb').ranges) {
    assert.ok(range.start + range.count <= result.instances);
  }
});
