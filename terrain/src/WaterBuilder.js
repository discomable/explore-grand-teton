/* WaterBuilder — lakes & the Snake from the baked authoritative water surface (Three.js r184).
 *
 * Sprint M1-2 (water correctness + derived shorelines). The 10 m NHD mask was baked against
 * 10 m heights but the world renders 1.25 m lidar heights, so mask and terrain disagree.
 * pipeline/water/bake_water.py re-derives ONE authoritative surface elevation per connected
 * water component from the CURRENT tile pyramid (monotonic non-increasing downstream via
 * priority-flood + isotonic smoothing for rivers, one flat elevation per lake, modal pool
 * snap for the Jackson reservoir) into water-surface.png:
 *     R,G = surface elevation S (0.1 m steps above elevMin; 0 = no water surface here)
 *     B   = wet-rule bias (+0.25 m inside the NHD mask, falling off outside it)
 *
 * Runtime wetness is the FIELD  v(x,z) = terrain(x,z) - (S + bias):
 *     wet where v < 0 — inside the baked candidate band. Marching squares on v puts the
 *     shoreline exactly on the heightfield∩water-level intersection at whatever LOD the
 *     height sampler currently serves. This is what clips bank-climb (terrain rising above
 *     S+bias goes dry), fills small mask gaps (a real channel the mask missed has terrain
 *     well under S), and keeps water/terrain aligned at every LOD. roadQuery() is an extra
 *     gate: near-road cells only stay wet if the terrain there is clearly below the surface,
 *     which kills NHD fringe film on road embankments.
 *
 * Geometry is built in 256-px (2.56 km) CHUNKS of the mask grid, each owning its cells —
 * the old per-component builds double-drew overlapping component bboxes (two 0.92-alpha
 * sheets = the auditor's near-black rectangular slab on Jackson Lake). Chunks near the
 * camera rebuild at fine grid (20 m interior quads / 10 m shoreline cells) with SHORELINE
 * BANDS as decoded height tiles stream in; far chunks stay coarse (40 m / 20 m, no bands).
 *
 * Shoreline bands (water-owned geometry, terrain shaders untouched): for every shoreline
 * chord a quad strip is extruded toward the dry side and draped on the terrain — damp dark
 * sediment nearest the water → sand → gravel, fading out. Width follows local bank slope
 * (flat = wide, steep = none) with a deterministic per-chord jitter so the shore reads
 * natural, not striped.
 *
 * Surface look (unchanged from Sprint 5): baked-noise chop/micro-ripple normal fields,
 * downstream flow drift (aFlow now = gradient of the BAKED surface, so the reservoir pool
 * is exactly flat with exactly zero flow), shared planar lake reflections with the
 * display-space untone dance, cloud shade via CLOUD_UNIFORMS, shallow-fringe alpha + foam.
 *
 *   const wb = new WaterBuilder({scene, terrain, landcover, sun, fog});
 *   wb.build();                      // async inside; water appears when the bake loads
 *   waterMat = wb.material;          // main loop drives uTime
 *   wb.surfaceAt(x, z)               // water surface world-Y at a point, or null
 *   wb.reflections = false           // kill-switch: analytic sky only, zero reflector cost
 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const FRAG = /* glsl */`
    uniform float uTime; uniform vec3 uSun; uniform vec3 uSunColor; uniform vec3 uAmb;
    uniform vec3 uFogColor;
    uniform float uFogNear; uniform float uFogFar;
    uniform float uCloudTime; uniform float uCloudAmt;
    uniform sampler2D uRippleTex;
    uniform sampler2D uReflTex; uniform float uReflAmt; uniform float uReflPlaneY;
    varying vec3 vWorld; varying float vEdge; varying float vDepth; varying vec2 vFlow; varying vec4 vReflCoord;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
    }
    /* same fbm recipe as the terrain/sky cloud layer (5 octaves, 2.13 lacunarity) */
    float fbmSky(vec2 p){
      float s=0.0, a=0.5;
      for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.13+vec2(31.4,17.7); a*=0.5; }
      return s;
    }
    /* drifting cloud shade — terrain fragment's exact field, subtler on water (0.18).
       uCloudTime/uCloudAmt come from the shared CLOUD_UNIFORMS contract (amt: 0 night → 1 day). */
    float cloudShade(){
      if(uCloudAmt < 0.005) return 1.0;
      vec2 cuv = vWorld.xz / 2680.0;
      vec2 drift = vec2(uCloudTime*0.006, uCloudTime*0.0022);
      float c = fbmSky(cuv*1.35 + drift) + 0.45*fbmSky(cuv*3.4 - drift*2.0);
      float cover = smoothstep(0.72, 1.06, c);
      return 1.0 - 0.18*cover*uCloudAmt;
    }
    /* two scrolling tiling normal fields from the baked noise texture:
       ~74 m tile of 2-3 m chop + ~13 m tile of ~0.5 m micro-ripple, different headings.
       .xy = slopes in [-1,1], .z = height (for the sparkle term). */
    vec3 chop(vec2 q){
      vec3 s1 = texture2D(uRippleTex, q*0.0135 + vec2(uTime*0.0063,  uTime*0.0041)).xyz;
      vec3 s2 = texture2D(uRippleTex, q*0.076  + vec2(-uTime*0.0187, uTime*0.0122)).xyz;
      return vec3((s1.xy-0.5)*(2.0*0.62) + (s2.xy-0.5)*(2.0*0.34), s1.z*s2.z);
    }
    void main(){
      float edgeF = clamp(vEdge, 0.0, 1.0);
      // Geometry carries physical water-column depth (surface elevation minus sampled bed),
      // so lake colour does not depend on the depth buffer or any screen-space technique.
      // The deliberately short artistic range keeps real lidar outliers from turning into
      // hard colour bands: shore shallows are restrained teal, established water is blue.
      float depthF = smoothstep(0.35, 8.0, clamp(vDepth, 0.0, 8.0));
      float fd = length(vWorld - cameraPosition);
      vec2 p = vWorld.xz;
      vec3 ns;
      if(dot(vFlow, vFlow) > 1e-4){
        // river drift along the local downhill dir: flow-map style two-phase crossfade so
        // per-vertex UV offsets stay bounded (≤9 m) and never tear at cell borders
        float ph1 = fract(uTime*0.11), ph2 = fract(uTime*0.11 + 0.5);
        vec2 f = vFlow*9.0;
        ns = mix(chop(p - f*ph1), chop(p - f*ph2), abs(ph1*2.0 - 1.0));
      }else{
        ns = chop(p);
      }
      float calm = 1.0 - 0.62*smoothstep(0.45, 0.95, edgeF);   // shallow fringe is calmer
      vec3 n = normalize(vec3(ns.x*calm, 1.0, ns.y*calm));
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(1.0-max(dot(V,n),0.0),3.0);
      // reflected sky follows the ambient (day blue → golden hour amber → near-black night)
      float ambLum = dot(uAmb, vec3(0.35,0.45,0.20));
      vec3 shallow = vec3(0.055,0.235,0.205);
      vec3 deep = vec3(0.045,0.145,0.275);
      vec3 waterBody = mix(shallow, deep, depthF) * clamp(ambLum*1.4, 0.06, 1.0);
      // Reflected-sky tint. The OLD code tinted the WHOLE low-sun sky one flat warm beige
      // (0.85,0.55,0.38); at grazing angles (fres→1) that washed the entire lake to a sandy
      // tan "beach". Real low-sun water is amber ONLY toward the sun and cool twilight blue
      // everywhere else, so split the dusk sky by view azimuth: pow() concentrates the amber
      // into the sun-facing arc while the rest of the sheet stays blue → amber-on-blue, not sand.
      float warm = smoothstep(0.0,0.30,uSun.y);            // 0 low sun → 1 high day sun
      vec2 sunAz  = normalize(uSun.xz + vec2(1e-5));
      vec2 viewAz = normalize((vWorld.xz - cameraPosition.xz) + vec2(1e-5));
      float toSun = 0.5 + 0.5*dot(viewAz, sunAz);          // 1 looking toward the low sun
      vec3 duskSky = mix(vec3(0.16,0.22,0.34), vec3(0.92,0.52,0.26), pow(toSun, 3.0));
      vec3 skyc = mix(duskSky, vec3(0.55,0.72,0.87), warm);
      skyc *= clamp(uAmb*1.9, vec3(0.03), vec3(1.0));
      // planar reflection where this surface sits on the shared reflector plane; everything
      // else (rivers, mismatched ponds, gated frames) keeps the analytic sky color.
      // Tolerance grows with distance: a few metres of surface/plane mismatch (coarse-tile
      // river reaches, reservoir pool) is sub-pixel parallax at range but wrong up close.
      vec3 srefl = skyc;
      float yTol = 0.8 + fd*0.004;
      float rAmt = uReflAmt * (1.0 - smoothstep(yTol, yTol*3.0, abs(vWorld.y - uReflPlaneY)));
      // the mirror is gated by CAMERA-to-anchor distance, but on a 15 km reservoir fragments
      // sit way beyond it: the half-res RT renders far shores as blocky near-black slabs
      // (the auditor's "stepped rectangular slab"). Fade to the analytic sky at range —
      // past a few km the mirror is sub-pixel detail anyway. The safe range collapses with
      // camera ALTITUDE: from the air the mirror camera looks steeply UP and compresses the
      // dark far shore into a flat desaturated wedge on far grazing water (the aerial slab the
      // eye-level V.y band-fix never reached — from 700 m that far water still has V.y well
      // above the 0.085 waterline gate). So shrink the fade window as the camera climbs above
      // the plane: eye-level shore vistas keep their audited long-range mirror; aerial views
      // drop it past ~2 km where only the analytic sky reads cleanly anyway.
      float camH = max(cameraPosition.y - uReflPlaneY, 0.0);
      float farEnd = mix(5200.0, 1900.0, smoothstep(120.0, 520.0, camH));
      rAmt *= 1.0 - smoothstep(farEnd*0.42, farEnd, fd);
      // …and by incidence: near nadir the physical Fresnel term is a few percent, but the
      // fixed 0.25 base in the deep/srefl mix let the RT punch through — from the air the
      // mirror of the dark forested north bank at Oxbow read as an angular near-black wedge
      // against analytic-sky water (A/B-verified: wedge gone with reflections off). Keep the
      // mirror for grazing views (shore vistas, marina) where it was audited good; ease it
      // out toward nadir where sky dominates real water anyway. Gate on the FLAT-surface
      // fresnel (not the chop-perturbed one) so the falloff is spatially smooth instead of
      // mottling per-ripple through the transition band.
      float fresFlat = pow(1.0 - max(V.y, 0.0), 3.0);
      // Ease the mirror out only toward true nadir (looking straight down, sky dominates real
      // water). This used to gate hard at 0.15–0.55, which — with the far-grazing gate below —
      // left the mirror alive in only a mid-distance annulus, so the reflection blinked out as
      // you panned and that band left the visible water. The near-black cases those tight gates
      // were guarding against are now caught by the luminance darkFix at the sample, so widen
      // this to keep near/head-on water reflecting (the deep/srefl fres mix already dims it).
      rAmt *= smoothstep(0.02, 0.28, fresFlat);
      // Far-waterline slab fix. Right where the water meets the far shore the view ray grazes
      // the plane (V.y→0); there the mirror camera's oblique near-clip (set ON the water plane)
      // plus the half-res RT collapse the reflected far bank into a blocky near-black sliver —
      // the auditor's "stepped rectangular slab". Fade JUST that thin grazing contact band back
      // to the analytic sky (smooth, chop-independent: uses flat V.y not the perturbed normal),
      // so the waterline reads as haze while the rest of the shore vista keeps its mirror.
      // Narrowed to just the true contact line (was 0.02–0.085, which killed the whole far half
      // of the lake at a low level-pitch view); the darkFix sample fallback covers the rest.
      rAmt *= smoothstep(0.0, 0.03, V.y);
      if(rAmt > 0.003 && vReflCoord.w > 0.0){
        vec2 ruv = vReflCoord.xy / vReflCoord.w;
        ruv += n.xz * (0.05 * clamp(80.0/fd, 0.2, 1.0));      // chop breaks the mirror
        vec2 bord = min(ruv, 1.0-ruv);
        float inb = smoothstep(0.0, 0.03, min(bord.x, bord.y));
        if(inb > 0.0){
          vec3 rc = texture2D(uReflTex, clamp(ruv, 0.0, 1.0)).rgb;
          // the shared mirror RT renders the sky DOME too; at the reflected horizon of a LOW far
          // shore the dome's own below-horizon band (plus any oblique-clipped sliver) comes back
          // near-black — the dark wedge that swings across the lake as the view pans. Daylit sky
          // and sunlit terrain are never that dark, so fade any near-black mirror sample back to
          // the analytic sky. Legitimately dark reflections (night) already match skyc → no-op.
          float rcLum = dot(rc, vec3(0.299, 0.587, 0.114));
          float darkFix = smoothstep(0.02, 0.12, rcLum);
          srefl = mix(skyc, rc, rAmt*inb*darkFix);
        }
      }
      vec3 col = mix(waterBody, srefl, 0.25+0.75*fres);
      vec3 H = normalize(V+uSun);
      col += uSunColor*pow(max(dot(n,H),0.0),240.0)*2.5;   // sun glints by day, moon glitter at night
      col += vec3(0.10,0.14,0.14)*ns.z*ambLum;
      float shade = cloudShade();
      col *= shade;
      // faint broken foam right at the waterline, breathing with a slow noise-phased swell
      // (gentle shore lap): never a solid outline, gone by ~500 m, dims with ambient at night
      float lap = 0.5 + 0.5*sin(uTime*0.9 + vnoise(vWorld.xz*0.05)*6.28318);
      float foamN = vnoise(vWorld.xz*0.9+vec2(uTime*0.12,-uTime*0.08));
      float foam = smoothstep(0.80-0.10*lap, 0.97, edgeF)*smoothstep(0.35,0.80,foamN)
                 *(1.0-smoothstep(160.0,520.0,fd))*clamp(ambLum*1.5,0.0,1.0);
      col += vec3(0.70,0.78,0.78)*foam*(0.16+0.12*lap)*shade;
      col = mix(col,uFogColor,smoothstep(uFogNear,uFogFar,fd));
      // shallow fringe: alpha eases from the body's 0.92 to ~0.55 at the contoured
      // waterline, concentrated in the outer part of the shoreline cell (~5-10 m)
      float shore = smoothstep(0.40,0.95,edgeF);
      gl_FragColor = vec4(col, 0.92-0.37*shore+0.06*foam);
    }`;
  const VERT = /* glsl */`
    attribute float aEdge; attribute float aDepth; attribute vec2 aFlow;
    uniform mat4 uReflMatrix;
    varying vec3 vWorld; varying float vEdge; varying float vDepth; varying vec2 vFlow; varying vec4 vReflCoord;
    void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vWorld=wp.xyz; vEdge=aEdge;
      vDepth=aDepth; vFlow=aFlow; vReflCoord=uReflMatrix*wp;
      gl_Position=projectionMatrix*viewMatrix*wp; }`;

  /* shoreline band: aU 0 at the waterline → 1 at the dry fade-out edge. Draped on terrain.
     Damp dark sediment → sand → gravel with noise-jittered transitions and gravel speckle,
     lit flat (up-normal diffuse) so it tracks day/night, cloud-shaded like the water. */
  const BAND_FRAG = /* glsl */`
    uniform vec3 uSun; uniform vec3 uSunColor; uniform vec3 uAmb;
    uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
    uniform float uCloudTime; uniform float uCloudAmt;
    varying vec3 vWorld; varying float vU;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
    }
    float fbmSky(vec2 p){
      float s=0.0, a=0.5;
      for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.13+vec2(31.4,17.7); a*=0.5; }
      return s;
    }
    float cloudShade(){
      if(uCloudAmt < 0.005) return 1.0;
      vec2 cuv = vWorld.xz / 2680.0;
      vec2 drift = vec2(uCloudTime*0.006, uCloudTime*0.0022);
      float c = fbmSky(cuv*1.35 + drift) + 0.45*fbmSky(cuv*3.4 - drift*2.0);
      return 1.0 - 0.18*smoothstep(0.72, 1.06, c)*uCloudAmt;
    }
    void main(){
      float nz = vnoise(vWorld.xz*0.85)*0.30 + vnoise(vWorld.xz*3.6)*0.18;
      float u = clamp(vU + (nz - 0.24), 0.0, 1.2);       // jittered so bands never stripe
      vec3 damp   = vec3(0.21, 0.175, 0.135);            // dark wet sediment
      vec3 sand   = vec3(0.55, 0.475, 0.355);
      vec3 gravel = vec3(0.50, 0.485, 0.45);
      vec3 col = mix(damp, sand, smoothstep(0.12, 0.48, u));
      col = mix(col, gravel, smoothstep(0.55, 0.9, u));
      // moisture sheen right at the waterline; gravel speckle further out
      col *= mix(0.62, 1.0, smoothstep(0.02, 0.35, u));
      col *= 0.92 + 0.22*vnoise(vWorld.xz*7.5)*smoothstep(0.45, 0.9, u);
      vec3 li = uAmb*0.85 + uSunColor*max(uSun.y, 0.0)*0.95;
      col *= li*cloudShade();
      float fd = length(vWorld - cameraPosition);
      col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, fd));
      float a = 1.0 - smoothstep(0.60, 1.0, vU + (nz - 0.24)*0.7);
      gl_FragColor = vec4(col, a*0.96);
    }`;
  const BAND_VERT = /* glsl */`
    attribute float aU;
    varying vec3 vWorld; varying float vU;
    void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vWorld=wp.xyz; vU=aU;
      gl_Position=projectionMatrix*viewMatrix*wp; }`;

  /* ================= shoreline dressing (M4) =================
     Sparse reeds / grass tufts / sedge + occasional driftwood, emitted ONLY along gentle shallow
     waterline chords (see chord() slope gate). Crossed alpha billboards in the veg style: ONE
     4-column procedural atlas (no downloaded asset — original art, public-domain), ONE shared
     MeshLambert material (auto sun/hemi day-night + scene fog + the ACES curve via the built-in
     path), a per-instance aUvOff picks the column, instanceColor tints, and a uCloudTime sway
     leans the tops. Instanced per water chunk, frustum-culled, disposed on chunk rebuild. */
  const DRESS_COLS = 4;                                 // 0 reed · 1 grass · 2 sedge · 3 driftwood
  function makeDressAtlas() {
    const CW = 64, H = 128, cv = document.createElement('canvas');
    cv.width = CW * DRESS_COLS; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const blade = (x0, yb, yt, bend, wdt, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = wdt; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, yb);
      ctx.quadraticCurveTo(x0 + bend * 0.5, (yb + yt) / 2, x0 + bend, yt); ctx.stroke();
    };
    // col 0 — cattail reeds: tall straight green blades + one brown seed head
    let ox = 0;
    for (let i = 0; i < 7; i++) {
      const x = ox + 14 + i * 5.2, b = (i - 3) * 3;
      blade(x, H - 4, 12 + (i % 3) * 6, b, 2.4, i % 2 ? '#4a6b32' : '#5c7d3c');
    }
    ctx.fillStyle = '#6e4a2a'; ctx.fillRect(ox + 30, 20, 5, 20);
    // col 1 — grass tuft: shorter yellow-green fan
    ox = CW;
    for (let i = 0; i < 11; i++) {
      const x = ox + 12 + i * 3.6;
      blade(x, H - 4, H * 0.42 - (i % 4) * 6, (i - 5) * 6, 2.0, i % 2 ? '#8a8b3c' : '#9ca247');
    }
    // col 2 — sedge: dense fine bright-green blades
    ox = CW * 2;
    for (let i = 0; i < 15; i++) {
      const x = ox + 10 + i * 2.9;
      blade(x, H - 4, H * 0.5 - (i % 5) * 4, (i - 7) * 4, 1.5, i % 2 ? '#3f7a3a' : '#4d8f42');
    }
    // col 3 — driftwood: pale bleached log across the lower card + two branch stubs
    ox = CW * 3;
    ctx.strokeStyle = '#b9ad97'; ctx.lineWidth = 11; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(ox + 8, H - 22); ctx.lineTo(ox + CW - 8, H - 30); ctx.stroke();
    ctx.strokeStyle = '#a1937b'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(ox + 22, H - 24); ctx.lineTo(ox + 16, H - 40);
    ctx.moveTo(ox + 44, H - 27); ctx.lineTo(ox + 52, H - 44); ctx.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4; tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    return tex;
  }
  // crossed unit cards (base y=0 → tip y=1, width 1 centred), uv u∈[0,1/COLS], v∈[0,1]; up-normals
  // so the tufts read as evenly lit grass rather than one bright / one black face.
  function makeDressGeo() {
    const cw = 1 / DRESS_COLS, pos = [], uv = [], nor = [];
    const quad = (blx, blz, brx, brz) => {
      const v = [[blx, 0, blz, 0, 0], [brx, 0, brz, cw, 0], [brx, 1, brz, cw, 1], [blx, 1, blz, 0, 1]];
      const t = [0, 1, 2, 0, 2, 3];
      for (const k of t) { pos.push(v[k][0], v[k][1], v[k][2]); uv.push(v[k][3], v[k][4]); nor.push(0, 1, 0); }
    };
    quad(-0.5, 0, 0.5, 0);                              // plane facing Z
    quad(0, -0.5, 0, 0.5);                              // plane facing X
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return g;
  }

  class WaterBuilder {
    constructor(o) {
      this.scene = o.scene; this.terrain = o.terrain; this.lc = o.landcover;
      // shared cloud uniforms (order-independent contract; TerrainStreamer's owner advances them)
      const CU = global.CLOUD_UNIFORMS = global.CLOUD_UNIFORMS ||
        { uCloudTime: { value: 0 }, uCloudAmt: { value: 0 } };
      this.material = new THREE.ShaderMaterial({
        transparent: true, fog: false,
        // The water sheet sits fractionally above terrain that often encodes the same water
        // surface (lidar returns). Past ~1 km that gap is far below 24-bit depth precision,
        // so without an offset the sheet z-fights the bed into an axis-aligned patchwork
        // from aerial views. Slope-scaled polygon offset wins the tie deterministically at
        // every range (same trick RoadRibbon uses). Keep it minimal (-1/-2): larger values
        // let fringe water ghost through real banks.
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
        uniforms: {
          uTime: { value: 0 }, uSun: { value: o.sun },
          uSunColor: { value: o.sunColor || new THREE.Color(1, 0.95, 0.85) },
          uAmb: { value: o.ambient || new THREE.Color(0.78, 0.86, 1.0) },
          uFogColor: { value: o.fog.color },
          uFogNear: { value: o.fog.near }, uFogFar: { value: o.fog.far },
          uCloudTime: CU.uCloudTime, uCloudAmt: CU.uCloudAmt,
          uRippleTex: { value: this._makeRippleTex() },
          uReflTex: { value: null }, uReflAmt: { value: 0 },
          uReflPlaneY: { value: 0 }, uReflMatrix: { value: new THREE.Matrix4() },
        },
        vertexShader: VERT, fragmentShader: FRAG,
      });
      this.bandMaterial = new THREE.ShaderMaterial({
        transparent: true, fog: false, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
        uniforms: {
          uSun: this.material.uniforms.uSun,
          uSunColor: this.material.uniforms.uSunColor,
          uAmb: this.material.uniforms.uAmb,
          uFogColor: this.material.uniforms.uFogColor,
          uFogNear: this.material.uniforms.uFogNear,
          uFogFar: this.material.uniforms.uFogFar,
          uCloudTime: CU.uCloudTime, uCloudAmt: CU.uCloudAmt,
        },
        vertexShader: BAND_VERT, fragmentShader: BAND_FRAG,
      });
      // shoreline dressing (reeds/driftwood): built once, cloned per dressed chunk
      if (/[?&]noprops/.test(global.location ? global.location.search : '')) global.__NODRESS = true;
      this._dressGeo = makeDressGeo();
      this._dressDummy = new THREE.Object3D();
      this.dressMaterial = new THREE.MeshLambertMaterial({
        map: makeDressAtlas(), vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide });
      this.dressMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uCloudTime = CU.uCloudTime;
        shader.vertexShader = 'attribute float aUvOff;\nuniform float uCloudTime;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n#ifdef USE_INSTANCING\n' +
          '  float dPh = instanceMatrix[3].x*0.7 + instanceMatrix[3].z*0.9;\n' +
          '  transformed.x += sin(uCloudTime*1.4 + dPh) * uv.y * 0.06;\n' +
          '  transformed.z += cos(uCloudTime*1.05 + dPh*1.3) * uv.y * 0.05;\n#endif\n');
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>',
          '#include <uv_vertex>\n#ifdef USE_UV\n  vUv.x += aUvOff;\n#endif\n');
      };

      this.group = new THREE.Group();
      this.group.name = 'waterSurfaces';
      this.scene.add(this.group);
      // build stamp — open DevTools console to confirm which reflection build a tab is running
      // (cuts through browser-cache ambiguity). PLANAR = the current correct build.
      console.log('%c[GT] water reflections: PLANAR v5 (pre-pass; smooth per-frame refresh while moving)', 'color:#3af');
      this.reflections = true;           // lane kill-switch (false → analytic sky, zero cost)
      if (/[?&]norefl/.test(global.location ? global.location.search : '')) this.reflections = false;
      this._anchors = [];                // reflector planes: lakes + the flat reservoir pool
      this._refl = null;                 // lazy: RT + mirror camera, built on first eligible frame
      // The reflection now renders as a PRE-PASS from the main loop (see renderReflection, called
      // before renderer.render), NOT nested inside a water mesh's onBeforeRender. The old nested
      // render re-entered the renderer mid-frame; under load that intermittently produced an empty
      // mirror (terrain absent, sky-only) which blanked the reflection. A top-of-frame pre-pass is
      // non-re-entrant and robust. The per-mesh hook is kept as a no-op for safety.
      this._reflHook = () => {};
      this._chunks = [];                 // 256-px mask-grid chunks that contain water
      this._surf = null;                 // Uint16 surface grid (0 = none), from the bake
      this._bias = null;                 // Int8 wet-rule bias (×0.01 m)
      this._lakeAreas = [];              // authoritative lake footprints from baked components
      this.wm = null;                    // water-meta.json
    }

    /* kicks the async bake load; meshes appear when it lands. Fail = no water (loudly). */
    build() {
      this._ready = this._load()
        .then(() => { this._initChunks(); this._buildAll(); this._startRefinement(); })
        .catch(err => console.error('[water] baked surface unavailable — no water. ' +
          'Run terrain/pipeline/water/bake_water.py.', err));
      return this;
    }

    async _load() {
      const base = 'terrain/public/';
      this.wm = await (await fetch(base + 'water-meta.json')).json();
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('water-surface.png failed'));
        img.src = base + this.wm.url;
      });
      const W = this.wm.width, H = this.wm.height;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, W, H).data;
      // compact typed copies (the 46 MB ImageData is released with the canvas)
      const surf = new Uint16Array(W * H), bias = new Int8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        surf[i] = (d[i * 4] << 8) | d[i * 4 + 1];
        bias[i] = d[i * 4 + 2] - 128;
      }
      this._surf = surf; this._bias = bias;
      const w = this.wm.world;
      this._cE = w.centerEasting; this._cN = w.centerNorthing; this._datum = w.datum;
      // reflection anchors: every lake plane + the reservoir pool (anchorY = pool mode).
      // Only fragments whose height matches the plane reflect, so river reaches opt out.
      for (const L of this.wm.comps) {
        if (L.type === 'lake') {
          const [lx0, lz0] = this._pixelToWorld(L.minPx[0], L.minPx[1]);
          const [lx1, lz1] = this._pixelToWorld(L.maxPx[0] + 1, L.maxPx[1] + 1);
          this._lakeAreas.push({
            y: (L.anchorY !== undefined ? L.anchorY : L.elev) - this._datum,
            bbox: [Math.min(lx0, lx1), Math.min(lz0, lz1),
              Math.max(lx0, lx1), Math.max(lz0, lz1)],
          });
        }
        if (L.type === 'river' && L.areaPx <= 200000) continue;
        const [ax, az] = this._pixelToWorld(L.minPx[0], L.minPx[1]);
        const [bx, bz] = this._pixelToWorld(L.maxPx[0] + 1, L.maxPx[1] + 1);
        this._anchors.push({ y: (L.anchorY !== undefined ? L.anchorY : L.elev) - this._datum,
          bbox: [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)] });
      }
    }

    _pixelToWorld(px, py) {
      const m = this.wm;
      const E = m.originE + px * m.res, N = m.originN - py * m.res;
      return [E - this._cE, this._cN - N];
    }

    /* bilinear surface + bias at a world point (pixel-center registered), or null outside
       the baked candidate band. Missing neighbours are weight-dropped so the band edge
       doesn't smear toward zero. Returns [surfaceWorldY, biasMeters]. */
    _surfaceSampler() {
      const m = this.wm, W = m.width, H = m.height;
      const surf = this._surf, bias = this._bias;
      const e0 = m.elevMin - this._datum, cE = this._cE, cN = this._cN;
      const out = [0, 0];
      return (x, z) => {
        const u = (x + cE - m.originE) / m.res - 0.5;
        const v = (m.originN - (cN - z)) / m.res - 0.5;
        const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
        let ws = 0, ss = 0, bs = 0;
        for (let dj = 0; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= H) continue;
          for (let di = 0; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= W) continue;
            const q = surf[jj * W + ii];
            if (!q) continue;
            const w = (di ? fu : 1 - fu) * (dj ? fv : 1 - fv);
            ws += w; ss += w * q; bs += w * bias[jj * W + ii];
          }
        }
        if (ws < 1e-6) return null;
        out[0] = (ss / ws - 1) * 0.1 + e0;
        out[1] = (bs / ws) * 0.01;
        return out;
      };
    }

    /* ================= chunked build ================= */
    _initChunks() {
      const m = this.wm, W = m.width, H = m.height, C = WaterBuilder.CHUNK;
      const surf = this._surf;
      const nx = Math.ceil(W / C), ny = Math.ceil(H / C);
      for (let cy = 0; cy < ny; cy++) {
        for (let cx = 0; cx < nx; cx++) {
          const px0 = cx * C, py0 = cy * C;
          const px1 = Math.min(px0 + C, W), py1 = Math.min(py0 + C, H);
          let has = false;
          for (let py = py0; py < py1 && !has; py++) {
            const row = py * W;
            for (let px = px0; px < px1; px += 2) {   // stride 2: band is ≥9 px wide
              if (surf[row + px]) { has = true; break; }
            }
          }
          if (!has) continue;
          const [ax, az] = this._pixelToWorld(px0, py0);
          const [bx, bz] = this._pixelToWorld(px1, py1);
          this._chunks.push({
            px0, py0, px1, py1,
            bbox: [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)],
            mesh: null, band: null, builtSig: -1, sig: 0, lastBuild: 0,
          });
        }
      }
    }

    _buildAll() {
      // boot build: coarse everywhere (only the z-base collision tiles are decoded anyway);
      // builtSig 0 = "coarse, no bands, no fine tiles seen" so the first refine tick only
      // rebuilds chunks that actually want more
      for (const ch of this._chunks) { this._buildChunk(ch, false, false); ch.builtSig = 0; }
    }

    /* distance from camera to a chunk's world rect */
    _chunkDist(ch, cam) {
      const b = ch.bbox;
      const dx = Math.max(b[0] - cam.x, 0, cam.x - b[2]);
      const dz = Math.max(b[1] - cam.z, 0, cam.z - b[3]);
      return Math.hypot(dx, dz);
    }

    _buildChunk(ch, fine, bands) {
      if (ch.mesh) { this.group.remove(ch.mesh); ch.mesh.geometry.dispose(); ch.mesh = null; }
      if (ch.band) { this.group.remove(ch.band); ch.band.geometry.dispose(); ch.band = null; }
      if (ch.dress) { this.group.remove(ch.dress); ch.dress.geometry.dispose(); ch.dress = null; }
      const step = fine ? 2 : 4, sub = fine ? 1 : 2;
      const m = this.wm, W = m.width, H = m.height;
      const surfGrid = this._surf;
      const sampleS = this._surfaceSampler();
      const sampleH = this._heightSampler();
      const rq = global.roadQuery;
      const HW = { track: 1.8, gravel: 3.0, park_paved: 4.0, highway: 6.0 };

      /* the wet field v = terrain - (S + bias); cached per lattice node. Near-road nodes
         only stay wet when terrain is clearly below the surface (embankment fringe dies,
         genuinely deep water under a legit crossing survives).
         Lattice nodes on the px==W / py==H boundary LINE map to the data extent itself
         (x=+spanX/2 etc. — the exact line terrain clips to); px==0 already sits on the west
         extent line, so without the <= the east/south water was cut one cell short of the
         terrain edge with a contoured false shoreline. sampleS edge-extends there by
         weight-dropping the out-of-grid bilinear taps. */
      const cache = new Map();
      const ev = (px, py) => {
        const k = (py + 8) * 8192 + px + 8;      // pad cells go 1 step negative
        let e = cache.get(k);
        if (e !== undefined) return e;
        let v = 9, sy = NaN;
        if (px >= 0 && py >= 0 && px <= W && py <= H) {
          const [wx, wz] = this._pixelToWorld(px, py);
          const sb = sampleS(wx, wz);
          if (sb) {
            const h = sampleH(wx, wz);
            sy = sb[0];
            v = h - (sb[0] + sb[1]);
            let authoritativeWater = false;
            // Core pixels come from the authoritative source-water mask. Fine terrain tiles
            // contain noisy returns over open water, so only the dilated shoreline candidate
            // band may be clipped back against live terrain.
            if (sb[1] >= 0.24) { v = Math.min(v, -0.01); authoritativeWater = true; }
            // A lake component is a solved flat surface. Within its recorded source footprint,
            // live DEM variation is measurement noise over water, not an island boundary.
            for (const lake of this._lakeAreas) {
              const b = lake.bbox;
              if (wx >= b[0] && wx <= b[2] && wz >= b[1] && wz <= b[3] &&
                  Math.abs(sy - lake.y) < 0.35) {
                v = Math.min(v, -0.01);
                authoritativeWater = true;
                break;
              }
            }
            if (v < 0 && rq && !authoritativeWater) {
              const r = rq(wx, wz);
              if (r.dist < (HW[r.class] || 3) + 1.5 && h > sb[0] - 0.5) v = 0.3;
            }
          }
        }
        e = { v, sy };
        cache.set(k, e);
        return e;
      };
      const wet = (px, py) => ev(px, py).v < 0;

      // downstream flow from the BAKED surface gradient (pool = exactly flat = zero flow)
      const NOFLOW = [0, 0];
      const flowCache = new Map();
      const flowAt = (px, py) => {
        const k = (py + 8) * 8192 + px + 8;
        let f = flowCache.get(k);
        if (f) return f;
        f = NOFLOW;
        const [wx, wz] = this._pixelToWorld(px, py);
        const d = 15;
        const sc = sampleS(wx, wz);
        if (sc) {
          const s0 = sc[0];
          const sxp = sampleS(wx + d, wz), sxm = sampleS(wx - d, wz);
          const szp = sampleS(wx, wz + d), szm = sampleS(wx, wz - d);
          const gx = (sxp ? sxp[0] : s0) - (sxm ? sxm[0] : s0);
          const gz = (szp ? szp[0] : s0) - (szm ? szm[0] : s0);
          const gn = Math.hypot(gx, gz);
          if (gn > 1e-6) {
            const s = Math.min(1, (gn / (2 * d)) * 400);
            f = [-gx / gn * s, -gz / gn * s];
          }
        }
        flowCache.set(k, f);
        return f;
      };

      const positions = [], edgeAttr = [], depthAttr = [], flowAttr = [];
      const bandPos = [], bandU = [];
      const dressMat = [], dressUv = [], dressCol = [];   // shoreline reeds/driftwood (M4)
      const DRESS_CAP = 480, dressLC = this.lc, dressDummy = this._dressDummy;
      const dhash = (a, b) => Math.abs(Math.sin(a * 45.11 + b * 13.73)) % 1;
      // verts are [wx, wy, wz, aEdge, depth, flowX, flowZ]. Depth is sampled from the
      // actual terrain bed, not the wet-rule bias used only to contour the shoreline.
      const pushTri = (p, q, r) => {
        positions.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
        edgeAttr.push(p[3], q[3], r[3]);
        depthAttr.push(p[4], q[4], r[4]);
        flowAttr.push(p[5], p[6], q[5], q[6], r[5], r[6]);
      };
      const corner = (px, py) => {
        const e = ev(px, py);
        const [wx, wz] = this._pixelToWorld(px, py);
        const f = flowAt(px, py);
        return [wx, e.sy, wz, 0, Math.max(0, e.sy - sampleH(wx, wz)), f[0], f[1]];
      };

      /* shoreline band quad strip for one waterline chord p→q (world verts). Extruded
         toward the dry side, draped on the terrain; width follows local bank slope. */
      const chord = (p, q) => {
        const mx = (p[0] + q[0]) / 2, mz = (p[2] + q[2]) / 2;
        let dx = q[0] - p[0], dz = q[2] - p[2];
        const len = Math.hypot(dx, dz);
        if (len < 0.5) return;
        dx /= len; dz /= len;
        let nx = dz, nz = -dx;                       // chord normal, sign resolved by probe
        const sHere = sampleS(mx, mz);
        if (!sHere) return;
        const sMid = sHere[0];
        if (rq) {
          const r = rq(mx, mz);
          if (r.dist < (HW[r.class] || 3) + 2) return;   // no beach on carriageways
        }
        const dPlus = sampleH(mx + nx * 2.5, mz + nz * 2.5) - sMid;
        const dMinus = sampleH(mx - nx * 2.5, mz - nz * 2.5) - sMid;
        if (dMinus > dPlus) { nx = -nx; nz = -nz; }
        const slope = Math.max(Math.max(dPlus, dMinus), 0.02) / 2.5;
        if (slope > 0.55) return;                    // steep bank: no beach at all
        const jit = Math.abs(Math.sin(mx * 12.9898 + mz * 78.233)) % 1;
        const w = Math.min(9, Math.max(1.5, 0.55 / Math.max(slope, 0.05))) * (0.7 + 0.6 * jit);
        const B = [];                                // rows: in(-0.8) / mid(0.45w) / out(w)
        for (const off of [-0.8, w * 0.45, w]) {
          for (const s of [p, q]) {
            const x = s[0] + nx * off, z = s[2] + nz * off;
            B.push([x, sampleH(x, z) + 0.04, z, off < 0 ? 0 : off / w]);
          }
        }
        const quad = (a, b, c, d) => {
          bandPos.push(B[a][0], B[a][1], B[a][2], B[b][0], B[b][1], B[b][2],
                       B[c][0], B[c][1], B[c][2]);
          bandU.push(B[a][3], B[b][3], B[c][3]);
          bandPos.push(B[b][0], B[b][1], B[b][2], B[d][0], B[d][1], B[d][2],
                       B[c][0], B[c][1], B[c][2]);
          bandU.push(B[b][3], B[d][3], B[c][3]);
        };
        quad(0, 1, 2, 3); quad(2, 3, 4, 5);

        /* —— shoreline dressing —— reeds only on gentle shallow margins (this flat chord), never
           on steep/rocky banks (already returned) nor forested/barren lake fringes. Deterministic
           from world position; sparse; a few reeds/grass/sedge with the odd driftwood log. */
        if (global.__NODRESS || slope >= 0.16 || dressMat.length >= DRESS_CAP) return;
        const clsDry = dressLC ? dressLC.classAt(mx + nx * w * 0.5, mz + nz * w * 0.5) : 0;
        if (!(clsDry === 71 || clsDry === 81 || clsDry === 82 || clsDry === 90 ||
              clsDry === 95 || clsDry === 52 || clsDry === 0)) return;
        const nCand = Math.max(1, Math.floor(len * 0.5));
        for (let c = 0; c < nCand && dressMat.length < DRESS_CAP; c++) {
          if (dhash(mx + c * 3.1, mz - c * 1.7) > 0.4) continue;      // sparse
          const t = (c + 0.5) / nCand;
          const bx = p[0] + (q[0] - p[0]) * t, bz = p[2] + (q[2] - p[2]) * t;
          const off = -0.4 + dhash(bx * 7.7, bz * 3.3) * (w * 0.7 + 0.4);   // shallows → damp bank
          const rx = bx + nx * off, rz = bz + nz * off;
          const rv = dhash(rx * 1.3, rz * 2.1);
          const col = dhash(rx * 5.9, rz * 9.2) < 0.06 ? 3 : (rv < 0.34 ? 0 : rv < 0.7 ? 1 : 2);
          const yb = sampleH(rx, rz) + 0.02;
          let sw, sh;
          if (col === 3) { sw = 1.5 + rv * 1.1; sh = 0.35 + rv * 0.2; }   // driftwood: low + wide
          else { sh = col === 0 ? 1.1 + rv * 0.9 : 0.5 + rv * 0.4; sw = 0.4 + rv * 0.4; }
          dressDummy.position.set(rx, yb, rz);
          dressDummy.rotation.set(0, rv * Math.PI * 2, 0);
          dressDummy.scale.set(sw, sh, col === 3 ? sw * 0.6 : sw);
          dressDummy.updateMatrix();
          dressMat.push(dressDummy.matrix.clone());
          dressUv.push(col / DRESS_COLS);
          if (col === 3) dressCol.push(0.72, 0.68, 0.60);
          else { const g = 0.8 + rv * 0.4; dressCol.push(g * 0.85, g, g * 0.6); }
        }
      };

      const quickQ = (px, py) =>                     // integer candidate test (fast reject);
        // boundary-line nodes (px==W / py==H) read the edge pixel they extend
        px >= 0 && py >= 0 && px <= W && py <= H &&
        surfGrid[Math.min(py, H - 1) * W + Math.min(px, W - 1)] > 0;

      for (let py = ch.py0 - step; py < ch.py1; py += step) {
        for (let px = ch.px0 - step; px < ch.px1; px += step) {
          // cells are owned by the chunk containing their origin, except the leading pad
          // row/column (so shoreline cells straddling the chunk edge aren't clipped) —
          // the pad only emits if the origin lies OUTSIDE every other chunk's core, i.e.
          // px<px0 requires px<0 side handled by ownership: skip pads that a neighbour owns
          if ((px < ch.px0 && px >= 0 && ch.px0 > 0) ||
              (py < ch.py0 && py >= 0 && ch.py0 > 0)) continue;
          const p1x = px + step, p1y = py + step,
                mx2 = px + (step >> 1), my2 = py + (step >> 1);
          // fast reject on the baked candidate band before any height sampling
          if (!(quickQ(px, py) || quickQ(p1x, py) || quickQ(px, p1y) || quickQ(p1x, p1y) ||
                quickQ(mx2, my2))) continue;
          const aw = wet(px, py), bw = wet(p1x, py),
                cw = wet(px, p1y), dw = wet(p1x, p1y);
          const m1 = wet(mx2, py), m2 = wet(px, my2), m3 = wet(mx2, my2),
                m4 = wet(p1x, my2), m5 = wet(mx2, p1y);
          if (!(aw || bw || cw || dw || m1 || m2 || m3 || m4 || m5)) continue;
          if (aw && bw && cw && dw && m1 && m2 && m3 && m4 && m5) {
            // interior: plain coarse quad on the baked surface
            pushTri(corner(px, py), corner(px, p1y), corner(p1x, py));
            pushTri(corner(p1x, py), corner(px, p1y), corner(p1x, p1y));
            continue;
          }
          // shoreline cell — re-contour at sub resolution, marching squares on the field.
          // Shore verts sit exactly where terrain crosses S+bias (the waterline).
          for (let sy = 0; sy < step; sy += sub) {
            const q0y = py + sy, q1y = py + Math.min(sy + sub, step);
            for (let sx = 0; sx < step; sx += sub) {
              const q0x = px + sx, q1x = px + Math.min(sx + sub, step);
              const cyc = [[q0x, q0y], [q0x, q1y], [q1x, q1y], [q1x, q0y]];
              const es = cyc.map(c => ev(c[0], c[1]));
              if (!(es[0].v < 0 || es[1].v < 0 || es[2].v < 0 || es[3].v < 0)) continue;
              const vert = (ci) => {
                const [cx, cyy] = cyc[ci], e = es[ci];
                const [wx, wz] = this._pixelToWorld(cx, cyy);
                const f = flowAt(cx, cyy);
                return [wx, e.sy, wz, 0, Math.max(0, e.sy - sampleH(wx, wz)), f[0], f[1]];
              };
              if (es[0].v < 0 && es[1].v < 0 && es[2].v < 0 && es[3].v < 0) {
                pushTri(vert(0), vert(1), vert(3)); pushTri(vert(3), vert(1), vert(2));
                continue;
              }
              // walk the boundary: keep wet corners, insert a waterline vertex where the
              // field crosses zero on a wet/dry edge (linear interp of v along the edge)
              const cross = (i, j) => {
                const a = es[i], b = es[j];
                let t = a.v / (a.v - b.v);
                t = Math.max(0.04, Math.min(0.96, t));
                const fpx = cyc[i][0] + (cyc[j][0] - cyc[i][0]) * t;
                const fpy = cyc[i][1] + (cyc[j][1] - cyc[i][1]) * t;
                const [wx, wz] = this._pixelToWorld(fpx, fpy);
                const sa = isNaN(a.sy) ? b.sy : a.sy, sb2 = isNaN(b.sy) ? a.sy : b.sy;
                const wetIdx = a.v < 0 ? i : j;
                const f = flowAt(cyc[wetIdx][0], cyc[wetIdx][1]);
                const wy = sa + (sb2 - sa) * t;
                return [wx, wy, wz, 1, Math.max(0, wy - sampleH(wx, wz)), f[0], f[1]];
              };
              const poly = [], shore = [];
              for (let i = 0; i < 4; i++) {
                const j = (i + 1) % 4;
                if (es[i].v < 0) { poly.push(vert(i)); shore.push(false); }
                if ((es[i].v < 0) !== (es[j].v < 0)) {
                  poly.push(cross(i, j)); shore.push(true);
                }
              }
              for (let i = 2; i < poly.length; i++) pushTri(poly[0], poly[i - 1], poly[i]);
              if (bands) {
                for (let i = 0; i < poly.length; i++) {
                  const j = (i + 1) % poly.length;
                  if (shore[i] && shore[j]) chord(poly[i], poly[j]);
                }
              }
            }
          }
        }
      }
      if (positions.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeAttr, 1));
        g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depthAttr, 1));
        g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flowAttr, 2));
        ch.mesh = new THREE.Mesh(g, this.material);
        ch.mesh.renderOrder = 2;                     // after the shoreline band
        // reflector driver: runs only when some water is actually on screen
        ch.mesh.onBeforeRender = this._reflHook;
        ch.mesh.matrixAutoUpdate = false; ch.mesh.updateMatrix();   // world-space verts, identity transform
        this.group.add(ch.mesh);
      }
      if (bandPos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3));
        g.setAttribute('aU', new THREE.Float32BufferAttribute(bandU, 1));
        ch.band = new THREE.Mesh(g, this.bandMaterial);
        ch.band.renderOrder = 1;
        ch.band.matrixAutoUpdate = false; ch.band.updateMatrix();
        this.group.add(ch.band);
      }
      if (dressMat.length) {
        const n = dressMat.length;
        const g = this._dressGeo.clone();               // 12-vert card + this chunk's per-instance uv
        const uvArr = new Float32Array(n);
        for (let i = 0; i < n; i++) uvArr[i] = dressUv[i];
        g.setAttribute('aUvOff', new THREE.InstancedBufferAttribute(uvArr, 1));
        const b = ch.bbox, midY = ch.midY || 0;
        g.boundingSphere = new THREE.Sphere(
          new THREE.Vector3((b[0] + b[2]) / 2, midY, (b[1] + b[3]) / 2),
          Math.hypot(b[2] - b[0], b[3] - b[1]) / 2 + 20);
        const im = new THREE.InstancedMesh(g, this.dressMaterial, n);
        const col = new THREE.Color();
        for (let i = 0; i < n; i++) {
          im.setMatrixAt(i, dressMat[i]);
          col.setRGB(dressCol[i * 3], dressCol[i * 3 + 1], dressCol[i * 3 + 2]);
          im.setColorAt(i, col);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.frustumCulled = true;
        im.renderOrder = 2;
        im.matrixAutoUpdate = false; im.updateMatrix();
        ch.dress = im;
        this.group.add(im);
      }
      ch.builtFine = fine; ch.builtBands = bands;
      ch.lastBuild = performance.now();
    }

    /* ================= lazy chunk refinement =================
       Chunks are built once at boot from the coarse collision-base heights. As the streamer
       decodes finer height tiles near the camera, nearby chunks rebuild fine (10 m shoreline
       cells + sediment bands); far chunks stay coarse and band-less. A cheap poll compares a
       per-chunk signature of decoded finer-than-base tiles + desired quality. */
    _startRefinement() {
      const t = this.terrain;
      if (!t || !t.m || !t.hCache || !this._chunks.length) return;
      this._zBase = Math.min(t.m.minZoom + 3, t.m.maxZoom);   // _loadBaseCollision's zoom
      this._refineTimer = setInterval(() => this._refineTick(), 250);
    }

    _refineTick() {
      const t = this.terrain;
      if (t.fetchQueue.length || t.uploadQueue.length || t.inFlight) return;  // streams settling
      const cam = t.camera && t.camera.position;
      if (!cam) return;
      // teleport rush: after a fast-travel / auto-capture jump, skip the rebuild cooldown and
      // triple the idle budget for a few seconds so the destination water is fine before the
      // player (or the headless camera) gets a good look at it
      const nowT = performance.now();
      const moved = this._lastCam ? Math.hypot(cam.x - this._lastCam[0], cam.z - this._lastCam[1]) : 1e9;
      this._lastCam = [cam.x, cam.z];
      if (moved > 2000) this._rushUntil = nowT + 8000;
      const rush = nowT < this._rushUntil;
      // signature of the finer-than-base decoded tiles over each chunk
      for (const ch of this._chunks) ch.sig = 0;
      for (const e of t.hCache.values()) {
        if (!e.decoded || e.z <= this._zBase) continue;
        const span = t.rootSpan / Math.pow(2, e.z);
        const minX = -t.spanX / 2 + e.x * span, minZ = -t.spanZ / 2 + e.y * span;
        const h = ((e.z * 73856093) ^ (e.x * 19349663) ^ (e.y * 83492791)) >>> 0;
        for (const ch of this._chunks) {
          const b = ch.bbox;
          if (minX < b[2] && minX + span > b[0] && minZ < b[3] && minZ + span > b[1]) ch.sig += h;
        }
      }
      const now = performance.now();
      const pending = [];
      for (const ch of this._chunks) {
        const d = this._chunkDist(ch, cam);
        if (d > 15000) continue;          // far chunks rebuild when the camera gets there
        const fine = d < WaterBuilder.FINE_DIST;
        const bands = d < WaterBuilder.BAND_DIST;
        const sig = ch.sig * 4 + (fine ? 2 : 0) + (bands ? 1 : 0);
        if (sig === ch.builtSig || (!rush && now - ch.lastBuild < 2500)) continue;
        ch._want = { sig, fine, bands, d };
        pending.push(ch);
      }
      if (!pending.length || this._refining) return;
      pending.sort((a, b) => a._want.d - b._want.d);
      this._refining = true;
      const budget = rush ? 45 : 14;
      const run = () => {
        const t0 = performance.now();
        while (pending.length) {
          const ch = pending.shift();
          this._buildChunk(ch, ch._want.fine, ch._want.bands);
          ch.builtSig = ch._want.sig;
          if (performance.now() - t0 > budget) break;   // the rest re-queues next tick
        }
        this._refining = false;
      };
      if (global.requestIdleCallback) global.requestIdleCallback(run, { timeout: 150 });
      else setTimeout(run, 0);
    }

    /* ================= planar lake reflections ================= */
    /* Reflection RT policy: scale from the renderer's real drawing buffer (therefore follows
       DPR and quality presets), preserve its aspect, and cap memory/fill cost. Ultra can reach
       1600×900 but never exceeds 1,048,576 pixels; small windows retain at least 320×180.
       A target is replaced only after a meaningful (>=32×18 px or >=8%) size change, avoiding
       resize churn from fractional browser chrome/layout changes. */
    _ensureReflectionTarget(renderer, R) {
      const db = R.drawSize || (R.drawSize = new THREE.Vector2());
      renderer.getDrawingBufferSize(db);
      const aspect = Math.max(db.x / Math.max(db.y, 1), 1e-3);
      const minW = 320, minH = 180, maxW = 1600, maxH = 900, maxPixels = 1048576;
      let scale = 0.70;
      scale = Math.max(scale, minW / db.x, minH / db.y);
      scale = Math.min(scale, maxW / db.x, maxH / db.y,
        Math.sqrt(maxPixels / Math.max(db.x * db.y, 1)));
      const even = n => Math.max(2, Math.round(n / 2) * 2);
      let w = even(db.x * scale), h = even(w / aspect);
      // Rounding to even pixels can push a just-budgeted target a few pixels over.
      if (w * h > maxPixels) {
        const shrink = Math.sqrt(maxPixels / (w * h));
        w = even(w * shrink); h = even(w / aspect);
        while (w * h > maxPixels) { w -= 2; h = even(w / aspect); }
      }
      const materiallyChanged = !R.rt ||
        Math.abs(w - R.rtW) >= 32 || Math.abs(h - R.rtH) >= 18 ||
        Math.abs(w / R.rtW - 1) >= 0.08 || Math.abs(h / R.rtH - 1) >= 0.08;
      if (!materiallyChanged) return false;
      if (R.rt) R.rt.dispose();
      R.rt = new THREE.WebGLRenderTarget(w, h, { stencilBuffer: false });
      // The reflection is a scene-radiance intermediate. It stays linear and joins the water
      // shader before the one final exposure/tone/output transform.
      R.rt.texture.encoding = THREE.LinearEncoding;
      R.rt.texture.generateMipmaps = false;
      R.rtW = w; R.rtH = h; R.have = false;
      return true;
    }

    /* one deterministic 256px tiling noise DataTexture (4 wrapped value-noise octaves, seeded
       integer hash): RG = height-field slopes (128-biased), B = height. Baked at boot, no
       disk asset. Mipmapped, so far water self-calms instead of shimmering. */
    _makeRippleTex() {
      const S = 256;
      const hash2 = (x, y) => {
        let n = ((x * 374761393 + y * 668265263) ^ 0x5bf03635) | 0;
        n = Math.imul(n ^ (n >>> 13), 1274126177);
        return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
      };
      const H = new Float32Array(S * S);
      let amp = 1, tot = 0;
      for (let oct = 0; oct < 4; oct++) {
        const cells = 8 << oct, seed = oct * 1013;
        for (let y = 0; y < S; y++) {
          const fy = y * cells / S, iy = fy | 0, ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
          const y1 = (iy + 1) % cells;
          for (let x = 0; x < S; x++) {
            const fx = x * cells / S, ix = fx | 0, tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
            const x1 = (ix + 1) % cells;
            const a = hash2(ix + seed, iy), b = hash2(x1 + seed, iy),
                  c = hash2(ix + seed, y1), d = hash2(x1 + seed, y1);
            H[y * S + x] += ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy) * amp;
          }
        }
        tot += amp; amp *= 0.55;
      }
      const dx = new Float32Array(S * S), dz = new Float32Array(S * S);
      let mx = 1e-9;
      for (let y = 0; y < S; y++) {
        const ym = (y + S - 1) % S, yp = (y + 1) % S;
        for (let x = 0; x < S; x++) {
          const xm = (x + S - 1) % S, xp = (x + 1) % S, i = y * S + x;
          dx[i] = H[y * S + xp] - H[y * S + xm];
          dz[i] = H[yp * S + x] - H[ym * S + x];
          mx = Math.max(mx, Math.abs(dx[i]), Math.abs(dz[i]));
        }
      }
      const data = new Uint8Array(S * S * 4);
      const k = 0.92 * 127 / mx;
      for (let i = 0; i < S * S; i++) {
        data[i * 4]     = 128 + Math.round(dx[i] * k);
        data[i * 4 + 1] = 128 + Math.round(dz[i] * k);
        data[i * 4 + 2] = Math.min(255, Math.round(255 * H[i] / tot));
        data[i * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    }

    /* mirror pass, Reflector-style but shared + gated. Runs from mesh.onBeforeRender during
       the transparent pass of the MAIN render. Recursion is impossible: this.group is hidden
       for the pass, so no water mesh fires its hook inside it. Amortized purely on wall-clock
       (see the reuse gate): renders once per frame while the view moves (a matched fresh
       matrix + RT keeps the reflection aligned), reuses the last render target within a frame
       and while the view is static. uReflAmt is set on EVERY path so it can never get stuck
       off — the old renderer.info.render.frame gate could, which dropped the reflection under
       load. */
    /* true when at least one built water chunk survives the camera frustum — i.e. when the main
       render will rasterise water fragments that sample the mirror. Chunk vertices are already in
       world space under an untransformed group, so Frustum.intersectsObject is bit-for-bit the
       test WebGLRenderer.projectObject will run a moment later. */
    _reflVisible(camera) {
      const F = this._reflFrustum || (this._reflFrustum = new THREE.Frustum());
      const M = this._reflFrustumM || (this._reflFrustumM = new THREE.Matrix4());
      F.setFromProjectionMatrix(M.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const ch of this._chunks) {
        const m = ch.mesh;
        if (!m || !m.visible) continue;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        if (F.intersectsObject(m)) return true;
      }
      return false;
    }

    _reflectPass(renderer, camera) {
      const U = this.material.uniforms;
      if (!this.reflections || !this.terrain || !this.terrain.group) {
        U.uReflAmt.value = 0; return;
      }
      const R = this._refl || (this._refl = {
        rt: null, cam: new THREE.PerspectiveCamera(), tm: new THREE.Matrix4(),
        plane: new THREE.Plane(), cpv: new THREE.Vector4(), tgt: new THREE.Vector3(),
        have: false, lastPos: new THREE.Vector3(1e9, 1e9, 1e9), lastFwd: new THREE.Vector3(),
        lastPlaneY: NaN, lastAspect: 0, lastMs: -1e9, rtW: 0, rtH: 0,
      });
      // gate: nearest reflection anchor whose plane is below the camera, within 2.5 km
      const cp = camera.position;
      let best = null, bestD = 2500 * 2500;
      for (const a of this._anchors) {
        if (cp.y <= a.y + 0.4) continue;                 // camera under this plane
        const dx = Math.max(a.bbox[0] - cp.x, 0, cp.x - a.bbox[2]);
        const dz = Math.max(a.bbox[1] - cp.z, 0, cp.z - a.bbox[3]);
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { best = a; bestD = d2; }
      }
      if (!best) { U.uReflAmt.value = 0; return; }       // not over any lake → analytic sky
      // Nothing samples uReflTex/uReflAmt unless a water chunk is actually drawn, and the anchor
      // gate above only asks "is a lake plane within 2.5 km and below me" — true for most of the
      // valley floor, including with the lake squarely behind the camera. Reuse three's own
      // per-object frustum test (same bounding sphere, same frustum, identity world matrix) so we
      // skip the whole mirror render exactly when the renderer would draw no water this frame.
      // Uniforms are left untouched: with no water fragments, nobody reads them.
      if (!this._reflVisible(camera)) return;
      const targetChanged = this._ensureReflectionTarget(renderer, R);
      // Re-render whenever the view MOVED: a planar mirror's projection matrix and its render
      // target are a matched pair, so a fresh matrix needs a fresh render — reusing a stale RT
      // under a moved camera projects the reflection off the water and it reads as flat (that's
      // what made it "barely appear" while panning). Reuse only when it's cheap-and-correct:
      // within the same frame (<8 ms coalesces the many water-chunk onBeforeRender hooks so the
      // mirror renders once per frame, not once per chunk) or the view is essentially static and
      // the render is recent (standing admiring the lake). uReflAmt is set on every path so it
      // can never get stuck off — the old renderer.info.render.frame gate could, which is what
      // dropped the reflection entirely under load.
      const e = camera.matrixWorld.elements;             // basis: e[4..6]=up, e[8..10]=back
      const nowMs = performance.now();
      // Tight thresholds: only a genuinely STATIONARY camera reuses (position within 5 cm, heading
      // within ~0.1°). Any real movement re-renders the mirror every frame so the reflection tracks
      // the camera smoothly instead of freezing then snapping — the old 1.5 m / 0.5° window let a
      // slow walk/pan reuse a stale frame for up to 600 ms, which read as a stutter. Standing still
      // still reuses (cheap); slow movement is light on the GPU, so per-frame re-render is affordable.
      const staticView =
        best.y === R.lastPlaneY && camera.aspect === R.lastAspect &&
        R.lastPos.distanceToSquared(cp) < 0.0025 &&
        Math.abs(R.lastFwd.x - e[8]) + Math.abs(R.lastFwd.y - e[9]) +
          Math.abs(R.lastFwd.z - e[10]) < 0.0015;
      if (!targetChanged && R.have && R.rt && (nowMs - R.lastMs < 8 || (staticView && nowMs - R.lastMs < 600))) {
        U.uReflAmt.value = 1;                            // same-frame dedup, or static reuse
        return;
      }
      R.lastPos.copy(cp); R.lastFwd.set(e[8], e[9], e[10]);
      R.lastPlaneY = best.y; R.lastAspect = camera.aspect; R.lastMs = nowMs;
      const rc = R.cam, py = best.y;
      rc.fov = camera.fov; rc.aspect = camera.aspect;
      rc.near = camera.near; rc.far = camera.far;
      rc.updateProjectionMatrix();
      // mirror the camera across the plane y = py (horizontal plane keeps the math tiny)
      rc.position.set(cp.x, 2 * py - cp.y, cp.z);
      rc.up.set(e[4], -e[5], e[6]);
      R.tgt.set(cp.x - e[8], (2 * py - cp.y) + e[9], cp.z - e[10]);
      rc.lookAt(R.tgt);
      rc.updateMatrixWorld(true);
      // projective texture matrix (pre-oblique; the oblique swap below only edits the z row)
      R.tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      R.tm.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
      U.uReflMatrix.value.copy(R.tm);
      // oblique near plane = the water plane: clips underwater terrain without touching any
      // material (the custom shaders have no clipping chunks)
      R.plane.normal.set(0, 1, 0); R.plane.constant = -py;
      R.plane.applyMatrix4(rc.matrixWorldInverse);
      const cpv = R.cpv.set(R.plane.normal.x, R.plane.normal.y, R.plane.normal.z, R.plane.constant);
      const pe = rc.projectionMatrix.elements;
      const qx = (Math.sign(cpv.x) + pe[8]) / pe[0];
      const qy = (Math.sign(cpv.y) + pe[9]) / pe[5];
      const qw = (1 + pe[10]) / pe[14];
      cpv.multiplyScalar(2 / (cpv.x * qx + cpv.y * qy - cpv.z + cpv.w * qw));
      pe[2] = cpv.x; pe[6] = cpv.y; pe[10] = cpv.z + 1; pe[14] = cpv.w;
      // render SKY + TERRAIN only into the RT. The tree impostors are DELIBERATELY excluded:
      // ScatterManager resizes its instanced buffers as cells stream while you move, and drawing
      // that mid-resize mesh in the mirror threw glDrawElementsInstanced "vertex buffer not big
      // enough", which corrupted the RT and made the whole reflection blank out (persisting at
      // rest). Reflecting the terrain/mountains is what matters; forested banks reflect their
      // terrain, not individual trees — a fine trade for a reflection that never glitches out.
      const terrainPass = this.terrain.beginReflectionPass ?
        this.terrain.beginReflectionPass(rc, py) :
        { active: false, group: this.terrain.group };
      const keep = this._keepSet || (this._keepSet = new Set());
      keep.clear();
      keep.add(terrainPass.group);
      try { if (typeof sky !== 'undefined' && sky && sky.isMesh) keep.add(sky); } catch (e) {}
      const shown = [];
      for (const c of this.scene.children) {
        if (c.isLight || keep.has(c)) continue;
        if (c.visible) { c.visible = false; shown.push(c); }
      }
      const prevRT = renderer.getRenderTarget();
      const prevAuto = renderer.info.autoReset;
      const prevShadow = renderer.shadowMap.autoUpdate;
      const prevTone = renderer.toneMapping;
      renderer.info.autoReset = false;      // keep the frame's call/tri stats accumulating
      renderer.shadowMap.autoUpdate = false; // skip a pointless depth pass (casters are hidden)
      renderer.toneMapping = THREE.NoToneMapping; // reflection target is always linear
      try {
        renderer.setRenderTarget(R.rt);
        renderer.render(this.scene, rc);
      } finally {
        renderer.setRenderTarget(prevRT);
        renderer.toneMapping = prevTone;
        renderer.info.autoReset = prevAuto;
        renderer.shadowMap.autoUpdate = prevShadow;
        for (const c of shown) c.visible = true;
        this.terrain.endReflectionPass?.(terrainPass);
      }
      U.uReflTex.value = R.rt.texture;
      U.uReflAmt.value = 1;
      U.uReflPlaneY.value = py;
      R.have = true;
    }

    /* deepest-decoded-tile height sampler: bilinear identical to terrain.heightAt, but an
       O(zoom levels) tile index instead of scanning the whole cache per sample — chunk
       rebuilds take ~10^5 samples */
    _heightSampler() {
      const t = this.terrain;
      const S = t.m.tileSize, uMax = S - 1.001;
      const byZ = []; let zTop = -1;
      for (const e of t.hCache.values()) {
        if (!e.decoded) continue;
        (byZ[e.z] || (byZ[e.z] = new Map())).set(e.x * 4096 + e.y, e.decoded);
        if (e.z > zTop) zTop = e.z;
      }
      const hx = t.spanX / 2, hz = t.spanZ / 2, root = t.rootSpan;
      const floorY = t.m.elevation.min - t.datum;
      return (x, z) => {
        for (let zz = zTop; zz >= 0; zz--) {
          const tiles = byZ[zz]; if (!tiles) continue;
          const span = root / (1 << zz);
          // valid-data clamp (terrain's uUVMax, sampler-side): tiles on the raster's last
          // column/row carry floor-height padding past the data edge. Keep the bilinear
          // footprint >1 source texel inside the extent so extent-line samples (px==W
          // boundary nodes) edge-extend real heights instead of reading the padding cliff.
          const pad = 1.3 * span / (S - 1);
          const cx = Math.min(Math.max(x, -hx + pad), hx - pad);
          const cz = Math.min(Math.max(z, -hz + pad), hz - pad);
          const tx = Math.floor((cx + hx) / span), ty = Math.floor((cz + hz) / span);
          const g = tiles.get(tx * 4096 + ty);
          if (!g) continue;
          let u = ((cx + hx) / span - tx) * (S - 1), v = ((cz + hz) / span - ty) * (S - 1);
          u = Math.max(0, Math.min(uMax, u)); v = Math.max(0, Math.min(uMax, v));
          const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
          const a = g[j * S + i], b = g[j * S + i + 1];
          const c = g[(j + 1) * S + i], d = g[(j + 1) * S + i + 1];
          return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
        }
        return floorY;
      };
    }

    /* water surface world-Y under (x,z), or null if not over (rendered) water */
    surfaceAt(x, z) {
      if (!this._surf) return null;
      if (!this._sampS) this._sampS = this._surfaceSampler();
      const sb = this._sampS(x, z);
      if (!sb) return null;
      if (this.terrain.heightAt(x, z) >= sb[0] + sb[1]) return null;   // dry here (clipped)
      return sb[0];
    }
  }

  WaterBuilder.CHUNK = 256;        // mask px per chunk (2.56 km)
  WaterBuilder.FINE_DIST = 4500;   // m: chunks nearer than this build 10 m shoreline cells
  WaterBuilder.BAND_DIST = 3000;   // m: chunks nearer than this get sediment shoreline bands

  global.WaterBuilder = WaterBuilder;
})(window);
