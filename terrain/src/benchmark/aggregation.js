import { counterDelta, requestRates } from '../terrain-telemetry.js';

const DEFAULT_PERCENTILES = [0.5, 0.95, 0.99];

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function summarizeDurations(values, percentiles = DEFAULT_PERCENTILES) {
  const finite = values.filter(Number.isFinite);
  const total = finite.reduce((sum, value) => sum + value, 0);
  const result = {
    count: finite.length,
    totalMs: round(total),
    meanMs: round(finite.length ? total / finite.length : 0),
    minMs: round(finite.length ? Math.min(...finite) : 0),
    maxMs: round(finite.length ? Math.max(...finite) : 0),
  };
  for (const fraction of percentiles) {
    result[`p${Math.round(fraction * 100)}Ms`] = round(percentile(finite, fraction));
  }
  return result;
}

export function retainWorst(entries, limit = 24, value = entry => entry.durationMs) {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError('limit must be non-negative');
  return entries.filter(entry => Number.isFinite(value(entry)))
    .sort((a, b) => value(b) - value(a)).slice(0, limit);
}

export function monotonicallyGrowing(values, { minimumStep = 1024 * 1024, streak = 3 } = {}) {
  let growing = 0;
  for (let index = 1; index < values.length; index++) {
    if (values[index] - values[index - 1] >= minimumStep) growing++;
    else growing = 0;
    if (growing >= streak) return true;
  }
  return false;
}

export function summarizeEnduranceFrames(values) {
  const summary = summarizeDurations(values);
  return {
    ...summary,
    over16_7: values.filter(value => value > 16.7).length,
    over25: values.filter(value => value > 25).length,
    over40: values.filter(value => value > 40).length,
    over50: values.filter(value => value > 50).length,
    over100: values.filter(value => value > 100).length,
  };
}

export function evaluateTerrainEndurance({
  scenarios = [], browserErrors = [], failedRequests = [], contextLosses = 0,
} = {}) {
  const MIB = 1024 * 1024;
  const settled = scenarios.map(item => item.settled || {});
  const settledBytes = settled.map(item => item.residentTerrainBytes ||
    item.totalTerrainOwnedBytes || 0);
  const warmOnlyBytes = settled.map(item => item.warmOnlyBytes || 0);
  const first = settledBytes[0] || 0;
  const final = settledBytes.at(-1) || 0;
  const repetitions = scenarios.map(item => item.repetition).filter(Number.isFinite);
  const finalRepetition = repetitions.length ? Math.max(...repetitions) : null;
  const trendBytes = finalRepetition == null ? settledBytes : scenarios
    .filter(item => item.repetition === finalRepetition)
    .map(item => item.settled?.residentTerrainBytes ||
      item.settled?.totalTerrainOwnedBytes || 0);
  const checks = {
    browserErrors: browserErrors.length === 0,
    failedRequests: failedRequests.length === 0,
    requestCounters: scenarios.every(item => (item.counterDelta?.failures || 0) === 0),
    contextLoss: contextLosses === 0,
    terrainCoverage: scenarios.every(item => (item.coverageFailures || []).length === 0),
    settledResidency: settledBytes.every(bytes => bytes <= 450 * MIB),
    warmOnlyResidency: warmOnlyBytes.every(bytes => bytes <= 75 * MIB),
    finalGrowth: final <= first + 32 * MIB,
    settled: scenarios.every(item => item.settle?.settled === true &&
      (item.prewarm == null || item.prewarm.settled === true)),
    capacityRetries: scenarios.every(item => (item.counterDelta?.capacityRetries || 0) === 0),
    residencyTrend: !monotonicallyGrowing(trendBytes),
    frameHang: scenarios.every(item => (item.frames?.maxMs || 0) <= 1000),
  };
  return {
    passed: Object.values(checks).every(Boolean), checks,
    limits: {
      settledTerrainBytes: 450 * MIB, warmOnlyBytes: 75 * MIB,
      finalGrowthBytes: 32 * MIB, hangFrameMs: 1000,
    },
    observed: {
      peakSettledTerrainBytes: Math.max(0, ...settledBytes),
      peakWarmOnlyBytes: Math.max(0, ...warmOnlyBytes),
      firstSettledTerrainBytes: first, finalSettledTerrainBytes: final,
      finalGrowthBytes: final - first,
    },
  };
}

export function buildTerrainEnduranceReport({
  scenarios = [], environment = {}, browserErrors = [], failedRequests = [], contextLosses = 0,
  manifestVersion = 1,
} = {}) {
  const gate = evaluateTerrainEndurance({ scenarios, browserErrors, failedRequests, contextLosses });
  return {
    schema: 'grand-teton-terrain-endurance/v1',
    createdAt: new Date().toISOString(), manifestVersion, environment,
    scenarios, browserErrors, failedRequests, contextLosses, gate,
  };
}

export { counterDelta, requestRates };

export function flattenNumeric(value, prefix = '', output = {}) {
  if (Number.isFinite(value)) {
    output[prefix] = value;
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flattenNumeric(child, prefix ? `${prefix}.${key}` : key, output);
    }
  }
  return output;
}

export function summarizeTelemetry(samples) {
  const series = new Map();
  for (const sample of samples) {
    for (const [path, value] of Object.entries(flattenNumeric(sample.value))) {
      if (!series.has(path)) series.set(path, []);
      series.get(path).push(value);
    }
  }
  return Object.fromEntries([...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([path, values]) => [path, {
      samples: values.length,
      mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      max: round(Math.max(...values)),
      final: round(values.at(-1)),
    }],
  ));
}

export function captureRendererTelemetry(renderer) {
  const info = renderer?.info;
  return {
    calls: finiteOrZero(info?.render?.calls),
    triangles: finiteOrZero(info?.render?.triangles),
    lines: finiteOrZero(info?.render?.lines),
    points: finiteOrZero(info?.render?.points),
    geometries: finiteOrZero(info?.memory?.geometries),
    textures: finiteOrZero(info?.memory?.textures),
    programs: Array.isArray(info?.programs) ? info.programs.length : 0,
  };
}

export function buildBenchmarkReport({
  startedAt,
  endedAt,
  frames = [],
  longTasks = [],
  telemetry = {},
  phases = [],
  environment = {},
}) {
  const elapsedMs = Math.max(0, endedAt - startedAt);
  const routeLongTasks = longTasks.filter(task =>
    Number.isFinite(task.startTime) &&
    task.startTime >= startedAt &&
    task.startTime <= endedAt);
  return {
    schema: 'grand-teton-streaming-benchmark/v1',
    createdAt: new Date().toISOString(),
    elapsedMs: round(elapsedMs),
    environment,
    route: phases.map(({ name, startedMs, endedMs }) => ({
      name,
      startedMs: round(startedMs),
      endedMs: round(endedMs),
      durationMs: round(endedMs - startedMs),
    })),
    frames: {
      ...summarizeDurations(frames),
      over16_7: frames.filter(value => value > 16.7).length,
      over50: frames.filter(value => value > 50).length,
    },
    longTasks: {
      ...summarizeDurations(routeLongTasks.map(task => task.duration)),
      entries: routeLongTasks.map(task => ({
        startMs: round(task.startTime - startedAt),
        durationMs: round(task.duration),
      })),
    },
    telemetry: Object.fromEntries(Object.entries(telemetry).map(
      ([name, samples]) => [name, summarizeTelemetry(samples)],
    )),
  };
}

export function evaluateTransportPerformance({
  quality = 'high', frames = [], coldStartInteractiveMs = 0,
  consoleErrors = 0, failedRequests = 0, contextLosses = 0, resourceGrowth = 0,
} = {}) {
  const limits = quality === 'accessible'
    ? { averageFps: 30, onePercentLowFps: 24, maxFrameMs: 350, coldStartMs: 5000 }
    : { averageFps: 45, onePercentLowFps: 30, maxFrameMs: 250, coldStartMs: 4000 };
  const summary = summarizeDurations(frames);
  const metrics = {
    averageFps: summary.meanMs > 0 ? round(1000 / summary.meanMs) : 0,
    onePercentLowFps: summary.p99Ms > 0 ? round(1000 / summary.p99Ms) : 0,
    maxFrameMs: summary.maxMs,
    coldStartInteractiveMs: round(coldStartInteractiveMs),
    consoleErrors, failedRequests, contextLosses, resourceGrowth,
  };
  const checks = {
    averageFps: metrics.averageFps >= limits.averageFps,
    onePercentLowFps: metrics.onePercentLowFps >= limits.onePercentLowFps,
    maxFrameMs: metrics.maxFrameMs <= limits.maxFrameMs,
    coldStart: metrics.coldStartInteractiveMs <= limits.coldStartMs,
    console: consoleErrors === 0,
    requests: failedRequests === 0,
    context: contextLosses === 0,
    resources: resourceGrowth <= 0,
  };
  return Object.freeze({ quality, passed: Object.values(checks).every(Boolean),
    limits: Object.freeze(limits), metrics: Object.freeze(metrics), checks: Object.freeze(checks) });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}
