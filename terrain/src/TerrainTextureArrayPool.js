import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  Texture,
  UnsignedByteType,
} from 'three';

const HEIGHT_BYTES_PER_TEXEL = 4;
const IMAGERY_BYTES_PER_TEXEL = 4;

export class TerrainTextureArrayCapacityError extends Error {
  constructor(kind, capacity) {
    super(`No unprotected ${kind} texture-array layer is available (capacity ${capacity})`);
    this.name = 'TerrainTextureArrayCapacityError';
    this.kind = kind;
    this.capacity = capacity;
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function protectionReasons(options) {
  const reasons = Array.isArray(options.protect) ? [...options.protect] :
    (options.protect ? [options.protect] : []);
  if (options.persistent && !reasons.includes('persistent')) reasons.push('persistent');
  return reasons;
}

function mipChainBytes(width, height, bytesPerTexel) {
  let bytes = 0;
  while (true) {
    bytes += width * height * bytesPerTexel;
    if (width === 1 && height === 1) return bytes;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
}

/**
 * Read-only compatibility check for the batched terrain path. Keeping this separate from pool
 * construction lets TerrainStreamer select its legacy Texture path without allocating anything.
 */
export function probeTerrainTextureArraySupport(renderer, options = {}) {
  const search = options.search ?? globalThis.location?.search ?? '';
  try {
    if (new URLSearchParams(search).get('terrainBatch') === '0') {
      return { supported: false, reason: 'disabled-by-query' };
    }
  } catch (_) {}

  if (!renderer || typeof renderer.getContext !== 'function') {
    return { supported: false, reason: 'missing-renderer' };
  }
  if (typeof renderer.initTexture !== 'function' ||
      typeof renderer.copyTextureToTexture !== 'function') {
    return { supported: false, reason: 'missing-texture-copy-api' };
  }

  const gl = renderer.getContext();
  if (!gl || renderer.capabilities?.isWebGL2 === false) {
    return { supported: false, reason: 'webgl2-required' };
  }

  const maxLayers = Number(gl.getParameter?.(gl.MAX_ARRAY_TEXTURE_LAYERS)) || 0;
  const maxTextureSize = Number(gl.getParameter?.(gl.MAX_TEXTURE_SIZE)) || 0;
  const heightTileSize = positiveInteger(options.heightTileSize, 512);
  const imageryTileSize = positiveInteger(options.imageryTileSize, 512);
  const minHeightLayers = positiveInteger(options.minHeightLayers, 1);
  const minImageryLayers = positiveInteger(options.minImageryLayers, 1);
  const requiredSize = Math.max(heightTileSize, imageryTileSize);

  if (maxTextureSize < requiredSize) {
    return {
      supported: false,
      reason: 'texture-size-limit',
      maxLayers,
      maxTextureSize,
      requiredSize,
    };
  }
  if (maxLayers < Math.max(minHeightLayers, minImageryLayers)) {
    return {
      supported: false,
      reason: 'array-layer-limit',
      maxLayers,
      maxTextureSize,
      requiredHeightLayers: minHeightLayers,
      requiredImageryLayers: minImageryLayers,
    };
  }

  return {
    supported: true,
    reason: null,
    maxLayers,
    maxTextureSize,
    floatLinear: !!gl.getExtension?.('OES_texture_float_linear'),
  };
}

/**
 * Stable key -> layer ownership with double-buffered render references. Manual protection is for
 * persistent base tiles and prefetch/ancestor policy; current/next references protect sources
 * while an instance table is still live or is being staged.
 */
export class TerrainTextureLayerPool {
  constructor({ kind, texture, capacity, bytesPerLayer, onEvict = null }) {
    this.kind = kind;
    this.texture = texture;
    this.capacity = capacity;
    this.bytesPerLayer = bytesPerLayer;
    this.onEvict = onEvict;
    this.records = new Map();
    this.layers = new Array(capacity).fill(null);
    this.freeLayers = [];
    for (let layer = capacity - 1; layer >= 0; layer--) this.freeLayers.push(layer);
    this.currentRefs = new Map();
    this.nextRefs = new Map();
    this.staging = false;
    this.clock = 0;
    this.evictions = 0;
    this.disposed = false;
  }

  _assertLive() {
    if (this.disposed) throw new Error(`${this.kind} texture-array pool is disposed`);
  }

  _isProtected(record) {
    return record.protection.size > 0 ||
      (this.currentRefs.get(record.key) || 0) > 0 ||
      (this.nextRefs.get(record.key) || 0) > 0;
  }

  _removeRecord(record, notify = true) {
    if (this.records.get(record.key) !== record) return false;
    this.records.delete(record.key);
    this.layers[record.layer] = null;
    this.currentRefs.delete(record.key);
    this.nextRefs.delete(record.key);
    this.freeLayers.push(record.layer);
    if (notify) this.onEvict?.({ ...record, protection: new Set(record.protection) });
    return true;
  }

  _evictionCandidate() {
    let candidate = null;
    for (const record of this.records.values()) {
      if (record.state !== 'ready' || this._isProtected(record)) continue;
      if (!candidate || record.lastUsed < candidate.lastUsed ||
          (record.lastUsed === candidate.lastUsed && record.layer < candidate.layer)) {
        candidate = record;
      }
    }
    return candidate;
  }

  reserve(key, options = {}) {
    this._assertLive();
    let record = this.records.get(key);
    if (record) {
      record.lastUsed = ++this.clock;
      for (const reason of protectionReasons(options)) record.protection.add(reason);
      return record;
    }

    if (!this.freeLayers.length) {
      const victim = this._evictionCandidate();
      if (!victim) throw new TerrainTextureArrayCapacityError(this.kind, this.capacity);
      this._removeRecord(victim);
      this.evictions++;
    }

    const layer = this.freeLayers.pop();
    record = {
      key,
      layer,
      state: 'reserved',
      lastUsed: ++this.clock,
      protection: new Set(protectionReasons(options)),
    };
    this.records.set(key, record);
    this.layers[layer] = record;
    return record;
  }

  markUploading(key) {
    const record = this.records.get(key);
    if (!record) throw new Error(`${this.kind} layer ${key} was not reserved`);
    record.state = 'uploading';
    return record;
  }

  markReady(key) {
    const record = this.records.get(key);
    if (!record) throw new Error(`${this.kind} layer ${key} was not reserved`);
    record.state = 'ready';
    record.lastUsed = ++this.clock;
    return record;
  }

  fail(key) {
    const record = this.records.get(key);
    return record ? this._removeRecord(record) : false;
  }

  getReady(key, touch = true) {
    const record = this.records.get(key);
    if (!record || record.state !== 'ready') return null;
    if (touch) record.lastUsed = ++this.clock;
    return { key: record.key, layer: record.layer, texture: this.texture };
  }

  protect(key, reason = 'manual') {
    const record = this.records.get(key);
    if (!record) return false;
    record.protection.add(reason);
    return true;
  }

  unprotect(key, reason = 'manual') {
    return this.records.get(key)?.protection.delete(reason) || false;
  }

  isProtected(key) {
    const record = this.records.get(key);
    return !!record && this._isProtected(record);
  }

  beginNextFrame() {
    this._assertLive();
    this.nextRefs.clear();
    this.staging = true;
  }

  retainForNextFrame(key, count = 1) {
    if (!this.staging) throw new Error('beginNextFrame() must precede retainForNextFrame()');
    if (!Number.isInteger(count) || count <= 0) throw new TypeError('reference count must be positive');
    const record = this.records.get(key);
    if (!record || record.state !== 'ready') return null;
    this.nextRefs.set(key, (this.nextRefs.get(key) || 0) + count);
    record.lastUsed = ++this.clock;
    return { key: record.key, layer: record.layer, texture: this.texture };
  }

  publishNextFrame() {
    if (!this.staging) throw new Error('No next frame is being staged');
    this.currentRefs = this.nextRefs;
    this.nextRefs = new Map();
    this.staging = false;
  }

  cancelNextFrame() {
    this.nextRefs.clear();
    this.staging = false;
  }

  release(key, { force = false } = {}) {
    const record = this.records.get(key);
    if (!record || (!force && this._isProtected(record))) return false;
    return this._removeRecord(record);
  }

  snapshot() {
    let ready = 0, uploading = 0, protectedLayers = 0;
    let currentReferences = 0, nextReferences = 0;
    for (const record of this.records.values()) {
      if (record.state === 'ready') ready++;
      else uploading++;
      if (this._isProtected(record)) protectedLayers++;
    }
    for (const count of this.currentRefs.values()) currentReferences += count;
    for (const count of this.nextRefs.values()) nextReferences += count;
    return {
      capacity: this.capacity,
      occupiedLayers: this.records.size,
      readyLayers: ready,
      pendingLayers: uploading,
      protectedLayers,
      currentReferences,
      nextReferences,
      residentGpuBytes: ready * this.bytesPerLayer,
      allocatedGpuBytes: this.capacity * this.bytesPerLayer,
      evictions: this.evictions,
    };
  }

  dispose() {
    if (this.disposed) return;
    for (const record of [...this.records.values()]) this._removeRecord(record);
    this.currentRefs.clear();
    this.nextRefs.clear();
    this.texture.dispose();
    this.disposed = true;
  }
}

function makeHeightTexture(size, capacity, floatLinear) {
  const texture = new DataArrayTexture(null, size, size, capacity);
  texture.name = 'terrain-height-array';
  texture.format = RedFormat;
  texture.type = FloatType;
  texture.internalFormat = 'R32F';
  texture.minFilter = texture.magFilter = floatLinear ? LinearFilter : NearestFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  // renderer.initTexture() only allocates user textures whose source version is non-zero.
  // The backing data intentionally stays null (immutable texStorage3D allocation); needsUpdate
  // advances the version without asking Three to upload a full CPU-sized array.
  texture.needsUpdate = true;
  return texture;
}

function makeImageryTexture(size, capacity, anisotropy) {
  const texture = new DataArrayTexture(null, size, size, capacity);
  texture.name = 'terrain-imagery-array';
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.internalFormat = 'RGBA8';
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

function edgePadImagery(source, size, validX, validY, canvasFactory) {
  if (validX >= size && validY >= size) return source;
  const makeCanvas = canvasFactory || ((width, height) => {
    if (typeof OffscreenCanvas !== 'function') {
      throw new Error('OffscreenCanvas is required to edge-pad imagery array layers');
    }
    return new OffscreenCanvas(width, height);
  });
  const canvas = makeCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create imagery edge-padding context');
  context.drawImage(source, 0, 0, size, size);
  if (validX < size) {
    context.drawImage(canvas, validX - 1, 0, 1, size, validX, 0, size - validX, size);
  }
  if (validY < size) {
    context.drawImage(canvas, 0, validY - 1, size, 1, 0, validY, size, size - validY);
  }
  return canvas;
}

/** Paired height/imagery array residency used by the instanced terrain renderer. */
export class TerrainTextureArrayPool {
  constructor(renderer, options) {
    this.renderer = renderer;
    this.heightTileSize = options.heightTileSize;
    this.imageryTileSize = options.imageryTileSize;
    this.temporaryUploads = 0;
    this.temporaryUploadBytes = 0;
    this.peakTemporaryUploadBytes = 0;
    this.totalUploads = 0;
    this.totalUploadBytes = 0;
    this.disposed = false;

    const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() || 1;
    const heightTexture = makeHeightTexture(
      this.heightTileSize, options.heightCapacity, options.floatLinear);
    const imageryTexture = makeImageryTexture(
      this.imageryTileSize, options.imageryCapacity, maxAnisotropy);
    this.height = new TerrainTextureLayerPool({
      kind: 'height',
      texture: heightTexture,
      capacity: options.heightCapacity,
      bytesPerLayer: this.heightTileSize * this.heightTileSize * HEIGHT_BYTES_PER_TEXEL,
      onEvict: record => options.onEvict?.('height', record),
    });
    this.imagery = new TerrainTextureLayerPool({
      kind: 'imagery',
      texture: imageryTexture,
      capacity: options.imageryCapacity,
      bytesPerLayer: mipChainBytes(
        this.imageryTileSize, this.imageryTileSize, IMAGERY_BYTES_PER_TEXEL),
      onEvict: record => options.onEvict?.('imagery', record),
    });

    // Allocate immutable array storage before any key can be exposed as ready. Subsequent public
    // copyTextureToTexture calls update one layer and regenerate the imagery mip chain at level 0.
    try {
      renderer.initTexture(heightTexture);
      renderer.initTexture(imageryTexture);
      // texStorage3D was allocated with the full mip count because generateMipmaps was true.
      // Subsequent layer uploads copy a completed temporary 2D mip chain level-by-level; leaving
      // this true would regenerate every layer after every level-0 copy.
      imageryTexture.generateMipmaps = false;
    } catch (error) {
      heightTexture.dispose();
      imageryTexture.dispose();
      throw error;
    }
  }

  _withTemporaryUpload(bytes, upload) {
    this.totalUploads++;
    this.totalUploadBytes += bytes;
    this.temporaryUploads++;
    this.temporaryUploadBytes += bytes;
    this.peakTemporaryUploadBytes = Math.max(
      this.peakTemporaryUploadBytes, this.temporaryUploadBytes);
    try { return upload(); }
    finally {
      this.temporaryUploads--;
      this.temporaryUploadBytes -= bytes;
    }
  }

  uploadHeight(key, decoded, options = {}) {
    if (!(decoded instanceof Float32Array) ||
        decoded.length !== this.heightTileSize * this.heightTileSize) {
      throw new TypeError('Height layer must be one tile-sized Float32Array');
    }
    const existing = this.height.getReady(key, false);
    if (existing && !options.replace) {
      this.height.reserve(key, options); // merge persistent/prefetch protection on stable hits
      return existing;
    }
    if (existing && this.height.isProtected(key)) {
      throw new Error(`Cannot replace protected height layer ${key}`);
    }
    const record = this.height.reserve(key, options);
    this.height.markUploading(key);
    const source = new DataTexture(
      decoded, this.heightTileSize, this.heightTileSize, RedFormat, FloatType);
    source.flipY = false;
    source.unpackAlignment = 1;
    try {
      this._withTemporaryUpload(decoded.byteLength, () => {
        this.renderer.copyTextureToTexture(
          source, this.height.texture, null, { x: 0, y: 0, z: record.layer });
      });
      this.height.markReady(key);
      return this.height.getReady(key, false);
    } catch (error) {
      this.height.fail(key);
      throw error;
    } finally {
      source.dispose();
    }
  }

  uploadImagery(key, bitmap, options = {}) {
    const existing = this.imagery.getReady(key, false);
    if (existing && !options.replace) {
      this.imagery.reserve(key, options); // merge persistent/prefetch protection on stable hits
      if (options.closeSource !== false) bitmap?.close?.();
      return existing;
    }
    if (existing && this.imagery.isProtected(key)) {
      if (options.closeSource !== false) bitmap?.close?.();
      throw new Error(`Cannot replace protected imagery layer ${key}`);
    }
    let record;
    try {
      record = this.imagery.reserve(key, options);
      this.imagery.markUploading(key);
    } catch (error) {
      if (options.closeSource !== false) bitmap?.close?.();
      throw error;
    }
    const validX = Math.max(1, Math.min(this.imageryTileSize,
      options.validX ?? this.imageryTileSize));
    const validY = Math.max(1, Math.min(this.imageryTileSize,
      options.validY ?? this.imageryTileSize));
    let image;
    try {
      image = options.prepared ? bitmap : edgePadImagery(
        bitmap, this.imageryTileSize, validX, validY, options.canvasFactory);
      try {
        const bytes = this.imageryTileSize * this.imageryTileSize * IMAGERY_BYTES_PER_TEXEL;
        this._withTemporaryUpload(bytes, () => {
          // Build this layer's mip chain on small temporary canvases, then upload each level
          // directly. WebGL's generateMipmap(TEXTURE_2D_ARRAY) regenerates ALL resident layers,
          // which turns streamed uploads into an O(capacity*uploads) startup stall.
          const levels = Math.floor(Math.log2(this.imageryTileSize)) + 1;
          const makeCanvas = options.canvasFactory || ((width, height) =>
            new OffscreenCanvas(width, height));
          const base = makeCanvas(this.imageryTileSize, this.imageryTileSize);
          const baseContext = base.getContext('2d');
          if (!baseContext) throw new Error('Unable to create imagery mip context');
          baseContext.drawImage(image, 0, 0, this.imageryTileSize, this.imageryTileSize);
          for (let level = 0; level < levels; level++) {
            const mipSize = Math.max(1, this.imageryTileSize >> level);
            let mipImage = base;
            if (level > 0) {
              mipImage = makeCanvas(mipSize, mipSize);
              const context = mipImage.getContext('2d');
              if (!context) throw new Error('Unable to create imagery mip context');
              context.drawImage(base, 0, 0, mipSize, mipSize);
            }
            const source = new Texture(mipImage);
            source.flipY = false; source.unpackAlignment = 1;
            try {
              this.renderer.copyTextureToTexture(
                source, this.imagery.texture, null, { x: 0, y: 0, z: record.layer },
                0, level);
            } finally { source.dispose(); }
          }
        });
      } finally {}
      this.imagery.markReady(key);
      return this.imagery.getReady(key, false);
    } catch (error) {
      this.imagery.fail(key);
      throw error;
    } finally {
      if (options.closeSource !== false) bitmap?.close?.();
    }
  }

  beginNextFrame() {
    this.height.beginNextFrame();
    this.imagery.beginNextFrame();
  }

  retainForNextFrame(kind, key, count = 1) {
    return this[kind]?.retainForNextFrame(key, count) || null;
  }

  publishNextFrame() {
    this.height.publishNextFrame();
    this.imagery.publishNextFrame();
  }

  cancelNextFrame() {
    this.height.cancelNextFrame();
    this.imagery.cancelNextFrame();
  }

  snapshot() {
    const height = this.height.snapshot();
    const imagery = this.imagery.snapshot();
    return {
      height,
      imagery,
      arrayCapacity: height.capacity + imagery.capacity,
      occupiedLayers: height.occupiedLayers + imagery.occupiedLayers,
      protectedLayers: height.protectedLayers + imagery.protectedLayers,
      temporaryUploads: this.temporaryUploads,
      temporaryUploadBytes: this.temporaryUploadBytes,
      peakTemporaryUploadBytes: this.peakTemporaryUploadBytes,
      totalUploads: this.totalUploads,
      totalUploadBytes: this.totalUploadBytes,
      residentGpuBytes: height.residentGpuBytes + imagery.residentGpuBytes,
      allocatedGpuBytes: height.allocatedGpuBytes + imagery.allocatedGpuBytes,
      cpuBytes: 0,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.height.dispose();
    this.imagery.dispose();
    this.disposed = true;
  }
}

/** Construct the paired pool or return a non-throwing legacy-path result. */
export function createTerrainTextureArrayPool(renderer, options = {}) {
  const support = probeTerrainTextureArraySupport(renderer, options);
  if (!support.supported) return { ...support, pool: null };
  const heightCapacity = Math.min(
    positiveInteger(options.heightCapacity, 256), support.maxLayers);
  const imageryCapacity = Math.min(
    positiveInteger(options.imageryCapacity, 256), support.maxLayers);
  if (heightCapacity < positiveInteger(options.minHeightLayers, 1) ||
      imageryCapacity < positiveInteger(options.minImageryLayers, 1)) {
    return { ...support, supported: false, reason: 'array-layer-limit', pool: null };
  }
  try {
    const pool = new TerrainTextureArrayPool(renderer, {
      ...options,
      heightTileSize: positiveInteger(options.heightTileSize, 512),
      imageryTileSize: positiveInteger(options.imageryTileSize, 512),
      heightCapacity,
      imageryCapacity,
      floatLinear: support.floatLinear,
    });
    return { ...support, heightCapacity, imageryCapacity, pool };
  } catch (error) {
    return {
      ...support,
      supported: false,
      reason: 'array-allocation-failed',
      error,
      pool: null,
    };
  }
}
