import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBenchmarkReport,
  evaluateTransportPerformance,
  captureRendererTelemetry,
  flattenNumeric,
  percentile,
  summarizeDurations,
  summarizeTelemetry,
  buildTerrainEnduranceReport,
  evaluateTerrainEndurance,
  monotonicallyGrowing,
  retainWorst,
  summarizeEnduranceFrames,
} from '../terrain/src/benchmark/aggregation.js';

test('duration summaries use nearest-rank percentiles and ignore non-finite values', () => {
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  assert.deepEqual(summarizeDurations([10, 20, 30, Number.NaN]), {
    count: 3, totalMs: 60, meanMs: 20, minMs: 10, maxMs: 30,
    p50Ms: 20, p95Ms: 30, p99Ms: 30,
  });
});

test('transport performance gates enforce high and accessible budgets', () => {
  const high = evaluateTransportPerformance({
    quality: 'high', frames: [16, 18, 20, 24], coldStartInteractiveMs: 3800,
  });
  assert.equal(high.passed, true);
  assert.equal(high.checks.onePercentLowFps, true);
  const accessible = evaluateTransportPerformance({
    quality: 'accessible', frames: [20, 28, 40, 400], coldStartInteractiveMs: 5100,
    consoleErrors: 1,
  });
  assert.equal(accessible.passed, false);
  assert.equal(accessible.checks.maxFrameMs, false);
  assert.equal(accessible.checks.coldStart, false);
  assert.equal(accessible.checks.console, false);
});

test('renderer telemetry captures workload and memory counters with safe defaults', () => {
  assert.deepEqual(captureRendererTelemetry({
    info: {
      render: {calls:12,triangles:3456,lines:7,points:8},
      memory: {geometries:9,textures:10},
      programs: [{},{}],
    },
  }), {
    calls:12,triangles:3456,lines:7,points:8,geometries:9,textures:10,programs:2,
  });
  assert.deepEqual(captureRendererTelemetry(null), {
    calls:0,triangles:0,lines:0,points:0,geometries:0,textures:0,programs:0,
  });
});

test('telemetry aggregation flattens nested numeric counters', () => {
  assert.deepEqual(flattenNumeric({queue:{pending:2},enabled:true,label:'x'}), {'queue.pending':2});
  assert.deepEqual(summarizeTelemetry([
    {atMs:0,value:{queue:{pending:2},generation:1}},
    {atMs:10,value:{queue:{pending:4},generation:2}},
  ]), {
    generation:{samples:2,mean:1.5,max:2,final:2},
    'queue.pending':{samples:2,mean:3,max:4,final:4},
  });
});

test('report includes route, frame thresholds, long tasks, and telemetry', () => {
  const report=buildBenchmarkReport({
    startedAt:100,
    endedAt:250,
    frames:[10,20,60],
    longTasks:[
      {startTime:20,duration:500},
      {startTime:120,duration:55},
      {startTime:300,duration:200},
    ],
    telemetry:{GT_STREAMING:[{atMs:0,value:{pending:3}}]},
    phases:[{name:'forward',startedMs:0,endedMs:100}],
    environment:{userAgent:'test'},
  });
  assert.equal(report.schema,'grand-teton-streaming-benchmark/v1');
  assert.equal(report.elapsedMs,150);
  assert.equal(report.frames.over16_7,2);
  assert.equal(report.frames.over50,1);
  assert.equal(report.longTasks.entries[0].startMs,20);
  assert.equal(report.longTasks.count,1);
  assert.equal(report.telemetry.GT_STREAMING.pending.final,3);
  assert.deepEqual(report.route[0],{name:'forward',startedMs:0,endedMs:100,durationMs:100});
});

test('endurance aggregation reports percentiles, thresholds, and bounded spikes', () => {
  assert.deepEqual(summarizeEnduranceFrames([10, 20, 30, 45, 60, 120]), {
    count:6,totalMs:285,meanMs:47.5,minMs:10,maxMs:120,p50Ms:30,p95Ms:120,p99Ms:120,
    over16_7:5,over25:4,over40:3,over50:2,over100:1,
  });
  const worst = retainWorst([
    { durationMs: 20 }, { durationMs: 80 }, { durationMs: 40 }, { durationMs: 10 },
  ], 2);
  assert.deepEqual(worst.map(item => item.durationMs), [80, 40]);
  assert.equal(monotonicallyGrowing([10, 12, 14, 16], {minimumStep:2,streak:3}), true);
  assert.equal(monotonicallyGrowing([10, 12, 11, 14], {minimumStep:2,streak:3}), false);
});

test('terrain endurance gates ownership, coverage, counters, hangs, and retained memory', () => {
  const MiB = 1024 * 1024;
  const scenario = (bytes, overrides = {}) => ({
    frames:{maxMs:100},coverageFailures:[],counterDelta:{capacityRetries:0},
    settle:{settled:true},settled:{totalTerrainOwnedBytes:bytes,warmOnlyBytes:10*MiB},...overrides,
  });
  const passing = [scenario(300*MiB),scenario(305*MiB),scenario(304*MiB),scenario(308*MiB)];
  assert.equal(evaluateTerrainEndurance({scenarios:passing}).passed, true);
  const failed = evaluateTerrainEndurance({scenarios:[
    scenario(300*MiB), scenario(340*MiB,{frames:{maxMs:1001},coverageFailures:[{atMs:2}],
      counterDelta:{capacityRetries:1,failures:1},settle:{settled:false},prewarm:{settled:false},
      settled:{totalTerrainOwnedBytes:460*MiB,warmOnlyBytes:80*MiB}}),
  ],browserErrors:['boom'],failedRequests:[{url:'x'}],contextLosses:1});
  assert.equal(failed.passed,false);
  for (const name of ['browserErrors','failedRequests','requestCounters','contextLoss','terrainCoverage',
    'settledResidency','warmOnlyResidency','finalGrowth','settled','capacityRetries','frameHang'])
    assert.equal(failed.checks[name],false,name);
  const report=buildTerrainEnduranceReport({scenarios:passing,manifestVersion:1});
  assert.equal(report.schema,'grand-teton-terrain-endurance/v1');
  assert.equal(report.gate.passed,true);
});
