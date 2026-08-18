/* TerrainStreamer — quadtree streaming of terrain height + aerial imagery for Three.js (r184).
 *
 * Two tile pyramids share one dyadic grid family (same extent, tileSize, and root span
 * rootSpan = tileSize * 2^maxZoom * pixelSize — e.g. heights 512·2^4·10 m and NAIP 512·2^7·1.25 m
 * are both 81920 m), so tile (z,x,y) means the same world square in every dataset.
 *
 * The quadtree subdivides to the DEEPEST dataset. A node deeper than a dataset's native maxZoom
 * (or whose native tile hasn't arrived yet) samples the nearest READY ancestor tile through a UV
 * sub-window (uniform vec3: offset + scale). That gives: crisp 1.25 m imagery draped over 10 m
 * heights today, and native 1 m heights the moment the deeper pyramid is baked — no code change.
 *
 * Memory: LRU caches per dataset + node-mesh pruning; only the visible working set is live.
 * heightAt(x,z) serves collision/placement from decoded height arrays (persistent coarse base
 * guarantees full-park coverage).
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const DEFAULTS = {
    heightCacheMax: 300,      // decoded float tiles (~1 MB each)
    imageryCacheMax: 250,     // RGB textures (~1 MB each)
    // Count limits are useful for request churn; byte limits are the actual memory guard.
    // These defaults preserve the current Ultra working set closely while preventing an
    // accumulation of decoded bitmaps/textures from silently exceeding the tile count.
    heightBytesMax: 320 * 1024 * 1024,
    imageryBytesMax: 128 * 1024 * 1024,
    // Inclusive decoded-source + resident-array budget. Keep a little headroom below the
    // endurance gate so telemetry cadence and a newly protected tile cannot make a nominally
    // settled working set oscillate around 450 MiB.
    residentBytesMax: 440 * 1024 * 1024,
    // Visible leaves, the CPU-query corridor and persistent ancestors overlap but can briefly
    // protect more than 128 height sources. Keep enough headroom to prevent continual layer
    // eviction/re-upload while retaining a much smaller allocation than the original 192/160.
    heightArrayLayers: 160,
    imageryArrayLayers: 128,
    queryRadius: 2500,
    meshIdleFrames: 240,      // prune node meshes unseen for this many frames
    uploadsPerFrame: 6,       // near-field imagery must land fast (was a visible beige lag)
    maxConcurrentFetch: 12,
    pixelError: 1.8,          // screen-space error (px) before subdividing
    geometricErrorFloor: 0.5, // retain half the authored texel-error envelope even on flat nodes;
                              // avoids an over-aggressive collapse while measured error removes
                              // the genuinely sub-pixel half of the legacy tessellation.
    // CORE-RANGE fidelity: nodes whose xz-box overlaps this world-space box (the Cathedral Group —
    // Grand/Owen/Teewinot/Middle Teton) subdivide with corePixelError instead of pixelError, so the
    // range keeps ~1 m relief in its silhouette at valley distance where the global SSE would round
    // it to a foothill. corePixelError is a CONSTANT inside the box (never ramped), so the cascaded
    // geomorph stays exactly as self-consistent inside it as it is globally — both the SSE test and
    // the geomorph handoff read the same per-node value. The box edges are parked out in the Snake
    // flats / lower benches (smooth terrain: the coarse<->fine morph residual there is sub-metre and
    // the transient skirt already swallows it), and the west/south edges climb terrain that the
    // valley never sees. Bounded to the box => ~0 cost anywhere else in the park.
    coreBox: { minX: -7700, maxX: -4300, minZ: -2050, maxZ: 1450 },
    corePixelError: 0.55,
    // CORE FLOOR ZOOM (M2 bespoke core-range pass): force nodes overlapping coreBox to subdivide to
    // AT LEAST this zoom regardless of camera distance, so the Cathedral Group keeps its full 1 m
    // silhouette from clear across the park (the SSE test alone rounds it to ~z5/40 m-verts at 9 km;
    // z7 = the 160-grid = ~4 m verts). Frustum-culled, so only the peaks actually in view pay. Bounded
    // to the box ⇒ 0 cost elsewhere. Set 0 to disable; lower (e.g. 6 = 20 m verts) if fps needs it.
    coreFloorZ: 7,
    gridByLOD: [16, 32, 64, 160],   // densest grid ~4 m verts on a z7 tile: uses the 1 m data
    skirt: 6,                 // base skirt (m); scaled per texel + relief. Edges now match by
                              //   construction (2:1 balance + stitch), so this only guards
                              //   streaming transients — small enough to stop dark ridge walls.
    snowLine: 900,            // procedural fallback palette only
    fog: { near: 2500, far: 20000 },
  };
  // Bounds include the decoded CPU working set as well as the GPU textures. 512px imagery is
  // roughly 1 MiB decoded and another 1.33 MiB on the GPU once mipmapped; height tiles retain a
  // 1 MiB Float32Array alongside their 1 MiB R32F upload. High used to permit 450/600 tiles,
  // making terrain residency alone capable of exceeding 2 GiB.
  const RESIDENCY_BY_QUALITY = Object.freeze({
    ultra:    Object.freeze({ height: 300, imagery: 250, heightBytes: 320, imageryBytes: 128 }),
    high:     Object.freeze({ height: 240, imagery: 300, heightBytes: 256, imageryBytes: 160 }),
    balanced: Object.freeze({ height: 180, imagery: 200, heightBytes: 192, imageryBytes: 112 }),
    low:      Object.freeze({ height: 120, imagery: 120, heightBytes: 144, imageryBytes: 80 }),
  });

  function makeGrid(n) {
    const verts = [], idx = [];
    const N = n + 2, step = 1 / n;               // +1 skirt ring each side
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) verts.push((i - 1) * step, 0, (j - 1) * step);
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    return g;
  }

  class TerrainStreamer {
    constructor(opts) {
      this.o = Object.assign({}, DEFAULTS, opts);
      // Quality presets must also bound world complexity, not only framebuffer resolution.
      // Keep Ultra byte-for-byte at the authored settings; High trades sub-pixel valley-distance
      // tessellation for substantially fewer vertices while retaining the 1 m source data and
      // the dedicated Cathedral Group floor.
      let quality = 'ultra';
      try {
        const requested = new URLSearchParams(global.location?.search || '').get('quality');
        quality = requested || global.localStorage?.getItem('gt-quality') || quality;
      }
      catch (_) {}
      if (!RESIDENCY_BY_QUALITY[quality]) quality = 'ultra';
      if (quality === 'high') {
        // High prioritises a stable view. The hard-edged Cathedral override and aerial grid
        // demotion exposed regional/tile boundaries during flight, so High keeps one uniform SSE
        // policy. Its residency is nevertheless bounded below Ultra to avoid retaining gigabytes
        // of decoded imagery during long traversals.
        if (opts.pixelError == null) this.o.pixelError = DEFAULTS.pixelError;
        if (opts.corePixelError == null) this.o.corePixelError = DEFAULTS.pixelError;
        if (opts.coreFloorZ == null) this.o.coreFloorZ = 0;
        if (opts.gridByLOD == null) this.o.gridByLOD = DEFAULTS.gridByLOD.slice();
        if (opts.uploadsPerFrame == null) this.o.uploadsPerFrame = 12;
        if (opts.maxConcurrentFetch == null) this.o.maxConcurrentFetch = 20;
        if (opts.heightCacheMax == null) this.o.heightCacheMax = RESIDENCY_BY_QUALITY.high.height;
        if (opts.imageryCacheMax == null) this.o.imageryCacheMax = RESIDENCY_BY_QUALITY.high.imagery;
        if (opts.heightBytesMax == null) this.o.heightBytesMax = RESIDENCY_BY_QUALITY.high.heightBytes * 1024 * 1024;
        if (opts.imageryBytesMax == null) this.o.imageryBytesMax = RESIDENCY_BY_QUALITY.high.imageryBytes * 1024 * 1024;
      } else if (quality === 'balanced' || quality === 'low') {
        if (opts.pixelError == null) this.o.pixelError = quality === 'low' ? 3.5 : 2.75;
        if (opts.corePixelError == null) this.o.corePixelError = quality === 'low' ? 1.2 : 0.9;
        if (opts.coreFloorZ == null) this.o.coreFloorZ = quality === 'low' ? 5 : 6;
        if (opts.gridByLOD == null) this.o.gridByLOD = quality === 'low'
          ? [16, 32, 48, 64] : [16, 32, 64, 96];
        if (opts.uploadsPerFrame == null) this.o.uploadsPerFrame = 2;
        // Accessible traversals cover widely separated park regions. Retaining the Ultra-sized
        // decoded/imagery working set pushes Chrome past a gigabyte and produces stop-the-world
        // collection cliffs late in endurance runs. Bound residency without changing visible
        // tessellation or the approved near-field transport geometry.
        if (opts.heightCacheMax == null) this.o.heightCacheMax = RESIDENCY_BY_QUALITY[quality].height;
        if (opts.imageryCacheMax == null) this.o.imageryCacheMax = RESIDENCY_BY_QUALITY[quality].imagery;
        if (opts.heightBytesMax == null) this.o.heightBytesMax = RESIDENCY_BY_QUALITY[quality].heightBytes * 1024 * 1024;
        if (opts.imageryBytesMax == null) this.o.imageryBytesMax = RESIDENCY_BY_QUALITY[quality].imageryBytes * 1024 * 1024;
      }
      this._quality = quality;
      this._naturalColor = !/[?&]naturalcolor=0(?:&|$)/.test(global.location?.search || '');
      this.scene = opts.scene; this.camera = opts.camera; this.renderer = opts.renderer;
      this.group = new THREE.Group(); this.group.name = 'terrainTiles'; this.scene.add(this.group);
      this.reflectionGroup = new THREE.Group();
      this.reflectionGroup.name = 'terrainReflectionTiles';
      this.reflectionGroup.visible = false; this.scene.add(this.reflectionGroup);
      this.hCache = new Map();      // height tiles: decoded Float32 + DataTexture
      this.iCache = new Map();      // imagery tiles: THREE.Texture
      this.meshes = new Map();      // node key -> {mesh, lastShown}
      this.batches = new Map();     // grid index -> active InstancedMesh record
      this._batchMaterial = null;
      this._batchCapacities = new Map();
      this._reflectionBatches = new Map();
      this._reflectionBatchCapacities = new Map();
      this._reflectionEnabled = !/[?&]reflectionTerrainLod=0(?:&|$)/.test(
        global.location?.search || '');
      this._reflectionCompare = /[?&]reflectionTerrainCompare=1(?:&|$)/.test(
        global.location?.search || '');
      this._reflectionFrame = null;
      this._reflectionStats = null;
      this._reflectionPassToken = null;
      this.arrayPool = null;
      this._batchSupport = { supported: false, reason: 'not-initialized' };
      this._batchCompare = /[?&]terrainBatchCompare=1(?:&|$)/.test(global.location?.search || '');
      this._visibilityEnabled = !/[?&]terrainVisibility=0(?:&|$)/.test(
        global.location?.search || '');
      this._visibilityCompare = /[?&]terrainVisibilityCompare=1(?:&|$)/.test(
        global.location?.search || '');
      this._terrainErrors = null;
      this._terrainErrorStatus = this._visibilityEnabled ? 'pending' : 'disabled';
      this._predictionState = null;
      this._visibilityStats = { geometricDecisions: 0, legacyDecisions: 0,
        changedDecisions: 0, predictedLeaves: 0, warmHeightSources: 0,
        warmImagerySources: 0, warmCancelled: 0, fallbackHits: 0 };
      this.fetchQueue = []; this.uploadQueue = []; this.inFlight = 0;
      this.workerPool = global.GT_APP && global.GT_APP.workerPool;
      this.worldIndex = global.GT_APP && global.GT_APP.worldIndex;
      this._worldHeightMirrors = new Map();
      this._worldHeightMirrorMax = Math.max(16, opts.worldIndexHeightMax || 64);
      this.worldIndex?.initialized?.then(() => {
        for (const e of this.hCache.values()) if (e.decoded) this._mirrorHeightTile(e);
      });
      this.generation = 1;
      this._streamStats = { heightDecoded: 0, imageryPrepared: 0, uploads: 0, stale: 0 };
      const requestCounters = () => ({ hits: 0, misses: 0, completions: 0, failures: 0,
        cancellations: 0, downloadedBytes: 0, uploads: 0, reuploads: 0, evictions: 0,
        capacityRetries: 0 });
      this._requestCounters = { height: requestCounters(), imagery: requestCounters() };
      this._lodStats = { currentSwaps: 0, cumulativeSwaps: 0, coverageFailures: 0,
        fallbackFrames: 0 };
      this._previousLeafKeys = new Set();
      this._nextLeafKeys = new Set();
      this._telemetryAt = 0;
      this.visibleTerrainCoverage = {
        visibleLeaves: 0, drawableLeaves: 0, missingLeaves: [], ratio: 0,
        nativeHeightLeaves: 0, nativeHeightRatio: 0, complete: false,
      };
      this.grids = this.o.gridByLOD.map(n => makeGrid(n));
      this._gridGeometryByN = new Map(this.o.gridByLOD.map((n, i) => [n, this.grids[i]]));
      this.noiseTex = this._buildNoiseAtlas();   // seamless tiling noise for the fragment shader
      this.detailNTex = this._buildDetailNormal(); // tiling rocky detail-normal (steep faces only)
      this.detailATex = this._buildDetailAlbedo(); // tiling class-material fields (near ground)
      this.lcTex = null; this.lcMap = null;        // set by _loadLandcoverTex()
      this.frame = 0;
      this._prevCam = new THREE.Vector3();
      this._clock0 = performance.now();   // drives uTime (cloud-shadow drift)
      this._timeSec = 0;
      // shared lighting refs (mutated in place by the app's sun controller)
      this.sunColor = opts.sunColor || new THREE.Color(1, 0.94, 0.84);
      this.sunAngles = opts.sunAngles || new THREE.Vector2(0.5, 0.9); // (azimuth, elevation) rad
      this.ambient = opts.ambient || new THREE.Color(0.78, 0.86, 1.0); // dims at night
      this.horizonTex = [null, null];                                  // set by loadHorizon()
      this.aoTex = null;                                               // set by _loadAO()
      this.roadsTex = null; this.roadsMap = null;                      // set by _loadRoads()
      this._pixelError = this.o.pixelError;   // effective (altitude-scaled) value, set per frame
      // core-range fidelity: fixed ratio so the box's reduced pixelError tracks the same per-frame
      // altitude scaling as the rest of the world (stays uniform INSIDE the box every frame)
      this._coreRatio = (this.o.corePixelError || this.o.pixelError) / this.o.pixelError;
      // shared cloud uniforms: this streamer is the PRODUCER (advances time + day gate each
      // frame); other modules consume the same objects in their onBeforeCompile shaders.
      // Order-independent create-or-adopt so parallel consumers can boot first.
      this.cloudU = global.CLOUD_UNIFORMS = global.CLOUD_UNIFORMS ||
        { uCloudTime: { value: 0 }, uCloudAmt: { value: 0 } };
      // shared real-cast-shadow uniforms: 20-scene is the producer (drives the depth pass and
      // updates map/matrix/gate each frame); tiles adopt the same objects so updates propagate.
      this.shadowU = global.SHADOW_UNIFORMS = global.SHADOW_UNIFORMS ||
        { uShadowMap: { value: null }, uShadowMtx: { value: new THREE.Matrix4() },
          uShadowOn: { value: 0 } };
      // shared terrain-aware headlight uniforms: 82-drive is the producer (writes beam origins/
      // dirs/params each frame while driving at night); terrain tiles + road ribbons adopt the
      // SAME objects so one update reaches every material. w (master intensity) 0 = fully off.
      this.headlightU = global.HEADLIGHT_UNIFORMS = global.HEADLIGHT_UNIFORMS ||
        { uHLPos:   { value: [new THREE.Vector3(1e6, 1e6, 1e6), new THREE.Vector3(1e6, 1e6, 1e6)] },
          uHLDir:   { value: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)] },
          uHLColor: { value: new THREE.Color(1.0, 0.92, 0.76) },
          uHLParams:{ value: new THREE.Vector4(0.974, 0.866, 40.0, 0.0) } };

      /* ---- optional true-GPU frame-time readout (perf-instrumentation lane) ----
         OFF by default so the standard headless suite renders byte-identical pixels and pays
         zero cost. Opt in with ?gpums (or ?gpu / window.SHOW_GPU_MS=true) to get an on-screen
         "GPU x.x ms" HUD. When EXT_disjoint_timer_query_webgl2 is present we bracket the frame's
         GL command stream with a TIME_ELAPSED query for real GPU time; otherwise we fall back to
         a CPU-side per-frame wall-clock interval (labelled so the number is never mistaken for
         GPU time). Timer queries draw nothing — enabling this never changes a pixel. */
      this.gpuMs = null;               // last GPU (or fallback CPU) frame time, ms; null until warm
      this.gpuBackend = null;          // 'gpu-timer' | 'cpu-fallback' — resolved lazily at warm-up
      let en = false;
      try { en = /[?&](gpums|gpu)\b/i.test(global.location ? global.location.search : '') ||
                 !!global.SHOW_GPU_MS; } catch (e) { /* no location (headless worker) */ }
      this._gpuEnabled = en;
      this._gpu = null;                // lazily-built { gl, ext, open, pending[], free[] }
      this._gpuHud = null;             // lazily-built HUD DOM node
      this._gpuFrameT0 = 0;            // CPU-fallback frame-interval clock
      this._timerSampleId = 0;
      this.timerSample = null;          // raw, explicitly-labelled sample for endurance tooling
      this.gpuTimerSample = null;       // genuine GPU samples only; never populated by fallback
    }

    /* Public runtime toggle so the HUD can be flipped from the console (terrain.showGpuMs(true)). */
    showGpuMs(on) {
      this._gpuEnabled = on !== false;
      if (!this._gpuEnabled && this._gpuHud) this._gpuHud.style.display = 'none';
    }

    /* One-time init of the timer-query machinery. Returns false (→ CPU fallback) unless the
       context is WebGL2 AND exposes EXT_disjoint_timer_query_webgl2. */
    _gpuInit() {
      if (this._gpu) return this._gpu.ext != null;
      const gl = this.renderer.getContext();
      let ext = null;
      try {
        if (this.renderer.capabilities.isWebGL2)
          ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      } catch (e) { ext = null; }
      this._gpu = { gl, ext, open: false, pending: [], free: [] };
      this.gpuBackend = ext ? 'gpu-timer' : 'cpu-fallback';
      return ext != null;
    }

    /* Called once at the very top of update(). Closes the query opened at the top of the PREVIOUS
       update (its bracket therefore spans exactly one full frame — the intervening renderer.render
       is the only GL that draws), harvests any finished results into this.gpuMs, then opens a fresh
       query for the frame about to run. Disjoint samples are discarded; at most a few queries are
       ever in flight. Never throws into the render loop. */
    _gpuTimerTick() {
      if (!this._gpuEnabled) return;
      // CPU-fallback clock always ticks (also the value shown when no timer ext):
      const now = performance.now();
      const frameMs = this._gpuFrameT0 ? now - this._gpuFrameT0 : 0;
      this._gpuFrameT0 = now;
      if (!this._gpuInit()) {                       // no GPU timer → show frame interval (CPU)
        if (frameMs > 0 && frameMs < 1000) {
          this.gpuMs = this.gpuMs == null ? frameMs : this.gpuMs + (frameMs - this.gpuMs) * 0.15;
          const labeled = global.GT_TERRAIN_TELEMETRY.labelTimerSample(
            ++this._timerSampleId, 'cpu-fallback', frameMs);
          this.timerSample = labeled.sample; this.gpuTimerSample = labeled.gpuSample;
        }
        this._gpuUpdateHud();
        return;
      }
      const g = this._gpu, gl = g.gl, T = g.ext.TIME_ELAPSED_EXT;
      try {
        if (g.open) { gl.endQuery(T); g.open = false; }   // close previous frame's bracket
        const disjoint = gl.getParameter(g.ext.GPU_DISJOINT_EXT);
        while (g.pending.length) {                          // harvest in FIFO order
          const q = g.pending[0];
          if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          g.pending.shift();
          if (!disjoint) {
            const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;   // ns → ms
            this.gpuMs = this.gpuMs == null ? ms : this.gpuMs + (ms - this.gpuMs) * 0.15;
            const labeled = global.GT_TERRAIN_TELEMETRY.labelTimerSample(
              ++this._timerSampleId, 'gpu-timer', ms);
            this.timerSample = labeled.sample; this.gpuTimerSample = labeled.gpuSample;
          }
          g.free.push(q);
        }
        if (g.pending.length < 4) {                         // open this frame's bracket
          const q = g.free.pop() || gl.createQuery();
          gl.beginQuery(T, q);
          g.open = true;
          g.pending.push(q);
        }
      } catch (e) {                                         // any GL hiccup → drop to CPU fallback
        this._gpu.ext = null; this.gpuBackend = 'cpu-fallback';
      }
      this._gpuUpdateHud();
    }

    /* Minimal opt-in HUD, built lazily on first enabled frame. Bottom-left, does not overlap the
       existing top stats block, and never created unless the user asked for it (so screenshots
       stay clean by default). */
    _gpuUpdateHud() {
      if (typeof document === 'undefined' || !document.body) return;
      if (!this._gpuHud) {
        const d = document.createElement('div');
        d.id = 'gpums';
        d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;font:12px/1.35 ' +
          'ui-monospace,Menlo,monospace;color:#cfe;background:rgba(0,0,0,.45);padding:3px 7px;' +
          'border-radius:4px;pointer-events:none;white-space:pre';
        document.body.appendChild(d);
        this._gpuHud = d;
      }
      this._gpuHud.style.display = this._gpuEnabled ? 'block' : 'none';
      if (!this._gpuEnabled) return;
      const v = this.gpuMs == null ? '—' : this.gpuMs.toFixed(2);
      const label = this.gpuBackend === 'gpu-timer' ? 'GPU' : 'frame(cpu)';
      this._gpuHud.textContent = `${label} ${v} ms` +
        (this.gpuMs ? `  ~${Math.round(1000 / this.gpuMs)} fps` : '');
    }

    /* Bake a seamless, tiling value-noise / fBm atlas ONCE at boot so the terrain fragment shader
       reads ground detail + cloud-shadow noise from a few texture fetches instead of evaluating
       ~17 sin-based value-noise octaves per pixel every frame. 512x512 RGBA8, RepeatWrapping.
       Channels reproduce terrain-shaders.js's old recipes so the look is unchanged:
         R,B = 1-octave value noise (decorrelated seeds; R general, B is warp.y)
         G   = 5-octave fBm, fbmSky recipe (lacunarity 2.13) — cloud shadows
         A   = 2-octave fBm matching the near-field grain (freq ratio 2.246, weights 0.6/0.4)
       The atlas holds N=64 base lattice cells across its [0,1) uv, so shader sites read
       texture2D(uNoise, X/64) to reproduce the old vnoise(X). Every octave uses an integer
       (period-exact) lattice count so the atlas tiles with no visible seam under REPEAT wrap. */
    _buildNoiseAtlas() {
      const R = 512, N = 64;
      const hash2 = (ix, iy, seed) => {
        let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
        h ^= h >>> 16;
        return (h >>> 0) / 4294967295;
      };
      // tiling value noise with integer period `cells` (smoothstep interpolation, as the old vnoise)
      const tv = (x, y, cells, seed) => {
        const ix = Math.floor(x), iy = Math.floor(y);
        let fx = x - ix, fy = y - iy;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const w = a => ((a % cells) + cells) % cells;
        const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
        const h00 = hash2(x0, y0, seed), h10 = hash2(x1, y0, seed);
        const h01 = hash2(x0, y1, seed), h11 = hash2(x1, y1, seed);
        return (h00 + (h10 - h00) * fx) * (1 - fy) + (h01 + (h11 - h01) * fx) * fy;
      };
      const oct = 5, lac = 2.13;
      const Nk = [];                              // per-octave lattice counts, rounded → period-exact
      for (let k = 0; k < oct; k++) Nk.push(Math.round(N * Math.pow(lac, k)));
      const Ng2 = Math.round(N * 2.246);          // grain 2nd-octave lattice
      const data = new Uint8Array(R * R * 4);
      const q = v => Math.max(0, Math.min(255, (v * 255 + 0.5) | 0));
      for (let j = 0; j < R; j++) {
        for (let i = 0; i < R; i++) {
          const cx = (i / R) * N, cy = (j / R) * N;
          const r = tv(cx, cy, N, 0);
          const b = tv(cx, cy, N, 1);
          let g = 0, a = 0.5;
          for (let k = 0; k < oct; k++) {
            const s = Nk[k] / N;                  // effective freq ≈ 2.13^k, period-exact
            g += a * tv(cx * s, cy * s, Nk[k], 10 + k);
            a *= 0.5;
          }
          const s2 = Ng2 / N;
          const grain = tv(cx, cy, N, 20) * 0.6 + tv(cx * s2, cy * s2, Ng2, 21) * 0.4;
          const o = (j * R + i) * 4;
          data[o] = q(r); data[o + 1] = q(g); data[o + 2] = q(b); data[o + 3] = q(grain);
        }
      }
      const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      return tex;
    }

    /* Bake a small tiling rocky detail-normal texture ONCE at boot (deterministic, no download,
       256 KB). Heightfield = 4-octave RIDGED tiling value noise — integer lattice counts per
       octave so the map wraps seamlessly under REPEAT; the abs-fold creases the field into
       crag-like ridges instead of soft bumps. RG encodes the world-XZ height-gradient (0.5 =
       flat), normalized so the strongest crease uses the full byte range; actual perturbation
       strength lives in the shader. The terrain fragment samples this ONLY on steep, near
       fragments (see the rock micro-relief block in terrain-shaders.js). Mipmapped (POT), so
       minification averages RG back toward 0.5 = flat — distant rock fades smooth, no shimmer. */
    _buildDetailNormal() {
      const R = 256;
      const hash2 = (ix, iy, seed) => {
        let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
        h ^= h >>> 16;
        return (h >>> 0) / 4294967295;
      };
      const tv = (x, y, cells, seed) => {          // tiling value noise, period = cells
        const ix = Math.floor(x), iy = Math.floor(y);
        let fx = x - ix, fy = y - iy;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const w = a => ((a % cells) + cells) % cells;
        const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
        const h00 = hash2(x0, y0, seed), h10 = hash2(x1, y0, seed);
        const h01 = hash2(x0, y1, seed), h11 = hash2(x1, y1, seed);
        return (h00 + (h10 - h00) * fx) * (1 - fy) + (h01 + (h11 - h01) * fx) * fy;
      };
      const cellsK = [5, 11, 23, 47];              // co-prime-ish → octaves never align
      const hgt = new Float32Array(R * R);
      for (let j = 0; j < R; j++) {
        const v = j / R;
        for (let i = 0; i < R; i++) {
          const u = i / R;
          let s = 0, a = 0.5;
          for (let k = 0; k < 4; k++) {
            const c = cellsK[k];
            const r = 1 - Math.abs(2 * tv(u * c, v * c, c, 30 + k) - 1);  // ridged fold
            s += a * r * r;                        // squaring sharpens the creases
            a *= 0.5;
          }
          hgt[j * R + i] = s;
        }
      }
      // central-difference gradient with wrap. Normalize by the 92nd-percentile |gradient|
      // (NOT the max — a single extreme crease would squash the typical slope toward the
      // flat-encode midpoint and the whole map would read as nearly smooth). Deterministic.
      const gx = new Float32Array(R * R), gz = new Float32Array(R * R);
      const mags = new Float32Array(R * R);
      for (let j = 0; j < R; j++) {
        const jm = (j + R - 1) % R, jp = (j + 1) % R;
        for (let i = 0; i < R; i++) {
          const im = (i + R - 1) % R, ip = (i + 1) % R;
          const o = j * R + i;
          gx[o] = hgt[j * R + ip] - hgt[j * R + im];
          gz[o] = hgt[jp * R + i] - hgt[jm * R + i];
          mags[o] = Math.max(Math.abs(gx[o]), Math.abs(gz[o]));
        }
      }
      mags.sort();
      const p92 = mags[(R * R * 0.92) | 0];
      const sc = p92 > 0 ? 0.5 / p92 : 0;
      const clamp05 = v2 => Math.max(-0.5, Math.min(0.5, v2));
      const data = new Uint8Array(R * R * 4);
      const q = v2 => Math.max(0, Math.min(255, ((v2 + 0.5) * 255 + 0.5) | 0));
      for (let o = 0; o < R * R; o++) {
        data[o * 4] = q(clamp05(gx[o] * sc));
        data[o * 4 + 1] = q(clamp05(gz[o] * sc));
        data[o * 4 + 2] = 128;
        data[o * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    }

    /* Bake a small tiling CLASS-DETAIL ALBEDO atlas ONCE at boot (deterministic, 256 KB, no
       download — chosen over CC0 photo tiles: zero storage/licensing and the fields are baked
       period-exact so REPEAT wrap is seamless). One RGBA texture = four ground materials as
       luma-modulation fields; the fragment shader picks a channel by NLCD landcover class and
       overlays it on the NAIP base color within ~140 m (terrain-shaders.js near-field block):
         R = dry grass / sage stipple (fine 2-octave noise, clump-biased)
         G = forest litter / duff (blobby patches + ridged twig/needle creases)
         B = gravel scree (tiling Worley stones: per-stone brightness, dark crevices)
         A = snow grain (very fine, low contrast)
       Every channel is renormalized to mean exactly 0.5 (= no-op overlay), so mipmaps average
       back to identity and the detail self-fades under minification with no color drift. */
    _buildDetailAlbedo() {
      const R = 256;
      const hash2 = (ix, iy, seed) => {
        let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
        h ^= h >>> 16;
        return (h >>> 0) / 4294967295;
      };
      const tv = (x, y, cells, seed) => {          // tiling value noise, period = cells
        const ix = Math.floor(x), iy = Math.floor(y);
        let fx = x - ix, fy = y - iy;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const w = a => ((a % cells) + cells) % cells;
        const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
        const h00 = hash2(x0, y0, seed), h10 = hash2(x1, y0, seed);
        const h01 = hash2(x0, y1, seed), h11 = hash2(x1, y1, seed);
        return (h00 + (h10 - h00) * fx) * (1 - fy) + (h01 + (h11 - h01) * fx) * fy;
      };
      // tiling Worley (period `cells`): F1/F2 distances + a stable per-stone id
      const worley = (x, y, cells, seed) => {
        const ix = Math.floor(x), iy = Math.floor(y);
        let f1 = 9, f2 = 9, id = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const cx = ix + di, cy = iy + dj;
          const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
          const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 1);
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          if (d < f1) { f2 = f1; f1 = d; id = hash2(wx, wy, seed + 2); }
          else if (d < f2) f2 = d;
        }
        return [Math.sqrt(f1), Math.sqrt(f2), id];
      };
      const ch = [new Float32Array(R * R), new Float32Array(R * R),
                  new Float32Array(R * R), new Float32Array(R * R)];
      for (let j = 0; j < R; j++) {
        const v = j / R;
        for (let i = 0; i < R; i++) {
          const u = i / R, o = j * R + i;
          // R: dry grass — fine sharpened stipple; a 7-cell clump field biases patches
          ch[0][o] = (tv(u * 53, v * 53, 53, 40) - 0.5) * 0.60
                   + (tv(u * 97, v * 97, 97, 41) - 0.5) * 0.42
                   + (tv(u * 7, v * 7, 7, 42) - 0.5) * 0.30;
          // G: forest duff — blobby litter patches, dark ridged twig/needle creases, fine chaff
          const twig = 1 - Math.abs(2 * tv(u * 31, v * 31, 31, 51) - 1);
          ch[1][o] = (tv(u * 13, v * 13, 13, 50) - 0.5) * 0.36
                   - twig * twig * 0.30
                   + (tv(u * 67, v * 67, 67, 52) - 0.5) * 0.24;
          // B: scree — Worley stones (10 cells over the ~3.5 m repeat → ~35 cm talus blocks):
          // flat per-stone shade, crevices darken toward boundaries
          const [f1, f2, id] = worley(u * 10, v * 10, 10, 60);
          const crev = Math.min(1, (f2 - f1) * 3.0);            // 0 on stone boundaries
          ch[2][o] = (0.30 + 0.50 * id) * (0.50 + 0.50 * crev)
                   + (tv(u * 83, v * 83, 83, 61) - 0.5) * 0.18;
          // A: snow grain — fine wind texture + soft ridged drift lines (not dirt: the
          // shader also halves its strength vs the other materials)
          const drift = 1 - Math.abs(2 * tv(u * 17, v * 17, 17, 72) - 1);
          ch[3][o] = (tv(u * 101, v * 101, 101, 70) - 0.5) * 0.34
                   + (tv(u * 43, v * 43, 43, 71) - 0.5) * 0.20
                   - drift * drift * 0.16;
        }
      }
      const data = new Uint8Array(R * R * 4);
      const q = x => Math.max(0, Math.min(255, (x * 255 + 0.5) | 0));
      for (let c = 0; c < 4; c++) {                // renormalize each field to mean 0.5
        let m = 0;
        for (let o = 0; o < R * R; o++) m += ch[c][o];
        m /= R * R;
        for (let o = 0; o < R * R; o++) data[o * 4 + c] = q(ch[c][o] - m + 0.5);
      }
      const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    }

    /* ================= init ================= */
    async init() {
      this.baseUrl = this.o.manifestUrl.replace(/[^/]+$/, '');
      this.m = await (await fetch(this.o.manifestUrl)).json();
      const gt = this.m.geoTransform;
      this.cE = this.m.world.centerEasting; this.cN = this.m.world.centerNorthing;
      this.datum = this.m.world.datum;
      this.px = gt[1];
      this.spanX = this.m.width * this.px; this.spanZ = this.m.height * this.px;
      this.enc = this.m.encoding;
      this.rootSpan = this.m.tileSize * Math.pow(2, this.m.maxZoom) * this.px;
      this.maxDepth = this.m.maxZoom;

      if (this._visibilityEnabled && this.m.geometricError?.url) {
        try {
          const response = await fetch(this.baseUrl + this.m.geometricError.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parser = global.GT_TERRAIN_VISIBILITY?.parseTerrainErrorPyramid;
          if (!parser) throw new Error('visibility contract unavailable');
          const errorBuffer = await response.arrayBuffer();
          const errors = parser(errorBuffer);
          this._terrainErrorBytes = errorBuffer.byteLength;
          if (errors.levels.length <= this.m.maxZoom)
            throw new Error('missing terrain zoom levels');
          for (let z = 0; z <= this.m.maxZoom; z++) {
            const [nx, ny] = this.tilesAtZoom(z), level = errors.levels[z];
            if (level.nx !== nx || level.ny !== ny)
              throw new Error(`z${z} dimensions ${level.nx}x${level.ny} != ${nx}x${ny}`);
          }
          this._terrainErrors = errors;
          this._terrainErrorStatus = 'ready';
        } catch (error) {
          this._terrainErrorStatus = `fallback: ${error?.message || error}`;
          console.warn('[terrain] geometric-error metadata unavailable; using legacy SSE.', error);
        }
      } else if (this._visibilityEnabled) this._terrainErrorStatus = 'fallback: not declared';

      // optional imagery pyramid (same grid family)
      this.img = null;
      try {
        const im = await (await fetch(this.baseUrl + 'imagery.json')).json();
        const rs = im.tileSize * Math.pow(2, im.maxZoom) * im.nativePixelSize;
        if (Math.abs(rs - this.rootSpan) > 1)
          console.warn('[terrain] imagery grid family mismatch', rs, this.rootSpan);
        else { this.img = im; this.maxDepth = Math.max(this.maxDepth, im.maxZoom); }
      } catch (e) { /* no imagery baked yet — procedural palette */ }

      // The instanced path is a capability-gated storage/submission replacement only. Allocation
      // happens before base loading, so a driver/limit failure cleanly retains the legacy per-tile
      // texture path without partially converting cache entries.
      const arrays = global.GT_TERRAIN_ARRAYS;
      if (arrays?.createTerrainTextureArrayPool && this.img) {
        this._batchSupport = arrays.createTerrainTextureArrayPool(this.renderer, {
          heightTileSize: this.m.tileSize,
          imageryTileSize: this.img.tileSize,
          heightCapacity: this.o.heightArrayLayers,
          imageryCapacity: this.o.imageryArrayLayers,
          minHeightLayers: this.o.heightArrayLayers,
          minImageryLayers: this.o.imageryArrayLayers,
          onEvict: (kind, record) => this._arrayLayerEvicted(kind, record),
        });
        this.arrayPool = this._batchSupport.pool;
      } else {
        this._batchSupport = { supported: false, reason: this.img ? 'missing-array-module' : 'no-imagery' };
      }
      this._batched = !!(this.arrayPool && global.TerrainShaders?.batch && global.GT_TERRAIN_BATCH);
      if (this.arrayPool && !this._batched) {
        this.arrayPool.dispose(); this.arrayPool = null;
        this._batchSupport = { supported: false, reason: 'missing-batch-shader' };
      }

      // optional horizon-shadow maps
      try { await this._loadHorizon(); } catch (e) { /* no shadows baked yet */ }

      // optional baked sky-visibility AO (couloir/gully ambient depth; bake_ao.py)
      try { await this._loadAO(); } catch (e) { /* no AO baked yet */ }

      // optional baked road SDF (one texture fetch in the fragment path stamps the roads)
      try { await this._loadRoads(); } catch (e) { /* no roads baked — app runs without them */ }

      // optional landcover class mask (class-aware near-field ground detail)
      try { await this._loadLandcoverTex(); } catch (e) { /* no landcover baked — detail off */ }

      if (this.o.fog && this.scene.fog) {
        this.scene.fog.near = this.o.fog.near; this.scene.fog.far = this.o.fog.far;
      }
      if (this.camera.far < 30000) { this.camera.far = 30000; this.camera.updateProjectionMatrix(); }

      await this._loadBaseCollision();
      // Persistent collision sources are also the guaranteed GPU ancestor fallback. Make their
      // layers ready before init resolves rather than waiting for the first animation frame.
      if (this._batched) this._pumpUploads(this.uploadQueue.length);
      if (this.img) await this._loadBaseImagery();
      return this;
    }

    async _loadHorizon() {
      const meta = await (await fetch(this.baseUrl + 'horizon.json')).json();
      const load = url => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const t = new THREE.Texture(img);
          t.flipY = false; t.minFilter = t.magFilter = THREE.LinearFilter;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
          res(t);
        };
        img.onerror = () => rej(new Error('horizon map failed'));
        img.src = this.baseUrl + url;
      });
      this.horizonTex = await Promise.all([load(meta.urlA), load(meta.urlB)]);
      this.horizonMaxAngle = (meta.maxAngleDeg || 60) * Math.PI / 180;
    }

    /* ao.png: single-channel baked sky visibility over the park extent (same world->uv mapping
       as the horizon maps: uWorldMin/uWorldInv). Linear + ClampToEdge, no flipY (PNG row 0 =
       DEM row 0 = min world Z, matching the horizon bake convention). */
    async _loadAO() {
      const meta = await (await fetch(this.baseUrl + 'ao.json')).json();
      this.aoTex = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const t = new THREE.Texture(img);
          t.flipY = false; t.minFilter = t.magFilter = THREE.LinearFilter;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
          res(t);
        };
        img.onerror = () => rej(new Error('ao map failed'));
        img.src = this.baseUrl + meta.url;
      });
    }

    /* landcover.png: R = NLCD class code (same file Landcover.js decodes on the CPU; this GPU
       copy drives class-aware near-field ground detail). Manually subsampled to HALF res and
       the R channel only — canvas scaling would INTERPOLATE class codes (a 42|52 border blends
       to a phantom 47), and a full-res RGBA upload would cost ~46 MB of VRAM for 10 m codes the
       shader jitters by ±4.5 m anyway. NEAREST + no mipmaps for the same never-interpolate
       reason. Row 0 = max northing = min world z (no flipY on DataTexture), and its world
       extent (uLCMin/uLCInv) is its own — NOT the park/horizon extent (uWorldMin). */
    async _loadLandcoverTex() {
      const meta = await (await fetch(this.baseUrl + 'landcover.json')).json();
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('landcover.png failed'));
        im.src = this.baseUrl + meta.url;
      });
      const cv = document.createElement('canvas');
      cv.width = meta.width; cv.height = meta.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, meta.width, meta.height).data;
      const W = meta.width >> 1, H = meta.height >> 1;
      const out = new Uint8Array(W * H);
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++)
          out[j * W + i] = src[(j * 2 * meta.width + i * 2) * 4];
      const t = new THREE.DataTexture(out, W, H, THREE.RedFormat, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.lcTex = t;
      const w = meta.world;
      this.lcMap = {   // full-image span: texel k of the half-res copy covers source pixel 2k
        min: new THREE.Vector2(meta.originE - w.centerEasting, w.centerNorthing - meta.originN),
        inv: new THREE.Vector2(1 / (meta.width * meta.res), 1 / (meta.height * meta.res)),
      };
    }

    /* roads.png: R = distance-to-centerline SDF (0..255 → 0..40 m), G = class. Linear +
       ClampToEdge, NO flipY (PNG row 0 = originZ = min world Z = uv.y 0, same convention as the
       imagery), no mipmaps (NPOT, and we want a crisp SDF read). roads-meta.json gives the exact
       world→uv mapping: u = (worldX - originX) / (width*res), v = (worldZ - originZ) / (height*res). */
    async _loadRoads() {
      const meta = await (await fetch(this.baseUrl + 'roads-meta.json')).json();
      const tex = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const t = new THREE.Texture(img);
          t.flipY = false;
          t.minFilter = t.magFilter = THREE.LinearFilter;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
          t.generateMipmaps = false;
          t.needsUpdate = true;
          res(t);
        };
        img.onerror = () => rej(new Error('roads.png failed'));
        img.src = this.baseUrl + 'roads.png';
      });
      const spanX = meta.width * meta.res, spanZ = meta.height * meta.res;
      this.roadsTex = tex;
      this.roadsMap = {
        origin: new THREE.Vector2(meta.originX, meta.originZ),
        inv: new THREE.Vector2(1 / spanX, 1 / spanZ),
      };
    }

    /* ================= grid math ================= */
    spanAt(z) { return this.rootSpan / Math.pow(2, z); }

    // does this node's xz-box overlap the core-range fidelity box?
    _overlapsCore(b) {
      const c = this.o.coreBox;
      if (!c) return false;
      return b.minX < c.maxX && b.minX + b.wpt > c.minX &&
             b.minZ < c.maxZ && b.minZ + b.hpt > c.minZ;
    }
    // effective pixelError for a node: reduced (finer subdivision) inside the core box, global
    // elsewhere. The SAME value feeds the SSE subdivision test AND the geomorph handoff so the
    // node's ring math stays coherent. Inside the box it is a per-frame CONSTANT (this._pixelError
    // is uniform, _coreRatio is fixed), so the cascade is self-consistent exactly as it is globally.
    _pixelErrorAt(b) {
      return this._overlapsCore(b) ? this._pixelError * this._coreRatio : this._pixelError;
    }
    /* Both are pure functions of (z,x,y) and are called thousands of times per frame by the
       quadtree traversal, the 2:1 balance fixpoint and the edge-stitch lookups. Memoised so the
       per-frame walk stops minting a 2-element array and a bounds object per visit. Results are
       treated as read-only by every caller (bounds is only ever read: minX/minZ/size/wpt/hpt). */
    tilesAtZoom(z) {
      const memo = this._tilesAtZoom || (this._tilesAtZoom = []);
      let hit = memo[z];
      if (!hit) {
        const s = this.spanAt(z);
        hit = memo[z] = [Math.ceil(this.spanX / s), Math.ceil(this.spanZ / s)];
      }
      return hit;
    }
    tileWorldBounds(z, x, y) {
      const memo = this._boundsMemo || (this._boundsMemo = new Map());
      const key = this._tileKey(z, x, y);
      let hit = memo.get(key);
      if (!hit) {
        const s = this.spanAt(z);
        hit = { minX: -this.spanX / 2 + x * s, minZ: -this.spanZ / 2 + y * s, size: s, wpt: s, hpt: s };
        memo.set(key, hit);
      }
      return hit;
    }
    // Collision-free integer tile key. maxZoom is 7 here and the deepest grid is 45x65 tiles, so
    // 2^12 per axis is ample headroom; the product stays far inside Number.MAX_SAFE_INTEGER.
    _tileKey(z, x, y) { return (z * 4096 + x) * 4096 + y; }

    /* ================= decode / textures ================= */
    // valid data texels of tile (z,x,y) before raster-edge padding starts (512 = fully valid)
    _validTexels(z, x, y) {
      const S = this.m.tileSize, b = this.tileWorldBounds(z, x, y);
      const f = v => Math.max(1, Math.min(S, Math.round(v * S)));
      return [f((this.spanX / 2 - b.minX) / b.size), f((this.spanZ / 2 - b.minZ) / b.size)];
    }

    _decodeHeight(bmp, z, x, y) {
      const S = this.m.tileSize;
      const cv = (this._cv ||= new OffscreenCanvas(S, S));
      const ctx = (this._ctx ||= cv.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(bmp, 0, 0, S, S);
      const data = ctx.getImageData(0, 0, S, S).data;
      const out = new Float32Array(S * S);
      const b = this.enc.baseval, iv = this.enc.interval, d = this.datum;
      const floor = this.m.elevation.min - d;
      for (let p = 0, q = 0; p < data.length; p += 4, q++) {
        out[q] = data[p + 3] < 128 ? floor
          : b + (data[p] * 65536 + data[p + 1] * 256 + data[p + 2]) * iv - d;
      }
      // raster-edge tiles: replace the baked floor-value padding by edge replication, so
      // GPU filtering/geomorph lattices and CPU heightAt never fall off a fake cliff
      const [vx, vy] = this._validTexels(z, x, y);
      if (vx < S) for (let j = 0; j < S; j++) {
        const v = out[j * S + vx - 1];
        for (let i = vx; i < S; i++) out[j * S + i] = v;
      }
      if (vy < S) {
        const src = (vy - 1) * S;
        for (let j = vy; j < S; j++) out.copyWithin(j * S, src, src + S);
      }
      return out;
    }

    async _decodeHeightAsync(bmp, z, x, y, priority) {
      if (!this.workerPool) return this._decodeHeight(bmp, z, x, y);
      const [validX, validY] = this._validTexels(z, x, y);
      const reply = await this.workerPool.run('decodeHeight', {
        bitmap: bmp, size: this.m.tileSize, encoding: this.enc, datum: this.datum,
        elevationMin: this.m.elevation.min, validX, validY,
      }, {
        generation: this.generation, priority: -priority, scope: 'terrain',
        transfer: [bmp],
      });
      return new Float32Array(reply.buffers[0]);
    }

    _heightTexture(decoded) {
      const S = this.m.tileSize;
      const tex = new THREE.DataTexture(decoded, S, S, THREE.RedFormat, THREE.FloatType);
      if (this._floatLinear === undefined)
        this._floatLinear = !!this.renderer.getContext().getExtension('OES_texture_float_linear');
      tex.minFilter = tex.magFilter = this._floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      return tex;
    }

    async _prepareImageryAsync(url, z, x, y, priority) {
      if (!this.workerPool) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`imagery HTTP ${response.status}`);
        const blob = await response.blob();
        return { bitmap: await createImageBitmap(blob), prepared: false,
          downloadedBytes: blob.size };
      }
      const [validX, validY] = this._validTexels(z, x, y);
      const reply = await this.workerPool.run('fetchImagery', {
        // Worker-relative fetch URLs resolve against cpu-worker.js, not the document.
        url: new URL(url, document.baseURI).href,
        size: this.img.tileSize, validX, validY,
      }, {
        generation: this.generation, priority: -priority, scope: 'terrain',
      });
      this._streamStats.imageryPrepared++;
      return { bitmap: reply.buffers[0], prepared: true,
        downloadedBytes: Number(reply.meta?.downloadedBytes) || 0 };
    }

    _imageryTexture(bmp, z, x, y, prepared, onUploaded) {
      let img = bmp;
      // raster-edge tiles: smear the last valid column/row across the neutral-grey padding —
      // a sampling clamp alone can't stop MIPMAPS from blending the grey into edge fragments
      const S = this.img.tileSize;
      const [vx, vy] = this._validTexels(z, x, y);   // same grid family as heights
      if (!prepared && (vx < S || vy < S)) {
        const cv = new OffscreenCanvas(S, S);
        const ctx = cv.getContext('2d');
        ctx.drawImage(bmp, 0, 0, S, S);
        if (vx < S) ctx.drawImage(cv, vx - 1, 0, 1, S, vx, 0, S - vx, S);
        if (vy < S) ctx.drawImage(cv, 0, vy - 1, S, 1, 0, vy, S, S - vy);
        img = cv;
      }
      const tex = new THREE.Texture(img);
      tex.flipY = false;                       // row 0 = north, matches uv.y=0 = minZ
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      // high anisotropy: standing in the valley means extreme grazing angles on the flats
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      // Three keeps Texture.image after upload, which otherwise pins every decoded ImageBitmap
      // (or edge-fix OffscreenCanvas) in CPU memory for the lifetime of the cache entry. onUpdate
      // runs only after WebGL has consumed the source, so it is safe to release at that boundary.
      tex.onUpdate = () => {
        bmp?.close?.();
        tex.image = null;
        tex.onUpdate = null;
        onUploaded?.();
      };
      tex.needsUpdate = true;
      return tex;
    }

    /* ================= fetch pipeline ================= */
    // Bulk height+imagery tiles may live off-origin (Cloudflare R2) to keep the repo/deploy lean.
    // window.GT_TILE_CDN (a base URL ending in '/', matching the manifest's tiles/… imagery/… layout)
    // overrides baseUrl for these two only; unset → same-origin baseUrl (local dev unchanged).
    // Small baked assets (ao/roads/landcover/horizon + manifests) always stay on baseUrl.
    _tileBase() { return (typeof window !== 'undefined' && window.GT_TILE_CDN) || this.baseUrl; }
    _urlH(z, x, y) { return this._tileBase() + this.m.url.replace('{z}', z).replace('{x}', x).replace('{y}', y); }
    _urlI(z, x, y) { return this._tileBase() + this.img.url.replace('{z}', z).replace('{x}', x).replace('{y}', y); }

    _reqHeight(z, x, y, priority) {
      const key = `${z}/${x}/${y}`;
      let e = this.hCache.get(key);
      if (e) {
        this._requestCounters.height.hits++;
        e.lastUsed = this.frame;
        if (e.state === 'decoded') this._queueUpload(e);
        return e;
      }
      this._requestCounters.height.misses++;
      e = {
        kind: 'h', key, z, x, y, state: 'queued', lastUsed: this.frame, priority,
        generation: this.generation, persistent: z <= (this._persistentHeightMaxZ ?? -1),
      };
      this.hCache.set(key, e);
      this.fetchQueue.push(e);
      return e;
    }
    _reqImagery(z, x, y, priority) {
      if (!this.img) return null;
      const key = `${z}/${x}/${y}`;
      let e = this.iCache.get(key);
      if (e) { this._requestCounters.imagery.hits++; e.lastUsed = this.frame; return e; }
      this._requestCounters.imagery.misses++;
      e = { kind: 'i', key, z, x, y, state: 'queued', lastUsed: this.frame,
            priority: priority * 0.9, generation: this.generation }; // imagery slightly outranks heights
      this.iCache.set(key, e);
      this.fetchQueue.push(e);
      return e;
    }

    _pumpFetches() {
      this.fetchQueue.sort((a, b) => a.priority - b.priority);
      while (this.inFlight < this.o.maxConcurrentFetch && this.fetchQueue.length) {
        const e = this.fetchQueue.shift();
        if (e.state !== 'queued' || e.generation !== this.generation) continue;
        e.state = 'loading'; e.abort = new AbortController(); this.inFlight++;
        const url = e.kind === 'h' ? this._urlH(e.z, e.x, e.y) : this._urlI(e.z, e.x, e.y);
        const load = e.kind === 'i'
          ? this._prepareImageryAsync(url, e.z, e.x, e.y, e.priority)
          : fetch(url, { signal: e.abort.signal })
              .then(r => r.ok ? r.blob() : Promise.reject(r.status))
              .then(blob => createImageBitmap(blob)
                .then(bitmap => ({ bitmap, prepared: false, downloadedBytes: blob.size })));
        load
          .then(async result => {
            const bmp = result.bitmap;
            e.prepared = result.prepared;
            const counters = e.kind === 'h' ? this._requestCounters.height :
              this._requestCounters.imagery;
            counters.downloadedBytes += Number(result.downloadedBytes) || 0;
            if (e.kind === 'h') {
              e.decoded = await this._decodeHeightAsync(bmp, e.z, e.x, e.y, e.priority);
              this._mirrorHeightTile(e);
              this._streamStats.heightDecoded++;
            } else e.bmp = bmp;
            if (e.generation !== this.generation) {
              e.bmp?.close?.();
              this._streamStats.stale++;
              return;
            }
            e.state = 'decoded';
            counters.completions++;
            this._queueUpload(e);
          })
          .catch(error => {
            const counters = e.kind === 'h' ? this._requestCounters.height :
              this._requestCounters.imagery;
            if (error && error.name === 'AbortError') {
              this._streamStats.stale++;
              if (!e._cancellationCounted) counters.cancellations++;
            } else counters.failures++;
            const c = e.kind === 'h' ? this.hCache : this.iCache;
            if (c.get(e.key) === e) c.delete(e.key);
          })
          .finally(() => { this.inFlight--; });
      }
    }

    _pumpUploads(limit = null) {
      const frameMs = global.GT_FRAME_MS || 16.7;
      let n = limit == null
        ? (frameMs > 28 ? 1 : frameMs > 20 ? Math.min(3, this.o.uploadsPerFrame)
                                            : this.o.uploadsPerFrame)
        : limit;
      while (n-- > 0 && this.uploadQueue.length) {
        const e = this.uploadQueue.shift();
        e._uploadQueued = false;
        if (e.state !== 'decoded' || e.generation !== this.generation) {
          e.bmp?.close?.();
          continue;
        }
        try {
        const counters = e.kind === 'h' ? this._requestCounters.height :
          this._requestCounters.imagery;
        const wasUploaded = (e._uploadCount || 0) > 0;
        if (e.kind === 'h') {
          if (this._batched) {
            const ready = this.arrayPool.uploadHeight(e.key, e.decoded, {
              persistent: !!e.persistent,
              protect: e.queryProtected ? 'query' : (e.predictionProtected ? 'prediction' :
                (e.prefetchProtected ? 'prefetch' : null)),
            });
            e.tex = ready.texture; e.layer = ready.layer;
          } else e.tex = this._heightTexture(e.decoded);
        } else {
          const source = e.bmp;
          if (this._batched) {
            const valid = this._validTexels(e.z, e.x, e.y);
            const ready = this.arrayPool.uploadImagery(e.key, source, {
              prepared: e.prepared, validX: valid[0], validY: valid[1],
              persistent: !!e.persistent,
              retainOnCapacity: true,
              protect: e.predictionProtected ? 'prediction' :
                (e.prefetchProtected ? 'prefetch' : null),
            });
            e.tex = ready.texture; e.layer = ready.layer; e.bmp = null;
          } else {
            e.tex = this._imageryTexture(source, e.z, e.x, e.y, e.prepared, () => {
              if (e.bmp === source) e.bmp = null;
            });
          }
        }
        e.state = 'ready';
        e._uploadCount = (e._uploadCount || 0) + 1;
        counters.uploads++;
        if (wasUploaded) counters.reuploads++;
        this._streamStats.uploads++;
        } catch (error) {
          if (error instanceof global.GT_TERRAIN_ARRAYS.TerrainTextureArrayCapacityError) {
            // Current and staged frame references are soft floors. Keep the decoded source queued
            // and render its ready ancestor; the just-published frame normally frees a layer on
            // the next tick. Never evict a protected visible/query/prefetch source for a number.
            e.state = 'decoded'; this._queueUpload(e);
            counters.capacityRetries++;
            continue;
          }
          throw error;
        }
      }
    }

    _queueUpload(e) {
      if (!e || e._uploadQueued) return;
      e._uploadQueued = true; this.uploadQueue.push(e);
    }

    _arrayLayerEvicted(kind, record) {
      this._requestCounters[kind === 'height' ? 'height' : 'imagery'].evictions++;
      const cache = kind === 'height' ? this.hCache : this.iCache;
      const e = cache.get(record.key);
      if (!e || e.layer !== record.layer) return;
      e.tex = null; e.layer = null;
      // Decoded height data can be re-uploaded without a network round-trip. Imagery bitmaps are
      // deliberately released after upload, so its cache record must be requested afresh.
      if (kind === 'height' && e.decoded) {
        e.state = 'decoded';
      } else if (!e.persistent) cache.delete(e.key);
    }

    _publishTelemetry() {
      const now = performance.now();
      if (now - this._telemetryAt < 500) return;
      this._telemetryAt = now;
      const memory = this._memoryEstimate();
      const requests = {
        height: { ...this._requestCounters.height },
        imagery: { ...this._requestCounters.imagery },
      };
      requests.total = global.GT_TERRAIN_TELEMETRY?.mergeCounterKinds?.(requests) || {};
      global.GT_STREAMING = {
        quality: this._quality,
        pixelError: this._pixelError,
        coreFloorZ: this.o.coreFloorZ,
        gridByLOD: this.o.gridByLOD.slice(),
        visibleLeaves: this._visible ? this._visible.length : 0,
        visibleTerrainCoverage: { ...this.visibleTerrainCoverage },
        generation: this.generation,
        fetchQueued: this.fetchQueue.length,
        fetchActive: this.inFlight,
        uploadQueued: this.uploadQueue.length,
        heightCache: this.hCache.size,
        imageryCache: this.iCache.size,
        memory,
        ownership: memory.ownership,
        requests,
        timer: {
          backend: this.gpuBackend || 'uninitialized',
          sample: this.timerSample ? { ...this.timerSample } : null,
          gpuSample: this.gpuTimerSample ? { ...this.gpuTimerSample } : null,
        },
        lod: { ...this._lodStats,
          terrainTriangles: this._batchFrame?.triangles || 0,
          leafCount: this._visible?.length || 0,
        },
        ...this._streamStats,
        workers: this.workerPool ? this.workerPool.snapshot() : null,
        worldIndex: this.worldIndex ? this.worldIndex.snapshot() : null,
        worldHeightMirrors: this._worldHeightMirrors.size,
        worldHeightMirrorMax: this._worldHeightMirrorMax,
        terrainSubmission: this._batched ? {
          mode: 'instanced-array', drawCalls: this._batchFrame?.drawCalls || 0,
          triangles: this._batchFrame?.triangles || 0,
          comparison: this._batchEquivalence,
          reflection: this._reflectionStats,
        } : { mode: 'legacy-mesh', drawCalls: this.meshes.size },
        arrayPool: this.arrayPool?.snapshot?.() || null,
        cpuQueryTiles: this._queryTileKeys?.size || 0,
        visibilityEnvelope: {
          enabled: this._visibilityEnabled,
          compare: this._visibilityCompare,
          errorMetadata: this._terrainErrorStatus,
          mode: this._predictionState?.mode || 'walk',
          horizonSeconds: this._predictionState?.mode === 'fly' ? 1.2 :
            this._predictionState?.mode === 'drive' ? 0.8 : 0.5,
          currentLeaves: this._visible?.length || 0,
          currentTriangles: this._batchFrame?.triangles || 0,
          ...this._visibilityStats,
        },
      };
      this.worldIndex?.refreshMemory();
    }

    _memoryEstimate() {
      let heightCpuBytes = 0, heightGpuBytes = 0, imageryDecodedBytes = 0,
          imageryGpuBytes = 0, reliefMipBytes = 0, rangeMipBytes = 0;
      const ownershipEntries = [];
      const arrayHeightBytes = this.arrayPool?.height?.bytesPerLayer ||
        (this.m?.tileSize || 0) ** 2 * 4;
      const arrayImageryBytes = this.arrayPool?.imagery?.bytesPerLayer ||
        Math.ceil((this.img?.tileSize || 0) ** 2 * 4 * 4 / 3);
      const activeHeight = this.arrayPool?.height?.currentRefs || new Map();
      const activeImagery = this.arrayPool?.imagery?.currentRefs || new Map();
      for (const e of this.hCache.values()) {
        const sourceBytes = e.decoded?.byteLength || 0;
        const reliefBytes = this._typedBytes(e.mip);
        const rangeBytes = this._typedBytes(e.rangeMip);
        const gpuBytes = e.layer != null ? arrayHeightBytes :
          (e.tex && !this._batched ? this.m.tileSize * this.m.tileSize * 4 : 0);
        heightCpuBytes += sourceBytes; reliefMipBytes += reliefBytes; rangeMipBytes += rangeBytes;
        heightGpuBytes += gpuBytes;
        ownershipEntries.push(this._ownershipEntry(e, sourceBytes + reliefBytes + rangeBytes,
          gpuBytes, activeHeight));
      }
      for (const e of this.iCache.values()) {
        const cpuBytes = e.bmp ? this.img.tileSize * this.img.tileSize * 4 : 0;
        const gpuBytes = e.layer != null ? arrayImageryBytes :
          (e.tex && !this._batched ? Math.ceil(this.img.tileSize * this.img.tileSize * 4 * 4 / 3) : 0);
        imageryDecodedBytes += cpuBytes; imageryGpuBytes += gpuBytes;
        ownershipEntries.push(this._ownershipEntry(e, cpuBytes, gpuBytes, activeImagery));
      }
      const arrays = this.arrayPool?.snapshot?.() || null;
      let arrayAllocatedBytes = heightGpuBytes + imageryGpuBytes;
      let arrayResidentBytes = heightGpuBytes + imageryGpuBytes;
      if (arrays) {
        arrayAllocatedBytes = arrays.allocatedGpuBytes;
        arrayResidentBytes = arrays.residentGpuBytes;
      }
      const queryMirrorBytes = [...this._worldHeightMirrors.keys()].reduce((sum, key) =>
        sum + (this.hCache.get(key)?.decoded?.byteLength || 0), 0);
      const errorMetadataBytes = this._terrainErrorBytes || this._typedBytes(this._terrainErrors);
      const otherCpuCacheBytes = this._textureCpuBytes([
        this.noiseTex, this.detailNTex, this.detailATex, this.lcTex,
      ]);
      const sharedGridGeometryBytes = this.grids.reduce((sum, geometry) =>
        sum + this._geometryBytes(geometry), 0);
      const activeInstanceBufferBytes = [...this.batches.values()].reduce((sum, record) =>
        sum + (record.buffer?.array?.byteLength || 0), 0);
      const reflectionInstanceBufferBytes = [...this._reflectionBatches.values()].reduce(
        (sum, record) => sum + (record.buffer?.array?.byteLength || 0), 0);
      const temporaryUploadBytes = arrays?.temporaryUploadBytes || 0;
      const otherTerrainTextureBytes = this._textureGpuBytes([
        this.noiseTex, this.detailNTex, this.detailATex, this.lcTex, this.roadsTex,
        this.horizonTex?.[0], this.horizonTex?.[1], this.aoTex,
      ]);
      const cpuBytes = {
        heightSources: heightCpuBytes, imagerySources: imageryDecodedBytes,
        reliefMips: reliefMipBytes, rangeMips: rangeMipBytes,
        queryMirrors: queryMirrorBytes, errorMetadata: errorMetadataBytes,
        otherCaches: otherCpuCacheBytes,
      };
      cpuBytes.total = Object.values(cpuBytes).reduce((sum, value) => sum + value, 0);
      const gpuBytes = {
        heightArraysAllocated: arrays?.height?.allocatedGpuBytes || heightGpuBytes,
        heightArraysResident: arrays?.height?.residentGpuBytes || heightGpuBytes,
        imageryArraysAllocated: arrays?.imagery?.allocatedGpuBytes || imageryGpuBytes,
        imageryArraysResident: arrays?.imagery?.residentGpuBytes || imageryGpuBytes,
        unusedArrayLayers: Math.max(0, arrayAllocatedBytes - arrayResidentBytes),
        sharedGridGeometry: sharedGridGeometryBytes,
        activeInstanceBuffers: activeInstanceBufferBytes,
        reflectionInstanceBuffers: reflectionInstanceBufferBytes,
        temporaryUploads: temporaryUploadBytes,
        otherTerrainTextures: otherTerrainTextureBytes,
      };
      // Allocation totals include unused layers; resident figures are diagnostic subsets.
      gpuBytes.totalAllocated = arrayAllocatedBytes + sharedGridGeometryBytes +
        activeInstanceBufferBytes + reflectionInstanceBufferBytes + temporaryUploadBytes +
        otherTerrainTextureBytes;
      const ownership = global.GT_TERRAIN_TELEMETRY?.accountTerrainOwnership?.(ownershipEntries) ||
        { inclusive: {}, exclusive: {} };
      const residentTerrainBytes = Object.values(ownership.exclusive)
        .reduce((sum, bucket) => sum + (bucket.totalBytes || 0), 0);
      return {
        heightCpuBytes, heightGpuBytes: arrays?.height?.allocatedGpuBytes || heightGpuBytes,
        imageryDecodedBytes,
        imageryGpuBytes: arrays?.imagery?.allocatedGpuBytes || imageryGpuBytes,
        cpuBytes, gpuBytes, ownership,
        residentTerrainBytes,
        estimatedTerrainBytes: cpuBytes.total + gpuBytes.totalAllocated,
        totalTerrainOwnedBytes: cpuBytes.total + gpuBytes.totalAllocated,
      };
    }

    _ownershipEntry(e, cpuBytes, gpuBytes, activeRefs) {
      return {
        cpuBytes, gpuBytes,
        active: !!activeRefs.get(e.key) || e.lastUsed === this.frame,
        warm: !!e.predictionProtected,
        safety: !!e.prefetchProtected,
        query: !!e.queryProtected,
        persistent: !!e.persistent,
      };
    }

    _typedBytes(value, seen = new Set()) {
      if (!value || typeof value !== 'object' || seen.has(value)) return 0;
      seen.add(value);
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      let bytes = 0;
      for (const child of Object.values(value)) bytes += this._typedBytes(child, seen);
      return bytes;
    }

    _geometryBytes(geometry) {
      let bytes = geometry?.index?.array?.byteLength || 0;
      for (const attribute of Object.values(geometry?.attributes || {}))
        bytes += attribute?.array?.byteLength || 0;
      return bytes;
    }

    _textureCpuBytes(textures) {
      return textures.reduce((sum, texture) =>
        sum + (texture?.image?.data?.byteLength || 0), 0);
    }

    _textureGpuBytes(textures) {
      return textures.reduce((sum, texture) => {
        const image = texture?.image;
        if (!image?.width || !image?.height) return sum;
        const channels = texture.format === THREE.RedFormat ? 1 : 4;
        const component = texture.type === THREE.FloatType ? 4 : 1;
        const mip = texture.generateMipmaps ? 4 / 3 : 1;
        return sum + Math.ceil(image.width * image.height * channels * component * mip);
      }, 0);
    }

    _entryBytes(e) {
      if (!e) return 0;
      if (e.kind === 'h') {
        return (e.decoded?.byteLength || 0) +
          (e.tex && !this._batched ? this.m.tileSize * this.m.tileSize * 4 : 0);
      }
      return (e.bmp ? this.img.tileSize * this.img.tileSize * 4 : 0) +
        (e.tex && !this._batched ? Math.ceil(this.img.tileSize * this.img.tileSize * 4 * 4 / 3) : 0);
    }

    _disposeCacheEntry(e) {
      if (this._batched && e?.layer != null) {
        const layers = e.kind === 'h' ? this.arrayPool?.height : this.arrayPool?.imagery;
        layers?.release(e.key);
      } else e?.tex?.dispose?.();
      e?.bmp?.close?.();
      if (e?.kind === 'h') {
        this.worldIndex?.remove(e.key);
        this._worldHeightMirrors.delete(e.key);
      }
    }

    _cacheBreakdown(cache) {
      let bytes = 0, persistentBytes = 0, workingTiles = 0, persistentTiles = 0;
      for (const e of cache.values()) {
        const size = this._entryBytes(e);
        if (e.persistent) { persistentBytes += size; persistentTiles++; }
        else { bytes += size; workingTiles++; }
      }
      return { bytes, persistentBytes, workingTiles, persistentTiles };
    }

    memorySnapshot() {
      const height = this._cacheBreakdown(this.hCache);
      const imagery = this._cacheBreakdown(this.iCache);
      return {
        heightTiles: this.hCache.size,
        heightTileLimit: this.o.heightCacheMax,
        imageryTiles: this.iCache.size,
        imageryTileLimit: this.o.imageryCacheMax,
        heightWorkingTiles: height.workingTiles,
        heightPersistentTiles: height.persistentTiles,
        imageryWorkingTiles: imagery.workingTiles,
        imageryPersistentTiles: imagery.persistentTiles,
        heightWorkingBytes: height.bytes,
        heightPersistentBytes: height.persistentBytes,
        imageryWorkingBytes: imagery.bytes,
        imageryPersistentBytes: imagery.persistentBytes,
        heightByteLimit: this.o.heightBytesMax,
        imageryByteLimit: this.o.imageryBytesMax,
        residentByteLimit: this.o.residentBytesMax,
        batched: !!this._batched,
        batchSupport: this._batchSupport?.reason || 'enabled',
        terrainBatches: this.batches.size,
        reflectionTerrainBatches: this._reflectionBatches.size,
        reflectionBatchBytes: this._reflectionStats?.capacityBytes || 0,
        reflectionTerrain: this._reflectionStats,
        visibilityEnvelope: {
          enabled: this._visibilityEnabled,
          errorMetadata: this._terrainErrorStatus,
          mode: this._predictionState?.mode || 'walk',
          currentLeaves: this._visible?.length || 0,
          currentTriangles: this._batchFrame?.triangles || 0,
          predictedLeaves: this._visibilityStats.predictedLeaves,
          warmHeightSources: this._visibilityStats.warmHeightSources,
          warmImagerySources: this._visibilityStats.warmImagerySources,
          warmCancelled: this._visibilityStats.warmCancelled,
          fallbackHits: this._visibilityStats.fallbackHits,
        },
        arrayPool: this.arrayPool?.snapshot?.() || null,
        cpuQueryTiles: this._queryTileKeys?.size || 0,
        ...this._memoryEstimate(),
      };
    }

    setQuality(quality) {
      const residency = RESIDENCY_BY_QUALITY[quality];
      if (!residency) return false;
      this._quality = quality;
      this.o.heightCacheMax = residency.height;
      this.o.imageryCacheMax = residency.imagery;
      this.o.heightBytesMax = residency.heightBytes * 1024 * 1024;
      this.o.imageryBytesMax = residency.imageryBytes * 1024 * 1024;
      this._evict();
      this._publishTelemetry();
      return true;
    }

    setPredictionState(state) {
      if (!state) { this._predictionState = null; return; }
      const v = state.velocity;
      this._predictionState = {
        mode: state.mode === 'fly' || state.mode === 'drive' ? state.mode : 'walk',
        velocity: [Number(v?.x ?? v?.[0]) || 0, Number(v?.y ?? v?.[1]) || 0,
                   Number(v?.z ?? v?.[2]) || 0],
        yawRate: Number(state.yawRate) || 0,
        pitchRate: Number(state.pitchRate) || 0,
        teleported: !!state.teleported,
      };
    }

    _evict() {
      // Fast travel can discover new leaves faster than the network/decoder can service them.
      // Queued records have no decoded-byte cost yet, so the normal cache byte floor cannot see
      // this backlog. Keep only a bounded, highest-priority request window; dropped records will
      // be requested again if they become visible later.
      const maxPending = Math.max(96, this.o.maxConcurrentFetch * 24);
      if (this.fetchQueue.length > maxPending) {
        this.fetchQueue.sort((a, b) => a.priority - b.priority || a.lastUsed - b.lastUsed);
        const dropped = this.fetchQueue.splice(maxPending);
        for (const e of dropped) {
          if (e.state !== 'queued' || e.generation !== this.generation) continue;
          e.state = 'stale';
          const cache = e.kind === 'h' ? this.hCache : this.iCache;
          if (cache.get(e.key) === e) cache.delete(e.key);
        }
      }
      const trim = (cache, max, byteMax) => {
        const initial = this._cacheBreakdown(cache);
        let bytes = initial.bytes, workingTiles = initial.workingTiles;
        if (workingTiles <= max && bytes <= byteMax) return;
        const live = [...cache.values()]
          .filter(e => !e.persistent && !e.queryProtected && !e.prefetchProtected &&
                       !e.predictionProtected &&
                       (e.state === 'ready' || e.state === 'decoded'))
          .sort((a, b) => a.lastUsed - b.lastUsed || this._entryBytes(b) - this._entryBytes(a));
        for (const e of live) {
          if ((workingTiles <= max && bytes <= byteMax) || e.lastUsed === this.frame) break;
          bytes -= this._entryBytes(e);
          workingTiles--;
          this._requestCounters[e.kind === 'h' ? 'height' : 'imagery'].evictions++;
          this._disposeCacheEntry(e);
          cache.delete(e.key);
        }
      };
      trim(this.hCache, this.o.heightCacheMax, this.o.heightBytesMax);
      trim(this.iCache, this.o.imageryCacheMax, this.o.imageryBytesMax);
      // The independent cache limits predate texture arrays and cannot bound combined CPU+GPU
      // residency: a teleport can leave both a full decoded-height cache and full height/imagery
      // arrays behind. Apply one ownership budget across both caches, evicting only genuinely
      // unprotected LRU sources. Current-frame, prediction, safety, query, and persistent sources
      // remain hard floors, so this changes retention rather than visible terrain quality.
      const residentEntryBytes = e => this._entryBytes(e) +
        (e.layer == null ? 0 : (e.kind === 'h'
          ? this.arrayPool?.height?.bytesPerLayer || 0
          : this.arrayPool?.imagery?.bytesPerLayer || 0));
      let residentBytes = 0;
      for (const cache of [this.hCache, this.iCache])
        for (const e of cache.values()) residentBytes += residentEntryBytes(e);
      if (residentBytes > this.o.residentBytesMax) {
        const candidates = [];
        for (const cache of [this.hCache, this.iCache]) for (const e of cache.values()) {
          const pool = e.kind === 'h' ? this.arrayPool?.height : this.arrayPool?.imagery;
          if (e.persistent || e.queryProtected || e.prefetchProtected || e.predictionProtected ||
              e.lastUsed === this.frame || pool?.isProtected(e.key) ||
              (e.state !== 'ready' && e.state !== 'decoded')) continue;
          candidates.push(e);
        }
        candidates.sort((a, b) => a.lastUsed - b.lastUsed ||
          residentEntryBytes(b) - residentEntryBytes(a));
        for (const e of candidates) {
          if (residentBytes <= this.o.residentBytesMax) break;
          residentBytes -= residentEntryBytes(e);
          this._requestCounters[e.kind === 'h' ? 'height' : 'imagery'].evictions++;
          this._disposeCacheEntry(e);
          (e.kind === 'h' ? this.hCache : this.iCache).delete(e.key);
        }
      }
      // prune node meshes unseen for a while (materials only; geometry is shared)
      if (!this._batched) for (const [k, n] of this.meshes) {
        if (this.frame - n.lastShown > this.o.meshIdleFrames) {
          this.group.remove(n.mesh);
          n.mesh.material.dispose();
          this.meshes.delete(k);
        }
      }
    }

    /* ================= per-frame ================= */
    update() {
      this._gpuTimerTick();   // opt-in true-GPU frame-time readout; no-op (and free) when disabled
      this.frame++;
      this._timeSec = (performance.now() - this._clock0) / 1000;
      this._visibilityStats.geometricDecisions = 0;
      this._visibilityStats.legacyDecisions = 0;
      this._visibilityStats.changedDecisions = 0;
      this._visibilityStats.fallbackHits = 0;
      const cam = this.camera;
      if (this.frame > 1 && cam.position.distanceToSquared(this._prevCam) > 1500 * 1500) {
        this.generation++;
        this.workerPool?.supersede('terrain', this.generation);
        const retainedFetches = [];
        for (const e of this.fetchQueue) if (e.state === 'queued') {
          if (e.persistent) retainedFetches.push(e);
          else {
            e.state = 'stale';
            this._requestCounters[e.kind === 'h' ? 'height' : 'imagery'].cancellations++;
          }
        }
        this.fetchQueue.length = 0;
        this.fetchQueue.push(...retainedFetches);
        for (const e of this.uploadQueue) {
          e._uploadQueued = false;
          e.bmp?.close?.();
          const cache = e.kind === 'h' ? this.hCache : this.iCache;
          if (!e.persistent) cache.delete(e.key);
        }
        this.uploadQueue.length = 0;
        for (const cache of [this.hCache, this.iCache]) {
          for (const [key, e] of cache) {
            if (!e.persistent && e.state === 'loading') {
              this._requestCounters[e.kind === 'h' ? 'height' : 'imagery'].cancellations++;
              e._cancellationCounted = true;
              e.abort?.abort();
              cache.delete(key);
            }
          }
        }
      }
      const fh = this.renderer.domElement.height;
      const projScale = fh / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
      this._projScale = projScale;
      cam.updateMatrixWorld();
      this._frustum = this._frustum || new THREE.Frustum();
      this._mtx = this._mtx || new THREE.Matrix4();
      this._frustum.setFromProjectionMatrix(
        this._mtx.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));

      // cloud-uniform producer: mirror the day gate in terrain-shaders.js cloudShade() —
      // sun above the horizon AND the active light warm (moonlight is cool, r < b, so the
      // same test zeroes cloud shade at night). Consumers multiply by uCloudAmt directly.
      const sst = (a, b, v) => {
        const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t);
      };
      this.cloudU.uCloudTime.value = this._timeSec;
      this.cloudU.uCloudAmt.value =
        sst(0.04, 0.14, this.sunAngles.y) * sst(0.02, 0.12, this.sunColor.r - this.sunColor.b);

      // Altitude-scaled screen-space error: looking down from 1–3 km, a 1.8 px height-field
      // error is invisible (the imagery is minified well past its own texel long before the
      // geometry error shows). Relaxing pixelError with height above the terrain cuts the
      // number of deep nodes roughly quadratically. Crack safety: the SAME effective value
      // feeds both the subdivision test and the geomorph handoff below, uniformly for every
      // node this frame, so ring-start/morph-band invariants are untouched.
      const above = Math.max(0, cam.position.y - this.heightAt(cam.position.x, cam.position.z));
      this._pixelError = this._quality === 'high' ? this.o.pixelError
        : this.o.pixelError * (1 + 0.25 * sst(250, 1200, above));
      // Grid demotion, DEEPEST level only: z=maxDepth nodes carry a 160-grid (4 m verts) sized
      // for a future 1 m height pyramid — today's data is 10 m, which a 64-grid samples
      // texel-exactly (a z7 node window covers 64 texels of the z4 height tile). High above the
      // terrain the extra density is pure waste (51.8k vs 8.7k tris per deep node), so those
      // nodes drop to the 64-grid. Coarser depths KEEP their grids — that's what holds ridge
      // silhouettes. Crack safety: the swap is uniform for every node in the frame, neighbour
      // densities stay deterministic per depth, the z/z-1 ratio stays even (2*64/64 = 2), and
      // uCUV still lands morph targets on the parent's real lattice. Hysteresis
      // prevents threshold flicker.
      this._gridShift = this._quality === 'high' ? 0
        : ((this._gridShift === 1 ? above > 650 : above > 750) ? 1 : 0);

      // reset the per-level node index and hand every pooled record back for reuse
      const levels = this._nodeLevels || (this._nodeLevels = []);
      for (let i = 0; i < levels.length; i++) if (levels[i]) levels[i].clear();
      const pool = this._nodePool || (this._nodePool = []);
      // Drop last frame's height-source references before reuse. A pooled record that is not
      // handed out this frame would otherwise pin an evicted cache entry (and its 1 MiB decoded
      // Float32Array) alive indefinitely.
      for (let i = 0; i < pool.length; i++) pool[i].hSrc = null;
      this._nodeUsed = 0;
      const t0 = this.tilesAtZoom(0), nx0 = t0[0], ny0 = t0[1];
      for (let ty = 0; ty < ny0; ty++)
        for (let tx = 0; tx < nx0; tx++)
          this._traverse(0, tx, ty, projScale);
      this._balance();                       // restricted 2:1 quadtree (needed for edge stitch)
      const visible = this._visible || (this._visible = []);
      visible.length = 0;
      for (const level of levels) {
        if (!level) continue;
        for (const node of level.values())
          if (!node.internal && node.render) visible.push(node);
      }

      // pass 1: resolve every visible node's height source FIRST, so the render pass can see
      // which neighbours are still drawing from a coarser ancestor (transient-aware skirts)
      if (this._batched) this.arrayPool.beginNextFrame();
      for (const node of visible)
        node.hSrc = this._source(this.hCache, this._reqHeight, node,
                                 Math.min(node.z, this.m.maxZoom));
      for (const node of visible) node.nativeHeightMaxZoom = this.m.maxZoom;
      if (this._batched) {
        const instances = [];
        for (const node of visible) {
          const instance = this._terrainInstance(node);
          if (instance) instances.push(instance);
        }
        this._publishTerrainBatches(instances);
      } else {
        for (const node of visible) this._renderNode(node);
        for (const n of this.meshes.values())
          if (n.lastShown !== this.frame) n.mesh.visible = false;
      }
      this.visibleTerrainCoverage = global.GT_TERRAIN_COVERAGE.summarizeVisibleTerrain(
        visible, this.meshes, this.frame);
      // Leaf-key comparison is the only per-frame endurance accounting beyond scalar counters.
      // Detailed ownership remains on the 500 ms telemetry cadence below.
      const leafKeys = this._nextLeafKeys;
      leafKeys.clear();
      for (const node of visible) leafKeys.add(node.z * 0x1000000 + node.x * 0x1000 + node.y);
      let swaps = 0;
      for (const key of leafKeys) if (!this._previousLeafKeys.has(key)) swaps++;
      for (const key of this._previousLeafKeys) if (!leafKeys.has(key)) swaps++;
      this._lodStats.currentSwaps = swaps;
      this._lodStats.cumulativeSwaps += swaps;
      this._nextLeafKeys = this._previousLeafKeys;
      this._previousLeafKeys = leafKeys;
      if (!this.visibleTerrainCoverage.complete) this._lodStats.coverageFailures++;
      if (this.visibleTerrainCoverage.nativeHeightRatio < 1) this._lodStats.fallbackFrames++;

      this._pumpFetches();
      this._pumpUploads();
      this._prefetch(visible);
      this._updateQueryCorridor();
      this._evict();
      this._publishTelemetry();
      this._prevCam.copy(cam.position);
    }

    coverageSnapshot() {
      return {
        ...this.visibleTerrainCoverage,
        missingLeaves: this.visibleTerrainCoverage.missingLeaves.slice(),
      };
    }

    // vertical-padded xz box used for both frustum culling and (elsewhere) balance.
    // Returns a SHARED scratch box: the only callers pass it straight to intersectsBox and never
    // retain it. Allocating a Box3 + two Vector3 per visited node per frame was the single
    // largest source of young-generation garbage in the render loop.
    _nodeBox(b) {
      const box = this._scratchBox || (this._scratchBox = new THREE.Box3());
      box.min.set(b.minX, this.m.elevation.min - this.datum - 10, b.minZ);
      box.max.set(b.minX + b.wpt, this.m.elevation.max - this.datum + 10, b.minZ + b.hpt);
      return box;
    }
    // NEAREST-point (xz box) distance, not center distance. With center distance an
    // unsubdivided coarse node could reach to 0.28*size of the camera, deep inside its finer
    // neighbours' geomorph band — those seams were only partially morphed and the full
    // fine-vs-coarse height delta opened as a crack (the pale sky-showing sheets on steep
    // faces). Nearest-point selection guarantees every vertex of a rendered node lies beyond
    // its ring start, so the morph band below can be placed to be provably complete at seams.
    _nodeDist(b) {
      const px2 = this.camera.position.x, pz2 = this.camera.position.z;
      const ddx = Math.max(b.minX - px2, 0, px2 - (b.minX + b.wpt));
      const ddz = Math.max(b.minZ - pz2, 0, pz2 - (b.minZ + b.hpt));
      return Math.max(1, Math.hypot(ddx, ddz));
    }

    _nodeGeometricError(z, x, y, gridN, bounds) {
      if (!this._visibilityEnabled) return null;
      const measured = this._terrainErrors?.errorMeters(z, x, y, gridN);
      if (measured == null) return null;
      // This project already has an approved visual LOD policy based on source texel size.
      // Measured relief may be much larger on cliffs; allowing it to exceed that authored ceiling
      // would refine almost the whole range (and regress 3.4m -> 23m triangles). Error metadata is
      // therefore a one-way simplifier: it proves when a node may stay coarse, never demands more
      // detail than the legacy selector that the captures approved.
      const authored = bounds.size / this.m.tileSize;
      return Math.min(authored, Math.max(measured, authored * this.o.geometricErrorFloor));
    }

    // Descend the quadtree, recording EVERY visited node (internal + leaf) in the level maps so
    // the balance pass below can see the whole rendered set. Frustum-culled subtrees are simply
    // never recorded — they aren't rendered, so no seam can show against them.
    _traverse(z, x, y, projScale) {
      const b = this.tileWorldBounds(z, x, y);
      if (!this._frustum.intersectsBox(this._nodeBox(b))) return;
      const dist = this._nodeDist(b);
      const texel = b.size / this.m.tileSize;            // meters per rendered texel at this z
      const sse = (texel * projScale) / dist;
      const threshold = this._pixelErrorAt(b);
      const gridN = this.o.gridByLOD[this._gridIndexForZ(z)];
      const errorMeters = this._nodeGeometricError(z, x, y, gridN, b);
      if (errorMeters == null) this._visibilityStats.fallbackHits++;
      // The core floor belongs only to the visual-safe legacy selector. Measured error retains
      // genuine Cathedral silhouette relief without forcing every smooth node in its rectangle.
      // Keep the Cathedral's steep connected face on one minimum depth. Mixed geometric-error
      // leaves inside this cliff complex exposed transient sheets even with 2:1 edge stitching.
      // z6 retains its silhouette at ~20 m vertices while avoiding the old z7/4 m blanket cost.
      const coreFloor = errorMeters == null ? this.o.coreFloorZ : Math.min(6, this.o.coreFloorZ);
      const forceCore = coreFloor && z < coreFloor && this._overlapsCore(b);
      const decision = global.GT_TERRAIN_VISIBILITY?.terrainShouldSubdivide({
        errorMeters, projectionScale: projScale, nearestDistance: dist,
        pixelThreshold: threshold, legacySse: sse, forceLegacy: !this._visibilityEnabled,
      }) || { subdivide: sse > threshold, mode: 'legacy', projectedError: sse };
      if (forceCore) decision.subdivide = true;
      // Do not mix z6 and z7 across the connected Cathedral cliff face. The skirts are intended
      // for streaming transients, not persistent alpine relief between differently detailed
      // leaves; a uniform z6 surface removes those bright triangular sheets.
      if (errorMeters != null && z >= 6 && this._overlapsCore(b)) decision.subdivide = false;
      if (decision.mode === 'geometric') this._visibilityStats.geometricDecisions++;
      else this._visibilityStats.legacyDecisions++;
      if (this._visibilityCompare && decision.subdivide !== (sse > threshold || forceCore))
        this._visibilityStats.changedDecisions++;
      if (z < this.maxDepth && decision.subdivide) {
        this._putNode(z, x, y, dist, b, true, false);
        const cn = this.tilesAtZoom(z + 1), cnx = cn[0], cny = cn[1];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const cxi = x * 2 + dx, cyi = y * 2 + dy;
          if (cxi < cnx && cyi < cny) this._traverse(z + 1, cxi, cyi, projScale);
        }
      } else {
        this._putNode(z, x, y, dist, b, false, true);
      }
    }

    /* Node records live in one per-level Map keyed by a small-integer (x,y) so lookups never
       build a `${z}/${x}/${y}` string — the balance fixpoint and edge-stitch alone did thousands
       of those per frame. Records are pooled and rewritten in place: the set is rebuilt from
       scratch every frame and nothing outside update() retains one past the frame. */
    _levelKey(x, y) { return x * 4096 + y; }
    _levelMap(z) {
      const levels = this._nodeLevels;
      let m = levels[z];
      if (!m) m = levels[z] = new Map();
      return m;
    }
    _putNode(z, x, y, dist, bounds, internal, render) {
      const pool = this._nodePool;
      let n = pool[this._nodeUsed];
      if (!n) n = pool[this._nodeUsed] = { z: 0, x: 0, y: 0, dist: 0, bounds: null,
        internal: false, render: false, hSrc: null, nativeHeightMaxZoom: 0 };
      this._nodeUsed++;
      n.z = z; n.x = x; n.y = y; n.dist = dist; n.bounds = bounds;
      n.internal = internal; n.render = render; n.hSrc = null;
      this._levelMap(z).set(this._levelKey(x, y), n);
      return n;
    }
    _getNode(z, x, y) {
      const m = this._nodeLevels[z];
      return m ? m.get(this._levelKey(x, y)) : undefined;
    }
    _hasNode(z, x, y) {
      const m = this._nodeLevels[z];
      return m ? m.has(this._levelKey(x, y)) : false;
    }

    /* Restricted quadtree (classic 2:1 balance): after the SSE traversal, no rendered leaf may
       border a leaf two or more levels finer. Enforcement: for every internal node at level z,
       each same-level edge neighbour cell must itself exist at level z — otherwise the coarse
       leaf covering it (the neighbour's parent at z-1) is 2+ levels below this node's children
       and must be split. Splitting can expose new violations, so iterate to a fixpoint. Once
       balanced, every boundary edge is level-matched or off by exactly one level — the single
       case the vertex-shader stitch handles. */
    _balance() {
      const internals = this._balanceScratch || (this._balanceScratch = []);
      let changed = true, guard = 0;
      while (changed && guard++ < 24) {
        changed = false;
        internals.length = 0;
        for (const level of this._nodeLevels) {
          if (!level) continue;
          for (const n of level.values()) if (n.internal) internals.push(n);
        }
        for (let k = 0; k < internals.length; k++) {
          const n = internals[k], z = n.z;
          if (z < 1) continue;                 // roots have no coarser neighbour to force
          const g = this.tilesAtZoom(z), gx = g[0], gy = g[1];
          // neighbour offsets inlined: this loop runs (internal nodes x 24 iterations) times, so
          // the old array-of-arrays literal was rebuilt tens of thousands of times per frame
          for (let i = 0; i < 4; i++) {
            const nx = n.x + (i === 0 ? -1 : i === 1 ? 1 : 0);
            const ny = n.y + (i === 2 ? -1 : i === 3 ? 1 : 0);
            if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;   // park boundary
            if (this._hasNode(z, nx, ny)) continue;                   // neighbour exists at z
            const p = this._getNode(z - 1, nx >> 1, ny >> 1);
            if (!p || p.internal || p.z >= this.maxDepth) continue;   // unrendered / already split
            this._split(p);
            changed = true;
          }
        }
      }
    }

    // promote a rendered leaf to internal, materialising its 4 children as leaves (frustum-culled)
    _split(p) {
      p.internal = true; p.render = false;
      const z = p.z + 1, g = this.tilesAtZoom(z), gx = g[0], gy = g[1];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const cx = p.x * 2 + dx, cy = p.y * 2 + dy;
        if (cx >= gx || cy >= gy) continue;
        const b = this.tileWorldBounds(z, cx, cy);
        const render = this._frustum.intersectsBox(this._nodeBox(b));
        this._putNode(z, cx, cy, this._nodeDist(b), b, false, render);
      }
    }

    // stitch ratio for one edge: 0 unless the neighbour across it is exactly one level coarser,
    // in which case r = 2*fineN/coarseN = this tile's boundary vertices per coarse edge segment.
    _edgeR(node, dx, dy, fineN, gridNForZoom = null) {
      const z = node.z, nx = node.x + dx, ny = node.y + dy;
      const g = this.tilesAtZoom(z), gx = g[0], gy = g[1];
      if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) return 0;    // park boundary — skirt covers
      if (this._hasNode(z, nx, ny)) return 0;                    // same level, or finer subtree
      const p = this._getNode(z - 1, nx >> 1, ny >> 1);
      if (!p || p.internal) return 0;                            // unrendered region
      const coarseN = gridNForZoom ? gridNForZoom(z - 1) :
        this.o.gridByLOD[this._gridIndexForZ(z - 1)];
      return 2 * fineN / coarseN;
    }

    /* deepest READY entry at or above targetZ on the ancestor path of (z,x,y); requests target */
    _source(cache, req, node, targetZ) {
      let tz = targetZ, tx = node.x >> 0, ty = node.y >> 0;
      // map node coords up to targetZ
      const up = node.z - targetZ;
      tx = node.x >> up; ty = node.y >> up;
      req.call(this, tz, tx, ty, node.dist);
      for (let z = tz, x = tx, y = ty; z >= 0; z--, x >>= 1, y >>= 1) {
        const e = cache.get(`${z}/${x}/${y}`);
        if (e && e.state === 'ready') { e.lastUsed = this.frame; return e; }
      }
      return null;
    }

    /* uv window mapping node (z,x,y) into source tile at e.z */
    _window(node, e, out) {
      const dz = node.z - e.z;
      const scale = 1 / Math.pow(2, dz);
      out.set((node.x - (node.x >> dz) * Math.pow(2, dz)) * scale,
              (node.y - (node.y >> dz) * Math.pow(2, dz)) * scale,
              scale);
      return out;
    }

    _terrainInstance(node) {
      const hSrc = node.hSrc;
      if (!hSrc || hSrc.layer == null ||
          !this.arrayPool.retainForNextFrame('height', hSrc.key)) return null;
      const iSrc = this.img ? this._source(this.iCache, this._reqImagery, node,
                                           Math.min(node.z, this.img.maxZoom)) : null;
      let imagery = null;
      if (iSrc && iSrc.layer != null && this.arrayPool.retainForNextFrame('imagery', iSrc.key)) {
        const win = this._window(node, iSrc, new THREE.Vector3());
        imagery = { key: iSrc.key, z: iSrc.z, x: iSrc.x, y: iSrc.y,
                    layer: iSrc.layer, window: [win.x, win.y, win.z] };
      }
      const hWin = this._window(node, hSrc, new THREE.Vector3());
      const gi = this._gridIndexForZ(node.z), fineN = this.o.gridByLOD[gi];
      const cuv = [0, 0, 0, 0];
      for (let k = 1; k <= 4 && node.z - k >= 0; k++)
        cuv[k - 1] = Math.pow(2, k) /
          this.o.gridByLOD[this._gridIndexForZ(node.z - k)];
      const srcTexel = this.spanAt(hSrc.z) / this.m.tileSize;
      const relief = this._windowRelief(hSrc, hWin);
      let skirt = this.o.skirt + 3 * srcTexel + 0.08 * relief;
      const nativeZ = Math.min(node.z, this.m.maxZoom);
      const nbSrcZ = this._nbTransientSrcZ(node);
      const worstZ = Math.min(hSrc.z < nativeZ ? hSrc.z : Infinity, nbSrcZ);
      if (worstZ < nativeZ)
        skirt += 4 * (this.spanAt(worstZ) / this.m.tileSize) + 0.17 * relief;
      return {
        key: `${node.z}/${node.x}/${node.y}`, node, gridN: fineN,
        uvMax: [
          Math.min(1, Math.max(1e-4, (this.spanX / 2 - node.bounds.minX) / node.bounds.size)),
          Math.min(1, Math.max(1e-4, (this.spanZ / 2 - node.bounds.minZ) / node.bounds.size)),
        ],
        height: { key: hSrc.key, z: hSrc.z, x: hSrc.x, y: hSrc.y,
                  layer: hSrc.layer, window: [hWin.x, hWin.y, hWin.z] },
        _heightEntry: hSrc,
        imagery,
        sourceTexelMeters: srcTexel,
        skirt,
        // Keep the authored uniform morph cascade. Geometric error changes leaf selection only;
        // per-node morph bands would differ across neighbours and break the seam invariant.
        morphBase: (node.bounds.size / this.m.tileSize) * this._projScale /
                   this._pixelErrorAt(node.bounds),
        morphLattice: cuv,
        edgeRatios: [
          this._edgeR(node, -1, 0, fineN), this._edgeR(node, 1, 0, fineN),
          this._edgeR(node, 0, -1, fineN), this._edgeR(node, 0, 1, fineN),
        ],
      };
    }

    _batchUniforms() {
      return {
        uHeightArray: { value: this.arrayPool.height.texture },
        uImageryArray: { value: this.arrayPool.imagery.texture },
        uSun: { value: this.o.sun }, uSunColor: { value: this.sunColor },
        uSunAngles: { value: this.sunAngles }, uAmb: { value: this.ambient },
        uEnvColor: (global.TERRAIN_ENV_UNIFORMS ||
          {uEnvColor:{value:new THREE.Color(0.2,0.3,0.5)}}).uEnvColor,
        uWet: (global.TERRAIN_ENV_UNIFORMS || {uWet:{value:0}}).uWet,
        uHorizonA: { value: this.horizonTex[0] }, uHorizonB: { value: this.horizonTex[1] },
        uHasHorizon: { value: this.horizonTex[0] ? 1 : 0 },
        uHorizonMax: { value: this.horizonMaxAngle || 1 },
        uAO: { value: this.aoTex }, uHasAO: { value: this.aoTex ? 1 : 0 },
        uWorldMin: { value: new THREE.Vector2(-this.spanX / 2, -this.spanZ / 2) },
        uWorldInv: { value: new THREE.Vector2(1 / this.spanX, 1 / this.spanZ) },
        uFogColor: { value: this.scene.fog.color },
        uFogNear: { value: this.scene.fog.near }, uFogFar: { value: this.scene.fog.far },
        uSnowLine: { value: this.o.snowLine },
        uNaturalColor: { value: this._naturalColor ? 1 : 0 },
        uSeason: global.SEASON_UNIFORMS?.uSeason || { value: 0 },
        uTime: { value: 0 }, uNoise: { value: this.noiseTex },
        uDetailN: { value: this.detailNTex }, uHasDetailN: { value: this.detailNTex ? 1 : 0 },
        uShadowMap: this.shadowU.uShadowMap, uShadowMtx: this.shadowU.uShadowMtx,
        uShadowOn: this.shadowU.uShadowOn,
        uHLPos: this.headlightU.uHLPos, uHLDir: this.headlightU.uHLDir,
        uHLColor: this.headlightU.uHLColor, uHLParams: this.headlightU.uHLParams,
        uDetailA: { value: this.detailATex }, uLandcover: { value: this.lcTex },
        uLCMin: { value: this.lcMap ? this.lcMap.min.clone() : new THREE.Vector2() },
        uLCInv: { value: this.lcMap ? this.lcMap.inv.clone() : new THREE.Vector2(1, 1) },
        uHasLC: { value: this.lcTex ? 1 : 0 }, uRoads: { value: this.roadsTex },
        uRoadsOrigin: { value: this.roadsMap ? this.roadsMap.origin.clone() : new THREE.Vector2() },
        uRoadsInv: { value: this.roadsMap ? this.roadsMap.inv.clone() : new THREE.Vector2(1, 1) },
        uHasRoads: { value: this.roadsTex ? 1 : 0 },
      };
    }

    _newTerrainBatch(gridN, capacity, packed, namePrefix = 'terrainBatch') {
      if (!this._batchMaterial) {
        const shader = global.TerrainShaders.batch;
        this._batchMaterial = new THREE.ShaderMaterial({
          uniforms: this._batchUniforms(), vertexShader: shader.vertex,
          fragmentShader: shader.fragment, glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
        });
      }
      let baseGeometry = this._gridGeometryByN.get(gridN);
      if (!baseGeometry) {
        baseGeometry = makeGrid(gridN); this._gridGeometryByN.set(gridN, baseGeometry);
      }
      const geometry = baseGeometry.clone();
      const buffer = new THREE.InstancedInterleavedBuffer(packed, 25, 1);
      const attrs = global.TerrainShaders.batch.attributes;
      let offset = 0;
      for (const spec of [attrs.tile, attrs.uvMax, attrs.height, attrs.imagery,
                          attrs.geom, attrs.ancestorLattice, attrs.edgeRatios]) {
        geometry.setAttribute(spec.name,
          new THREE.InterleavedBufferAttribute(buffer, spec.itemSize, offset, false));
        offset += spec.itemSize;
      }
      const mesh = new THREE.InstancedMesh(geometry, this._batchMaterial, capacity);
      mesh.name = `${namePrefix}-${gridN}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      return { mesh, geometry, buffer, capacity, gridN };
    }

    _publishTerrainBatches(instances) {
      const contract = global.GT_TERRAIN_BATCH;
      const frame = contract.buildTerrainFrame(instances, {
        frameId: this.frame, capacities: this._batchCapacities,
      });
      const occupied = new Set();
      for (const [gridN, data] of frame.batches) {
        occupied.add(gridN);
        let record = this.batches.get(gridN);
        if (!record || record.capacity < data.capacity) {
          const replacement = this._newTerrainBatch(gridN, data.capacity, data.packed);
          replacement.mesh.count = data.count;
          this.group.add(replacement.mesh);
          if (record) { this.group.remove(record.mesh); record.geometry.dispose(); }
          record = replacement; this.batches.set(gridN, record);
        } else {
          record.buffer.array.set(data.packed.subarray(0, data.count * 25));
          record.buffer.needsUpdate = true;
          record.mesh.count = data.count; record.mesh.visible = true;
        }
        this._batchCapacities.set(gridN, record.capacity);
      }
      for (const [gridN, record] of [...this.batches]) if (!occupied.has(gridN)) {
        this.group.remove(record.mesh); record.geometry.dispose(); this.batches.delete(gridN);
      }
      this.arrayPool.publishNextFrame();

      // Preserve the public per-leaf map consumed by coverage, movement-pop, and season telemetry.
      this.meshes.clear();
      for (const descriptor of frame.descriptors) {
        const record = this.batches.get(descriptor.gridN);
        this.meshes.set(descriptor.key, { mesh: record.mesh, lastShown: this.frame });
      }
      const u = this._batchMaterial?.uniforms;
      if (u) {
        u.uFogNear.value = this.scene.fog.near; u.uFogFar.value = this.scene.fog.far;
        u.uTime.value = this._timeSec;
        if (this.horizonTex[0]) {
          u.uHorizonA.value = this.horizonTex[0]; u.uHorizonB.value = this.horizonTex[1];
          u.uHasHorizon.value = 1; u.uHorizonMax.value = this.horizonMaxAngle;
        }
        if (this.aoTex) { u.uAO.value = this.aoTex; u.uHasAO.value = 1; }
        if (this.lcTex) {
          u.uLandcover.value = this.lcTex; u.uLCMin.value.copy(this.lcMap.min);
          u.uLCInv.value.copy(this.lcMap.inv); u.uHasLC.value = 1;
        }
      }
      this._batchFrame = frame;
      this._batchInstances = instances;
      this._batchEquivalence = this._batchCompare
        ? contract.compareTerrainSubmissions(instances, frame) : null;
    }

    _publishReflectionBatches(frame) {
      const occupied = new Set();
      for (const [gridN, data] of frame.batches) {
        occupied.add(gridN);
        let record = this._reflectionBatches.get(gridN);
        if (!record || record.capacity < data.capacity) {
          const replacement = this._newTerrainBatch(
            gridN, data.capacity, data.packed, 'terrainReflectionBatch');
          replacement.mesh.count = data.count;
          this.reflectionGroup.add(replacement.mesh);
          if (record) {
            this.reflectionGroup.remove(record.mesh); record.geometry.dispose();
          }
          record = replacement; this._reflectionBatches.set(gridN, record);
        } else {
          record.buffer.array.set(data.packed.subarray(0, data.count * 25));
          record.buffer.needsUpdate = true;
          record.mesh.count = data.count; record.mesh.visible = true;
        }
        this._reflectionBatchCapacities.set(gridN, record.capacity);
      }
      for (const [gridN, record] of [...this._reflectionBatches]) if (!occupied.has(gridN)) {
        this.reflectionGroup.remove(record.mesh); record.geometry.dispose();
        this._reflectionBatches.delete(gridN);
      }
      this._reflectionFrame = frame;
    }

    _prepareReflectionFrame(camera, planeY) {
      const contract = global.GT_TERRAIN_BATCH;
      if (!this._batched || !contract || !this._batchInstances) return null;
      const matrix = this._reflectionFrustumMatrix ||
        (this._reflectionFrustumMatrix = new THREE.Matrix4());
      const frustum = this._reflectionFrustum || (this._reflectionFrustum = new THREE.Frustum());
      const box = this._reflectionBox || (this._reflectionBox = new THREE.Box3());
      camera.updateMatrixWorld(true);
      frustum.setFromProjectionMatrix(matrix.multiplyMatrices(
        camera.projectionMatrix, camera.matrixWorldInverse));
      const mainGridForZoom = zoom =>
        this.o.gridByLOD[this._gridIndexForZ(zoom)];
      const reflectionGridForZoom = zoom =>
        contract.reflectionTerrainGridN(mainGridForZoom(zoom));
      let frustumCulled = 0, planeCulled = 0;
      const include = instance => {
        const bounds = instance.node.bounds;
        const heightBounds = this._windowHeightBounds(
          instance._heightEntry, instance.height.window);
        const minY = heightBounds ? heightBounds[0] - instance.skirt :
          this.m.elevation.min - this.datum - instance.skirt;
        const maxY = heightBounds ? heightBounds[1] + 6 * instance.sourceTexelMeters :
          this.m.elevation.max - this.datum + 10;
        if (Number.isFinite(planeY) && maxY < planeY - 0.5) {
          planeCulled++; return false;
        }
        box.min.set(bounds.minX, minY, bounds.minZ);
        box.max.set(bounds.minX + (bounds.wpt || bounds.size), maxY,
                    bounds.minZ + (bounds.hpt || bounds.size));
        if (!frustum.intersectsBox(box)) { frustumCulled++; return false; }
        return true;
      };
      const derived = contract.buildReflectionTerrainInstances(this._batchInstances, {
        include,
        gridNForZoom: reflectionGridForZoom,
        edgeRatiosForNode: (node, fineN) => [
          this._edgeR(node, -1, 0, fineN, reflectionGridForZoom),
          this._edgeR(node, 1, 0, fineN, reflectionGridForZoom),
          this._edgeR(node, 0, -1, fineN, reflectionGridForZoom),
          this._edgeR(node, 0, 1, fineN, reflectionGridForZoom),
        ],
      });
      const frame = contract.buildTerrainFrame(derived.instances, {
        frameId: this.frame, capacities: this._reflectionBatchCapacities,
      });
      this._publishReflectionBatches(frame);
      const gridCounts = {};
      for (const [gridN, batch] of frame.batches) gridCounts[gridN] = batch.count;
      const sourceEquivalent = !this._reflectionCompare || derived.instances.every(instance => {
        const source = this._batchInstances.find(item => item.key === instance.key);
        return source && source.height.key === instance.height.key &&
          source.imagery?.key === instance.imagery?.key &&
          JSON.stringify(source.height.window) === JSON.stringify(instance.height.window) &&
          JSON.stringify(source.imagery?.window || null) ===
            JSON.stringify(instance.imagery?.window || null);
      });
      const capacityBytes = [...this._reflectionBatches.values()]
        .reduce((sum, record) => sum + record.capacity * 25 * 4, 0);
      this._reflectionStats = {
        enabled: true, mode: 'coarse-instanced-array', frameId: this.frame,
        inputLeaves: this._batchInstances.length, submittedLeaves: derived.instances.length,
        culledLeaves: derived.culled, frustumCulled, planeCulled,
        drawCalls: frame.drawCalls, triangles: frame.triangles, gridCounts, capacityBytes,
        mainTriangles: this._batchFrame?.triangles || 0,
        reductionRatio: this._batchFrame?.triangles ?
          1 - frame.triangles / this._batchFrame.triangles : 0,
        comparison: this._reflectionCompare ? { sourceEquivalent } : null,
      };
      return frame;
    }

    beginReflectionPass(camera, planeY) {
      if (this._reflectionPassToken) throw new Error('terrain reflection pass already active');
      const token = {
        active: false, group: this.group,
        mainVisible: this.group.visible, reflectionVisible: this.reflectionGroup.visible,
      };
      if (!this._reflectionEnabled || !this._batched || !this._batchInstances) {
        this._reflectionStats = {
          enabled: false,
          mode: this._reflectionEnabled ? 'main-reuse-fallback' : 'main-reuse-disabled',
          drawCalls: this._batchFrame?.drawCalls || this.meshes.size,
          triangles: this._batchFrame?.triangles || 0,
        };
        return token;
      }
      this._prepareReflectionFrame(camera, planeY);
      this.group.visible = false; this.reflectionGroup.visible = true;
      token.active = true; token.group = this.reflectionGroup;
      this._reflectionPassToken = token;
      return token;
    }

    endReflectionPass(token) {
      if (!token?.active) return;
      if (this._reflectionPassToken !== token)
        throw new Error('terrain reflection pass token mismatch');
      this.group.visible = token.mainVisible;
      this.reflectionGroup.visible = token.reflectionVisible;
      this._reflectionPassToken = null;
    }

    _renderNode(node) {
      const key = `${node.z}/${node.x}/${node.y}`;
      const hSrc = node.hSrc;                             // pre-resolved in update() pass 1
      if (!hSrc) return;                                  // nothing decoded yet (first frames only)
      const iSrc = this.img ? this._source(this.iCache, this._reqImagery, node,
                                           Math.min(node.z, this.img.maxZoom)) : null;

      let n = this.meshes.get(key);
      if (!n) {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uHeight: { value: hSrc.tex }, uHWin: { value: new THREE.Vector3(0, 0, 1) },
            uImagery: { value: iSrc ? iSrc.tex : null }, uIWin: { value: new THREE.Vector3(0, 0, 1) },
            uHasImg: { value: 0 },
            uUVMax: { value: new THREE.Vector2(1, 1) },           // valid-data clamp (per frame)
            uHTexelM: { value: 1.25 },                            // m per source texel (per frame)
            uTileOrigin: { value: new THREE.Vector2() }, uTileSize: { value: 0 },
            uSkirt: { value: this.o.skirt },
            uMorphBase: { value: 1e9 },                           // LOD handoff dist (per frame)
            uCUV: { value: new THREE.Vector4(0, 0, 0, 0) },       // cascade lattice steps (per frame)
            uEdgeR: { value: new THREE.Vector4(0, 0, 0, 0) },     // per-edge stitch ratio (per frame)
            uGridN: { value: this.o.gridByLOD[0] },               // this tile's grid resolution
            uSun: { value: this.o.sun }, uSunColor: { value: this.sunColor },
            uSunAngles: { value: this.sunAngles }, uAmb: { value: this.ambient },
            uEnvColor: (window.TERRAIN_ENV_UNIFORMS || {uEnvColor:{value:new THREE.Color(0.2,0.3,0.5)}}).uEnvColor,
            uWet: (window.TERRAIN_ENV_UNIFORMS || {uWet:{value:0}}).uWet,
            uHorizonA: { value: this.horizonTex[0] }, uHorizonB: { value: this.horizonTex[1] },
            uHasHorizon: { value: this.horizonTex[0] ? 1 : 0 },
            uHorizonMax: { value: this.horizonMaxAngle || 1 },
            uAO: { value: this.aoTex }, uHasAO: { value: this.aoTex ? 1 : 0 },
            uWorldMin: { value: new THREE.Vector2(-this.spanX / 2, -this.spanZ / 2) },
            uWorldInv: { value: new THREE.Vector2(1 / this.spanX, 1 / this.spanZ) },
            uFogColor: { value: this.scene.fog.color },
            uFogNear: { value: this.scene.fog.near }, uFogFar: { value: this.scene.fog.far },
            uSnowLine: { value: this.o.snowLine },
            uNaturalColor: { value: this._naturalColor ? 1 : 0 },
            uTime: { value: 0 },
            uNoise: { value: this.noiseTex },
            uDetailN: { value: this.detailNTex },
            uHasDetailN: { value: this.detailNTex ? 1 : 0 },
            uShadowMap: this.shadowU.uShadowMap,      // shared objects — live-updated by 20-scene
            uShadowMtx: this.shadowU.uShadowMtx,
            uShadowOn: this.shadowU.uShadowOn,
            uHLPos: this.headlightU.uHLPos,           // shared objects — live-updated by 82-drive
            uHLDir: this.headlightU.uHLDir,
            uHLColor: this.headlightU.uHLColor,
            uHLParams: this.headlightU.uHLParams,
            uDetailA: { value: this.detailATex },
            uLandcover: { value: this.lcTex },
            uLCMin: { value: this.lcMap ? this.lcMap.min.clone() : new THREE.Vector2() },
            uLCInv: { value: this.lcMap ? this.lcMap.inv.clone() : new THREE.Vector2(1, 1) },
            uHasLC: { value: this.lcTex ? 1 : 0 },
            uRoads: { value: this.roadsTex },
            uRoadsOrigin: { value: this.roadsMap ? this.roadsMap.origin.clone() : new THREE.Vector2() },
            uRoadsInv: { value: this.roadsMap ? this.roadsMap.inv.clone() : new THREE.Vector2(1, 1) },
            uHasRoads: { value: this.roadsTex ? 1 : 0 },
          },
          vertexShader: global.TerrainShaders.vertex,
          fragmentShader: global.TerrainShaders.fragment,
          side: THREE.DoubleSide,   // a heightfield has no underside: from below the world was
                                    // a see-through void with floating roads/trees. Underside
                                    // fragments reuse the up-facing shading (dim, plausible).
        });
        const mesh = new THREE.Mesh(this.grids[0], mat);
        mesh.frustumCulled = false;      // unit-space shared grid; we cull in _traverse
        // Tile placement lives in uTileOrigin/uTileSize, never in the object transform, so the
        // matrix is identity for life — skip recomposing it for ~120 tiles every frame.
        mesh.matrixAutoUpdate = false; mesh.updateMatrix();
        this.group.add(mesh);
        n = { mesh, lastShown: 0 };
        this.meshes.set(key, n);
      }
      // grid density by node DEPTH, not camera distance: every node of a given z uses the same
      // grid, so a node knows exactly what lattice its coarser neighbours render with and the
      // geomorph target (uCUV) can land on their triangles. Distance-bucketed grids made
      // neighbour densities nondeterministic — the root of the alpine seam sheets.
      const gi = this._gridIndexForZ(node.z);
      n.mesh.geometry = this.grids[gi];

      const u = n.mesh.material.uniforms;
      // edge stitch: with 2:1 balance guaranteed above, each edge is level-matched or borders a
      // 1-level-coarser leaf; only the coarse case collapses this tile's extra boundary vertices.
      const fineN = this.o.gridByLOD[gi];
      u.uGridN.value = fineN;
      u.uEdgeR.value.set(
        this._edgeR(node, -1, 0, fineN), this._edgeR(node, 1, 0, fineN),
        this._edgeR(node, 0, -1, fineN), this._edgeR(node, 0, 1, fineN));
      u.uHeight.value = hSrc.tex;
      this._window(node, hSrc, u.uHWin.value);
      if (iSrc) { u.uImagery.value = iSrc.tex; this._window(node, iSrc, u.uIWin.value); u.uHasImg.value = 1; }
      else u.uHasImg.value = 0;
      u.uTileOrigin.value.set(node.bounds.minX, node.bounds.minZ);
      u.uTileSize.value = node.bounds.size;
      // valid-data clamp: tiles on the raster's last column/row carry floor-height + grey
      // padding beyond the data edge. Clamp SAMPLING (height + imagery) to the data extent so
      // the world edge-extends instead of cliffing into grey slabs. Same world line for every
      // node/z, so seams stay consistent.
      u.uUVMax.value.set(
        Math.min(1, Math.max(1e-4, (this.spanX / 2 - node.bounds.minX) / node.bounds.size)),
        Math.min(1, Math.max(1e-4, (this.spanZ / 2 - node.bounds.minZ) / node.bounds.size)));
      // cascaded geomorph lattice steps: ancestor z-k's grid step expressed in this node's uv
      // is 2^k / gridN(z-k) (quadrant offsets cancel because every grid count is divisible by
      // 2^k for k<=4). 0 = no such ancestor — the shader holds the last completed level, and
      // both sides of any seam saturate at the same absolute level.
      const cuv = u.uCUV.value;
      cuv.set(0, 0, 0, 0);
      for (let k = 1; k <= 4; k++) {
        if (node.z - k < 0) break;
        cuv.setComponent(k - 1, Math.pow(2, k) / this.o.gridByLOD[this._gridIndexForZ(node.z - k)]);
      }
      // skirt swallows what construction can't: residual border curvature (cm) and STREAMING
      // transients. Scale with the SOURCE texel size + local relief; when this node or any
      // edge neighbour still renders from a coarser ANCESTOR (native tile not landed yet),
      // deepen by the coarsest transient texel + more relief — a 6 m skirt never covered a
      // z3-ancestor-vs-native mismatch on alpine faces. Settled frames pay nothing extra.
      const srcTexel = this.spanAt(hSrc.z) / this.m.tileSize;
      u.uHTexelM.value = srcTexel;
      const relief = this._windowRelief(hSrc, u.uHWin.value);
      let skirt = this.o.skirt + 3 * srcTexel + 0.08 * relief;
      const nativeZ = Math.min(node.z, this.m.maxZoom);
      const nbSrcZ = this._nbTransientSrcZ(node);
      const worstZ = Math.min(hSrc.z < nativeZ ? hSrc.z : Infinity, nbSrcZ);
      if (worstZ < nativeZ)
        skirt += 4 * (this.spanAt(worstZ) / this.m.tileSize) + 0.17 * relief;
      u.uSkirt.value = skirt;
      // cascaded geomorph: a node is selected for nearest-point distances in [handoff,
      // 2*handoff) — finer children take over below, the parent above. Band 1 must be 0 at
      // the ring start and 1 by 2*handoff (where a coarser neighbour's base surface begins);
      // later bands (see surfaceH) keep far vertices consistent with neighbours that are
      // already morphing toward THEIR parents.
      const handoff = (node.bounds.size / this.m.tileSize) * this._projScale /
        this._pixelErrorAt(node.bounds);
      u.uMorphBase.value = handoff;
      u.uFogNear.value = this.scene.fog.near; u.uFogFar.value = this.scene.fog.far;
      u.uTime.value = this._timeSec;
      if (this.horizonTex[0] && !u.uHorizonA.value) {
        u.uHorizonA.value = this.horizonTex[0]; u.uHorizonB.value = this.horizonTex[1];
        u.uHasHorizon.value = 1; u.uHorizonMax.value = this.horizonMaxAngle;
      }
      if (this.aoTex && !u.uAO.value) {          // AO baked in after this mesh was created
        u.uAO.value = this.aoTex; u.uHasAO.value = 1;
      }
      if (this.lcTex && !u.uLandcover.value) {  // landcover loaded after this mesh was created
        u.uLandcover.value = this.lcTex;
        u.uLCMin.value.copy(this.lcMap.min); u.uLCInv.value.copy(this.lcMap.inv);
        u.uHasLC.value = 1;
      }
      if (this.roadsTex && !u.uRoads.value) {   // roads baked in after this mesh was created
        u.uRoads.value = this.roadsTex;
        u.uRoadsOrigin.value.copy(this.roadsMap.origin);
        u.uRoadsInv.value.copy(this.roadsMap.inv);
        u.uHasRoads.value = 1;
      }
      n.mesh.visible = true;
      n.lastShown = this.frame;
    }

    /* Min height-source z among edge neighbours that are still rendering from a coarser
       ANCESTOR tile (streaming transient). Infinity when every neighbour is native. Used to
       deepen this node's skirt while a neighbour's surface can still jump by a whole
       ancestor-texel worth of relief when its native tile lands. */
    _nbTransientSrcZ(node) {
      let worst = Infinity;
      const consider = n => {
        if (!n || n.internal || !n.render || !n.hSrc) return;
        const nat = Math.min(n.z, this.m.maxZoom);
        if (n.hSrc.z < nat && n.hSrc.z < worst) worst = n.hSrc.z;
      };
      // Neighbour offsets and child pairs are computed arithmetically rather than through array
      // literals: this runs for every visible node every frame, and the old form built five
      // arrays plus up to eight template-string keys per call.
      const z = node.z;
      for (let side = 0; side < 4; side++) {
        const nx = node.x + (side === 0 ? -1 : side === 1 ? 1 : 0);
        const ny = node.y + (side === 2 ? -1 : side === 3 ? 1 : 0);
        const same = this._getNode(z, nx, ny);
        if (same) {
          if (!same.internal) { consider(same); continue; }
          // finer subtree: the two z+1 children along the shared edge
          const cx0 = nx * 2, cy0 = ny * 2;
          // side 0 (west neighbour) -> its east column; 1 -> west column; 2 -> south row; 3 -> north row
          const kx0 = side === 0 ? cx0 + 1 : cx0;
          const ky0 = side === 2 ? cy0 + 1 : cy0;
          const kx1 = side === 0 ? cx0 + 1 : side === 1 ? cx0 : cx0 + 1;
          const ky1 = side === 2 ? cy0 + 1 : side === 3 ? cy0 : cy0 + 1;
          consider(this._getNode(z + 1, kx0, ky0));
          consider(this._getNode(z + 1, kx1, ky1));
          continue;
        }
        consider(this._getNode(z - 1, nx >> 1, ny >> 1));
      }
      return worst;
    }

    /* grid resolution per node depth (deterministic; deepest → densest).
       Ultra z=maxDepth:160, -1:64, -2:64, -3:32, coarser:16; quality profiles may replace
       those resolutions while preserving the integral parent/child ratio — every pair keeps
       2*childN/parentN integral so parent grid vertices land on child vertex positions. */
    _gridIndexForZ(z) {
      const d = Math.max(0, this.maxDepth - z);
      if (d === 0 && this._gridShift) return 2;   // deepest -> 64: texel-exact on 10 m data
      return [3, 2, 2, 1, 0][Math.min(d, 4)];
    }

    /* height range (m) of source tile e inside uv window win — from a lazy 8x8 min/max mip */
    _windowRelief(e, win) {
      if (!e.mip) {
        if (!e.decoded) return 0;
        const S = this.m.tileSize, C = 8, cs = S / C;
        const mn = new Float32Array(C * C).fill(Infinity);
        const mx = new Float32Array(C * C).fill(-Infinity);
        for (let j = 0; j < S; j += 2) {
          const row = ((j / cs) | 0) * C;
          for (let i = 0; i < S; i += 2) {
            const v = e.decoded[j * S + i], c = row + ((i / cs) | 0);
            if (v < mn[c]) mn[c] = v;
            if (v > mx[c]) mx[c] = v;
          }
        }
        e.mip = { mn, mx, C };
      }
      const C = e.mip.C;
      const x0 = Math.max(0, Math.floor(win.x * C)), x1 = Math.min(C - 1, Math.ceil((win.x + win.z) * C) - 1);
      const y0 = Math.max(0, Math.floor(win.y * C)), y1 = Math.min(C - 1, Math.ceil((win.y + win.z) * C) - 1);
      let lo = Infinity, hi = -Infinity;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const c = j * C + i;
        if (e.mip.mn[c] < lo) lo = e.mip.mn[c];
        if (e.mip.mx[c] > hi) hi = e.mip.mx[c];
      }
      return hi > lo ? hi - lo : 0;
    }

    /* Exact compact min/max cells used only for conservative reflection-pass culling. Unlike the
       relief estimate above, this scans every decoded sample once; the 512-byte result survives
       release of the 1 MiB CPU height tile. Intersecting whole cells can only overestimate a
       node's range, so uncertain terrain remains rendered. */
    _windowHeightBounds(e, win) {
      if (!e) return null;
      if (!e.rangeMip) {
        if (!e.decoded) return null;
        const S = this.m.tileSize, C = 8, cs = S / C;
        const mn = new Float32Array(C * C).fill(Infinity);
        const mx = new Float32Array(C * C).fill(-Infinity);
        for (let j = 0; j < S; j++) {
          const row = Math.min(C - 1, (j / cs) | 0) * C;
          for (let i = 0; i < S; i++) {
            const value = e.decoded[j * S + i], cell = row + Math.min(C - 1, (i / cs) | 0);
            if (value < mn[cell]) mn[cell] = value;
            if (value > mx[cell]) mx[cell] = value;
          }
        }
        e.rangeMip = { mn, mx, C };
      }
      const mip = e.rangeMip, C = mip.C;
      const x0 = Math.max(0, Math.floor(win[0] * C));
      const x1 = Math.min(C - 1, Math.ceil((win[0] + win[2]) * C) - 1);
      const y0 = Math.max(0, Math.floor(win[1] * C));
      const y1 = Math.min(C - 1, Math.ceil((win[1] + win[2]) * C) - 1);
      let lo = Infinity, hi = -Infinity;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const cell = j * C + i;
        if (mip.mn[cell] < lo) lo = mip.mn[cell];
        if (mip.mx[cell] > hi) hi = mip.mx[cell];
      }
      return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
    }

    _prefetch(visible) {
      const vel = new THREE.Vector3().subVectors(this.camera.position, this._prevCam);
      for (const cache of [this.hCache, this.iCache]) for (const e of cache.values()) {
        if (e.prefetchProtected && e.prefetchUntil < this.frame) {
          e.prefetchProtected = false;
          if (e.layer != null) (e.kind === 'h' ? this.arrayPool?.height : this.arrayPool?.imagery)
            ?.unprotect(e.key, 'prefetch');
        }
      }
      const protect = e => {
        if (!e) return e;
        e.prefetchProtected = true; e.prefetchUntil = this.frame + 2;
        if (e.layer != null) (e.kind === 'h' ? this.arrayPool?.height : this.arrayPool?.imagery)
          ?.protect(e.key, 'prefetch');
        return e;
      };
      // Keep a coarse panoramic height + imagery ring resident. Frustum-only requests made a fast
      // 180° turn expose undecoded tiles even though the camera had not moved; the normal fine
      // requests still replace this fallback as soon as the new view becomes active.
      {
        const z = Math.max(0, this.maxDepth - 2);
        const span = this.rootSpan / (1 << z);
        const cx = Math.floor((this.camera.position.x + this.spanX / 2) / span);
        const cy = Math.floor((this.camera.position.z + this.spanZ / 2) / span);
        const panoKey = `${z}/${cx}/${cy}`;
        if (panoKey !== this._panoPrefetchKey) {
          this._panoPrefetchKey = panoKey;
          const [nx, ny] = this.tilesAtZoom(z);
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && y >= 0 && x < nx && y < ny) {
              const hz = Math.min(z, this.m.maxZoom), hs = z - hz;
              protect(this._reqHeight(hz, x >> hs, y >> hs, 9200 + dx * dx + dy * dy));
              if (this.img) {
                const iz = Math.min(z, this.img.maxZoom), is = z - iz;
                protect(this._reqImagery(iz, x >> is, y >> is, 9000 + dx * dx + dy * dy));
              }
            }
          }
        }
      }
      const moving = vel.x * vel.x + vel.z * vel.z > 1;
      for (const node of visible) {
        const hz = Math.min(node.z, this.m.maxZoom);
        if (hz > 0) this._reqHeight(hz - 1, node.x >> (node.z - hz + 1),
          node.y >> (node.z - hz + 1), node.dist + 5000);
        if (!moving) continue;
        const [gx, gy] = this.tilesAtZoom(node.z);
        const nx = node.x + (vel.x > 0 ? 1 : -1), ny = node.y + (vel.z > 0 ? 1 : -1);
        if (nx >= 0 && nx < gx) {
          protect(this._reqHeight(Math.min(node.z, this.m.maxZoom), nx >> (node.z - hz), node.y >> (node.z - hz), node.dist + 2000));
          if (this.img) protect(this._reqImagery(Math.min(node.z, this.img.maxZoom), nx, node.y, node.dist + 2500));
        }
        if (ny >= 0 && ny < gy && this.img)
          protect(this._reqImagery(Math.min(node.z, this.img.maxZoom), node.x, ny, node.dist + 2500));
      }
      this._prefetchPredicted();
    }

    _predictedFrustum(pose) {
      const camera = this._predictionCamera || (this._predictionCamera = this.camera.clone());
      camera.fov = this.camera.fov; camera.aspect = this.camera.aspect;
      camera.near = this.camera.near; camera.far = this.camera.far;
      camera.updateProjectionMatrix();
      camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
      camera.rotation.order = 'YXZ'; camera.rotation.set(pose.pitch, pose.yaw, 0);
      camera.updateMatrixWorld(true);
      const matrix = this._predictionMatrix || (this._predictionMatrix = new THREE.Matrix4());
      const frustum = this._predictionFrustumScratch ||
        (this._predictionFrustumScratch = new THREE.Frustum());
      frustum.setFromProjectionMatrix(matrix.multiplyMatrices(
        camera.projectionMatrix, camera.matrixWorldInverse));
      return frustum;
    }

    _nodeDistFrom(b, position) {
      const dx = Math.max(b.minX - position[0], 0, position[0] - (b.minX + b.wpt));
      const dz = Math.max(b.minZ - position[2], 0, position[2] - (b.minZ + b.hpt));
      return Math.max(1, Math.hypot(dx, dz));
    }

    _collectPredictedCandidates(pose, height, imagery) {
      const frustum = this._predictedFrustum(pose), projScale = this._projScale;
      const forward = [-Math.sin(pose.yaw) * Math.cos(pose.pitch), Math.sin(pose.pitch),
                       -Math.cos(pose.yaw) * Math.cos(pose.pitch)];
      const visit = (z, x, y) => {
        const b = this.tileWorldBounds(z, x, y);
        if (!frustum.intersectsBox(this._nodeBox(b))) return;
        const dist = this._nodeDistFrom(b, pose.position);
        const texel = b.size / this.m.tileSize;
        const threshold = this._pixelErrorAt(b);
        const gridN = this.o.gridByLOD[this._gridIndexForZ(z)];
        const errorMeters = this._nodeGeometricError(z, x, y, gridN, b);
        const legacySse = texel * projScale / dist;
        const decision = global.GT_TERRAIN_VISIBILITY?.terrainShouldSubdivide({
          errorMeters, projectionScale: projScale, nearestDistance: dist,
          pixelThreshold: threshold, legacySse, forceLegacy: !this._visibilityEnabled,
        }) || { subdivide: legacySse > threshold };
        const coreFloor = errorMeters == null ? this.o.coreFloorZ : Math.min(6, this.o.coreFloorZ);
        if (coreFloor && z < coreFloor && this._overlapsCore(b)) decision.subdivide = true;
        if (errorMeters != null && z >= 6 && this._overlapsCore(b)) decision.subdivide = false;
        if (z < this.maxDepth && decision.subdivide) {
          const [nx, ny] = this.tilesAtZoom(z + 1);
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const cx = x * 2 + dx, cy = y * 2 + dy;
            if (cx < nx && cy < ny) visit(z + 1, cx, cy);
          }
          return;
        }
        this._visibilityStats.predictedLeaves++;
        const cx = b.minX + b.wpt * 0.5, cy = (this.m.elevation.min +
          this.m.elevation.max) * 0.5 - this.datum, cz = b.minZ + b.hpt * 0.5;
        const vx = cx - pose.position[0], vy = cy - pose.position[1], vz = cz - pose.position[2];
        const inv = 1 / Math.max(1, Math.hypot(vx, vy, vz));
        const centrality = 1 - Math.max(-1, Math.min(1,
          (vx * forward[0] + vy * forward[1] + vz * forward[2]) * inv));
        const hz = Math.min(z, this.m.maxZoom), hs = z - hz;
        height.push({ key: `${hz}/${x >> hs}/${y >> hs}`, z: hz, x: x >> hs, y: y >> hs,
                      time: pose.t, centrality, distance: dist });
        if (this.img) {
          const iz = Math.min(z, this.img.maxZoom), shift = z - iz;
          imagery.push({ key: `${iz}/${x >> shift}/${y >> shift}`, z: iz,
            x: x >> shift, y: y >> shift, time: pose.t, centrality, distance: dist });
        }
      };
      const [nx, ny] = this.tilesAtZoom(0);
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) visit(0, x, y);
    }

    _prefetchPredicted() {
      const state = this._predictionState;
      // Prediction is visibility planning, not animation. Rebuild at 15 Hz; current-frustum
      // traversal still runs every frame. Teleports bypass the cadence and clear immediately.
      if (state && !state.teleported && this._lastPredictionFrame != null &&
          this.frame - this._lastPredictionFrame < 4) return;
      this._lastPredictionFrame = this.frame;
      this._visibilityStats.predictedLeaves = 0;
      this._visibilityStats.warmHeightSources = 0;
      this._visibilityStats.warmImagerySources = 0;
      for (const cache of [this.hCache, this.iCache]) for (const e of cache.values()) {
        if (!e.predictionProtected) continue;
        e.predictionProtected = false;
        (e.kind === 'h' ? this.arrayPool?.height : this.arrayPool?.imagery)
          ?.unprotect(e.key, 'prediction');
      }
      if (!state || state.teleported || !this._visibilityEnabled) {
        const old = this._lastWarmKeys?.size || 0;
        this._visibilityStats.warmCancelled += old;
        this._lastWarmKeys = new Set();
        return;
      }
      const predictor = global.GT_TERRAIN_VISIBILITY;
      if (!predictor?.predictTerrainPoses || !predictor?.selectTerrainWarmSources) return;
      const camera = this.camera;
      const euler = this._predictionEuler || (this._predictionEuler = new THREE.Euler(0, 0, 0, 'YXZ'));
      euler.setFromQuaternion(camera.quaternion, 'YXZ');
      const poses = predictor.predictTerrainPoses({ ...state,
        position: [camera.position.x, camera.position.y, camera.position.z],
        yaw: euler.y, pitch: euler.x,
      });
      const heights = [], imagery = [];
      for (const pose of poses) this._collectPredictedCandidates(pose, heights, imagery);
      const hCapacity = Math.min(32, Math.floor((this.arrayPool?.height?.capacity ||
        this.o.heightArrayLayers) * 0.25));
      const iCapacity = Math.min(32, Math.floor((this.arrayPool?.imagery?.capacity ||
        this.o.imageryArrayLayers) * 0.25));
      const selectedH = predictor.selectTerrainWarmSources(heights, hCapacity);
      const selectedI = predictor.selectTerrainWarmSources(imagery, iCapacity);
      const nextKeys = new Set();
      const protect = (kind, candidate) => {
        const e = kind === 'h'
          ? this._reqHeight(candidate.z, candidate.x, candidate.y, candidate.distance + 1000)
          : this._reqImagery(candidate.z, candidate.x, candidate.y, candidate.distance + 1200);
        if (!e) return;
        e.predictionProtected = true; nextKeys.add(`${kind}:${e.key}`);
        (kind === 'h' ? this.arrayPool?.height : this.arrayPool?.imagery)
          ?.protect(e.key, 'prediction');
      };
      for (const candidate of selectedH) protect('h', candidate);
      for (const candidate of selectedI) protect('i', candidate);
      if (this._lastWarmKeys) for (const taggedKey of this._lastWarmKeys) {
        if (nextKeys.has(taggedKey)) continue;
        this._visibilityStats.warmCancelled++;
        const split = taggedKey.indexOf(':'), kind = taggedKey.slice(0, split);
        const key = taggedKey.slice(split + 1), cache = kind === 'h' ? this.hCache : this.iCache;
        const e = cache.get(key);
        // Cancel only work that remained prediction-only this frame. A source independently
        // touched by the current view/query corridor has lastUsed===frame and must finish.
        if (!e || e.lastUsed === this.frame || e.persistent || e.queryProtected ||
            e.prefetchProtected) continue;
        if (e.state === 'queued') {
          this._requestCounters[e.kind === 'h' ? 'height' : 'imagery'].cancellations++;
          e._cancellationCounted = true;
          e.state = 'stale'; cache.delete(key);
        } else if (e.state === 'loading') {
          this._requestCounters[e.kind === 'h' ? 'height' : 'imagery'].cancellations++;
          e._cancellationCounted = true;
          e.abort?.abort(); cache.delete(key);
        }
      }
      this._lastWarmKeys = nextKeys;
      this._visibilityStats.warmHeightSources = selectedH.length;
      this._visibilityStats.warmImagerySources = selectedI.length;
    }

    _rehydrateHeight(e) {
      if (!e || e.decoded || e.cpuLoading || e.state !== 'ready') return;
      this._requestCounters.height.misses++;
      e.cpuLoading = true; this.inFlight++;
      const generation = this.generation;
      fetch(this._urlH(e.z, e.x, e.y))
        .then(r => r.ok ? r.blob() : Promise.reject(new Error(`height HTTP ${r.status}`)))
        .then(blob => {
          this._requestCounters.height.downloadedBytes += blob.size;
          return createImageBitmap(blob);
        })
        .then(bmp => this._decodeHeightAsync(bmp, e.z, e.x, e.y, -9000))
        .then(decoded => {
          if (generation !== this.generation || this.hCache.get(e.key) !== e) return;
          e.decoded = decoded; this._mirrorHeightTile(e);
          this._requestCounters.height.completions++;
        })
        .catch(error => {
          if (error?.name === 'AbortError') this._requestCounters.height.cancellations++;
          else this._requestCounters.height.failures++;
        })
        .finally(() => { e.cpuLoading = false; this.inFlight--; });
    }

    _updateQueryCorridor() {
      if (!this._batched || !this.m) return;
      const radius = this.o.queryRadius, z = this.m.maxZoom, span = this.spanAt(z);
      const cx = this.camera.position.x, cz = this.camera.position.z;
      const desired = new Set();
      const [countX, countY] = this.tilesAtZoom(z);
      const minX = Math.max(0, Math.floor((cx - radius + this.spanX / 2) / span));
      const maxX = Math.min(countX - 1, Math.floor((cx + radius + this.spanX / 2) / span));
      const minY = Math.max(0, Math.floor((cz - radius + this.spanZ / 2) / span));
      const maxY = Math.min(countY - 1, Math.floor((cz + radius + this.spanZ / 2) / span));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const b = this.tileWorldBounds(z, x, y);
        const dx = Math.max(b.minX - cx, 0, cx - (b.minX + b.wpt));
        const dz = Math.max(b.minZ - cz, 0, cz - (b.minZ + b.hpt));
        if (dx * dx + dz * dz <= radius * radius) desired.add(`${z}/${x}/${y}`);
      }
      let fx = this.camera.position.x - this._prevCam.x;
      let fz = this.camera.position.z - this._prevCam.z;
      if (fx * fx + fz * fz < 1e-4) {
        const direction = this._queryForward || (this._queryForward = new THREE.Vector3());
        this.camera.getWorldDirection(direction); fx = direction.x; fz = direction.z;
      }
      const fl = Math.hypot(fx, fz) || 1;
      const aheadX = cx + fx / fl * (radius + span * 0.5);
      const aheadZ = cz + fz / fl * (radius + span * 0.5);
      const ax = Math.floor((aheadX + this.spanX / 2) / span);
      const ay = Math.floor((aheadZ + this.spanZ / 2) / span);
      if (ax >= 0 && ay >= 0 && ax < countX && ay < countY) desired.add(`${z}/${ax}/${ay}`);

      for (const e of this.hCache.values()) {
        const wanted = e.persistent || desired.has(e.key);
        e.queryProtected = wanted && !e.persistent;
        if (e.layer != null) {
          if (wanted) this.arrayPool.height.protect(e.key, 'query');
          else this.arrayPool.height.unprotect(e.key, 'query');
        }
        if (wanted && !e.decoded) this._rehydrateHeight(e);
        if (!wanted && !e.persistent && e.decoded && e.state === 'ready') {
          e.cpuReleaseAt ||= performance.now() + 10000;
          if (performance.now() < e.cpuReleaseAt) continue;
          // The 8x8 relief mip is enough for future skirt calculations; GPU rendering no longer
          // needs the full 1 MiB Float32Array once the tile is outside CPU consumers' corridor.
          this._windowRelief(e, { x: 0, y: 0, z: 1 });
          e.decoded = null;
          this.worldIndex?.remove(e.key); this._worldHeightMirrors.delete(e.key);
        }
        if (wanted) e.cpuReleaseAt = 0;
      }
      for (const key of desired) {
        const parts = key.split('/').map(Number);
        const e = this._reqHeight(parts[0], parts[1], parts[2], -9000);
        e.queryProtected = true;
        if (e.layer != null) this.arrayPool.height.protect(e.key, 'query');
        if (!e.decoded) this._rehydrateHeight(e);
      }
      this._queryTileKeys = desired;
    }

    /* ================= collision / heightAt ================= */
    async _loadBaseCollision() {
      // z3 = ~20 m/px; its 15 tiles plus nine coarser ancestors are ~24 MB decoded. Water surfaces
      // are BUILT from z3 heights, and 80 m base data draped the Snake/creeks visibly wrong.
      const z = Math.min(this.m.minZoom + 3, this.m.maxZoom);
      // Every coarser tile is a render ancestor of these collision tiles. Once requested, retain
      // it as a GPU safety fallback too; otherwise a panoramic turn can evict the only drawable
      // z0-z2 source even though the deeper persistent collision level remains resident.
      this._persistentHeightMaxZ = z;
      const jobs = [];
      // Load every ancestor through the collision level. A z3 tile cannot render a z0-z2 leaf;
      // retaining only the deepest collision level left panoramic/turning views without a legal
      // fallback until those coarse requests happened to arrive.
      for (let level = 0; level <= z; level++) {
        const [nx, ny] = this.tilesAtZoom(level);
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const key = `${level}/${x}/${y}`;
        const e = {
          kind: 'h', key, z: level, x, y, state: 'loading', lastUsed: 0, persistent: true,
          generation: this.generation,
        };
        this.hCache.set(key, e);
        this._requestCounters.height.misses++;
        jobs.push(fetch(this._urlH(z, x, y))
          .then(r => { if (!r.ok) throw new Error(`base tile ${key}: HTTP ${r.status}`); return r.blob(); })
          .then(blob => {
            this._requestCounters.height.downloadedBytes += blob.size;
            return createImageBitmap(blob);
          })
          .then(async bmp => {
            e.decoded = await this._decodeHeightAsync(bmp, e.z, e.x, e.y, -10000);
            this._mirrorHeightTile(e);
            this._requestCounters.height.completions++;
            e.state = 'decoded'; this._queueUpload(e);
          }).catch(error => { this._requestCounters.height.failures++; throw error; }));
        }
      }
      await Promise.all(jobs);
    }

    /* Keep one complete coarse imagery level resident. Every visible node can therefore render
       a geographically correct ancestor immediately after a turn or teleport; finer imagery
       only sharpens it, instead of replacing a procedural beige/grey tile seconds later. */
    async _loadBaseImagery() {
      const z = Math.min(3, this.img.maxZoom);
      const [nx, ny] = this.tilesAtZoom(z);
      const jobs = [];
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const key = `${z}/${x}/${y}`;
        if (this.iCache.has(key)) continue;
        const e = {
          kind: 'i', key, z, x, y, state: 'loading', lastUsed: 0, persistent: true,
          generation: this.generation,
        };
        this.iCache.set(key, e);
        this._requestCounters.imagery.misses++;
        jobs.push(this._prepareImageryAsync(this._urlI(z, x, y), z, x, y, -10000)
          .then(result => {
            this._requestCounters.imagery.downloadedBytes += Number(result.downloadedBytes) || 0;
            this._requestCounters.imagery.completions++;
            e.prepared = result.prepared;
            if (this._batched) {
              const valid = this._validTexels(z, x, y);
              const ready = this.arrayPool.uploadImagery(key, result.bitmap, {
                prepared: result.prepared, validX: valid[0], validY: valid[1], persistent: true,
              });
              e.tex = ready.texture; e.layer = ready.layer;
            } else e.tex = this._imageryTexture(result.bitmap, z, x, y, result.prepared);
            e.state = 'ready';
            e._uploadCount = 1;
            this._requestCounters.imagery.uploads++;
            this._streamStats.imageryPrepared++;
            this._streamStats.uploads++;
          })
          .catch(error => {
            this._requestCounters.imagery.failures++;
            this.iCache.delete(key);
            throw new Error(`base imagery tile ${key}: ${error && error.message || error}`);
          }));
      }
      await Promise.all(jobs);
    }

    _mirrorHeightTile(e) {
      if (!this.worldIndex?.ready || !e?.decoded || e.generation !== this.generation) return false;
      const b = this.tileWorldBounds(e.z, e.x, e.y);
      const installed = this.worldIndex.installHeightTile({
        id: e.key, generation: this.worldIndex.generation, z: e.z, x: e.x, y: e.y,
        data: e.decoded, size: this.m.tileSize,
        minX: b.minX, minZ: b.minZ, width: b.wpt, height: b.hpt,
      });
      if (!installed) return false;
      this._worldHeightMirrors.delete(e.key);
      this._worldHeightMirrors.set(e.key, this.frame);
      while (this._worldHeightMirrors.size > this._worldHeightMirrorMax) {
        const oldest = this._worldHeightMirrors.keys().next().value;
        this._worldHeightMirrors.delete(oldest);
        this.worldIndex.remove(oldest);
      }
      return true;
    }

    heightAt(x, z) {
      const best = this._decodedTileAt(x, z);
      if (!best) return this.m.elevation.min - this.datum;
      const grid = best.e.decoded, b = best.b, N = this.m.tileSize;
      let u = ((x - b.minX) / b.wpt) * (N - 1);
      let v = ((z - b.minZ) / b.hpt) * (N - 1);
      u = Math.max(0, Math.min(N - 1.001, u)); v = Math.max(0, Math.min(N - 1.001, v));
      const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
      const a = grid[j * N + i], bb = grid[j * N + i + 1];
      const c = grid[(j + 1) * N + i], d = grid[(j + 1) * N + i + 1];
      return (a + (bb - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
    }

    _decodedTileAt(x, z) {
      let best = null;
      for (const e of this.hCache.values()) {
        if (!e.decoded) continue;
        const b = this.tileWorldBounds(e.z, e.x, e.y);
        if (x >= b.minX && x < b.minX + b.wpt && z >= b.minZ && z < b.minZ + b.hpt) {
          if (!best || e.z > best.e.z) best = { e, b };
        }
      }
      return best;
    }
  }

  global.TerrainStreamer = TerrainStreamer;
})(window);
