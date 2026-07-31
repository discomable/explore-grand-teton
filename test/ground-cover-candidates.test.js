import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateGroundCoverRandoms,
  mulberry32,
} from '../terrain/src/workers/ground-cover-candidates.js';

test('ground-cover candidate stream matches the historical fixed draw sequence', () => {
  const input = { cx: -12, cz: 7, candidates: 31, v2: true };
  const actual = generateGroundCoverRandoms(input);
  const expected = mulberry32(
    ((input.cx * 73856093) ^ (input.cz * 19349663) ^ 0x62B10E) >>> 0,
  );
  for (const value of actual) assert.equal(value, expected());
});

test('ground-cover v1 and v2 streams retain their independent salts', () => {
  const input = { cx: 3, cz: -5, candidates: 8 };
  const v1 = generateGroundCoverRandoms({ ...input, v2: false });
  const v2 = generateGroundCoverRandoms({ ...input, v2: true });
  assert.notDeepEqual(v1, v2);
  assert.deepEqual(v2, generateGroundCoverRandoms({ ...input, v2: true }));
});

test('ground-cover buffers transfer ownership and generation observes cancellation', () => {
  const randoms = generateGroundCoverRandoms({ cx: 1, cz: 2, candidates: 4, v2: true });
  const expected = [...randoms];
  const transferred = structuredClone(randoms, { transfer: [randoms.buffer] });
  assert.equal(randoms.buffer.byteLength, 0);
  assert.deepEqual([...transferred], expected);

  assert.throws(
    () => generateGroundCoverRandoms(
      { cx: 0, cz: 0, candidates: 1, v2: false },
      () => true,
    ),
    error => error.name === 'AbortError',
  );
});
