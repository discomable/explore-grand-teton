import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCandidateRandoms,
  mulberry32,
} from '../terrain/src/workers/vegetation-candidates.js';

test('worker candidate streams remain byte-for-byte deterministic', () => {
  const input = { cx: -17, cz: 31, treeCandidates: 37, shrubCandidates: 19 };
  const result = generateCandidateRandoms(input);
  const tree = mulberry32((input.cx * 73856093) ^ (input.cz * 19349663) ^ 0x9E3779B9);
  const shrub = mulberry32(((input.cx * 83492791) ^ (input.cz * 297121507) ^ 0x51AB1E) >>> 0);
  for (const value of result.tree) assert.equal(value, tree());
  for (const value of result.shrub) assert.equal(value, shrub());
});

test('candidate generation observes cancellation', () => {
  assert.throws(
    () => generateCandidateRandoms(
      { cx: 0, cz: 0, treeCandidates: 1, shrubCandidates: 0 },
      () => true,
    ),
    error => error.name === 'AbortError',
  );
});

test('candidate buffers have an exact transferable layout', () => {
  const result = generateCandidateRandoms({
    cx: 4,
    cz: -9,
    treeCandidates: 11,
    shrubCandidates: 7,
  });

  assert.equal(result.tree.constructor, Float64Array);
  assert.equal(result.tree.length, 11 * 13);
  assert.equal(result.tree.byteOffset, 0);
  assert.equal(result.tree.byteLength, 11 * 13 * Float64Array.BYTES_PER_ELEMENT);
  assert.equal(result.tree.buffer.byteLength, result.tree.byteLength);

  assert.equal(result.shrub.constructor, Float64Array);
  assert.equal(result.shrub.length, 7 * 8);
  assert.equal(result.shrub.byteOffset, 0);
  assert.equal(result.shrub.byteLength, 7 * 8 * Float64Array.BYTES_PER_ELEMENT);
  assert.equal(result.shrub.buffer.byteLength, result.shrub.byteLength);
  assert.equal(result.treeSpatial.length, 11 * 5);
  assert.equal(result.shrubSpatial.length, 7 * 2);
});

test('candidate buffers transfer ownership without cloning', () => {
  const result = generateCandidateRandoms({
    cx: 8,
    cz: 13,
    treeCandidates: 3,
    shrubCandidates: 2,
  });
  const expectedTree = [...result.tree];
  const expectedShrub = [...result.shrub];
  const expectedTreeSpatial = [...result.treeSpatial];
  const expectedShrubSpatial = [...result.shrubSpatial];

  const transferred = structuredClone(result, {
    transfer: [
      result.tree.buffer,
      result.treeSpatial.buffer,
      result.shrub.buffer,
      result.shrubSpatial.buffer,
    ],
  });

  assert.equal(result.tree.buffer.byteLength, 0);
  assert.equal(result.treeSpatial.buffer.byteLength, 0);
  assert.equal(result.shrub.buffer.byteLength, 0);
  assert.equal(result.shrubSpatial.buffer.byteLength, 0);
  assert.deepEqual([...transferred.tree], expectedTree);
  assert.deepEqual([...transferred.treeSpatial], expectedTreeSpatial);
  assert.deepEqual([...transferred.shrub], expectedShrub);
  assert.deepEqual([...transferred.shrubSpatial], expectedShrubSpatial);
});

test('tree and shrub streams are independent of the other candidate count', () => {
  const common = { cx: 27, cz: -14 };
  const small = generateCandidateRandoms({
    ...common,
    treeCandidates: 4,
    shrubCandidates: 3,
  });
  const moreShrubs = generateCandidateRandoms({
    ...common,
    treeCandidates: 4,
    shrubCandidates: 30,
  });
  const moreTrees = generateCandidateRandoms({
    ...common,
    treeCandidates: 40,
    shrubCandidates: 3,
  });

  assert.deepEqual(small.tree, moreShrubs.tree);
  assert.deepEqual(small.shrub, moreTrees.shrub);
});

test('candidate generation can be cancelled between tree and shrub streams', () => {
  let checks = 0;
  assert.throws(
    () => generateCandidateRandoms(
      { cx: 0, cz: 0, treeCandidates: 1, shrubCandidates: 1 },
      () => ++checks === 2,
    ),
    error => error.name === 'AbortError',
  );
  assert.equal(checks, 2);
});
