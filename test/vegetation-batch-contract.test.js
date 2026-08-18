import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVegetationFade,
  buildVegetationBatchFrame,
  compactVegetationRecord,
  keepVegetationInstance,
  nextVegetationCapacity,
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
