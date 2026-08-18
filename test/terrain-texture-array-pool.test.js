import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import {
  TerrainTextureArrayCapacityError,
  createTerrainTextureArrayPool,
  probeTerrainTextureArraySupport,
} from '../terrain/src/TerrainTextureArrayPool.js';

function fakeRenderer({ maxLayers = 8, maxTextureSize = 4096, floatLinear = true } = {}) {
  const gl = {
    MAX_ARRAY_TEXTURE_LAYERS: 1,
    MAX_TEXTURE_SIZE: 2,
    getParameter(parameter) {
      if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return maxLayers;
      if (parameter === this.MAX_TEXTURE_SIZE) return maxTextureSize;
      return 0;
    },
    getExtension(name) {
      return name === 'OES_texture_float_linear' && floatLinear ? {} : null;
    },
  };
  return {
    capabilities: { isWebGL2: true, getMaxAnisotropy: () => 12 },
    copies: [],
    initialized: [],
    getContext: () => gl,
    initTexture(texture) { this.initialized.push(texture); },
    copyTextureToTexture(source, destination, region, position) {
      this.copies.push({ source, destination, region, position });
    },
  };
}

function makePool(renderer = fakeRenderer(), options = {}) {
  const result = createTerrainTextureArrayPool(renderer, {
    search: '',
    heightTileSize: 2,
    imageryTileSize: 2,
    heightCapacity: 2,
    imageryCapacity: 2,
    ...options,
  });
  assert.equal(result.supported, true);
  return result.pool;
}

function heights(value) {
  return new Float32Array(4).fill(value);
}

test('capability probe provides explicit legacy-path reasons and clamps capacities', () => {
  const renderer = fakeRenderer({ maxLayers: 3 });
  assert.deepEqual(probeTerrainTextureArraySupport(renderer, {
    search: '?terrainBatch=0', heightTileSize: 2, imageryTileSize: 2,
  }), { supported: false, reason: 'disabled-by-query' });

  const tooSmall = probeTerrainTextureArraySupport(
    fakeRenderer({ maxTextureSize: 1 }), { search: '', heightTileSize: 2, imageryTileSize: 2 });
  assert.equal(tooSmall.supported, false);
  assert.equal(tooSmall.reason, 'texture-size-limit');

  const result = createTerrainTextureArrayPool(renderer, {
    search: '', heightTileSize: 2, imageryTileSize: 2,
    heightCapacity: 8, imageryCapacity: 7,
  });
  assert.equal(result.heightCapacity, 3);
  assert.equal(result.imageryCapacity, 3);
  result.pool.dispose();
});

test('array textures preserve R32F and RGBA8 sampling contracts', () => {
  const renderer = fakeRenderer({ floatLinear: true });
  const pool = makePool(renderer);
  assert.equal(renderer.initialized.length, 2);
  assert.equal(pool.height.texture.isDataArrayTexture, true);
  assert.equal(pool.height.texture.format, RedFormat);
  assert.equal(pool.height.texture.type, FloatType);
  assert.equal(pool.height.texture.internalFormat, 'R32F');
  assert.equal(pool.height.texture.minFilter, LinearFilter);
  assert.equal(pool.height.texture.magFilter, LinearFilter);
  assert.equal(pool.height.texture.generateMipmaps, false);

  assert.equal(pool.imagery.texture.isDataArrayTexture, true);
  assert.equal(pool.imagery.texture.format, RGBAFormat);
  assert.equal(pool.imagery.texture.type, UnsignedByteType);
  assert.equal(pool.imagery.texture.internalFormat, 'RGBA8');
  assert.equal(pool.imagery.texture.minFilter, LinearMipmapLinearFilter);
  assert.equal(pool.imagery.texture.magFilter, LinearFilter);
  assert.equal(pool.imagery.texture.generateMipmaps, false);
  assert.equal(pool.imagery.texture.anisotropy, 12);
  pool.dispose();

  const nearestPool = makePool(fakeRenderer({ floatLinear: false }));
  assert.equal(nearestPool.height.texture.minFilter, NearestFilter);
  nearestPool.dispose();
});

test('height assignments stay stable and are exposed only after upload completes', () => {
  const renderer = fakeRenderer();
  const pool = makePool(renderer);
  let observedDuringCopy = 'not-called';
  renderer.copyTextureToTexture = (source, destination, region, position) => {
    observedDuringCopy = pool.height.getReady('4/2/1', false);
    renderer.copies.push({ source, destination, region, position });
  };
  const first = pool.uploadHeight('4/2/1', heights(10));
  assert.equal(observedDuringCopy, null);
  assert.equal(first.layer, 0);
  assert.equal(first.texture, pool.height.texture);
  assert.equal(pool.uploadHeight('4/2/1', heights(20), { protect: 'prefetch' }).layer, 0);
  assert.equal(pool.height.isProtected('4/2/1'), true);
  assert.equal(renderer.copies.length, 1);
  assert.deepEqual(renderer.copies[0].position, { x: 0, y: 0, z: 0 });
  pool.dispose();
});

test('LRU reuse never evicts persistent, current-frame, or next-frame sources', () => {
  const pool = makePool();
  pool.uploadHeight('base', heights(1), { persistent: true });
  pool.uploadHeight('visible', heights(2));

  pool.beginNextFrame();
  assert.equal(pool.retainForNextFrame('height', 'visible', 2).layer, 1);
  assert.throws(
    () => pool.uploadHeight('new', heights(3)),
    error => error instanceof TerrainTextureArrayCapacityError && error.kind === 'height');
  pool.publishNextFrame();

  pool.beginNextFrame();
  assert.throws(() => pool.uploadHeight('new', heights(3)), TerrainTextureArrayCapacityError);
  pool.publishNextFrame();

  const replacement = pool.uploadHeight('new', heights(3));
  assert.equal(replacement.layer, 1);
  assert.equal(pool.height.getReady('visible', false), null);
  assert.equal(pool.height.getReady('base', false).layer, 0);
  assert.equal(pool.height.snapshot().evictions, 1);
  pool.dispose();
});

test('unprotected least-recently-used layers are reused deterministically', () => {
  const pool = makePool();
  const a = pool.uploadHeight('a', heights(1));
  const b = pool.uploadHeight('b', heights(2));
  pool.height.getReady('a');
  const c = pool.uploadHeight('c', heights(3));
  assert.equal(c.layer, b.layer);
  assert.equal(pool.height.getReady('b', false), null);
  assert.equal(pool.height.getReady('a', false).layer, a.layer);
  pool.dispose();
});

test('imagery upload edge-pads before publishing and closes the decoded source', () => {
  const renderer = fakeRenderer();
  const pool = makePool(renderer);
  const draws = [];
  const canvas = {
    width: 2,
    height: 2,
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
  };
  let closed = 0;
  const bitmap = { width: 2, height: 2, close: () => closed++ };
  let observedDuringCopy = 'not-called';
  renderer.copyTextureToTexture = (source, destination, region, position, sourceLevel, destinationLevel) => {
    observedDuringCopy = pool.imagery.getReady('7/0/0', false);
    renderer.copies.push({ source, destination, region, position, sourceLevel, destinationLevel });
  };
  const ready = pool.uploadImagery('7/0/0', bitmap, {
    validX: 1,
    validY: 1,
    canvasFactory: () => canvas,
  });
  assert.equal(observedDuringCopy, null);
  assert.equal(ready.layer, 0);
  assert.equal(closed, 1);
  assert.equal(draws.length, 5);
  assert.equal(renderer.copies[0].source.image, canvas);
  assert.equal(renderer.copies[0].destination.generateMipmaps, false);
  assert.deepEqual(renderer.copies[0].position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(renderer.copies.map(copy => [copy.sourceLevel, copy.destinationLevel]),
    [[0, 0], [0, 1]]);
  pool.dispose();
});

test('failed uploads free reservations and disposal releases both arrays', () => {
  const renderer = fakeRenderer();
  const pool = makePool(renderer);
  renderer.copyTextureToTexture = () => { throw new Error('upload failed'); };
  assert.throws(() => pool.uploadHeight('bad', heights(1)), /upload failed/);
  assert.equal(pool.height.getReady('bad', false), null);
  assert.equal(pool.height.snapshot().occupiedLayers, 0);

  let heightDisposed = 0, imageryDisposed = 0;
  pool.height.texture.addEventListener('dispose', () => heightDisposed++);
  pool.imagery.texture.addEventListener('dispose', () => imageryDisposed++);
  pool.dispose();
  pool.dispose();
  assert.equal(heightDisposed, 1);
  assert.equal(imageryDisposed, 1);
});

test('rejected imagery is closed and allocation failures request legacy fallback', () => {
  const pool = makePool(fakeRenderer(), { imageryCapacity: 1 });
  pool.uploadImagery('protected', { close() {} }, {
    prepared: true, persistent: true,
    canvasFactory: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
  });
  let closed = 0;
  assert.throws(() => pool.uploadImagery('rejected', { close: () => closed++ }, {
    prepared: true,
  }), TerrainTextureArrayCapacityError);
  assert.equal(closed, 1);

  let retainedClosed = 0;
  assert.throws(() => pool.uploadImagery('retryable', { close: () => retainedClosed++ }, {
    prepared: true, retainOnCapacity: true,
  }), TerrainTextureArrayCapacityError);
  assert.equal(retainedClosed, 0);
  pool.dispose();

  const renderer = fakeRenderer();
  renderer.initTexture = () => { throw new Error('driver rejected allocation'); };
  const result = createTerrainTextureArrayPool(renderer, {
    search: '', heightTileSize: 2, imageryTileSize: 2,
  });
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'array-allocation-failed');
  assert.match(result.error.message, /driver rejected allocation/);
});

test('metrics report layer protection, reference counts, and allocated bytes', () => {
  const pool = makePool();
  pool.uploadHeight('base', heights(1), { protect: 'ancestor' });
  pool.uploadHeight('tile', heights(2));
  pool.beginNextFrame();
  pool.retainForNextFrame('height', 'tile', 3);
  const metrics = pool.snapshot();
  assert.equal(metrics.height.capacity, 2);
  assert.equal(metrics.height.occupiedLayers, 2);
  assert.equal(metrics.height.protectedLayers, 2);
  assert.equal(metrics.height.nextReferences, 3);
  assert.equal(metrics.temporaryUploads, 0);
  assert.equal(metrics.temporaryUploadBytes, 0);
  assert.equal(metrics.peakTemporaryUploadBytes, 16);
  assert.equal(metrics.totalUploads, 2);
  assert.equal(metrics.totalUploadBytes, 32);
  assert.equal(metrics.cpuBytes, 0);
  assert.equal(metrics.allocatedGpuBytes, (2 * 16) + (2 * (16 + 4)));
  pool.cancelNextFrame();
  pool.dispose();
});
