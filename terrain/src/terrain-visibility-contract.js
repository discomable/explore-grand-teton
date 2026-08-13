const MAGIC = 0x31455447; // "GTE1" little-endian
export const TERRAIN_ERROR_VERSION = 1;
export const TERRAIN_ERROR_QUANTIZATION_METERS = 0.1;

function assert(condition, message) {
  if (!condition) throw new Error(`terrain error metadata: ${message}`);
}

/** Parse the compact row-major geometric-error pyramid emitted by bake_terrain_error.py. */
export function parseTerrainErrorPyramid(buffer) {
  const view = new DataView(buffer);
  assert(view.byteLength >= 16, 'truncated header');
  assert(view.getUint32(0, true) === MAGIC, 'bad magic');
  const version = view.getUint16(4, true);
  assert(version === TERRAIN_ERROR_VERSION, `unsupported version ${version}`);
  const levelCount = view.getUint16(6, true);
  const gridCount = view.getUint16(8, true);
  const quantization = view.getFloat32(12, true);
  assert(levelCount > 0 && levelCount <= 32, 'invalid level count');
  assert(gridCount > 0 && gridCount <= 32, 'invalid grid count');
  assert(Number.isFinite(quantization) && quantization > 0, 'invalid quantization');
  let cursor = 16;
  assert(view.byteLength >= cursor + gridCount * 2 + levelCount * 8, 'truncated directory');
  const grids = [];
  for (let i = 0; i < gridCount; i++, cursor += 2) grids.push(view.getUint16(cursor, true));
  const levels = [];
  let values = 0;
  for (let z = 0; z < levelCount; z++) {
    const nx = view.getUint16(cursor, true), ny = view.getUint16(cursor + 2, true);
    const offset = view.getUint32(cursor + 4, true);
    cursor += 8;
    assert(nx > 0 && ny > 0, `invalid z${z} dimensions`);
    assert(offset === values, `non-contiguous z${z} offset`);
    levels.push({ nx, ny, offset });
    values += nx * ny * gridCount;
  }
  assert(cursor + values * 2 === view.byteLength, 'payload length mismatch');
  const payload = new Uint16Array(buffer, cursor, values);
  const gridIndex = new Map(grids.map((grid, index) => [grid, index]));
  return {
    version, quantization, grids, levels,
    errorMeters(z, x, y, grid) {
      const level = levels[z], gi = gridIndex.get(grid);
      if (!level || gi == null || x < 0 || y < 0 || x >= level.nx || y >= level.ny) return null;
      const raw = payload[level.offset + (y * level.nx + x) * gridCount + gi];
      return raw === 0xffff ? null : raw * quantization;
    },
  };
}

export function projectedTerrainError(errorMeters, projectionScale, nearestDistance) {
  if (!Number.isFinite(errorMeters) || errorMeters < 0) return Infinity;
  return errorMeters * projectionScale / Math.max(1, nearestDistance);
}

export function terrainShouldSubdivide({
  errorMeters, projectionScale, nearestDistance, pixelThreshold, legacySse, forceLegacy,
}) {
  if (forceLegacy || errorMeters == null)
    return { subdivide: legacySse > pixelThreshold, mode: 'legacy', projectedError: legacySse };
  const projectedError = projectedTerrainError(errorMeters, projectionScale, nearestDistance);
  return { subdivide: projectedError > pixelThreshold, mode: 'geometric', projectedError };
}

export function predictionHorizon(mode) {
  return mode === 'fly' ? 1.2 : mode === 'drive' ? 0.8 : 0.5;
}

/** Camera-relative pose samples. Arrays keep this helper independent of THREE. */
export function predictTerrainPoses(state, sampleCount = 3) {
  const horizon = predictionHorizon(state.mode);
  const sweepLimit = Math.PI / 2;
  const yawRate = Number.isFinite(state.yawRate) ? state.yawRate : 0;
  const pitchRate = Number.isFinite(state.pitchRate) ? state.pitchRate : 0;
  const velocity = state.velocity || [0, 0, 0];
  const poses = [];
  for (let i = 1; i <= sampleCount; i++) {
    const t = horizon * i / sampleCount;
    const yawDelta = Math.max(-sweepLimit, Math.min(sweepLimit, yawRate * t));
    const pitchDelta = Math.max(-sweepLimit, Math.min(sweepLimit, pitchRate * t));
    poses.push({
      t,
      position: [state.position[0] + velocity[0] * t,
        state.position[1] + velocity[1] * t, state.position[2] + velocity[2] * t],
      yaw: state.yaw + yawDelta,
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.pitch + pitchDelta)),
    });
  }
  return poses;
}

/** Earliest/most central warm sources win; duplicate source keys collapse deterministically. */
export function selectTerrainWarmSources(candidates, capacity) {
  const best = new Map();
  for (const candidate of candidates) {
    if (!candidate?.key) continue;
    const old = best.get(candidate.key);
    if (!old || candidate.time < old.time ||
        (candidate.time === old.time && candidate.centrality < old.centrality) ||
        (candidate.time === old.time && candidate.centrality === old.centrality &&
          candidate.distance < old.distance)) best.set(candidate.key, candidate);
  }
  return [...best.values()].sort((a, b) => a.time - b.time ||
    a.centrality - b.centrality || a.distance - b.distance || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, capacity | 0));
}

/** Test/pipeline helper; runtime only needs the parser. */
export function encodeTerrainErrorPyramid({ grids, levels, quantization = 0.1 }) {
  const gridCount = grids.length, levelCount = levels.length;
  let count = 0;
  for (const level of levels) count += level.nx * level.ny * gridCount;
  const headerBytes = 16 + gridCount * 2 + levelCount * 8;
  const buffer = new ArrayBuffer(headerBytes + count * 2);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true); view.setUint16(4, TERRAIN_ERROR_VERSION, true);
  view.setUint16(6, levelCount, true); view.setUint16(8, gridCount, true);
  view.setFloat32(12, quantization, true);
  let cursor = 16;
  for (const grid of grids) { view.setUint16(cursor, grid, true); cursor += 2; }
  let offset = 0;
  for (const level of levels) {
    view.setUint16(cursor, level.nx, true); view.setUint16(cursor + 2, level.ny, true);
    view.setUint32(cursor + 4, offset, true); cursor += 8;
    offset += level.nx * level.ny * gridCount;
  }
  const payload = new Uint16Array(buffer, cursor);
  let p = 0;
  for (const level of levels) for (const value of level.values) {
    payload[p++] = value == null ? 0xffff : Math.min(0xfffe, Math.ceil(value / quantization));
  }
  assert(p === count, 'encoder value count mismatch');
  return buffer;
}
