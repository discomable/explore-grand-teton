import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVisibleTerrain } from '../terrain/src/terrain-coverage.js';

function mesh(visible, lastShown) {
  return { mesh: { visible }, lastShown };
}

test('visible terrain coverage requires every rendered leaf to draw this frame', () => {
  const nodes = [
    { z: 2, x: 0, y: 0, render: true, internal: false, hSrc: { z: 1 }, nativeHeightMaxZoom: 4 },
    { z: 2, x: 1, y: 0, render: true, internal: false, hSrc: { z: 2 }, nativeHeightMaxZoom: 4 },
    { z: 1, x: 0, y: 0, render: false, internal: true },
  ];
  const meshes = new Map([
    ['2/0/0', mesh(true, 9)],
    ['2/1/0', mesh(true, 9)],
  ]);
  assert.deepEqual(summarizeVisibleTerrain(nodes, meshes, 9), {
    visibleLeaves: 2,
    drawableLeaves: 2,
    missingLeaves: [],
    ratio: 1,
    nativeHeightLeaves: 1,
    nativeHeightRatio: 0.5,
    complete: true,
  });
});

test('visible terrain coverage reports missing and stale leaves', () => {
  const nodes = [
    { z: 3, x: 2, y: 4, render: true, internal: false, hSrc: null, nativeHeightMaxZoom: 4 },
    { z: 3, x: 3, y: 4, render: true, internal: false, hSrc: { z: 3 }, nativeHeightMaxZoom: 4 },
  ];
  const meshes = new Map([
    ['3/3/4', mesh(true, 7)],
  ]);
  const result = summarizeVisibleTerrain(nodes, meshes, 8);
  assert.equal(result.complete, false);
  assert.equal(result.ratio, 0);
  assert.deepEqual(result.missingLeaves, ['3/2/4', '3/3/4']);
});
