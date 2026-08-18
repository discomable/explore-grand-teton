export const VEGETATION_SPECIES = Object.freeze([
  'conifer', 'spire', 'aspen', 'cottonwood', 'snag', 'sage', 'bb',
]);

const SPECIES_SALT = Object.freeze(Object.fromEntries(
  VEGETATION_SPECIES.map((species, index) => [species, (index + 1) * 0x9e3779b1]),
));

function mix32(value) {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function nextVegetationCapacity(required, current = 0) {
  if (!Number.isInteger(required) || required < 0 || !Number.isInteger(current) || current < 0) {
    throw new RangeError('vegetation capacities must be non-negative integers');
  }
  if (required <= current) return current;
  let capacity = Math.max(1, current);
  while (capacity < required) capacity *= 2;
  return capacity;
}

export function keepVegetationInstance(cellX, cellZ, species, ordinal, band) {
  if (band !== 2 || species !== 'bb') return true;
  const salt = SPECIES_SALT[species] || 0;
  const hash = mix32(Math.imul(cellX | 0, 73856093) ^ Math.imul(cellZ | 0, 19349663) ^
    Math.imul(ordinal | 0, 83492791) ^ salt);
  return (hash & 1) === 0;
}

export function compactVegetationRecord({
  cellX, cellZ, band, species, count, matrices, colors, uvs = null,
}) {
  if (!Number.isInteger(count) || count < 0 || matrices.length < count * 16 ||
      colors.length < count * 3 || (uvs && uvs.length < count)) {
    throw new RangeError('invalid vegetation instance record');
  }
  let kept = 0;
  for (let i = 0; i < count; i++) {
    if (keepVegetationInstance(cellX, cellZ, species, i, band)) kept++;
  }
  const outMatrices = new Float32Array(kept * 16);
  const outColors = new Float32Array(kept * 3);
  const outUvs = uvs ? new Float32Array(kept) : null;
  for (let i = 0, at = 0; i < count; i++) {
    if (!keepVegetationInstance(cellX, cellZ, species, i, band)) continue;
    outMatrices.set(matrices.subarray(i * 16, i * 16 + 16), at * 16);
    outColors.set(colors.subarray(i * 3, i * 3 + 3), at * 3);
    if (outUvs) outUvs[at] = uvs[i];
    at++;
  }
  return Object.freeze({
    species, count: kept, matrices: outMatrices, colors: outColors, uvs: outUvs,
    omitted: count - kept,
  });
}

export function applyVegetationFade(source, destination, growth) {
  if (source.length !== destination.length || source.length % 16 !== 0) {
    throw new RangeError('vegetation fade matrices must have matching 16-float records');
  }
  for (let offset = 0; offset < source.length; offset += 16) {
    for (let component = 0; component < 12; component++) {
      destination[offset + component] = source[offset + component] * growth;
    }
    for (let component = 12; component < 16; component++) {
      destination[offset + component] = source[offset + component];
    }
  }
  return destination;
}

export function buildVegetationBatchFrame(cells, intersects) {
  const batches = new Map();
  const visible = [];
  let instances = 0;
  for (const cell of cells) {
    if (!intersects(cell.sphere, cell)) continue;
    visible.push(cell);
    for (const record of cell.records) {
      let batch = batches.get(record.species);
      if (!batch) batches.set(record.species, batch = { count: 0, records: [] });
      batch.records.push(record);
      batch.count += record.count;
      instances += record.count;
    }
  }
  return { batches, visibleCells: visible.length, visible, instances };
}
