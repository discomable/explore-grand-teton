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
