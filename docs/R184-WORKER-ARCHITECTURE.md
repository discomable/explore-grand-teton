# Three.js r184 and worker architecture

The supported runtime is now Vite with `three@0.184.0` pinned in `package-lock.json`.

## Commands

- `npm run dev` starts the development server.
- `npm test` runs worker-pool protocol tests.
- `npm run build` creates the static `dist/` deployment.
- `npm run preview` serves the production build locally.

`build-web.sh` remains as the deployment-oriented wrapper which also writes host headers.

## Runtime boundary

`terrain/src/main.js` is the ES-module entry point. It imports Three.js and the matching
`three/addons` GLTF loader, creates `AppContext`, starts the CPU worker pool, and then loads the
legacy world modules in their established dependency order. New services should be registered on
`window.GT_APP`; converting the remaining world modules from ordered scripts to imports can now be
done manager-by-manager without another engine migration.

The old r128 engine and loader bundles have been removed.

## CPU workers

`WorkerPool` creates `min(4, max(1, hardwareConcurrency - 2))` native module workers. Jobs carry an
ID, kind, generation, priority, payload, and transfer list. Queued and running work can be
cancelled; superseding a scope rejects old generations. A crashed worker is recreated and its
active job is retried once when the payload has not transferred ownership. Jobs with transfer
lists fail safely because their buffers may already be detached.

Terrain height image decoding, conversion, edge padding, and min/max extraction run in this pool.
`ImageBitmap` enters the worker by transfer and the decoded `Float32Array` buffer returns by
transfer. When workers are unavailable, `TerrainStreamer` uses its existing synchronous decoder.
GPU texture creation and upload remain on the main thread and retain the per-frame upload budget.

Imagery fetch, browser decode, and raster-edge padding also run in the pool. Prepared
`ImageBitmap`s return by ownership transfer, while texture creation remains on the main thread.
Large camera teleports advance the terrain generation and cancel stale decoding work. The upload
budget adapts to recent frame time so a decode burst cannot monopolize a slow frame.

The worker also exposes a typed-data scatter-matrix job for subsequent scatter/ground-cover manager
migration. Queue length is bounded and `window.GT_STREAMING` exposes worker latency, active/queued
jobs, decode counts, cache sizes, upload backlog, and generation state.

## Vegetation streaming

Missing vegetation cells remain deterministic and world-anchored, but their build queue is
reprioritized toward the camera view after movement or a meaningful turn. Rotation never evicts or
rebuilds resident cells. LOD replacements retain priority and swap atomically.

A dedicated module worker now prepares the deterministic tree and shrub candidate streams. It has
a bounded queue, cancellation and generation checks, transfers candidate buffers back without
cloning, and falls back to the original synchronous path. Terrain, water, road and building
queries are captured into exact per-candidate immutable snapshots. Snapshot sampling is spread
across frames; the worker then performs procedural acceptance, species/atlas selection, pose,
scale and tint generation. Imagery-dot tree filtering and shrub acceptance/pose/tint now use the
same worker path. Final Three.js mesh application remains on the main thread.

`window.GT_VEGETATION_STREAMING` reports resident, queued and fading cells, close-detail count,
average/worst cell construction time, worker availability, generation, submitted/completed/
cancelled/stale job counts, transferred bytes and queue high-water mark.

The production far vegetation LOD uses irregular multi-tree stand impostors in world-stable 128 m
microcells. It reuses the existing 512 m moving ring and one instanced draw, but multi-samples the
forest field so mixed edges retain openings instead of becoming continuous canopy. `?farRows=1`
restores the old crossed-row control.

An experimental terrain-conforming canopy shell remains available from the worker-owned height,
vegetation and forest indexes. It is not the production target: the connected surface suppresses
stand structure, and route validation showed that its per-cell worker protocol cannot populate the
moving ring within budget. Use `?canopyShell=1` only for diagnostic comparison.
`GT_VEGETATION_STREAMING.farCanopy` reports its queue, completed cells, rebuilds, vertices,
triangles, cancellations, worker adoption and construction time.

Ground cover has the same bounded asynchronous candidate preparation and synchronous fallback.
Its worker performs ecological filtering and returns final matrix, color and atlas typed arrays,
which the main thread copies directly into the instanced GPU buffers. Exact live-query sampling is
also incremental, with a small bounded startup boost until the first nearby cell is resident.
`window.GT_GROUND_COVER_STREAMING` reports its generation, pending/ready/queued/resident cells,
live instances, sampling progress/budgets, job counters, transferred bytes and fill timings.
Record both objects alongside
`window.GT_STREAMING` and `window.GT_FRAME_MS` during a repeatable movement route; a single idle
snapshot is not a streaming benchmark. Live mutable world indexes still require main-thread
sampling; future work can make those indexes themselves immutable worker-owned services.

## Worker-owned world indexes

`WorldIndexClient`, `world-index.js` and `world-index-worker.js` provide the production query
service without requiring `SharedArrayBuffer` or cross-origin isolation. The persistent worker owns
stripped landcover, vegetation, forest and ground-tint channels; a packed authoritative water
surface; packed road segments and building footprints; and a bounded mirror of recent decoded
height tiles. Sampling preserves the original nearest, bilinear, road-bucket, point-in-polygon and
water missing-neighbour rules.

Scatter and ground-cover cell jobs batch all live world queries through this service. If an index
or height tile is absent, that value uses the exact main-thread query fallback. At full coverage,
`worldIndexAdoptionPercent` reaches 100% and snapshot construction performs no live main-thread
terrain, ecology or exclusion query. The main thread still retains renderer/collision raster data
and applies final Three.js/GPU buffers, so mirrored height tiles are capped independently at 64 to
bound duplicate memory.

## Worker verification and performance acceptance

Protocol tests cover priority/FIFO dispatch, queue bounds, queued and running cancellation, stale
generation rejection, crash retry and the non-retry rule for transferred payloads. Candidate
helper tests lock down the exact deterministic streams, buffer sizes, independent tree/shrub
sequences, cancellation boundaries and transfer-of-ownership behavior. New typed-data helpers
should remain importable outside their worker entry point so these properties can be tested
without a browser.

Use a frozen camera route containing forward travel, a 180-degree turn, and a teleport while cells
are in flight. Compare the worker implementation with the equivalent r184 synchronous path after
a warm-up run. Add `noWorkers=1` to disable the CPU pool, worker-owned world index, and dedicated
vegetation/ground-cover workers while retaining the same r184 renderer. Acceptance for vegetation
and ground cover is:

- At least 50% less main-thread long-task time during the route.
- No more than 5% GPU-time regression; worker changes do not relax the GPU budget.
- Identical accepted instance counts and deterministic instance data for the same seed and inputs.
- No visible cell holes or rotation-triggered resident-cell rebuilds.
- Queue and pending counts return to their idle baseline after the route.
- Every pre-teleport reply is cancelled or counted as stale, and none reaches GPU upload.
- Transferred-byte telemetry agrees with the returned typed-array byte lengths.
- Repeating the route does not increase resident cache memory or leave detached buffers retained.

Capture median and 95th-percentile frame time, main-thread long-task milliseconds, per-stage worker
latency, queue high-water mark, cancellation/stale counts, transferred bytes, upload backlog,
resident cell counts, draw calls, triangles and GPU time. Run the full route in current Chrome,
Firefox and Safari; use the main-thread renderer for production acceptance and report the
experimental renderer-worker route separately.

The browser harness automates the common forward, 180-degree turn, forward, and teleport-settle
route. Start it with `?benchmark=1`; repeat with `?benchmark=1&noWorkers=1` for the synchronous
control. `benchmarkScale=0.5` shortens every phase for smoke tests.
`benchmarkWarmupMs=10000` optionally leaves an unmeasured residency warm-up before the route.
After the fixed teleport-settle phase, the harness waits up to 30 seconds for terrain, worker,
world-index, vegetation, and ground-cover queues to drain. Override this with
`benchmarkIdleTimeoutMs`; the report records `environment.idleSettled`, `idleWaitMs`, and the final
queue snapshot so a timed-out run cannot be mistaken for an accepted result.
It samples frame intervals, Long Tasks API entries, `GT_STREAMING`, `GT_VEGETATION_STREAMING`, and
`GT_GROUND_COVER_STREAMING`, plus per-frame renderer draw calls, triangles, programs, geometries
and textures, then places the versioned JSON result in
`window.GT_BENCHMARK_REPORT`. Call `GT_exportBenchmarkReport()` in DevTools to download it, or add
`benchmarkDownload=1` for automatic download. `GT_BENCHMARK_STATUS` and the
`gt:benchmark-complete` event support browser automation. The harness is not loaded without the
flag and does not alter normal production input or streaming.

## Shader extensions

Built-in material patches are registered through `shader-extension-registry.js`. The registry
asserts every replacement anchor, composes a stable `customProgramCacheKey()`, and preserves any
pre-existing material hook. Building and water patches use this path, so a future Three.js shader
chunk change fails at the named extension instead of silently producing a degraded material.

## Renderer worker experiment

`?renderWorker=1` feature-detects module workers and `transferControlToOffscreen()`. The main thread
owns DOM and sampled input while the worker owns a WebGLRenderer, scene, camera, frame loop, and
telemetry. Initialization failure removes the flag by navigation and starts the normal renderer in
a fresh document, because a transferred canvas cannot be reclaimed.

This mode is deliberately experimental and currently validates the renderer/input/telemetry
boundary; the complete terrain and gameplay manager graph remains on the production main-thread
renderer until each DOM dependency has a proxy.

## Color and visual acceptance

The renderer uses `outputColorSpace = SRGBColorSpace`; display textures use `colorSpace`, and data
or render-target textures use `NoColorSpace`. Terrain imagery remains explicitly authored-space in
its custom shader because that shader performs its own single sRGB-to-linear conversion after
classification/detail blending.

The r128 global `ShaderMaterial.prototype.onBeforeCompile` output patch is gone. The r184 result is
a new visual baseline and should be approved with the canonical capture views before release.
