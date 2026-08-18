/* Pure terrain-batching contracts shared by deterministic tests and the runtime batcher.
 *
 * This module deliberately has no Three.js or DOM dependency.  It captures the values that must
 * remain identical when TerrainStreamer changes from one Mesh per leaf to one InstancedMesh per
 * grid family: node placement, source windows, stitching, morph data and submitted index count.
 */

export const TERRAIN_INSTANCE_LAYOUT = Object.freeze({
  terrainTile: Object.freeze({ offset: 0, size: 4 }),      // minX, minZ, tile size, skirt
  uvMax: Object.freeze({ offset: 4, size: 2 }),
  height: Object.freeze({ offset: 6, size: 4 }),           // win.x, win.y, win.scale, layer
  imagery: Object.freeze({ offset: 10, size: 4 }),         // window, layer (-1 means absent)
  geom: Object.freeze({ offset: 14, size: 3 }),            // source texel m, morph base, gridN
  morphLattice: Object.freeze({ offset: 17, size: 4 }),
  edgeRatios: Object.freeze({ offset: 21, size: 4 }),      // west, east, north, south
  stride: 25,
});

const SAMPLE_UVS = Object.freeze([
  Object.freeze([0, 0]), Object.freeze([1, 0]), Object.freeze([0, 1]),
  Object.freeze([1, 1]), Object.freeze([0.5, 0.5]),
]);

export function terrainNodeKey(node) {
  return `${node.z}/${node.x}/${node.y}`;
}

export function terrainSourceWindow(node, source) {
  if (!node || !source || !Number.isInteger(node.z) || !Number.isInteger(source.z))
    throw new TypeError('node and source integer zooms are required');
  const dz = node.z - source.z;
  if (dz < 0) throw new RangeError('terrain source cannot be finer than its rendered node');
  const divisor = 2 ** dz;
  return [
    (node.x - (node.x >> dz) * divisor) / divisor,
    (node.y - (node.y >> dz) * divisor) / divisor,
    1 / divisor,
  ];
}

export function gridTriangleCount(gridN) {
  if (!Number.isInteger(gridN) || gridN < 1)
    throw new RangeError('gridN must be a positive integer');
  // makeGrid() adds one skirt vertex outside each edge: (gridN + 1)^2 quads, two tris each.
  return 2 * (gridN + 1) * (gridN + 1);
}

export const REFLECTION_TERRAIN_GRIDS = Object.freeze([8, 16, 32]);

/* Reflection pixels are rendered into a smaller, distorted target. Preserve the authored leaf
 * set and sources, but use a deterministic lower-density grid for each existing main family. */
export function reflectionTerrainGridN(mainGridN) {
  if (!Number.isFinite(mainGridN) || mainGridN < 1)
    throw new RangeError('mainGridN must be positive');
  if (mainGridN >= 96) return 32;
  if (mainGridN >= 32) return 16;
  return 8;
}

export function deriveReflectionTerrainInstance(instance, {
  gridNForZoom, edgeRatiosForNode,
} = {}) {
  if (!instance?.node || typeof gridNForZoom !== 'function' ||
      typeof edgeRatiosForNode !== 'function')
    throw new TypeError('instance, gridNForZoom, and edgeRatiosForNode are required');
  const node = instance.node;
  const gridN = gridNForZoom(node.z);
  const morphLattice = [0, 0, 0, 0];
  for (let k = 1; k <= 4 && node.z - k >= 0; k++)
    morphLattice[k - 1] = 2 ** k / gridNForZoom(node.z - k);
  return {
    ...instance,
    gridN,
    morphLattice,
    edgeRatios: Array.from(edgeRatiosForNode(node, gridN)),
  };
}

export function buildReflectionTerrainInstances(instances, options = {}) {
  const include = options.include || (() => true);
  const output = [];
  let culled = 0;
  for (const instance of instances || []) {
    if (!include(instance)) { culled++; continue; }
    output.push(deriveReflectionTerrainInstance(instance, options));
  }
  return Object.freeze({ instances: Object.freeze(output), culled });
}

export function edgeStitchRatio({
  node, dx, dy, fineGridN, tileCountsAtZoom, getNode, gridNForZoom,
}) {
  if (Math.abs(dx) + Math.abs(dy) !== 1) throw new RangeError('edge must be cardinal');
  const z = node.z;
  const [countX, countY] = tileCountsAtZoom(z);
  const nx = node.x + dx, ny = node.y + dy;
  if (nx < 0 || ny < 0 || nx >= countX || ny >= countY) return 0;
  if (getNode(z, nx, ny)) return 0;
  if (z === 0) return 0;
  const coarse = getNode(z - 1, nx >> 1, ny >> 1);
  if (!coarse || coarse.internal) return 0;
  return 2 * fineGridN / gridNForZoom(z - 1);
}

export function terrainEdgeRatios(node, fineGridN, context) {
  const args = { node, fineGridN, ...context };
  return [
    edgeStitchRatio({ ...args, dx: -1, dy: 0 }),
    edgeStitchRatio({ ...args, dx: 1, dy: 0 }),
    edgeStitchRatio({ ...args, dx: 0, dy: -1 }),
    edgeStitchRatio({ ...args, dx: 0, dy: 1 }),
  ];
}

function vec(value, size, label) {
  if (!value || value.length !== size || Array.from(value).some(v => !Number.isFinite(v)))
    throw new TypeError(`${label} must contain ${size} finite numbers`);
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export function packTerrainInstance(instance, target = null, targetOffset = 0) {
  const layout = TERRAIN_INSTANCE_LAYOUT;
  const out = target || new Float32Array(layout.stride);
  if (targetOffset < 0 || targetOffset + layout.stride > out.length)
    throw new RangeError('terrain instance does not fit target buffer');
  const bounds = instance.node?.bounds;
  if (!bounds) throw new TypeError('instance.node.bounds is required');
  const uvMax = vec(instance.uvMax, 2, 'uvMax');
  const heightWindow = vec(instance.height?.window, 3, 'height.window');
  const imageryWindow = instance.imagery ? vec(instance.imagery.window, 3, 'imagery.window') : [0, 0, 1];
  const morphLattice = vec(instance.morphLattice, 4, 'morphLattice');
  const edgeRatios = vec(instance.edgeRatios, 4, 'edgeRatios');
  const values = [
    finite(bounds.minX, 'bounds.minX'), finite(bounds.minZ, 'bounds.minZ'),
    finite(bounds.size, 'bounds.size'), finite(instance.skirt, 'skirt'), uvMax[0], uvMax[1],
    ...heightWindow, finite(instance.height.layer, 'height.layer'), ...imageryWindow,
    instance.imagery ? finite(instance.imagery.layer, 'imagery.layer') : -1,
    finite(instance.sourceTexelMeters, 'sourceTexelMeters'), finite(instance.morphBase, 'morphBase'),
    finite(instance.gridN, 'gridN'), ...morphLattice, ...edgeRatios,
  ];
  out.set(values, targetOffset);
  return out;
}

export function nextPowerOfTwoCapacity(current, required) {
  if (!Number.isInteger(current) || current < 0 || !Number.isInteger(required) || required < 0)
    throw new RangeError('capacities must be non-negative integers');
  if (required <= current) return current;
  let capacity = Math.max(1, current);
  while (capacity < required) capacity *= 2;
  return capacity;
}

function descriptor(instance) {
  const { node, height, imagery } = instance;
  return Object.freeze({
    key: instance.key || terrainNodeKey(node),
    gridN: instance.gridN,
    originSize: Object.freeze([node.bounds.minX, node.bounds.minZ, node.bounds.size]),
    uvMax: Object.freeze(Array.from(instance.uvMax)),
    heightSource: height.key ?? `${height.z}/${height.x}/${height.y}`,
    heightWindow: Object.freeze(Array.from(height.window)),
    imagerySource: imagery ? (imagery.key ?? `${imagery.z}/${imagery.x}/${imagery.y}`) : null,
    imageryWindow: imagery ? Object.freeze(Array.from(imagery.window)) : null,
    edgeRatios: Object.freeze(Array.from(instance.edgeRatios)),
    morphLattice: Object.freeze(Array.from(instance.morphLattice)),
    triangles: gridTriangleCount(instance.gridN),
  });
}

export function buildTerrainFrame(instances, { frameId = 0, capacities = new Map() } = {}) {
  const grouped = new Map();
  for (const instance of instances || []) {
    const gridN = instance.gridN;
    let list = grouped.get(gridN);
    if (!list) grouped.set(gridN, list = []);
    list.push(instance);
  }
  const batches = new Map();
  const descriptors = [];
  let triangles = 0;
  for (const [gridN, list] of grouped) {
    const prior = capacities.get?.(gridN) || 0;
    const capacity = nextPowerOfTwoCapacity(prior, list.length);
    const packed = new Float32Array(capacity * TERRAIN_INSTANCE_LAYOUT.stride);
    const batchDescriptors = [];
    for (let i = 0; i < list.length; i++) {
      packTerrainInstance(list[i], packed, i * TERRAIN_INSTANCE_LAYOUT.stride);
      const item = descriptor(list[i]);
      batchDescriptors.push(item); descriptors.push(item); triangles += item.triangles;
    }
    batches.set(gridN, Object.freeze({
      gridN, count: list.length, capacity, packed,
      descriptors: Object.freeze(batchDescriptors),
      triangles: gridTriangleCount(gridN) * list.length,
    }));
  }
  return Object.freeze({
    frameId, batches, descriptors: Object.freeze(descriptors),
    drawCalls: batches.size, triangles,
  });
}

export class AtomicTerrainFramePublisher {
  constructor(initialFrame = buildTerrainFrame([], { frameId: -1 })) {
    this._active = initialFrame;
    this._staging = null;
  }

  get active() { return this._active; }
  get staging() { return this._staging; }

  stage(instances, frameId) {
    const capacities = new Map();
    for (const [gridN, batch] of this._active.batches) capacities.set(gridN, batch.capacity);
    this._staging = buildTerrainFrame(instances, { frameId, capacities });
    return this._staging;
  }

  publish(frameId = this._staging?.frameId) {
    if (!this._staging) throw new Error('no staged terrain frame');
    if (frameId !== this._staging.frameId) throw new Error('staged terrain frame id mismatch');
    const previous = this._active;
    this._active = this._staging;
    this._staging = null;
    return previous;
  }
}

export function sampledTerrainWorldPositions(item, sampleUvs = SAMPLE_UVS) {
  const origin = item.originSize || [
    item.node.bounds.minX, item.node.bounds.minZ, item.node.bounds.size,
  ];
  return sampleUvs.map(([u, v]) => [origin[0] + u * origin[2], origin[1] + v * origin[2]]);
}

function canonical(item) {
  return item.originSize ? item : descriptor(item);
}

export function compareTerrainSubmissions(legacyInstances, batchedFrame) {
  const legacy = new Map((legacyInstances || []).map(item => {
    const d = canonical(item); return [d.key, d];
  }));
  const batched = new Map((batchedFrame?.descriptors || []).map(item => [item.key, item]));
  const missing = [], unexpected = [], mismatched = [];
  for (const [key, expected] of legacy) {
    const actual = batched.get(key);
    if (!actual) { missing.push(key); continue; }
    const fields = ['gridN', 'originSize', 'uvMax', 'heightSource', 'heightWindow',
      'imagerySource', 'imageryWindow', 'edgeRatios', 'morphLattice', 'triangles'];
    const changed = fields.filter(field => JSON.stringify(expected[field]) !== JSON.stringify(actual[field]));
    if (changed.length || JSON.stringify(sampledTerrainWorldPositions(expected)) !==
        JSON.stringify(sampledTerrainWorldPositions(actual))) mismatched.push({ key, fields: changed });
  }
  for (const key of batched.keys()) if (!legacy.has(key)) unexpected.push(key);
  const legacyTriangles = [...legacy.values()].reduce((sum, item) => sum + item.triangles, 0);
  return Object.freeze({
    equivalent: !missing.length && !unexpected.length && !mismatched.length &&
      legacyTriangles === batchedFrame.triangles,
    missing, unexpected, mismatched,
    legacyTriangles, batchedTriangles: batchedFrame?.triangles || 0,
  });
}
