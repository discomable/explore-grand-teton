/*
 * Worker-owned immutable world-query indexes.
 *
 * The main thread decodes browser images, extracts only the channels required
 * for queries, then transfers ownership of those typed arrays to a worker.
 * SharedArrayBuffer is deliberately not required.
 */
export const WORLD_INDEX_VERSION = 1;
export const SPATIAL_INDEX_VERSION = 1;
export const WATER_SURFACE_INDEX_VERSION = 1;

const TYPES = Object.freeze({
  u8: Uint8Array,
  u16: Uint16Array,
  f32: Float32Array,
  f64: Float64Array,
});

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function rasterMeta(input) {
  const width = input?.width, height = input?.height;
  if (!Number.isInteger(width) || width <= 0 ||
      !Number.isInteger(height) || height <= 0) {
    throw new TypeError('raster width and height must be positive integers');
  }
  return Object.freeze({
    width,
    height,
    originE: finiteNumber(input.originE, 'originE'),
    originN: finiteNumber(input.originN, 'originN'),
    res: finiteNumber(input.res, 'res'),
    centerEasting: finiteNumber(input.centerEasting, 'centerEasting'),
    centerNorthing: finiteNumber(input.centerNorthing, 'centerNorthing'),
  });
}

export function createRasterDescriptor({
  id, kind = 'scalar', data, width, height, originE, originN, res,
  centerEasting, centerNorthing, scale = 1, offset = 0, noData = null,
}) {
  if (!id || typeof id !== 'string') throw new TypeError('raster id is required');
  if (!ArrayBuffer.isView(data) || data instanceof DataView) {
    throw new TypeError('raster data must be a typed array');
  }
  const meta = rasterMeta({
    width, height, originE, originN, res, centerEasting, centerNorthing,
  });
  if (data.length !== width * height) throw new TypeError('raster data size mismatch');
  return Object.freeze({
    version: WORLD_INDEX_VERSION, type: 'raster', id, kind, data, ...meta,
    scale: finiteNumber(scale, 'scale'),
    offset: finiteNumber(offset, 'offset'),
    noData,
  });
}

export function extractChannel(rgba, channel, Type = Uint8Array) {
  if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array) ||
      rgba.length % 4 !== 0) throw new TypeError('rgba must contain four-byte pixels');
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) {
    throw new RangeError('channel must be 0..3');
  }
  const result = new Type(rgba.length / 4);
  for (let i = 0, p = channel; i < result.length; i++, p += 4) result[i] = rgba[p];
  return result;
}

export function createHeightTileDescriptor({
  id, generation = 0, z, x, y, data, size, minX, minZ, width, height,
}) {
  if (!id || typeof id !== 'string') throw new TypeError('tile id is required');
  if (!(data instanceof Float32Array || data instanceof Float64Array)) {
    throw new TypeError('height tile data must be Float32Array or Float64Array');
  }
  if (!Number.isInteger(size) || size < 2 || data.length !== size * size) {
    throw new TypeError('height tile size mismatch');
  }
  return Object.freeze({
    version: WORLD_INDEX_VERSION, type: 'heightTile', id,
    generation: generation >>> 0, z: z | 0, x: x | 0, y: y | 0, data, size,
    minX: finiteNumber(minX, 'minX'), minZ: finiteNumber(minZ, 'minZ'),
    width: finiteNumber(width, 'width'), height: finiteNumber(height, 'height'),
  });
}

function worldPixel(meta, x, z) {
  return [
    (x + meta.centerEasting - meta.originE) / meta.res,
    (meta.originN - (meta.centerNorthing - z)) / meta.res,
  ];
}

function decodedValue(index, raw) {
  return index.noData !== null && raw === index.noData
    ? null : raw * index.scale + index.offset;
}

export class WorldIndex {
  constructor({ generation = 0 } = {}) {
    this.generation = generation >>> 0;
    this.rasters = new Map();
    this.heightTiles = new Map();
    this.spatial = new Map();
    this.waterSurface = null;
    this.bytes = 0;
  }

  installSpatial(descriptor) {
    if (descriptor?.version !== SPATIAL_INDEX_VERSION ||
        !['roads', 'buildings'].includes(descriptor.type)) {
      throw new TypeError('unsupported spatial index descriptor');
    }
    const previous = this.spatial.get(descriptor.type);
    if (previous) this.bytes -= spatialBytes(previous);
    this.spatial.set(descriptor.type, descriptor);
    this.bytes += spatialBytes(descriptor);
  }

  installWaterSurface(descriptor) {
    if (descriptor?.version !== WATER_SURFACE_INDEX_VERSION ||
        !(descriptor.surface instanceof Uint16Array) ||
        !(descriptor.bias instanceof Int8Array) ||
        descriptor.surface.length !== descriptor.width * descriptor.height ||
        descriptor.bias.length !== descriptor.surface.length) {
      throw new TypeError('invalid water surface descriptor');
    }
    if (this.waterSurface) this.bytes -= waterBytes(this.waterSurface);
    this.waterSurface = descriptor;
    this.bytes += waterBytes(descriptor);
  }

  install(descriptor) {
    if (descriptor?.version !== WORLD_INDEX_VERSION) {
      throw new TypeError('unsupported world index descriptor');
    }
    const target = descriptor.type === 'raster' ? this.rasters :
      descriptor.type === 'heightTile' ? this.heightTiles : null;
    if (!target) throw new TypeError(`unsupported descriptor type: ${descriptor.type}`);
    const previous = target.get(descriptor.id);
    if (previous) this.bytes -= previous.data.byteLength;
    target.set(descriptor.id, descriptor);
    this.bytes += descriptor.data.byteLength;
    return descriptor.id;
  }

  remove(id) {
    const value = this.rasters.get(id) || this.heightTiles.get(id);
    if (!value) return false;
    this.rasters.delete(id); this.heightTiles.delete(id);
    this.bytes -= value.data.byteLength;
    return true;
  }

  clear({ generation = this.generation + 1 } = {}) {
    this.rasters.clear(); this.heightTiles.clear(); this.bytes = 0;
    this.spatial.clear();
    this.waterSurface = null;
    this.generation = generation >>> 0;
  }

  sampleNearest(id, x, z, outside = null) {
    const index = this.rasters.get(id);
    if (!index) return outside;
    const [u, v] = worldPixel(index, x, z);
    const px = Math.trunc(u), py = Math.trunc(v);
    if (px < 0 || py < 0 || px >= index.width || py >= index.height) return outside;
    return decodedValue(index, index.data[py * index.width + px]);
  }

  // Matches ForestMask: pixel-centre registration, a one-pixel fringe and
  // clamped edge texels. Outside the fringe returns the caller's fallback.
  sampleBilinear(id, x, z, outside = null) {
    const index = this.rasters.get(id);
    if (!index) return outside;
    let [u, v] = worldPixel(index, x, z);
    u -= 0.5; v -= 0.5;
    if (u < -1 || v < -1 || u > index.width || v > index.height) return outside;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const at = (px, py) => {
      px = Math.max(0, Math.min(index.width - 1, px));
      py = Math.max(0, Math.min(index.height - 1, py));
      return decodedValue(index, index.data[py * index.width + px]);
    };
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    if (a === null || b === null || c === null || d === null) return outside;
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  }

  sampleHeight(x, z, outside = null) {
    let best = null;
    for (const tile of this.heightTiles.values()) {
      if (tile.generation !== this.generation) continue;
      if (x >= tile.minX && x < tile.minX + tile.width &&
          z >= tile.minZ && z < tile.minZ + tile.height &&
          (!best || tile.z > best.z)) best = tile;
    }
    if (!best) return outside;
    const n = best.size;
    let u = ((x - best.minX) / best.width) * (n - 1);
    let v = ((z - best.minZ) / best.height) * (n - 1);
    u = Math.max(0, Math.min(n - 1.001, u));
    v = Math.max(0, Math.min(n - 1.001, v));
    const i = Math.trunc(u), j = Math.trunc(v), fu = u - i, fv = v - j;
    const a = best.data[j * n + i], b = best.data[j * n + i + 1];
    const c = best.data[(j + 1) * n + i], d = best.data[(j + 1) * n + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  }

  memory() {
    return Object.freeze({
      bytes: this.bytes,
      rasterBytes: [...this.rasters.values()].reduce((n, v) => n + v.data.byteLength, 0),
      heightTileBytes: [...this.heightTiles.values()].reduce((n, v) => n + v.data.byteLength, 0),
      spatialBytes: [...this.spatial.values()].reduce((n, v) => n + spatialBytes(v), 0),
      waterSurfaceBytes: this.waterSurface ? waterBytes(this.waterSurface) : 0,
      rasters: this.rasters.size,
      heightTiles: this.heightTiles.size,
      spatialIndexes: this.spatial.size,
      spatialTypes: [...this.spatial.keys()],
      waterSurface: !!this.waterSurface,
      generation: this.generation,
    });
  }

  queryRoad(x, z) {
    const r = this.spatial.get('roads');
    if (!r) return { distance: Infinity, clearance: Infinity, classCode: 0 };
    const cx = Math.floor(x / r.cell), cz = Math.floor(z / r.cell);
    let best = Infinity, code = 0, halfWidth = 0;
    const seen = new Set();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const bucket = packedBucket(r, cx + dx, cz + dz);
      for (let p = bucket[0]; p < bucket[1]; p++) {
        const si = r.bucketItems[p];
        if (seen.has(si)) continue;
        seen.add(si);
        const q = si * 4;
        const distance = segmentDistance(x, z, r.segments[q], r.segments[q + 1],
          r.segments[q + 2], r.segments[q + 3]);
        if (distance < best) {
          best = distance; code = r.classCodes[si]; halfWidth = r.halfWidths[si];
        }
      }
    }
    return { distance: best, clearance: best - halfWidth, classCode: code };
  }

  queryBuilding(x, z, y = Number.NaN, pad = 0) {
    const b = this.spatial.get('buildings');
    if (!b) return { blocked: false, proximity: Infinity };
    const reach = Math.max(0, Math.ceil(pad / b.cell));
    const cx = Math.floor(x / b.cell), cz = Math.floor(z / b.cell);
    let proximity = Infinity;
    const seen = new Set();
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const bucket = packedBucket(b, cx + dx, cz + dz);
      for (let p = bucket[0]; p < bucket[1]; p++) {
        const bi = b.bucketItems[p];
        if (seen.has(bi)) continue;
        seen.add(bi);
        const bb = bi * 4;
        if (Number.isFinite(y) && y > b.topY[bi]) continue;
        if (x < b.bboxes[bb] - pad || x > b.bboxes[bb + 1] + pad ||
            z < b.bboxes[bb + 2] - pad || z > b.bboxes[bb + 3] + pad) continue;
        const start = b.ringOffsets[bi], end = b.ringOffsets[bi + 1];
        let inside = false, distance = Infinity;
        for (let i = start, j = end - 1; i < end; j = i++) {
          const ix = b.rings[i * 2], iz = b.rings[i * 2 + 1];
          const jx = b.rings[j * 2], jz = b.rings[j * 2 + 1];
          if (((iz > z) !== (jz > z)) &&
              x < (jx - ix) * (z - iz) / (jz - iz) + ix) inside = !inside;
          distance = Math.min(distance, segmentDistance(x, z, ix, iz, jx, jz));
        }
        const signed = inside ? -distance : distance;
        proximity = Math.min(proximity, signed);
        if (inside || distance <= pad) return { blocked: true, proximity: signed };
      }
    }
    return { blocked: false, proximity };
  }

  queryWaterSurface(x, z) {
    const m = this.waterSurface;
    if (!m) return { installed: false, valid: false, surface: Number.NaN, bias: Number.NaN };
    const u = (x + m.centerEasting - m.originE) / m.res - 0.5;
    const v = (m.originN - (m.centerNorthing - z)) / m.res - 0.5;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    let ws = 0, ss = 0, bs = 0;
    for (let dj = 0; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= m.height) continue;
      for (let di = 0; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= m.width) continue;
        const q = m.surface[jj * m.width + ii];
        if (!q) continue;
        const weight = (di ? fu : 1 - fu) * (dj ? fv : 1 - fv);
        ws += weight; ss += weight * q; bs += weight * m.bias[jj * m.width + ii];
      }
    }
    if (ws < 1e-6) {
      return { installed: true, valid: false, surface: Number.NaN, bias: Number.NaN };
    }
    return {
      installed: true, valid: true,
      surface: (ss / ws - 1) * 0.1 + (m.elevMin - m.datum),
      bias: (bs / ws) * 0.01,
    };
  }

  sampleCanopyShell(points) {
    if (!(points instanceof Float64Array) || points.length % 2) {
      throw new TypeError('canopy points must be Float64Array x,z pairs');
    }
    const count = points.length / 2;
    const terrainHeight = new Float64Array(count);
    const vegetation = new Float64Array(count * 2);
    const forestProbability = new Float64Array(count);
    const valid = new Uint8Array(count);
    terrainHeight.fill(Number.NaN);
    vegetation.fill(Number.NaN);
    forestProbability.fill(Number.NaN);
    const installed = {
      terrain: this.heightTiles.size > 0,
      vegetation: this.rasters.has('vegetation-height') &&
        this.rasters.has('vegetation-cover'),
      forest: this.rasters.has('forest-probability'),
    };
    const coverage = { terrain: 0, vegetation: 0, forest: 0 };
    for (let i = 0; i < count; i++) {
      const x = points[i * 2], z = points[i * 2 + 1];
      const height = this.sampleHeight(x, z, null);
      if (height !== null) {
        terrainHeight[i] = height; valid[i] |= 1; coverage.terrain++;
      }
      const vh = this.sampleNearest('vegetation-height', x, z, null);
      const vc = this.sampleNearest('vegetation-cover', x, z, null);
      if (vh !== null && vc !== null) {
        vegetation[i * 2] = vh; vegetation[i * 2 + 1] = vc;
        valid[i] |= 2; coverage.vegetation++;
      }
      const probability = this.sampleBilinear('forest-probability', x, z, null);
      if (probability !== null) {
        forestProbability[i] = probability; valid[i] |= 4; coverage.forest++;
      }
    }
    return {
      count, terrainHeight, vegetation, forestProbability, valid, installed, coverage,
    };
  }
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function spatialBytes(value) {
  return Object.values(value).reduce((sum, item) =>
    sum + (ArrayBuffer.isView(item) ? item.byteLength : 0), 0);
}
function waterBytes(value) {
  return value.surface.byteLength + value.bias.byteLength;
}

function packedBucket(index, cx, cz) {
  let lo = 0, hi = index.bucketKeys.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, p = mid * 2;
    const cmp = index.bucketKeys[p] - cx || index.bucketKeys[p + 1] - cz;
    if (cmp < 0) lo = mid + 1;
    else if (cmp > 0) hi = mid - 1;
    else return [index.bucketOffsets[mid], index.bucketOffsets[mid + 1]];
  }
  return [0, 0];
}

export function packBuckets(buckets) {
  const entries = [...buckets.entries()].map(([key, items]) => {
    const [x, z] = typeof key === 'string' ? key.split(',').map(Number) : key;
    return { x, z, items };
  }).sort((a, b) => a.x - b.x || a.z - b.z);
  const bucketKeys = new Int32Array(entries.length * 2);
  const bucketOffsets = new Uint32Array(entries.length + 1);
  const bucketItems = new Uint32Array(entries.reduce((n, e) => n + e.items.length, 0));
  let cursor = 0;
  entries.forEach((e, i) => {
    bucketKeys[i * 2] = e.x; bucketKeys[i * 2 + 1] = e.z;
    bucketOffsets[i] = cursor; bucketItems.set(e.items, cursor); cursor += e.items.length;
  });
  bucketOffsets[entries.length] = cursor;
  return { bucketKeys, bucketOffsets, bucketItems };
}

export function spatialTransferList(descriptor) {
  return [...new Set(Object.values(descriptor)
    .filter(ArrayBuffer.isView).map((value) => value.buffer))];
}

export function waterSurfaceTransferList(descriptor) {
  return [descriptor.surface.buffer, descriptor.bias.buffer];
}

export function worldIndexTransferList(descriptors) {
  const list = Array.isArray(descriptors) ? descriptors : [descriptors];
  return [...new Set(list.map((item) => item?.data?.buffer).filter(Boolean))];
}

export function supportsWorldIndexWorkers(scope = globalThis) {
  return typeof scope.Worker === 'function' &&
    typeof scope.ArrayBuffer === 'function' &&
    typeof scope.Uint8Array === 'function';
}
