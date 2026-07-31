import {
  createRasterDescriptor,
  createHeightTileDescriptor,
  packBuckets,
  spatialTransferList,
  SPATIAL_INDEX_VERSION,
  WATER_SURFACE_INDEX_VERSION,
  waterSurfaceTransferList,
  supportsWorldIndexWorkers,
  worldIndexTransferList,
} from './world-index.js';

export const WorldIndexIds = Object.freeze({
  LANDCOVER: 'landcover',
  WATER_MASK: 'water-mask',
  VEGETATION_HEIGHT: 'vegetation-height',
  VEGETATION_COVER: 'vegetation-cover',
  FOREST_PROBABILITY: 'forest-probability',
  GROUND_TINT_R: 'ground-tint-r',
  GROUND_TINT_G: 'ground-tint-g',
  GROUND_TINT_B: 'ground-tint-b',
});
export const RoadClassCodes = Object.freeze({
  track: 1, gravel: 2, park_paved: 3, highway: 4, trail: 5,
  primitive_trail: 6, steps: 7, boardwalk: 8,
});

/*
 * Persistent main-thread bridge to the worker-owned world query index.
 * During staged adoption it mirrors height tiles into fresh Float32 buffers:
 * renderer/collision ownership is never detached.
 */
export class WorldIndexClient {
  static supported(scope = globalThis) {
    return supportsWorldIndexWorkers(scope);
  }

  constructor({
    WorkerClass = null,
    workerUrl = null,
    generation = 1,
  } = {}) {
    this.generation = generation >>> 0;
    this.ready = false;
    this.failed = false;
    this.closed = false;
    this._nextId = 1;
    this._pending = new Map();
    this._memory = null;
    this._stats = { installed: 0, removed: 0, stale: 0, failures: 0 };
    const NativeWorker = globalThis.Worker;
    if (WorkerClass) {
      this.worker = new WorkerClass(
        workerUrl || 'world-index-worker.js',
        { type: 'module', name: 'gt-world-index' });
    } else {
      if (typeof NativeWorker !== 'function') throw new Error('module workers unavailable');
      // Keep the literal new Worker(new URL()) shape so Vite emits the worker
      // as a static-host-compatible production asset.
      this.worker = new Worker(
        new URL('./world-index-worker.js', import.meta.url),
        { type: 'module', name: 'gt-world-index' });
    }
    this.worker.onmessage = (event) => this._onMessage(event.data);
    this.worker.onerror = (event) => this._fail(event?.error || new Error('world-index worker failed'));
    this.initialized = this._request('init', { descriptors: [] }, { generation: this.generation })
      .then((reply) => {
        if (reply.generation === this.generation) this.ready = true;
        return reply;
      })
      .catch((error) => {
        this.failed = true;
        console.warn('[world-index] unavailable; retaining main-thread queries.', error);
        return null;
      });
  }

  _request(kind, payload = {}, {
    generation = this.generation, transfer = [], signal = null,
  } = {}) {
    if (this.closed || this.failed) return Promise.reject(new Error('world-index unavailable'));
    if (signal?.aborted) {
      const error = new Error('world-index request cancelled'); error.name = 'AbortError';
      return Promise.reject(error);
    }
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener?.('abort', abort);
      const abort = () => {
        if (!this._pending.delete(id)) return;
        try {
          this.worker.postMessage({
            id: this._nextId++, kind: 'cancel', generation, priority: 0, payload: { id },
          });
        } catch (_) {}
        const error = new Error('world-index request cancelled'); error.name = 'AbortError';
        cleanup(); reject(error);
      };
      this._pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
        kind, generation,
      });
      signal?.addEventListener?.('abort', abort, { once: true });
      try {
        this.worker.postMessage({ id, kind, generation, priority: 0, payload }, transfer);
      } catch (error) {
        this._pending.delete(id); cleanup();
        reject(error);
      }
    });
  }

  _onMessage(message) {
    const pending = this._pending.get(message?.id);
    if (!pending) return;
    this._pending.delete(message.id);
    if (message.generation !== pending.generation ||
        (pending.kind !== 'init' && message.generation !== this.generation)) {
      this._stats.stale++;
      pending.reject(new Error('stale world-index reply'));
      return;
    }
    if (!message.ok) {
      this._stats.failures++;
      pending.reject(new Error(message.error || 'world-index request failed'));
      return;
    }
    if (message.meta?.bytes != null) this._memory = message.meta;
    pending.resolve(message);
  }

  _fail(error) {
    if (this.failed) return;
    this.failed = true; this.ready = false; this._stats.failures++;
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }

  async supersede(generation) {
    this.generation = generation >>> 0;
    this.ready = false;
    for (const [id, pending] of this._pending) {
      try {
        this.worker.postMessage({
          id: this._nextId++, kind: 'cancel', generation: pending.generation,
          priority: 0, payload: { id },
        });
      } catch (_) {}
      pending.reject(new Error('world-index generation superseded'));
      this._pending.delete(id);
    }
    const reply = await this._request('init', { descriptors: [] },
      { generation: this.generation });
    this.ready = true;
    return reply;
  }

  installHeightTile({ id, generation = this.generation, z, x, y, data,
    size, minX, minZ, width, height }) {
    if (!this.ready || this.failed || generation !== this.generation) return false;
    // Copy is intentional until main-thread heightAt and GPU upload no longer
    // consume the source buffer.
    const owned = new Float32Array(data);
    const descriptor = createHeightTileDescriptor({
      id, generation, z, x, y, data: owned, size, minX, minZ, width, height,
    });
    this._stats.installed++;
    this._request('install', { descriptors: [descriptor] },
      { transfer: worldIndexTransferList(descriptor) }).catch(() => {});
    return true;
  }

  installDescriptors(descriptors, { transfer = true } = {}) {
    if (!this.ready || this.failed) return Promise.reject(new Error('world-index not ready'));
    const list = Array.isArray(descriptors) ? descriptors : [descriptors];
    return this._request('install', { descriptors: list },
      { transfer: transfer ? worldIndexTransferList(list) : [] });
  }

  installRaster(options) {
    if (!ArrayBuffer.isView(options?.data) || options.data instanceof DataView) {
      return Promise.reject(new TypeError('raster data must be a typed array'));
    }
    // Classic managers retain their decoded RGBA/channel data during staged
    // adoption, so the client owns and transfers a same-type copy.
    const data = new options.data.constructor(options.data);
    return this.installDescriptors(createRasterDescriptor({ ...options, data }));
  }

  installRoadIndex({ segments, buckets, cell, halfWidths = {} }) {
    const packed = packBuckets(buckets);
    const coords = new Float64Array(segments.length * 4);
    const classCodes = new Uint8Array(segments.length);
    const widths = new Float64Array(segments.length);
    segments.forEach((segment, i) => {
      coords.set([segment.ax, segment.az, segment.bx, segment.bz], i * 4);
      classCodes[i] = RoadClassCodes[segment.cls] || RoadClassCodes.track;
      widths[i] = Number.isFinite(segment.halfWidth) ? segment.halfWidth : halfWidths[segment.cls] || 0;
    });
    const descriptor = Object.freeze({
      version: SPATIAL_INDEX_VERSION, type: 'roads', cell,
      segments: coords, classCodes, halfWidths: widths, ...packed,
    });
    return this._request('installSpatial', { descriptors: [descriptor] },
      { transfer: spatialTransferList(descriptor) });
  }

  installTransportSnapshot(snapshot) {
    if (!(snapshot?.version >= 1 && snapshot.version <= 3) || !Array.isArray(snapshot.segments)) {
      return Promise.reject(new TypeError('invalid transport snapshot'));
    }
    const cell = snapshot.cellSize || 32, buckets = new Map();
    const segments = snapshot.segments.map((segment, index) => {
      // v3 shares one `recipe` per feature; v1/v2 spread those fields onto every segment.
      const r = segment.recipe || segment;
      const cls = r.classification || (r.vehicleAllowed ? 'track' : 'trail');
      const halfWidth = r.halfWidth || 0;
      const minX = Math.floor((Math.min(segment.ax, segment.bx) - halfWidth) / cell);
      const maxX = Math.floor((Math.max(segment.ax, segment.bx) + halfWidth) / cell);
      const minZ = Math.floor((Math.min(segment.az, segment.bz) - halfWidth) / cell);
      const maxZ = Math.floor((Math.max(segment.az, segment.bz) + halfWidth) / cell);
      for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const key = `${x},${z}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(index);
      }
      return { ax: segment.ax, az: segment.az, bx: segment.bx, bz: segment.bz, cls, halfWidth };
    });
    return this.installRoadIndex({ segments, buckets, cell });
  }

  installBuildingIndex({ records, buckets, cell }) {
    const packed = packBuckets(buckets);
    const ringOffsets = new Uint32Array(records.length + 1);
    const pointCount = records.reduce((n, record) => n + record.ring.length / 2, 0);
    const rings = new Float64Array(pointCount * 2);
    const bboxes = new Float64Array(records.length * 4);
    const topY = new Float64Array(records.length);
    let cursor = 0;
    records.forEach((record, i) => {
      ringOffsets[i] = cursor;
      rings.set(record.ring, cursor * 2); cursor += record.ring.length / 2;
      bboxes.set([record.minX, record.maxX, record.minZ, record.maxZ], i * 4);
      topY[i] = record.topY;
    });
    ringOffsets[records.length] = cursor;
    const descriptor = Object.freeze({
      version: SPATIAL_INDEX_VERSION, type: 'buildings', cell,
      rings, ringOffsets, bboxes, topY, ...packed,
    });
    return this._request('installSpatial', { descriptors: [descriptor] },
      { transfer: spatialTransferList(descriptor) });
  }

  installWaterSurface({
    surface, bias, width, height, originE, originN, res,
    centerEasting, centerNorthing, elevMin, datum,
  }) {
    if (!(surface instanceof Uint16Array) || !(bias instanceof Int8Array)) {
      return Promise.reject(new TypeError('water surface requires Uint16 surface and Int8 bias'));
    }
    const descriptor = Object.freeze({
      version: WATER_SURFACE_INDEX_VERSION,
      surface: new Uint16Array(surface),
      bias: new Int8Array(bias),
      width, height, originE, originN, res,
      centerEasting, centerNorthing, elevMin, datum,
    });
    return this._request('installWaterSurface', { descriptor },
      { transfer: waterSurfaceTransferList(descriptor) });
  }

  _spatialRequest(kind, payload, transfer, signal) {
    return this._request(kind, payload, { transfer, signal });
  }

  sampleRoad(points, { signal } = {}) {
    const owned = new Float64Array(points);
    return this._spatialRequest('sampleRoad', { points: owned }, [owned.buffer], signal)
      .then((reply) => ({ ...reply.buffers, installed: !!reply.meta.installed }));
  }

  sampleBuildings(points, { y = null, pad = 0, signal } = {}) {
    const owned = new Float64Array(points);
    const heights = y ? new Float64Array(y) : null;
    const transfer = [owned.buffer];
    if (heights) transfer.push(heights.buffer);
    return this._spatialRequest('sampleBuildings',
      { points: owned, y: heights, pad }, transfer, signal)
      .then((reply) => ({ ...reply.buffers, installed: !!reply.meta.installed }));
  }

  sampleWaterSurface(points, { signal } = {}) {
    const owned = new Float64Array(points);
    return this._spatialRequest('sampleWaterSurface',
      { points: owned }, [owned.buffer], signal)
      .then((reply) => ({ ...reply.buffers, installed: !!reply.meta.installed }));
  }

  sampleCanopyShell(points, { signal } = {}) {
    const owned = new Float64Array(points);
    return this._spatialRequest('sampleCanopyShell',
      { points: owned }, [owned.buffer], signal)
      .then((reply) => ({
        ...reply.buffers,
        installed: reply.meta.installed,
        coverage: reply.meta.coverage,
      }));
  }

  sample({ index = null, method = 'nearest', points, signal } = {}) {
    if (!this.ready || this.failed) return Promise.reject(new Error('world-index not ready'));
    const owned = points instanceof Float64Array ? new Float64Array(points) :
      new Float64Array(points || []);
    const id = this._nextId++;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this._pending.delete(id)) return;
        try {
          this.worker.postMessage({
            id: this._nextId++, kind: 'cancel', generation, priority: 0, payload: { id },
          });
        } catch (_) {}
        const error = new Error('world-index sample cancelled');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) {
        const error = new Error('world-index sample cancelled');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      const cleanup = () => signal?.removeEventListener?.('abort', abort);
      this._pending.set(id, {
        kind: 'sample', generation,
        resolve: (message) => { cleanup(); resolve(message.buffers.values); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener?.('abort', abort, { once: true });
      try {
        this.worker.postMessage({
          id, kind: 'sample', generation, priority: 0,
          payload: { index, method, points: owned },
        }, [owned.buffer]);
      } catch (error) {
        cleanup(); this._pending.delete(id); reject(error);
      }
    });
  }

  remove(ids) {
    if (!this.ready || this.failed) return false;
    const list = Array.isArray(ids) ? ids : [ids];
    this._stats.removed += list.length;
    this._request('remove', { ids: list }).catch(() => {});
    return true;
  }

  refreshMemory() {
    if (!this.ready || this.failed) return Promise.resolve(null);
    return this._request('memory').then((reply) => reply.meta, () => null);
  }

  snapshot() {
    return Object.freeze({
      supported: true,
      ready: this.ready,
      failed: this.failed,
      generation: this.generation,
      pending: this._pending.size,
      memory: this._memory,
      ...this._stats,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    this.worker.terminate();
    for (const pending of this._pending.values()) pending.reject(new Error('world-index closed'));
    this._pending.clear();
  }
}
