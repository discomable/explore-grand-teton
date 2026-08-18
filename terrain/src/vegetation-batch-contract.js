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

function cellIdentity(cell) {
  const hasCoordinates = Number.isInteger(cell?.cellX) && Number.isInteger(cell?.cellZ);
  const key = cell?.key ?? (hasCoordinates ? `${cell.cellX},${cell.cellZ}` : null);
  if (key == null || key === '') throw new RangeError('vegetation cells require a stable key');
  return String(key);
}

function speciesState(state, species) {
  let batch = state.species.get(species);
  if (!batch) {
    batch = { slots: [], cellSlots: new Map() };
    state.species.set(species, batch);
  }
  return batch;
}

function dirtySpecies(changes, species) {
  let dirty = changes.get(species);
  if (!dirty) changes.set(species, dirty = new Set());
  return dirty;
}

function removeCell(state, key, changes) {
  const cell = state.cells.get(key);
  if (!cell) return 0;
  let compactions = 0;
  for (const record of cell.records) {
    const batch = state.species.get(record.species);
    const owned = batch?.cellSlots.get(key);
    if (!batch || !owned) continue;
    while (owned.size) {
      const slot = owned.values().next().value;
      const lastIndex = batch.slots.length - 1;
      const last = batch.slots[lastIndex];
      owned.delete(slot);
      if (slot !== lastIndex) {
        batch.slots[slot] = last;
        const lastOwned = batch.cellSlots.get(last.cellKey);
        lastOwned.delete(lastIndex);
        lastOwned.add(slot);
        dirtySpecies(changes, record.species).add(slot);
        compactions++;
      }
      batch.slots.pop();
    }
    batch.cellSlots.delete(key);
  }
  state.cells.delete(key);
  return compactions;
}

function addCell(state, cell, changes) {
  const key = cellIdentity(cell);
  state.cells.set(key, cell);
  for (const record of cell.records) {
    const batch = speciesState(state, record.species);
    const owned = new Set();
    batch.cellSlots.set(key, owned);
    const dirty = dirtySpecies(changes, record.species);
    for (let ordinal = 0; ordinal < record.count; ordinal++) {
      const slot = batch.slots.length;
      batch.slots.push({ cellKey: key, record, ordinal });
      owned.add(slot);
      dirty.add(slot);
    }
  }
}

function coalesceSlots(slots) {
  const sorted = [...slots].sort((a, b) => a - b);
  const ranges = [];
  for (const slot of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.count === slot) last.count++;
    else ranges.push({ start: slot, count: 1 });
  }
  return ranges;
}

/**
 * Mutable CPU-side dense vegetation layout. A slot retains its authored record + ordinal, so
 * packing never changes the instance data or needs an identity-dependent RNG draw.
 */
export function createVegetationSubmissionState() {
  return { cells: new Map(), species: new Map() };
}

/** Reconcile the visible cell set using individual-slot swap removal and append-only insertion. */
export function reconcileVegetationSubmission(state, visibleCells) {
  if (!state?.cells || !state?.species) throw new TypeError('invalid vegetation submission state');
  const desired = new Map();
  for (const cell of visibleCells) desired.set(cellIdentity(cell), cell);
  const dirty = new Map();
  let compactions = 0, membershipChanges = 0;

  for (const [key, cell] of [...state.cells]) {
    const replacement = desired.get(key);
    if (!replacement || replacement !== cell) {
      compactions += removeCell(state, key, dirty);
      membershipChanges++;
    }
  }
  for (const [key, cell] of desired) {
    if (!state.cells.has(key)) {
      addCell(state, cell, dirty);
      membershipChanges++;
    }
    else if (cell.batchDirty) {
      for (const record of cell.records) {
        const slots = state.species.get(record.species)?.cellSlots.get(key);
        if (!slots) continue;
        const speciesDirty = dirtySpecies(dirty, record.species);
        for (const slot of slots) speciesDirty.add(slot);
      }
    }
  }

  const species = new Map();
  let instances = 0, dirtyRanges = 0, dirtyInstances = 0, uploadBytes = 0;
  for (const [name, batch] of state.species) {
    // A later removal in the same reconciliation can retire a slot dirtied by an earlier swap.
    // Discard those now-out-of-range indices before materializing upload ranges.
    const ranges = coalesceSlots([...(dirty.get(name) || [])]
      .filter(slot => slot < batch.slots.length));
    const stride = name === 'bb' || !['snag', 'sage'].includes(name) ? 20 : 19;
    const changed = ranges.reduce((sum, range) => sum + range.count, 0);
    species.set(name, { slots: batch.slots, count: batch.slots.length, ranges, stride });
    instances += batch.slots.length;
    dirtyRanges += ranges.length;
    dirtyInstances += changed;
    uploadBytes += changed * stride * 4;
  }
  for (const cell of desired.values()) cell.batchDirty = false;
  return {
    species, visibleCells: desired.size, instances, dirtyRanges, dirtyInstances,
    uploadBytes, fullUploadBytes: [...species.values()]
      .reduce((sum, batch) => sum + batch.count * batch.stride * 4, 0),
    compactions, membershipChanges,
  };
}

export function vegetationSlotIdentity(slot, species) {
  return `${slot.cellKey}/${species}/${slot.ordinal}`;
}
