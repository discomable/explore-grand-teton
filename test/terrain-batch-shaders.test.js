import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
await import('../terrain/src/terrain-shaders.js?terrain-batch-test');

const { vertex, fragment, batch } = globalThis.TerrainShaders;

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

test('terrain batch shader exposes the fixed 25-float instance contract', () => {
  assert.equal(batch.glslVersion, '300 es');
  assert.equal(batch.heightSampler, 'uHeightArray');
  assert.equal(batch.imagerySampler, 'uImageryArray');
  assert.deepEqual(batch.attributes, {
    tile: { name: 'aTerrainTile', itemSize: 4 },
    uvMax: { name: 'aTerrainUVMax', itemSize: 2 },
    height: { name: 'aTerrainHeight', itemSize: 4 },
    imagery: { name: 'aTerrainImagery', itemSize: 4 },
    geom: { name: 'aTerrainGeom', itemSize: 3 },
    ancestorLattice: { name: 'aTerrainCUV', itemSize: 4 },
    edgeRatios: { name: 'aTerrainEdgeR', itemSize: 4 },
  });
  assert.equal(Object.values(batch.attributes).reduce((n, attr) => n + attr.itemSize, 0), 25);
});

test('terrain batch shader uses array layers and keeps the legacy fallback intact', () => {
  assert.match(vertex, /uniform sampler2D uHeight;/);
  assert.match(fragment, /uniform sampler2D uImagery;/);
  assert.doesNotMatch(vertex, /sampler2DArray/);
  assert.doesNotMatch(fragment, /sampler2DArray/);

  assert.match(batch.vertex, /uniform highp sampler2DArray uHeightArray;/);
  assert.match(batch.vertex, /texture\(uHeightArray, vec3\(terrainUV, aTerrainHeight\.w\)\)/);
  assert.doesNotMatch(batch.vertex, /uniform sampler2D uHeight;/);
  assert.match(batch.fragment, /uniform highp sampler2DArray uImageryArray;/);
  assert.match(batch.fragment, /vTerrainImagery\.w\), mipBias\)/);
  assert.match(batch.fragment, /#define uHasImg\s+step\(-0\.5, vTerrainImagery\.w\)/);
  assert.doesNotMatch(batch.fragment, /uniform sampler2D uImagery;/);
  assert.match(batch.fragment, /layout\(location = 0\) out highp vec4 terrainFragColor;/);
  assert.doesNotMatch(batch.fragment, /gl_FragColor/);
});

test('batch derivation preserves morph, stitch, and lighting equations verbatim', () => {
  for (const signature of [
    'float hLattice(vec2 uv, float s)',
    'float surfaceH(vec2 uv)',
    'float collapseEdge(float fixedU, bool xFixed, float along, float r)',
  ]) assert.equal(functionSource(batch.vertex, signature), functionSource(vertex, signature));

  for (const signature of [
    'vec3 authoredToLinear(vec3 c)',
    'vec3 hlBeam(vec3 world, vec3 nrm, vec3 bpos, vec3 bdir)',
    'float cloudShade()',
    'float sunCastShadow()',
    'float sunVisibility()',
  ]) assert.equal(functionSource(batch.fragment, signature), functionSource(fragment, signature));
});

test('per-instance fields are flat where they cross into the fragment stage', () => {
  for (const shader of [batch.vertex, batch.fragment]) {
    assert.match(shader, /flat varying vec4 vTerrainImagery;/);
    assert.match(shader, /flat varying vec2 vTerrainUVMax;/);
  }
  assert.match(batch.vertex, /vTerrainImagery = aTerrainImagery;/);
  assert.match(batch.vertex, /vTerrainUVMax = aTerrainUVMax;/);
});
