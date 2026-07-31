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
    meshIdleFrames: 240,      // prune node meshes unseen for this many frames
    uploadsPerFrame: 6,       // near-field imagery must land fast (was a visible beige lag)
    maxConcurrentFetch: 12,
    pixelError: 1.8,          // screen-space error (px) before subdividing
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
    ultra:    Object.freeze({ height: 300, imagery: 250 }),
    high:     Object.freeze({ height: 240, imagery: 300 }),
    balanced: Object.freeze({ height: 180, imagery: 200 }),
    low:      Object.freeze({ height: 120, imagery: 120 }),
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
      }
      this._quality = quality;
      this._naturalColor = !/[?&]naturalcolor=0(?:&|$)/.test(global.location?.search || '');
      this.scene = opts.scene; this.camera = opts.camera; this.renderer = opts.renderer;
      this.group = new THREE.Group(); this.group.name = 'terrainTiles'; this.scene.add(this.group);
      this.hCache = new Map();      // height tiles: decoded Float32 + DataTexture
      this.iCache = new Map();      // imagery tiles: THREE.Texture
      this.meshes = new Map();      // node key -> {mesh, lastShown}
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
      this._telemetryAt = 0;
      this.visibleTerrainCoverage = {
        visibleLeaves: 0, drawableLeaves: 0, missingLeaves: [], ratio: 0,
        nativeHeightLeaves: 0, nativeHeightRatio: 0, complete: false,
      };
      this.grids = this.o.gridByLOD.map(n => makeGrid(n));
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
        if (frameMs > 0 && frameMs < 1000)
          this.gpuMs = this.gpuMs == null ? frameMs : this.gpuMs + (frameMs - this.gpuMs) * 0.15;
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

      // optional imagery pyramid (same grid family)
      this.img = null;
      try {
        const im = await (await fetch(this.baseUrl + 'imagery.json')).json();
        const rs = im.tileSize * Math.pow(2, im.maxZoom) * im.nativePixelSize;
        if (Math.abs(rs - this.rootSpan) > 1)
          console.warn('[terrain] imagery grid family mismatch', rs, this.rootSpan);
        else { this.img = im; this.maxDepth = Math.max(this.maxDepth, im.maxZoom); }
      } catch (e) { /* no imagery baked yet — procedural palette */ }

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
        return { bitmap: await createImageBitmap(await response.blob()), prepared: false };
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
      return { bitmap: reply.buffers[0], prepared: true };
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
      if (e) { e.lastUsed = this.frame; return e; }
      e = {
        kind: 'h', key, z, x, y, state: 'queued', lastUsed: this.frame, priority,
        generation: this.generation,
      };
      this.hCache.set(key, e);
      this.fetchQueue.push(e);
      return e;
    }
    _reqImagery(z, x, y, priority) {
      if (!this.img) return null;
      const key = `${z}/${x}/${y}`;
      let e = this.iCache.get(key);
      if (e) { e.lastUsed = this.frame; return e; }
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
              .then(b => createImageBitmap(b))
              .then(bitmap => ({ bitmap, prepared: false }));
        load
          .then(async result => {
            const bmp = result.bitmap;
            e.prepared = result.prepared;
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
            this.uploadQueue.push(e);
          })
          .catch(error => {
            if (error && error.name === 'AbortError') this._streamStats.stale++;
            const c = e.kind === 'h' ? this.hCache : this.iCache;
            if (c.get(e.key) === e) c.delete(e.key);
          })
          .finally(() => { this.inFlight--; });
      }
    }

    _pumpUploads() {
      const frameMs = global.GT_FRAME_MS || 16.7;
      let n = frameMs > 28 ? 1 : frameMs > 20 ? Math.min(3, this.o.uploadsPerFrame)
                                             : this.o.uploadsPerFrame;
      while (n-- > 0 && this.uploadQueue.length) {
        const e = this.uploadQueue.shift();
        if (e.state !== 'decoded' || e.generation !== this.generation) {
          e.bmp?.close?.();
          continue;
        }
        if (e.kind === 'h') {
          e.tex = this._heightTexture(e.decoded);
        } else {
          const source = e.bmp;
          e.tex = this._imageryTexture(source, e.z, e.x, e.y, e.prepared, () => {
            if (e.bmp === source) e.bmp = null;
          });
        }
        e.state = 'ready';
        this._streamStats.uploads++;
      }
    }

    _publishTelemetry() {
      const now = performance.now();
      if (now - this._telemetryAt < 500) return;
      this._telemetryAt = now;
      const memory = this._memoryEstimate();
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
        ...this._streamStats,
        workers: this.workerPool ? this.workerPool.snapshot() : null,
        worldIndex: this.worldIndex ? this.worldIndex.snapshot() : null,
        worldHeightMirrors: this._worldHeightMirrors.size,
        worldHeightMirrorMax: this._worldHeightMirrorMax,
      };
      this.worldIndex?.refreshMemory();
    }

    _memoryEstimate() {
      let heightCpuBytes = 0, heightGpuBytes = 0, imageryDecodedBytes = 0,
          imageryGpuBytes = 0;
      for (const e of this.hCache.values()) {
        heightCpuBytes += e.decoded?.byteLength || 0;
        if (e.tex) heightGpuBytes += this.m.tileSize * this.m.tileSize * 4;
      }
      for (const e of this.iCache.values()) {
        if (e.bmp) imageryDecodedBytes += this.img.tileSize * this.img.tileSize * 4;
        if (e.tex) imageryGpuBytes += Math.ceil(this.img.tileSize * this.img.tileSize * 4 * 4 / 3);
      }
      return {
        heightCpuBytes, heightGpuBytes, imageryDecodedBytes, imageryGpuBytes,
        estimatedTerrainBytes:
          heightCpuBytes + heightGpuBytes + imageryDecodedBytes + imageryGpuBytes,
      };
    }

    memorySnapshot() {
      return {
        heightTiles: this.hCache.size,
        heightTileLimit: this.o.heightCacheMax,
        imageryTiles: this.iCache.size,
        imageryTileLimit: this.o.imageryCacheMax,
        ...this._memoryEstimate(),
      };
    }

    setQuality(quality) {
      const residency = RESIDENCY_BY_QUALITY[quality];
      if (!residency) return false;
      this._quality = quality;
      this.o.heightCacheMax = residency.height;
      this.o.imageryCacheMax = residency.imagery;
      this._evict();
      this._publishTelemetry();
      return true;
    }

    _evict() {
      const trim = (cache, max) => {
        if (cache.size <= max) return;
        const live = [...cache.values()]
          .filter(e => !e.persistent && (e.state === 'ready' || e.state === 'decoded'))
          .sort((a, b) => a.lastUsed - b.lastUsed);
        let over = cache.size - max;
        for (const e of live) {
          if (over-- <= 0 || e.lastUsed === this.frame) break;
          e.tex?.dispose(); e.bmp?.close?.();
          if (e.kind === 'h') {
            this.worldIndex?.remove(e.key);
            this._worldHeightMirrors.delete(e.key);
          }
          cache.delete(e.key);
        }
      };
      trim(this.hCache, this.o.heightCacheMax);
      trim(this.iCache, this.o.imageryCacheMax);
      // prune node meshes unseen for a while (materials only; geometry is shared)
      for (const [k, n] of this.meshes) {
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
      const cam = this.camera;
      if (this.frame > 1 && cam.position.distanceToSquared(this._prevCam) > 1500 * 1500) {
        this.generation++;
        this.workerPool?.supersede('terrain', this.generation);
        for (const e of this.fetchQueue) if (e.state === 'queued') e.state = 'stale';
        this.fetchQueue.length = 0;
        for (const e of this.uploadQueue) {
          e.bmp?.close?.();
          const cache = e.kind === 'h' ? this.hCache : this.iCache;
          if (!e.persistent) cache.delete(e.key);
        }
        this.uploadQueue.length = 0;
        for (const cache of [this.hCache, this.iCache]) {
          for (const [key, e] of cache) {
            if (!e.persistent && e.state === 'loading') {
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
      for (const node of visible)
        node.hSrc = this._source(this.hCache, this._reqHeight, node,
                                 Math.min(node.z, this.m.maxZoom));
      for (const node of visible) node.nativeHeightMaxZoom = this.m.maxZoom;
      for (const node of visible) this._renderNode(node);
      for (const n of this.meshes.values())
        if (n.lastShown !== this.frame) n.mesh.visible = false;
      this.visibleTerrainCoverage = global.GT_TERRAIN_COVERAGE.summarizeVisibleTerrain(
        visible, this.meshes, this.frame);

      this._pumpFetches();
      this._pumpUploads();
      this._prefetch(visible);
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

    // Descend the quadtree, recording EVERY visited node (internal + leaf) in the level maps so
    // the balance pass below can see the whole rendered set. Frustum-culled subtrees are simply
    // never recorded — they aren't rendered, so no seam can show against them.
    _traverse(z, x, y, projScale) {
      const b = this.tileWorldBounds(z, x, y);
      if (!this._frustum.intersectsBox(this._nodeBox(b))) return;
      const dist = this._nodeDist(b);
      const texel = b.size / this.m.tileSize;            // meters per rendered texel at this z
      const sse = (texel * projScale) / dist;
      // core floor: force the Cathedral Group box to subdivide to coreFloorZ even when the SSE would
      // stop earlier (distant valley view), so the hero peaks stay razor-sharp from anywhere.
      const forceCore = this.o.coreFloorZ && z < this.o.coreFloorZ && this._overlapsCore(b);
      if (z < this.maxDepth && (sse > this._pixelErrorAt(b) || forceCore)) {
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
    _edgeR(node, dx, dy, fineN) {
      const z = node.z, nx = node.x + dx, ny = node.y + dy;
      const g = this.tilesAtZoom(z), gx = g[0], gy = g[1];
      if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) return 0;    // park boundary — skirt covers
      if (this._hasNode(z, nx, ny)) return 0;                    // same level, or finer subtree
      const p = this._getNode(z - 1, nx >> 1, ny >> 1);
      if (!p || p.internal) return 0;                            // unrendered region
      const coarseN = this.o.gridByLOD[this._gridIndexForZ(z - 1)];
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
      const handoff = (node.bounds.size / this.m.tileSize) * this._projScale / this._pixelErrorAt(node.bounds);
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
      if (!e.decoded) return 0;
      if (!e.mip) {
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

    _prefetch(visible) {
      const vel = new THREE.Vector3().subVectors(this.camera.position, this._prevCam);
      // Keep a coarse panoramic imagery ring resident. Frustum-only requests made a fast 180°
      // turn expose undecoded tiles even though the camera had not moved; the normal fine requests
      // still replace this fallback as soon as the new view becomes active.
      if (this.img) {
        const z = Math.min(this.img.maxZoom, Math.max(0, this.maxDepth - 2));
        const span = this.rootSpan / (1 << z);
        const cx = Math.floor((this.camera.position.x + this.spanX / 2) / span);
        const cy = Math.floor((this.camera.position.z + this.spanZ / 2) / span);
        const panoKey = `${z}/${cx}/${cy}`;
        if (panoKey !== this._panoPrefetchKey) {
          this._panoPrefetchKey = panoKey;
          const [nx, ny] = this.tilesAtZoom(z);
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && y >= 0 && x < nx && y < ny)
              this._reqImagery(z, x, y, 9000 + dx * dx + dy * dy);
          }
        }
      }
      for (const node of visible) {
        const hz = Math.min(node.z, this.m.maxZoom);
        if (hz > 0) this._reqHeight(hz - 1, node.x >> (node.z - hz + 1), node.y >> (node.z - hz + 1), node.dist + 5000);
        const [gx, gy] = this.tilesAtZoom(node.z);
        const nx = node.x + (vel.x > 0 ? 1 : -1), ny = node.y + (vel.z > 0 ? 1 : -1);
        if (nx >= 0 && nx < gx) {
          this._reqHeight(Math.min(node.z, this.m.maxZoom), nx >> (node.z - hz), node.y >> (node.z - hz), node.dist + 2000);
          if (this.img) this._reqImagery(Math.min(node.z, this.img.maxZoom), nx, node.y, node.dist + 2500);
        }
        if (ny >= 0 && ny < gy && this.img)
          this._reqImagery(Math.min(node.z, this.img.maxZoom), node.x, ny, node.dist + 2500);
      }
    }

    /* ================= collision / heightAt ================= */
    async _loadBaseCollision() {
      // z3 = ~20 m/px, 15 tiles (~15 MB decoded): water surfaces are BUILT from these heights at
      // boot, and 80 m base data draped the Snake/creeks visibly wrong on sloping ground
      const z = Math.min(this.m.minZoom + 3, this.m.maxZoom);
      const [nx, ny] = this.tilesAtZoom(z);
      const jobs = [];
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const key = `${z}/${x}/${y}`;
        const e = {
          kind: 'h', key, z, x, y, state: 'loading', lastUsed: 0, persistent: true,
          generation: this.generation,
        };
        this.hCache.set(key, e);
        jobs.push(fetch(this._urlH(z, x, y))
          .then(r => { if (!r.ok) throw new Error(`base tile ${key}: HTTP ${r.status}`); return r.blob(); })
          .then(createImageBitmap)
          .then(async bmp => {
            e.decoded = await this._decodeHeightAsync(bmp, e.z, e.x, e.y, -10000);
            this._mirrorHeightTile(e);
            e.state = 'decoded'; this.uploadQueue.push(e);
          }));
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
        jobs.push(this._prepareImageryAsync(this._urlI(z, x, y), z, x, y, -10000)
          .then(result => {
            e.prepared = result.prepared;
            e.tex = this._imageryTexture(result.bitmap, z, x, y, result.prepared);
            e.state = 'ready';
            this._streamStats.imageryPrepared++;
            this._streamStats.uploads++;
          })
          .catch(error => {
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
