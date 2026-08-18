const OWNERS = Object.freeze(['active', 'warm', 'safety', 'query', 'persistent']);

function blankTotal() {
  return { sources: 0, cpuBytes: 0, gpuBytes: 0, totalBytes: 0 };
}

function add(total, entry) {
  total.sources++;
  total.cpuBytes += Number(entry.cpuBytes) || 0;
  total.gpuBytes += Number(entry.gpuBytes) || 0;
  total.totalBytes = total.cpuBytes + total.gpuBytes;
}

/**
 * Account each terrain source once in the exclusive table while retaining every applicable
 * protection reason in the inclusive table. `shared` means two or more ownership reasons.
 */
export function accountTerrainOwnership(entries = []) {
  const inclusive = Object.fromEntries(OWNERS.map(owner => [owner, blankTotal()]));
  inclusive.unprotected = blankTotal();
  const exclusive = Object.fromEntries(
    [...OWNERS.map(owner => `${owner}Only`), 'shared', 'unprotected']
      .map(owner => [owner, blankTotal()]));

  for (const entry of entries) {
    const owners = OWNERS.filter(owner => !!entry[owner]);
    if (!owners.length) {
      add(inclusive.unprotected, entry);
      add(exclusive.unprotected, entry);
    } else {
      for (const owner of owners) add(inclusive[owner], entry);
      add(exclusive[owners.length === 1 ? `${owners[0]}Only` : 'shared'], entry);
    }
  }
  return { inclusive, exclusive };
}

export function mergeCounterKinds(kinds = {}) {
  const total = {};
  for (const counters of Object.values(kinds)) {
    for (const [name, value] of Object.entries(counters || {})) {
      if (Number.isFinite(value)) total[name] = (total[name] || 0) + value;
    }
  }
  return total;
}

export function counterDelta(start = {}, end = {}) {
  const result = {};
  for (const key of new Set([...Object.keys(start), ...Object.keys(end)])) {
    const before = Number(start[key]) || 0;
    const after = Number(end[key]) || 0;
    result[key] = Math.max(0, after - before);
  }
  return result;
}

export function requestRates(start, end, elapsedMs) {
  const delta = counterDelta(start, end);
  const seconds = Math.max(0.001, elapsedMs / 1000);
  const attempts = (delta.hits || 0) + (delta.misses || 0);
  return {
    delta,
    cacheHitRate: attempts ? delta.hits / attempts : null,
    requestsPerSecond: attempts / seconds,
    completionsPerSecond: (delta.completions || 0) / seconds,
    cancellationsPerSecond: (delta.cancellations || 0) / seconds,
    uploadsPerSecond: (delta.uploads || 0) / seconds,
    reuploadsPerSecond: (delta.reuploads || 0) / seconds,
    evictionsPerSecond: (delta.evictions || 0) / seconds,
    downloadedBytesPerSecond: (delta.downloadedBytes || 0) / seconds,
  };
}

export function labelTimerSample(id, backend, ms) {
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(ms) || ms < 0)
    throw new TypeError('timer sample needs a positive integer id and finite milliseconds');
  if (backend !== 'gpu-timer' && backend !== 'cpu-fallback')
    throw new TypeError('timer backend must be gpu-timer or cpu-fallback');
  const sample = { id, backend, ms };
  return { sample, gpuSample: backend === 'gpu-timer' ? sample : null };
}

export const TERRAIN_OWNERS = OWNERS;
