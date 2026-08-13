/* TrailBuilder — the park's foot trails (OSM highway=path/footway) as a thin dirt tread draped
 * on the terrain (Three.js r184). A deliberately LIGHTER cousin of RoadRibbon:
 *
 *  SPLINE   Each OSM centerline (already Douglas-Peucker simplified at 2 m in the pipeline) is
 *           fit with a centripetal Catmull-Rom spline and resampled at ~5 m — the same spline
 *           math RoadRibbon uses — so switchbacks read as smooth curves, not faceted diagonals.
 *
 *  DRAPE    No graded slab: a footpath simply HUGS the ground. Every cross-section's two edge
 *           verts sit on the real terrain height (per-edge sample) + a 12 cm lift, so the tread
 *           follows every hill and cross-slope with no float and never buries into the ground.
 *           Long straight, flat runs are decimated (same greedy heading+height test as the road
 *           ribbon) to hold the triangle budget over ~678 km of trail.
 *
 *  MATERIAL A matte bare-earth tread — brown, foot-packed darker down the centreline, dusty at
 *           the edges. NO markings, no shoulder band. Shares the terrain's cloud-shade + cast
 *           shadows + headlights + fog recipe (copied from RoadRibbon's LIGHT_GLSL) so it lights
 *           coherently with the rest of the world at every time of day.
 *
 *  EXCLUSION Trails must not have trees/sage/grass clipping through them. TrailBuilder wraps the
 *           global roadQuery(x,z) (the exact sampler ScatterManager / GroundCover / PropScatter
 *           read for foliage exclusion) so a query near a trail reports class:'trail'. Because
 *           drive-mode reads the *lexical* roadQuery / RoadIndex — not window.roadQuery — the car
 *           is entirely unaffected; only the scatter modules see the trails, and keep clear.
 *
 *    const tb = new TrailBuilder({scene, sampleGround, terrain, trailsUrl, sun, sunColor, ambient, fog});
 *    await tb.build();     // fetch + spline + decimate + drape + mesh + install exclusion wrapper
 *    tb.stats              // {tris, drawCalls, trails}
 *    tb.update();          // per-frame: lazy amortized re-drape onto finer streamed height
 *
 *  The lazy re-drape mirrors RoadRibbon's converged-signature contract (poll ~6 Hz, only when the
 *  fine-tile set changed AND the streamer is idle, amortized over a per-frame budget) — but since
 *  a trail vert is just ground+lift, the pass simply re-samples the finest decoded height per vert
 *  (no grading to preserve), so the tread converges exactly onto whatever LOD the terrain shows.
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const TRAIL_W  = 1.2;     // tread width (m) — a real single-track foot trail
  const SEG_LEN  = 2.5;     // authoritative near tread spacing (m)
  const LIFT     = 0.12;    // tread sits this far above the sampled ground (never buried)
  const NATURAL_LIFT = 0.160; // bench-cut core clears terrain triangles; outer rows remain flush
  const EDGE_LIFT = 0.006;    // terrain-convergence rows must not expose a raised ribbon edge
  const V_TILE   = 3.0;     // metres of trail per uv.v = 1
  const MAX_RUN  = 5.0;     // stable terrain-following cap; mid/far LODs decimate this mesh
  const HDG_TOL  = 5.0;     // deg — lateral heading tolerance for decimation
  const H_EPS    = 0.035;   // m  — retain 2.5 m samples wherever centre or edges bend materially
  /* Amortized by WALL CLOCK, not by a cross-section count — see the matching note in
     RoadRibbon.js. A count budget is a proxy for work whose calibration drifts as the per-section
     cost changes; a time slice measures the thing we actually care about and needs no retuning. */
  const DRAPE_SLICE_MS = 4;
  const GRADE_WIN = 13.0;   // m  — arc-length window that smooths the tread profile (like RoadRibbon _grade)
  const RENDER_CELL = 1024, LOD_NEAR = 700, LOD_MID = 1800;
  const MAX_TILT  = 0.09;   // max cross-slope rise per metre of half-width (banked/cut tread on sidehills)

  /* arc-length moving average — ports RoadRibbon.movAvgArc so trails ride a SMOOTHED longitudinal
     profile instead of hugging every DEM bump (kills the faceted ground-hug jitter). */
  function movAvgArc(v, s, win) {
    const n = v.length, out = new Float64Array(n), h = win * 0.5;
    let a = 0, b = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      while (b < n && s[b] <= s[i] + h) { sum += v[b]; b++; }
      while (s[a] < s[i] - h) { sum -= v[a]; a++; }
      out[i] = sum / (b - a);
    }
    return out;
  }
  /* smoothed tread profile + clamped cross-tilt + anti-burial, from per-vertex ground samples
     (centre gC, left gL, right gR at arc-length s). Shared by build + re-drape so grading survives
     the finer-tile re-drape. Mirrors RoadRibbon._grade at track scale. */
  function gradeProfile(gC, gL, gR, s, width = TRAIL_W) {
    const n = gC.length, mt = MAX_TILT * width * 0.5;
    const prof = movAvgArc(gC, s, GRADE_WIN);
    const tRaw = new Float64Array(n);
    for (let i = 0; i < n; i++) { const t = (gR[i] - gL[i]) * 0.5; tRaw[i] = t < -mt ? -mt : t > mt ? mt : t; }
    const tilt = movAvgArc(tRaw, s, GRADE_WIN * 0.5);
    for (let i = 0; i < n; i++)                       // never bury the tread below the local terrain
      prof[i] += Math.max(gC[i] - prof[i], gL[i] - (prof[i] - tilt[i]), gR[i] - (prof[i] + tilt[i]), 0);
    return { prof, tilt };
  }

  const VERT = /* glsl */`
    varying vec2  vUv;
    varying vec3  vWorld;
    varying vec3  vNormal;
    attribute float surfaceKind;
    varying float vSurfaceKind;
    void main(){
      vUv = uv; vNormal = normalize(normal); vSurfaceKind = surfaceKind;
      vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  // shared lighting + fog + cloud-shade + cast-shadow + headlight tail — same recipe as the
  // terrain / road ribbon so trails sit in the identical light at every time of day.
  const LIGHT_GLSL = /* glsl */`
    uniform vec3  uSun; uniform vec3 uSunColor; uniform vec3 uAmb;
    uniform vec3  uFogColor; uniform float uFogNear; uniform float uFogFar;
    uniform float uCloudTime; uniform float uCloudAmt;
    uniform sampler2D uShadowMap; uniform mat4 uShadowMtx; uniform float uShadowOn;
    uniform vec3  uHLPos[2]; uniform vec3 uHLDir[2]; uniform vec3 uHLColor; uniform vec4 uHLParams;
    vec3 hlBeam(vec3 world, vec3 nrm, vec3 bpos, vec3 bdir){
      vec3 toF = world - bpos; float dist = length(toF);
      vec3 L = toF / max(dist, 1.0e-3);
      float cone = smoothstep(uHLParams.y, uHLParams.x, dot(L, bdir));
      float atten = (1.0 - smoothstep(0.55 * uHLParams.z, uHLParams.z, dist))
                  / (1.0 + 0.015 * dist + 0.0012 * dist * dist);  // softer falloff → beam throws much further
      return uHLColor * (cone * atten * max(dot(nrm, -L), 0.0));
    }
    vec3 headlight(vec3 world, vec3 nrm){
      if(uHLParams.w < 0.001) return vec3(0.0);
      return (hlBeam(world, nrm, uHLPos[0], uHLDir[0])
            + hlBeam(world, nrm, uHLPos[1], uHLDir[1])) * uHLParams.w;
    }
    float shadowDepthUnpack(vec4 v){
      return dot(v, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)) * (255.0/256.0);
    }
    float sunCastShadow(vec3 w){
      if(uShadowOn < 0.5) return 1.0;
      vec3 sc = (uShadowMtx * vec4(w, 1.0)).xyz;
      vec2 db = min(sc.xy, 1.0 - sc.xy);
      float inBox = smoothstep(0.0, 0.06, min(db.x, db.y)) * step(sc.z, 1.0);
      if(inBox <= 0.0) return 1.0;
      float zr = sc.z - 0.0006;
      float e = 1.2 / 2048.0;
      float ra = fract(sin(dot(w.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
      vec2 t1 = vec2(cos(ra), sin(ra)) * e;
      vec2 t2 = vec2(-t1.y, t1.x);
      float lit = step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy + t1)))
                + step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy - t1)))
                + step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy + t2)))
                + step(zr, shadowDepthUnpack(texture2D(uShadowMap, sc.xy - t2)));
      return mix(1.0, lit * 0.25, inBox);
    }
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
    }
    float fbmSky(vec2 p){ float s=0.0,a=0.5;
      for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.13+vec2(31.4,17.7); a*=0.5; } return s; }
    float cloudShade(vec3 w){
      if(uCloudAmt < 0.005) return 1.0;
      vec2 cuv = w.xz / 2680.0;
      vec2 drift = vec2(uCloudTime*0.006, uCloudTime*0.0022);
      float c = fbmSky(cuv*1.35 + drift) + 0.45*fbmSky(cuv*3.4 - drift*2.0);
      float cover = smoothstep(0.72, 1.06, c);
      return 1.0 - 0.28*cover*uCloudAmt;
    }
    float surfH(vec2 p){ return vnoise(p*3.0)*0.5 + vnoise(p*11.0)*0.32 + vnoise(p*29.0)*0.18; }
    vec3 shadeSurface(vec3 albedo, vec3 nrm, vec3 world){
      vec3 n = normalize(nrm);
      float sh    = sunCastShadow(world);
      float cloud = cloudShade(world);
      float diff  = max(dot(n, uSun), 0.0) * sh;
      float amb   = mix(0.32, 0.52, n.y*0.5+0.5);
      vec3 col = albedo * (vec3(amb)*uAmb + uSunColor*diff*1.15) * cloud;
      vec3 hl = headlight(world, n);
      col += albedo * hl;
      float fd = length(world - cameraPosition);
      col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, fd));
      return col;
    }`;

  const FRAG = /* glsl */`
    precision highp float;
    ${LIGHT_GLSL}
    uniform sampler2D uTrailAlbedo;
    varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormal; varying float vSurfaceKind;
    void main(){
      float dCam = length(vWorld - cameraPosition);
      vec2  P    = vWorld.xz;
      float near = 1.0 - smoothstep(70.0, 240.0, dCam);
      float ax   = abs(vUv.x - 0.5);          // 0 centre .. 0.5 edge
      float primitive = 1.0-step(-0.5,vSurfaceKind);
      float irregular=vnoise(P*vec2(.43,1.37)+vec2(73.0,19.0))*.62+
        vnoise(P*vec2(1.9,.57)+vec2(11.0,47.0))*.38;
      // The compacted tread never breaks into triangular holes. Only the authored disturbed
      // margin (uv.x outside 0..1) dissolves into the real terrain beneath it.
      float coreHalf=mix(.30,.25,primitive);
      float visibleHalf=mix(.59,.55,primitive)+mix(.20,.22,primitive)*(irregular-.5);
      float widthBreak=smoothstep(.64,.82,
        vnoise(vec2(vUv.y*.23,vUv.y*1.17)+P*.014+vec2(31.0,67.0)));
      visibleHalf-=widthBreak*mix(.035,.085,primitive);
      visibleHalf=max(visibleHalf,coreHalf+.045);
      // The outer disturbed-soil triangles feather into terrain through a deterministic,
      // sub-centimetre broken edge. There is no alpha-sorted translucent ribbon.
      float coverage=1.0-smoothstep(coreHalf,visibleHalf,ax);
      if(vSurfaceKind<.5&&coverage<hash(floor(P*38.0)+17.0)) discard;

      vec2 trailUvA=P/4.8;
      vec2 trailUvB=mat2(.866,-.5,.5,.866)*P/9.5+vec2(.31,.73);
      vec3 photo=mix(texture2D(uTrailAlbedo,trailUvA).rgb,
        texture2D(uTrailAlbedo,trailUvB).rgb,.18);
      float macro=.88+.18*vnoise(P*.09+vec2(29.0,7.0));
      vec3 maintainedSoil = photo*vec3(1.12,1.04,.90)*macro;
      vec3 primitiveSoil = photo*vec3(.88,.76,.58)*(.88+.18*vnoise(P*.075+41.0));
      vec3 albedo = mix(maintainedSoil,primitiveSoil,primitive);
      vec3 nrm = vNormal;
      // The compacted tread is only centimetres above terrain. Suppress the exaggerated light
      // response of its narrow terrain-convergence triangles; photographic micro-relief below
      // restores the fine surface response without exposing the triangulation.
      if(vSurfaceKind<.5) nrm=normalize(mix(nrm,vec3(0.0,1.0,0.0),.90));
      if(vSurfaceKind > 0.5 && vSurfaceKind < 1.5){
        // weathered timber boardwalk / bridge deck and rails
        float grain = vnoise(vec2(vUv.y*8.0, vUv.x*1.4));
        float seam = smoothstep(0.44,0.49,abs(fract(vUv.y)-0.5));
        albedo = vec3(0.39,0.285,0.175) * (0.82 + 0.28*grain);
        albedo *= 1.0 - seam*0.20;
      } else if(vSurfaceKind > 1.5){
        // stone/concrete stair modules, deliberately quieter than nearby loose tread
        float fleck = vnoise(P*7.0);
        albedo = vec3(0.39,0.385,0.35) * (0.82 + 0.25*fleck);
      }

      if(near > 0.001&&vSurfaceKind<.5){
        // dusty lighter margins, foot-packed darker crown down the centre
        albedo = mix(albedo, albedo*vec3(1.10,1.08,1.02),
          smoothstep(0.25,0.5,ax)*mix(0.42,0.18,primitive)*near);
        albedo *= 1.0-mix(0.10,0.045,primitive)*(1.0-smoothstep(0.0,0.22,ax))*near;
        // Disturbed margins retain the tread soil but vary subtly in compaction.
        float margin=smoothstep(.32,.52,ax);
        float disturbed=(vnoise(P*3.7+23.0)-.5)*margin;
        albedo*=1.0+disturbed*.10*near;
        // The disturbed band is partly reclaimed by grass and low ground cover. Broad,
        // world-anchored patches prevent the photographic soil from reading as a cut-out ribbon.
        float reclaimMask=smoothstep(.24,.60,ax)*
          (.26+.48*vnoise(P*vec2(.72,1.61)+vec2(47.0,13.0)))*near;
        vec3 reclaimed=mix(vec3(.34,.30,.17),vec3(.22,.30,.12),
          vnoise(P*.83+vec2(9.0,71.0)));
        albedo=mix(albedo,reclaimed,reclaimMask*mix(.72,.88,primitive));
        // Photographic luminance supplies fine irregular relief without the old repeating
        // procedural normal lattice.
        vec2 e=vec2(1.0/1024.0,0.0);
        float hx=dot(texture2D(uTrailAlbedo,trailUvA+e.xy).rgb,vec3(.299,.587,.114))-
          dot(texture2D(uTrailAlbedo,trailUvA-e.xy).rgb,vec3(.299,.587,.114));
        float hz=dot(texture2D(uTrailAlbedo,trailUvA+e.yx).rgb,vec3(.299,.587,.114))-
          dot(texture2D(uTrailAlbedo,trailUvA-e.yx).rgb,vec3(.299,.587,.114));
        nrm=normalize(nrm+vec3(-hx*1.35,0.0,-hz*1.35)*near);
      }
      gl_FragColor = vec4(shadeSurface(albedo, nrm, vWorld), 1.0);
    }`;

  /* ---------------- geometry helpers (shared shape with RoadRibbon) ---------------- */
  const dist2d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const featureSeed = value => {
    const text = String(value || 'trail'); let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  };

  function crPoint(p0, p1, p2, p3, t, out) {
    const a = 0.5, t0 = 0;
    const t1 = t0 + Math.max(Math.pow(dist2d(p0, p1), a), 1e-4);
    const t2 = t1 + Math.max(Math.pow(dist2d(p1, p2), a), 1e-4);
    const t3 = t2 + Math.max(Math.pow(dist2d(p2, p3), a), 1e-4);
    const tt = t1 + (t2 - t1) * t;
    const lp = (pa, pb, ta, tb) => {
      const w = (tt - ta) / (tb - ta);
      return [pa[0] + (pb[0] - pa[0]) * w, pa[1] + (pb[1] - pa[1]) * w];
    };
    const A1 = lp(p0, p1, t0, t1), A2 = lp(p1, p2, t1, t2), A3 = lp(p2, p3, t2, t3);
    const B1 = lp(A1, A2, t0, t2), B2 = lp(A2, A3, t1, t3);
    const C = lp(B1, B2, t1, t2);
    out[0] = C[0]; out[1] = C[1];
    return out;
  }

  class TrailBuilder {
    constructor(o) {
      this.scene = o.scene;
      this.sampleGround = o.sampleGround ||
        (o.terrain ? (x, z) => o.terrain.heightAt(x, z) : null);
      this.terrain = o.terrain || null;
      this.camera = o.camera || null;
      this.trailsUrl = o.trailsUrl || 'terrain/public/trails.json';
      // adopt (or create) the shared uniform contracts, exactly like RoadRibbon
      const CU = global.CLOUD_UNIFORMS = global.CLOUD_UNIFORMS ||
        { uCloudTime: { value: 0 }, uCloudAmt: { value: 0 } };
      const SH = global.SHADOW_UNIFORMS = global.SHADOW_UNIFORMS ||
        { uShadowMap: { value: null }, uShadowMtx: { value: new THREE.Matrix4() },
          uShadowOn: { value: 0 } };
      const HL = global.HEADLIGHT_UNIFORMS = global.HEADLIGHT_UNIFORMS ||
        { uHLPos:   { value: [new THREE.Vector3(1e6, 1e6, 1e6), new THREE.Vector3(1e6, 1e6, 1e6)] },
          uHLDir:   { value: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)] },
          uHLColor: { value: new THREE.Color(1.0, 0.92, 0.76) },
          uHLParams:{ value: new THREE.Vector4(0.974, 0.866, 40.0, 0.0) } };
      const fog = o.fog || { color: new THREE.Color(0.8, 0.8, 0.85), near: 1200, far: 9000 };
      const trailAlbedo = new THREE.TextureLoader().load(
        'terrain/public/materials/transport/packed-trail-albedo.webp');
      trailAlbedo.wrapS = trailAlbedo.wrapT = THREE.RepeatWrapping;
      trailAlbedo.colorSpace = THREE.SRGBColorSpace;
      trailAlbedo.anisotropy = 8;
      this.material = new THREE.ShaderMaterial({
        uniforms: {
          uSun: { value: o.sun || new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: o.sunColor || new THREE.Color(1, 0.94, 0.84) },
          uAmb: { value: o.ambient || new THREE.Color(0.78, 0.86, 1.0) },
          uFogColor: { value: fog.color },
          uFogNear: { value: fog.near }, uFogFar: { value: fog.far },
          uCloudTime: CU.uCloudTime, uCloudAmt: CU.uCloudAmt,
          uShadowMap: SH.uShadowMap, uShadowMtx: SH.uShadowMtx, uShadowOn: SH.uShadowOn,
          uHLPos: HL.uHLPos, uHLDir: HL.uHLDir, uHLColor: HL.uHLColor, uHLParams: HL.uHLParams,
          uTrailAlbedo: { value: trailAlbedo },
        },
        vertexShader: VERT, fragmentShader: FRAG,
        fog: false, side: THREE.DoubleSide,
        // sit just under the road ribbons (rank<track) so a trail meeting a dirt road tucks
        // beneath the road surface rather than z-fighting it.
        polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -0.5,
      });
      this.group = new THREE.Group();
      this.group.name = 'transportTrails';
      this.scene.add(this.group);
      this.mesh = null;
      this.renderCells = null;      // batched {meshes, records} — see GT_transportBatch
      this.stats = { tris: 0, drawCalls: 0, trails: 0 };
      this._trails = [];            // per-trail re-drape records {v0, n, bb}
      // exclusion index (grid-bucketed segments, mirrors RoadIndex)
      this._exc = { cell: 32, buckets: new Map(), segs: [], _seen: new Set() };
      this._wrapped = false;
      // lazy re-drape state
      this._zBase = null; this._maxZoom = null; this._drapedSig = -1;
      this._frame = 0; this._pass = null;
      this._detailRecords = (o.roadDetails || []).slice();
      this._detailCells = new Map();
      this._detailMeshes = null;
    }

    async build() {
      let list;
      try {
        const res = await fetch(this.trailsUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        list = await res.json();
      } catch (e) {
        console.info('[TrailBuilder] trails.json unavailable — skipping trails.', e && e.message || e);
        return this;
      }
      if (!this.sampleGround) { console.info('[TrailBuilder] no ground sampler — skipping.'); return this; }

      const b = { pos: [], uv: [], kind: [], idx: [], base: 0 };
      for (const f of list) {
        const cls = f.class || 'trail';
        const engineered = cls === 'steps' || cls === 'boardwalk' ||
          (f.tags && f.tags.bridge === 'yes');
        const pts = this._spline(f.pts, cls === 'steps' ? 0.4 : engineered ? 1.0 : SEG_LEN);
        if (pts) { this._registerExclusion(pts); this._buildTrail(pts, b, f); }
      }
      this._installExclusion();          // wrap window.roadQuery so foliage keeps clear of trails

      if (b.pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
        geo.setAttribute('surfaceKind', new THREE.Float32BufferAttribute(b.kind, 1));
        geo.setIndex(b.idx);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.visible = false;            // authoritative buffer owner for lazy re-drape
        this.mesh = mesh;
        this.renderCells = this._toRenderCells(geo);
        for (const m of this.renderCells.meshes) if (m) this.group.add(m);
        const meshCount = this.renderCells.meshes.filter(Boolean).length;
        this.stats = { tris: b.idx.length / 3, drawCalls: meshCount,
          cells: this.renderCells.records.length, lods: 3, trails: this._trails.length };
      }
      this._buildDetails();
      console.info('[TrailBuilder] built', this._trails.length, 'trails,',
        this.stats.tris, 'tris, 1 draw call');
      return this;
    }

    _lodIndices(step) {
      const out = [];
      for (const w of this._trails) {
        for (let q = 0; q + 1 < w.n; q += step) {
          const q1 = Math.min(q + step, w.n - 1);
          const a = w.v0 + q * w.stride, b = w.v0 + q1 * w.stride;
          for (let c = 0; c + 1 < w.stride; c++)
            out.push(a+c,b+c,a+c+1, a+c+1,b+c,b+c+1);
        }
      }
      return out;
    }

    _toRenderCells(master) {
      const pos = master.attributes.position;
      // Mid/far intentionally retain the authoritative deck/tread top only; fascia, stair
      // risers, posts and rails are near-band silhouette detail.
      const levels = [Array.from(master.index.array), this._lodIndices(2), this._lodIndices(4)];
      const cells = levels.map(() => new Map());
      const add = (map, tri) => {
        const x = tri.reduce((s, v) => s + pos.getX(v), 0) / 3;
        const z = tri.reduce((s, v) => s + pos.getZ(v), 0) / 3;
        const key = Math.floor(x / RENDER_CELL) + ',' + Math.floor(z / RENDER_CELL);
        let r = map.get(key);
        if (!r) { r = { idx: [], minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity,
          minZ:Infinity,maxZ:-Infinity }; map.set(key, r); }
        r.idx.push(...tri);
        for (const v of tri) {
          const vx=pos.getX(v), vy=pos.getY(v), vz=pos.getZ(v);
          r.minX=Math.min(r.minX,vx); r.maxX=Math.max(r.maxX,vx);
          r.minY=Math.min(r.minY,vy); r.maxY=Math.max(r.maxY,vy);
          r.minZ=Math.min(r.minZ,vz); r.maxZ=Math.max(r.maxZ,vz);
        }
      };
      levels.forEach((idx, li) => {
        for (let i = 0; i < idx.length; i += 3) add(cells[li], [idx[i], idx[i + 1], idx[i + 2]]);
      });
      // Shared with RoadRibbon: one mesh per LOD level, visible cells emitted as merged index
      // runs in geometry.groups. See the commentary on buildTransportBatch in RoadRibbon.js.
      return global.GT_transportBatch.build(master, this.material, 0, cells, [0, LOD_NEAR, LOD_MID]);
    }

    /* Per frame from the main loop (92-boot), before the render. */
    updateRenderCells(camera) {
      const F = this._cellFrustum || (this._cellFrustum = new THREE.Frustum());
      const M = this._cellMtx || (this._cellMtx = new THREE.Matrix4());
      F.setFromProjectionMatrix(M.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      global.GT_transportBatch.update(this.renderCells, camera, F, camera.position);
    }

    /* clean → centripetal Catmull-Rom resample at ~SEG_LEN (same as RoadRibbon, no radius relax:
       foot trails legitimately switchback tighter than any vehicle turning radius) */
    _spline(raw, spacing = SEG_LEN) {
      if (!raw || raw.length < 2) return null;
      const clean = [raw[0]];
      for (let i = 1; i < raw.length; i++)
        if (dist2d(raw[i], clean[clean.length - 1]) >= 0.5) clean.push(raw[i]);
      if (clean.length < 2) return null;
      const out = [];
      const tmp = [0, 0];
      const n = clean.length;
      for (let i = 0; i + 1 < n; i++) {
        const p1 = clean[i], p2 = clean[i + 1];
        const p0 = i > 0 ? clean[i - 1] : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
        const p3 = i + 2 < n ? clean[i + 2] : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
        const segs = Math.max(1, Math.ceil(dist2d(p1, p2) / spacing));
        for (let s = 0; s < segs; s++) { crPoint(p0, p1, p2, p3, s / segs, tmp); out.push([tmp[0], tmp[1]]); }
      }
      out.push([clean[n - 1][0], clean[n - 1][1]]);
      return out.length >= 2 ? out : null;
    }

    /* One trail → an authoritative compacted tread plus disturbed, terrain-converging margins.
       Natural trails use five vertices per section; engineered structures retain three. */
    _buildTrail(pts, b, feature = {}) {
      const classification = feature.class || 'trail';
      const tags = feature.tags || {};
      const taggedWidth = Number.parseFloat(tags.width);
      const width = taggedWidth > 0 ? taggedWidth :
        classification === 'boardwalk' ? 2.0 : classification === 'steps' ? 1.5 :
        classification === 'primitive_trail' ? 0.8 : TRAIL_W;
      const half = width * 0.5, n = pts.length, g = this.sampleGround;
      const structureKind = classification === 'steps' ? 'steps' :
        classification === 'boardwalk' ? 'boardwalk' : tags.bridge === 'yes' ? 'footbridge' : null;
      const shaderKind = structureKind === 'steps' ? 2 : structureKind ? 1 :
        classification === 'primitive_trail' ? -1 : 0;
      const dir = [];
      for (let i = 0; i + 1 < n; i++) {
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
        const l = Math.hypot(dx, dz) || 1; dir.push([dx / l, dz / l]);
      }
      const mx = new Float64Array(n), mz = new Float64Array(n), s = new Float64Array(n);
      const halfL = new Float64Array(n), halfR = new Float64Array(n);
      const centreDrift = new Float64Array(n), seed = featureSeed(feature.id);
      const gC = new Float64Array(n), gL = new Float64Array(n), gR = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const dP = dir[i - 1] || dir[i], dN = dir[i] || dir[i - 1];
        const pP = [-dP[1], dP[0]], pN = [-dN[1], dN[0]];
        let x = pP[0] + pN[0], z = pP[1] + pN[1];
        const l = Math.hypot(x, z) || 1; x /= l; z /= l;
        let sc = 1 / Math.max(x * pN[0] + z * pN[1], 0.4); sc = Math.min(sc, 2.5);
        mx[i] = x * sc; mz[i] = z * sc;
        if (i > 0) s[i] = s[i - 1] + dist2d(pts[i - 1], pts[i]);
        const leftWave=.54*Math.sin(s[i]*.081+seed*31.7)+
          .29*Math.sin(s[i]*.233+seed*13.1)+.17*Math.sin(s[i]*.47+2.1);
        const rightWave=.51*Math.sin(s[i]*.067+seed*27.3+4.2)+
          .31*Math.sin(s[i]*.191+seed*17.9)+.18*Math.sin(s[i]*.43+6.7);
        const primitive=classification === 'primitive_trail';
        halfL[i]=structureKind?half:half*(primitive?.72+.10*leftWave:.94+.07*leftWave);
        halfR[i]=structureKind?half:half*(primitive?.72+.10*rightWave:.94+.07*rightWave);
        centreDrift[i]=structureKind?0:half*(.08*Math.sin(s[i]*.119+seed*23.0)+
          .035*Math.sin(s[i]*.37+seed*9.0));
        gC[i] = g(pts[i][0], pts[i][1]);
        gL[i] = g(pts[i][0] + mx[i] * halfL[i], pts[i][1] + mz[i] * halfL[i]);
        gR[i] = g(pts[i][0] - mx[i] * halfR[i], pts[i][1] - mz[i] * halfR[i]);
      }
      const { prof, tilt } = gradeProfile(gC, gL, gR, s, width);   // smoothed tread, not raw ground-hug
      if (structureKind === 'steps') {
        // Quantise the longitudinal profile into real, level treads.  The dense 40 cm resample
        // keeps individual risers within a comfortable pedestrian module.
        const rise = 0.17, origin = prof[0];
        for (let i = 0; i < n; i++) {
          prof[i] = origin + Math.round((prof[i] - origin) / rise) * rise;
          tilt[i] = 0;
        }
      }
      if(!structureKind){
        let detailBucket=-1;
        for(let di=0;di<n;di++){
          const bucket=Math.floor((s[di]+seed*11.0)/11.0);
          if(bucket===detailBucket) continue;
          detailBucket=bucket;
          const hsh=.5+.5*Math.sin(s[di]*.371+seed*43.0)*
            Math.sin(s[di]*.117+seed*17.0);
          const d=dir[Math.min(di,dir.length-1)];
          const slope=di?Math.abs((prof[di]-prof[di-1])/Math.max(.1,s[di]-s[di-1])):0;
          const type=slope>.16&&bucket%3===0?'erosion':hsh>.69?'root':'stone';
          const lateral=(hsh-.5)*width*1.35;
          this._detailRecords.push({type,x:pts[di][0]+mx[di]*lateral,
            z:pts[di][1]+mz[di]*lateral,yaw:Math.atan2(d[0],d[1])+Math.PI*.5+
              (hsh-.5)*.65,scale:.68+hsh*.85,seed:hsh});
        }
      }
      // decimation: greedily extend a straight, ground-tracking run (heading + height tolerance)
      const keep = [0];
      const sinTol = Math.sin(HDG_TOL * Math.PI / 180);
      let i0 = 0;
      while (structureKind !== 'steps' && i0 + 1 < n) {
        let j = i0 + 1;
        for (let jj = i0 + 2; jj < n; jj++) {
          if (s[jj] - s[i0] > MAX_RUN) break;
          const cx = pts[jj][0] - pts[i0][0], cz = pts[jj][1] - pts[i0][1];
          const cl = Math.hypot(cx, cz) || 1;
          let ok = true;
          for (let k = i0 + 1; k < jj && ok; k++) {
            const px = pts[k][0] - pts[i0][0], pz = pts[k][1] - pts[i0][1];
            if (Math.abs((cx * pz - cz * px) / cl) > sinTol * (s[k] - s[i0])) { ok = false; break; }
            const t = (s[k] - s[i0]) / (s[jj] - s[i0]);
            const hI = gC[i0] + (gC[jj] - gC[i0]) * t;
            const hLI = gL[i0] + (gL[jj] - gL[i0]) * t;
            const hRI = gR[i0] + (gR[jj] - gR[i0]) * t;
            if (Math.abs(hI - gC[k]) > H_EPS ||
                Math.abs(hLI - gL[k]) > H_EPS ||
                Math.abs(hRI - gR[k]) > H_EPS) { ok = false; break; }
          }
          if (ok) j = jj; else break;
        }
        keep.push(j); i0 = j;
      }
      if (structureKind === 'steps') for (let i = 1; i < n; i++) keep.push(i);
      const v0 = b.base;
      const stride=structureKind?3:5;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const i of keep) {
        const px = pts[i][0], pz = pts[i][1], v = s[i] / V_TILE;
        const lh=halfL[i],rh=halfR[i];
        const lx=px+mx[i]*lh,lz=pz+mz[i]*lh;
        const rx=px-mx[i]*rh,rz=pz-mz[i]*rh;
        if(structureKind){
          b.pos.push(lx,prof[i]-tilt[i]+LIFT,lz);b.uv.push(0,v);b.kind.push(shaderKind);
          b.pos.push(px,prof[i]+LIFT,pz);b.uv.push(.5,v);b.kind.push(shaderKind);
          b.pos.push(rx,prof[i]+tilt[i]+LIFT,rz);b.uv.push(1,v);b.kind.push(shaderKind);
        }else{
          const disturbed=classification==='primitive_trail'?.50:.65;
          const lo=lh+disturbed,ro=rh+disturbed;
          const lox=px+mx[i]*lo,loz=pz+mz[i]*lo;
          const rox=px-mx[i]*ro,roz=pz-mz[i]*ro;
          const cx=px+mx[i]*centreDrift[i],cz=pz+mz[i]*centreDrift[i];
          b.pos.push(lox,g(lox,loz)+EDGE_LIFT,loz);b.uv.push(-.22,v);b.kind.push(shaderKind);
          b.pos.push(lx,prof[i]-tilt[i]+NATURAL_LIFT-.012,lz);b.uv.push(0,v);b.kind.push(shaderKind);
          b.pos.push(cx,prof[i]+NATURAL_LIFT-
            (classification==='primitive_trail'?.012:.025),cz);
          b.uv.push(.5,v);b.kind.push(shaderKind);
          b.pos.push(rx,prof[i]+tilt[i]+NATURAL_LIFT-.012,rz);b.uv.push(1,v);b.kind.push(shaderKind);
          b.pos.push(rox,g(rox,roz)+EDGE_LIFT,roz);b.uv.push(1.22,v);b.kind.push(shaderKind);
        }
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      }
      const m = keep.length;
      for (let q = 0; q + 1 < m; q++) {
        const r0=v0+q*stride,r1=r0+stride;
        for(let c=0;c+1<stride;c++)
          b.idx.push(r0+c,r1+c,r0+c+1,r0+c+1,r1+c,r1+c+1);
      }
      b.base += m*stride;
      const followers = [];
      if (structureKind) this._buildStructure(b,v0,m,width,structureKind,followers,stride);
      const pad = half + 3;
      this._trails.push({ v0, n: m, featureId:feature.id||null,
        classification, name:feature.name||null, tags:feature.tags||null, width, structureKind, followers,
        stride,treadLeft:structureKind?0:1,treadCentre:structureKind?1:2,treadRight:structureKind?2:3,
        bb: { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad } });
    }

    /* Add modular engineered details without disturbing the authoritative first two vertices of
       each section. Followers retain a source tread vertex + vertical offset, so lazy re-drape
       moves deck fascia, stair risers, posts and rails atomically with the sampled surface. */
    _buildStructure(b, v0, n, width, structureKind, followers, stride) {
      const depth = structureKind === 'steps' ? 0.20 : 0.24;
      const knd = structureKind === 'steps' ? 2 : 1;
      const addFollower = (source, dy, u, v) => {
        const k = source * 3;
        const vi = b.base++;
        b.pos.push(b.pos[k], b.pos[k + 1] + dy, b.pos[k + 2]);
        b.uv.push(u, v); b.kind.push(knd);
        followers.push({ vertex: vi, source, dy });
        return vi;
      };
      // Continuous fascia gives boardwalks/bridges thickness; on stairs it forms visible risers.
      for (let q = 0; q + 1 < n; q++) {
        const l0 = v0 + q*stride, r0=l0+stride-1, l1=l0+stride, r1=l1+stride-1;
        const lb0 = addFollower(l0, -depth, 0, q), lb1 = addFollower(l1, -depth, 0, q + 1);
        const rb0 = addFollower(r0, -depth, 1, q), rb1 = addFollower(r1, -depth, 1, q + 1);
        b.idx.push(l0, lb0, l1, l1, lb0, lb1, r1, rb0, r0, rb1, rb0, r1);
        if (structureKind === 'steps') b.idx.push(l1, lb1, r1, r1, lb1, rb1);
      }
      // Close both modular ends. Open side fascia previously exposed a V-shaped pair of triangles
      // at boardwalk/trail transitions when viewed from below or around a switchback.
      for(const q of [0,n-1]){
        const l=v0+q*stride,r=l+stride-1;
        const lb=addFollower(l,-depth,0,q),rb=addFollower(r,-depth,1,q);
        if(q===0) b.idx.push(l,lb,r,r,lb,rb);
        else b.idx.push(l,r,lb,r,rb,lb);
      }
      if (structureKind !== 'footbridge') return;
      // Sparse waist-height timber rails. Every third metre-ish section gets a post; paired
      // upper vertices form the handrail while keeping short bridges visually legible.
      const posts = [];
      for (let q = 0; q < n; q += 3) {
        for (let side = 0; side < 2; side++) {
          const source = v0 + q*stride + side*(stride-1);
          const top = addFollower(source, 1.05, side, q);
          const mid = addFollower(source, 0.08, side, q);
          posts.push({ q, side, top });
          // crossed skinny triangles read as a post without adding a separate material/draw call
          b.idx.push(source, mid, top);
        }
      }
      for (let i = 0; i < posts.length; i++) {
        const a = posts[i], c = posts[i + 2];
        if (!c || a.side !== c.side) continue;
        const aLow = addFollower(a.top, -0.08, a.side, a.q);
        const cLow = addFollower(c.top, -0.08, c.side, c.q);
        b.idx.push(a.top, aLow, c.top, c.top, aLow, cLow);
      }
    }

    /* ---------------- deterministic near-field surface detail ---------------- */

    _buildDetails() {
      if(!this._detailRecords.length||!this.camera) return;
      const cellSize=64;
      for(const rec of this._detailRecords){
        const key=Math.floor(rec.x/cellSize)+','+Math.floor(rec.z/cellSize);
        let list=this._detailCells.get(key);
        if(!list){list=[];this._detailCells.set(key,list);}
        list.push(rec);
      }
      const stoneGeo=new THREE.DodecahedronGeometry(1,0);
      const rootGeo=new THREE.CylinderGeometry(.68,1,1,7,1,false);
      const stoneMat=new THREE.MeshStandardMaterial({color:0x5f5a51,roughness:.96,metalness:0,
        emissive:0x080706,emissiveIntensity:.12});
      const rootMat=new THREE.MeshStandardMaterial({color:0x65452d,roughness:1,metalness:0,
        emissive:0x160c06,emissiveIntensity:.34});
      const stone=new THREE.InstancedMesh(stoneGeo,stoneMat,720);
      const root=new THREE.InstancedMesh(rootGeo,rootMat,420);
      stone.name='transportNearStones';root.name='transportNearRoots';
      stone.count=0;root.count=0;stone.frustumCulled=false;root.frustumCulled=false;
      this.group.add(stone,root);
      this._detailMeshes={stone,root,cellSize,lastX:Infinity,lastZ:Infinity};
      this._updateDetails(true);
    }

    _updateDetails(force=false) {
      const state=this._detailMeshes,cam=this.camera;
      if(!state||!cam) return;
      const x=cam.position.x,z=cam.position.z;
      if(!force&&Math.hypot(x-state.lastX,z-state.lastZ)<18) return;
      state.lastX=x;state.lastZ=z;
      const cs=state.cellSize,cx=Math.floor(x/cs),cz=Math.floor(z/cs),radius=210,cr=Math.ceil(radius/cs);
      const stone=[],root=[];
      for(let dz=-cr;dz<=cr;dz++) for(let dx=-cr;dx<=cr;dx++){
        const list=this._detailCells.get((cx+dx)+','+(cz+dz));
        if(!list) continue;
        for(const rec of list) if((rec.x-x)*(rec.x-x)+(rec.z-z)*(rec.z-z)<=radius*radius)
          (rec.type==='stone'?stone:root).push(rec);
      }
      const dummy=new THREE.Object3D();
      const fill=(mesh,list,isRoot)=>{
        const count=Math.min(mesh.instanceMatrix.count,list.length);
        for(let i=0;i<count;i++){
          const rec=list[i],base=this.sampleGround(rec.x,rec.z);
          dummy.position.set(rec.x,base+(isRoot?.045:.055),rec.z);
          if(isRoot) dummy.rotation.set(Math.PI*.5,rec.yaw,0);
          else dummy.rotation.set(rec.seed*2.1,rec.yaw,rec.seed*.7);
          if(isRoot){
            const length=(rec.type==='erosion'?1.05:.46)*rec.scale;
            const thick=(rec.type==='erosion'?.055:.035)*(.8+rec.seed*.4);
            dummy.scale.set(thick,length,thick);
          }else{
            const size=.04+.055*rec.seed;
            dummy.scale.set(size*rec.scale,size*(.45+rec.seed*.25),size*(.72+rec.seed*.35));
          }
          dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);
        }
        mesh.count=count;mesh.instanceMatrix.needsUpdate=true;
      };
      fill(state.stone,stone,false);fill(state.root,root,true);
    }

    /* ---------------- foliage exclusion ---------------- */

    _registerExclusion(pts) {
      const E = this._exc;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], c = pts[i + 1], si = E.segs.length;
        E.segs.push({ ax: a[0], az: a[1], bx: c[0], bz: c[1] });
        const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil(len / E.cell));
        for (let spi = 0; spi <= steps; spi++) {
          const t = spi / steps, x = a[0] + dx * t, z = a[1] + dz * t;
          const key = Math.floor(x / E.cell) + ',' + Math.floor(z / E.cell);
          let arr = E.buckets.get(key); if (!arr) { arr = []; E.buckets.set(key, arr); }
          if (arr[arr.length - 1] !== si) arr.push(si);
        }
      }
    }

    /* nearest-trail distance (m) at (x,z) — scans the query cell + 8 neighbours, ~O(1) */
    trailDist(x, z) {
      const E = this._exc;
      if (!E.segs.length) return Infinity;
      const cx = Math.floor(x / E.cell), cz = Math.floor(z / E.cell);
      let best = Infinity; const seen = E._seen; seen.clear();
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const arr = E.buckets.get((cx + i) + ',' + (cz + j)); if (!arr) continue;
        for (const si of arr) {
          if (seen.has(si)) continue; seen.add(si);
          const s = E.segs[si], dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
          if (d < best) best = d;
        }
      }
      return best;
    }

    /* Wrap window.roadQuery so the scatter modules (which read global.roadQuery) keep foliage
       clear of trails. Returns whichever of road/trail is nearer; a trail hit reports class
       'trail' (ROAD_CLEAR['trail'] is undefined → 0, so the scatter's own TREE/SHRUB/SURF margins
       carve the corridor). Drive mode reads the LEXICAL roadQuery / RoadIndex, never window's, so
       the car is untouched. Idempotent; original is preserved and still driven for roads. */
    _installExclusion() {
      if (this._wrapped || !this._exc.segs.length) return;
      const self = this;
      const orig = global.roadQuery;
      global.roadQuery = function (x, z) {
        const r = orig ? orig(x, z) : { dist: 1e9, class: null, name: null };
        const td = self.trailDist(x, z);
        if (td < (r ? r.dist : 1e9)) return { dist: td, class: 'trail', name: null };
        return r;
      };
      this._wrapped = true;
    }

    /* ================= lazy re-drape (converged-signature pattern; see RoadRibbon.update) =======
       At boot trails are draped on the coarse base-collision height; the terrain then renders from
       finer streamed LODs. As fine height tiles decode, re-sample the finest decoded height per
       trail vert and rewrite Y = ground + LIFT in place. Fine-tile arrivals start a pass
       immediately, even while other tiles are still streaming; drains DRAPE_BUDGET cross-sections a frame; normals
       recompute once the pass commits. XZ is immutable (read back from the buffer). */
    update() {
      this._updateDetails();
      const t = this.terrain;
      if (!t || !t.hCache || !this._trails.length || !this.mesh) return;
      if (this._zBase === null) {
        if (!t.m) return;
        this._zBase = Math.min(t.m.minZoom + 3, t.m.maxZoom);
        this._maxZoom = t.m.maxZoom;
      }
      if (this._maxZoom <= this._zBase) return;

      if (this._pass) {
        this._stepPass();
        return;
      }
      if ((this._frame = (this._frame + 1) & 0x3fffffff) % 2 !== 0) return;
      const sig = this._fineSig();
      if (sig === this._drapedSig) return;
      this._startPass(sig);
      if (this._pass) this._stepPass();
    }

    _fineSig() {
      const t = this.terrain, zBase = this._zBase; let sig = 0;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= zBase) continue;
        sig = (sig + (((e.z * 73856093) ^ (e.x * 19349663) ^ (e.y * 83492791)) >>> 0)) >>> 0;
      }
      return sig;
    }

    _startPass(sig) {
      const idx = this._fineIndex();
      if (!idx) { this._drapedSig = sig; return; }
      const trails = [];
      for (const w of this._trails) {
        const bb = w.bb;
        if (!idx.intersects(bb)) continue;
        trails.push(w);
      }
      if(this.camera){
        const cx=this.camera.position.x,cz=this.camera.position.z;
        trails.sort((a,b)=>{
          const ax=(a.bb.minX+a.bb.maxX)*.5-cx,az=(a.bb.minZ+a.bb.maxZ)*.5-cz;
          const bx=(b.bb.minX+b.bb.maxX)*.5-cx,bz=(b.bb.minZ+b.bb.maxZ)*.5-cz;
          return ax*ax+az*az-(bx*bx+bz*bz);
        });
      }
      if (!trails.length) { this._drapedSig = sig; return; }
      const t = this.terrain;
      const S = (x, z) => { const y = idx(x, z); return y === null ? t.heightAt(x, z) : y; };
      this._pass = { sig, S, trails, wi: 0, dirty: false };
    }

    _stepPass() {
      const p = this._pass, arr = this.mesh.geometry.attributes.position.array;
      // Deadline checked AFTER each trail, so the pass always advances by at least one.
      const deadline = performance.now() + DRAPE_SLICE_MS;
      while (p.wi < p.trails.length) {
        const w = p.trails[p.wi], nn = w.n;
        // re-sample ground at each edge + centre on the finer tiles, then RE-GRADE (same smoothing as
        // build) so the re-drape keeps the graded profile instead of snapping back to raw ground-hug.
        const gC = new Float64Array(nn), gL = new Float64Array(nn), gR = new Float64Array(nn), sA = new Float64Array(nn);
        let px = 0, pz = 0;
        for (let i = 0; i < nn; i++) {
          const row=w.v0+i*w.stride;
          const k=(row+w.treadLeft)*3,rk=(row+w.treadRight)*3,ck=(row+w.treadCentre)*3;
          const lx = arr[k], lz = arr[k+2], rx = arr[rk], rz = arr[rk+2];
          gL[i] = p.S(lx, lz); gR[i] = p.S(rx, rz);
          const cx=arr[ck],cz=arr[ck+2];gC[i]=p.S(cx,cz);
          if (i > 0) sA[i] = sA[i - 1] + Math.hypot(cx - px, cz - pz);
          px = cx; pz = cz;
        }
        const { prof, tilt } = gradeProfile(gC, gL, gR, sA, w.width || TRAIL_W);
        if (w.structureKind === 'steps') {
          const rise = 0.17, origin = prof[0];
          for (let i = 0; i < nn; i++) {
            prof[i] = origin + Math.round((prof[i] - origin) / rise) * rise;
            tilt[i] = 0;
          }
        }
        for (let i = 0; i < nn; i++) {
          const row=w.v0+i*w.stride;
          const lk=(row+w.treadLeft)*3,rk=(row+w.treadRight)*3,ck=(row+w.treadCentre)*3;
          const lift=w.structureKind?LIFT:NATURAL_LIFT;
          arr[lk+1]=prof[i]-tilt[i]+lift-(w.structureKind?0:.012);
          arr[ck+1]=prof[i]+lift-(w.structureKind?0:
            w.classification==='primitive_trail'?.012:.025);
          arr[rk+1]=prof[i]+tilt[i]+lift-(w.structureKind?0:.012);
          if(!w.structureKind){
            const okL=row*3,okR=(row+w.stride-1)*3;
            arr[okL+1]=p.S(arr[okL],arr[okL+2])+EDGE_LIFT;
            arr[okR+1]=p.S(arr[okR],arr[okR+2])+EDGE_LIFT;
          }
        }
        if(!w.structureKind){
          // The fine terrain may curve above a 5 m chord even when both authored rows are
          // correctly draped. Sample each core midpoint and raise its adjacent rows together;
          // the wide outer disturbed rows remain terrain-flush and absorb the adjustment.
          const raise=new Float64Array(nn);
          for(let i=0;i+1<nn;i++) for(let c=w.treadLeft;c<=w.treadRight;c++){
            const ak=(w.v0+i*w.stride+c)*3,bk=(w.v0+(i+1)*w.stride+c)*3;
            const ground=p.S((arr[ak]+arr[bk])*.5,(arr[ak+2]+arr[bk+2])*.5);
            const deficit=ground+.045-(arr[ak+1]+arr[bk+1])*.5;
            if(deficit>0){raise[i]=Math.max(raise[i],deficit);raise[i+1]=Math.max(raise[i+1],deficit);}
          }
          for(let i=0;i<nn;i++) if(raise[i]>0)
            for(let c=w.treadLeft;c<=w.treadRight;c++)
              arr[(w.v0+i*w.stride+c)*3+1]+=raise[i];
        }
        for (const f of w.followers || [])
          arr[f.vertex * 3 + 1] = arr[f.source * 3 + 1] + f.dy;
        this._updateTreadNormals(w);
        p.wi++; p.dirty = true;
        if (performance.now() >= deadline) break;
      }
      if (p.wi < p.trails.length) return;
      if (p.dirty) {
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.normal.needsUpdate = true;
      }
      this._drapedSig = p.sig;
      this._pass = null;
      global.dispatchEvent(new CustomEvent('transport-geometry-updated'));
    }

    _updateTreadNormals(w) {
      const geometry=this.mesh.geometry, pos=geometry.attributes.position.array;
      const normal=geometry.attributes.normal.array, st=w.stride;
      for(let i=0;i<w.n;i++) for(let q=0;q<st;q++){
        const i0=Math.max(0,i-1),i1=Math.min(w.n-1,i+1);
        const q0=Math.max(0,q-1),q1=Math.min(st-1,q+1);
        const ak=(w.v0+i0*st+q)*3,bk=(w.v0+i1*st+q)*3;
        const ck=(w.v0+i*st+q0)*3,dk=(w.v0+i*st+q1)*3;
        const tx=pos[bk]-pos[ak],ty=pos[bk+1]-pos[ak+1],tz=pos[bk+2]-pos[ak+2];
        const lx=pos[dk]-pos[ck],ly=pos[dk+1]-pos[ck+1],lz=pos[dk+2]-pos[ck+2];
        let nx=ty*lz-tz*ly,ny=tz*lx-tx*lz,nz=tx*ly-ty*lx;
        if(ny<0){nx=-nx;ny=-ny;nz=-nz;}
        const length=Math.hypot(nx,ny,nz)||1,k=(w.v0+i*st+q)*3;
        normal[k]=nx/length;normal[k+1]=ny/length;normal[k+2]=nz/length;
      }
    }

    /* fast bilinear sampler over decoded FINER-than-base tiles (copied from RoadRibbon): O(zooms)
       tile index instead of scanning the cache per sample; null where no finer tile covers (x,z). */
    _fineIndex() {
      const t = this.terrain, S = t.m.tileSize, uMax = S - 1.001;
      const byZ = []; let zTop = -1;
      const hx = t.spanX / 2, hz = t.spanZ / 2, root = t.rootSpan;
      const coverZ = this._zBase + 1, cover = new Set();
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= this._zBase) continue;
        (byZ[e.z] || (byZ[e.z] = new Map())).set(e.x * 4096 + e.y, e);
        const shift = e.z - coverZ;
        cover.add(`${e.x >> shift},${e.y >> shift}`);
        if (e.z > zTop) zTop = e.z;
        const span = root / (1 << e.z);
        const x0 = e.x * span - hx, z0 = e.y * span - hz;
        if (x0 < minX) minX = x0; if (x0 + span > maxX) maxX = x0 + span;
        if (z0 < minZ) minZ = z0; if (z0 + span > maxZ) maxZ = z0 + span;
      }
      if (zTop < 0) return null;
      const sampler = (x, z) => {
        for (let zz = zTop; zz > this._zBase; zz--) {
          const tiles = byZ[zz]; if (!tiles) continue;
          const span = root / (1 << zz);
          const tx = Math.floor((x + hx) / span), ty = Math.floor((z + hz) / span);
          const e = tiles.get(tx * 4096 + ty);
          if (!e) continue;
          const g = e.decoded;
          // Terrain residency may release a fine CPU tile while a drape pass is spanning
          // multiple frames. Treat that tile as unavailable and fall through to a coarser
          // decoded source (or the caller's coarse heightAt fallback) instead of indexing null.
          if (!g) continue;
          let u = ((x + hx) / span - tx) * (S - 1), v = ((z + hz) / span - ty) * (S - 1);
          u = Math.max(0, Math.min(uMax, u)); v = Math.max(0, Math.min(uMax, v));
          const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
          const a = g[j * S + i], bb = g[j * S + i + 1];
          const c = g[(j + 1) * S + i], d = g[(j + 1) * S + i + 1];
          return (a + (bb - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
        }
        return null;
      };
      sampler.bounds = { minX, maxX, minZ, maxZ };
      sampler.intersects = bb => {
        const span = root / (1 << coverZ);
        const x0 = Math.floor((bb.minX + hx) / span), x1 = Math.floor((bb.maxX + hx) / span);
        const y0 = Math.floor((bb.minZ + hz) / span), y1 = Math.floor((bb.maxZ + hz) / span);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
          if (cover.has(`${x},${y}`)) return true;
        return false;
      };
      return sampler;
    }
  }

  global.TrailBuilder = TrailBuilder;
})(window);
