/*
 * Immutable, candidate-indexed query data shared by vegetation workers.
 *
 * Sampling stays on the main thread, where the authoritative terrain, water and
 * exclusion services live. Workers receive only owned typed arrays and never
 * need to approximate those services with a grid.
 */
export const QUERY_SNAPSHOT_VERSION = 1;

export const QueryFlags = Object.freeze({
  HEIGHT_VALID: 1 << 0,
  LANDCOVER_VALID: 1 << 1,
  WATER: 1 << 2,
  EXCLUDED: 1 << 3,
  VEGETATION_VALID: 1 << 4,
  TINT_VALID: 1 << 5,
});

function abortError() {
  if (typeof DOMException !== 'undefined') return new DOMException('cancelled', 'AbortError');
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Build exact point samples for an interleaved [x,z,...] position array.
 *
 * The returned object contains only structured-clone-safe primitives and typed
 * arrays. Continuous samples use Float64 so moving the query across a worker
 * boundary does not introduce additional rounding.
 */
export function buildQuerySnapshot({
  positions,
  sampleHeight,
  sampleLandcover,
  sampleWater,
  sampleExclusion,
  sampleVegetation,
  sampleTint,
  generation = 0,
  cancelled,
}) {
  if (!positions || positions.length % 2 !== 0) {
    throw new TypeError('positions must contain interleaved x,z pairs');
  }
  if (typeof sampleHeight !== 'function' || typeof sampleLandcover !== 'function') {
    throw new TypeError('sampleHeight and sampleLandcover are required');
  }

  const count = positions.length / 2;
  const points = new Float64Array(positions);
  const heights = new Float64Array(count);
  heights.fill(Number.NaN);
  const landcover = new Int16Array(count);
  landcover.fill(-1);
  const flags = new Uint8Array(count);
  const vegetation = sampleVegetation ? new Float64Array(count * 2) : null;
  const tint = sampleTint ? new Float64Array(count * 3) : null;
  if (vegetation) vegetation.fill(Number.NaN);
  if (tint) tint.fill(Number.NaN);

  for (let i = 0; i < count; i++) {
    if ((i & 255) === 0 && cancelled?.()) throw abortError();
    const x = points[i * 2], z = points[i * 2 + 1];
    const height = sampleHeight(x, z);
    if (finite(height)) {
      heights[i] = height;
      flags[i] |= QueryFlags.HEIGHT_VALID;
    }

    const lc = sampleLandcover(x, z);
    if (Number.isInteger(lc) && lc >= -32768 && lc <= 32767) {
      landcover[i] = lc;
      flags[i] |= QueryFlags.LANDCOVER_VALID;
    }
    if (sampleWater?.(x, z, height)) flags[i] |= QueryFlags.WATER;
    if (sampleExclusion?.(x, z, height)) flags[i] |= QueryFlags.EXCLUDED;

    if (vegetation) {
      const value = sampleVegetation(x, z);
      const vegHeight = Array.isArray(value) || ArrayBuffer.isView(value)
        ? value[0] : value?.height;
      const vegCover = Array.isArray(value) || ArrayBuffer.isView(value)
        ? value[1] : value?.cover;
      if (finite(vegHeight) && finite(vegCover)) {
        vegetation[i * 2] = vegHeight;
        vegetation[i * 2 + 1] = vegCover;
        flags[i] |= QueryFlags.VEGETATION_VALID;
      }
    }

    if (tint) {
      const value = sampleTint(x, z);
      const r = value?.[0], g = value?.[1], b = value?.[2];
      if (finite(r) && finite(g) && finite(b)) {
        tint[i * 3] = r;
        tint[i * 3 + 1] = g;
        tint[i * 3 + 2] = b;
        flags[i] |= QueryFlags.TINT_VALID;
      }
    }
  }

  return Object.freeze({
    version: QUERY_SNAPSHOT_VERSION,
    generation: generation >>> 0,
    count,
    points,
    heights,
    landcover,
    flags,
    vegetation,
    tint,
  });
}

/**
 * Incremental façade for spreading authoritative sampling across animation
 * frames. `step()` samples at most maxPoints and `finish()` returns the exact
 * same snapshot layout as buildQuerySnapshot().
 */
export function createIncrementalQuerySnapshot(options) {
  const source = options?.positions;
  if (!source || source.length % 2 !== 0) {
    throw new TypeError('positions must contain interleaved x,z pairs');
  }
  if (typeof options.sampleHeight !== 'function' ||
      typeof options.sampleLandcover !== 'function') {
    throw new TypeError('sampleHeight and sampleLandcover are required');
  }

  // Own coordinates immediately: later mutation/detachment of the candidate
  // source cannot change the result across frame boundaries.
  const positions = new Float64Array(source);
  const count = positions.length / 2;
  const chunks = [];
  let cursor = 0;

  const builder = {
    get count() { return count; },
    get sampled() { return cursor; },
    get remaining() { return count - cursor; },
    get done() { return cursor === count; },

    step(maxPoints = 256) {
      if (!Number.isInteger(maxPoints) || maxPoints <= 0) {
        throw new RangeError('maxPoints must be a positive integer');
      }
      if (options.cancelled?.()) throw abortError();
      if (cursor === count) return 0;
      const end = Math.min(count, cursor + maxPoints);
      const chunkPositions = positions.subarray(cursor * 2, end * 2);
      chunks.push(buildQuerySnapshot({
        ...options,
        positions: chunkPositions,
        // Cancellation is checked by both the chunk boundary above and the
        // one-shot sampler while a larger chunk is running.
        generation: options.generation,
      }));
      const sampled = end - cursor;
      cursor = end;
      return sampled;
    },

    finish() {
      if (cursor !== count) {
        throw new Error(`query snapshot incomplete (${cursor}/${count})`);
      }
      const result = {
        version: QUERY_SNAPSHOT_VERSION,
        generation: (options.generation || 0) >>> 0,
        count,
        points: positions,
        heights: new Float64Array(count),
        landcover: new Int16Array(count),
        flags: new Uint8Array(count),
        vegetation: options.sampleVegetation ? new Float64Array(count * 2) : null,
        tint: options.sampleTint ? new Float64Array(count * 3) : null,
      };
      let offset = 0;
      for (const chunk of chunks) {
        result.heights.set(chunk.heights, offset);
        result.landcover.set(chunk.landcover, offset);
        result.flags.set(chunk.flags, offset);
        if (result.vegetation) result.vegetation.set(chunk.vegetation, offset * 2);
        if (result.tint) result.tint.set(chunk.tint, offset * 3);
        offset += chunk.count;
      }
      return Object.freeze(result);
    },
  };
  return Object.freeze(builder);
}

/** Return each owned ArrayBuffer exactly once, suitable for postMessage(). */
export function querySnapshotTransferList(snapshot) {
  validateQuerySnapshot(snapshot);
  const arrays = [
    snapshot.points,
    snapshot.heights,
    snapshot.landcover,
    snapshot.flags,
    snapshot.vegetation,
    snapshot.tint,
  ];
  return [...new Set(arrays.filter(Boolean).map((array) => array.buffer))];
}

export function validateQuerySnapshot(snapshot) {
  const count = snapshot?.count;
  if (snapshot?.version !== QUERY_SNAPSHOT_VERSION || !Number.isInteger(count) || count < 0) {
    throw new TypeError('unsupported query snapshot');
  }
  const valid =
    snapshot.points instanceof Float64Array && snapshot.points.length === count * 2 &&
    snapshot.heights instanceof Float64Array && snapshot.heights.length === count &&
    snapshot.landcover instanceof Int16Array && snapshot.landcover.length === count &&
    snapshot.flags instanceof Uint8Array && snapshot.flags.length === count &&
    (!snapshot.vegetation ||
      (snapshot.vegetation instanceof Float64Array && snapshot.vegetation.length === count * 2)) &&
    (!snapshot.tint ||
      (snapshot.tint instanceof Float64Array && snapshot.tint.length === count * 3));
  if (!valid) throw new TypeError('invalid query snapshot layout');
  return snapshot;
}
