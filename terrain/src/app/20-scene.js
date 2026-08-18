'use strict';
/* 20-scene.js — three.js scene, camera, renderer, fog, lights + shared light refs.
   DECLARES: scene, camera, renderer, SUN_DIR, SUN_COLOR, SUN_ANGLES, AMB_COLOR,
     FOG_COLOR, sun, hemi.  CONSUMES: THREE (global). */
/* ============================================================ */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, innerWidth/innerHeight, 0.5, 16000);
const renderer = new THREE.WebGLRenderer({antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
if (window.GT_APP) {
  window.GT_APP.scene = scene;
  window.GT_APP.camera = camera;
  window.GT_APP.renderer = renderer;
}

/* The proven direct renderer is the default: Three applies ACES/output exactly once while
   rendering to the canvas. The experimental HDR post stack is now explicitly enabled with
   `?postfx` (or `?post8` for its forced byte-target compatibility mode).
   In particular, do not patch ShaderChunk or ShaderMaterial.prototype here: that old display-
   space hook destroyed highlight headroom before bloom and made streamed materials depend on
   compile order. */
const TETON_POST_ENABLED = /[?&](?:postfx|post8)(?:&|$)/.test(location.search);
renderer.toneMapping = TETON_POST_ENABLED ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const SUN_DIR = new THREE.Vector3(-0.52,0.5,0.42).normalize();
const SUN_COLOR = new THREE.Color(1,0.94,0.84);          // shared ref: terrain/water read live
const SUN_ANGLES = new THREE.Vector2(0.5,0.9);           // (azimuth, elevation) rad, for shadows
const AMB_COLOR = new THREE.Color(0.78,0.86,1.0);        // shared ambient tint (dims at night)
const FOG_COLOR = new THREE.Color(0.72,0.81,0.9);
scene.fog = new THREE.Fog(FOG_COLOR, 1800, 7500);

const sun = new THREE.DirectionalLight(0xfff2dd, 1.05);
sun.position.copy(SUN_DIR).multiplyScalar(1000);
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbcd8ee, 0x5a5648, 0.55);
scene.add(hemi);

/* ---- real cast shadows — ONE camera-following 2048 PCF directional map -----------------
   LANE-REVERTIBLE: delete everything from here to end-of-file, plus the SHADOW_UNIFORMS
   plumbing in TerrainStreamer.js / terrain-shaders.js / RoadRibbon.js, and the world is back
   to baked-only shadows.
   Design (perf first, ~30 fps baseline):
     - one 2048 PCF shadow map in a tight ortho box (~260 m) that follows the camera, snapped
       to the shadow texel grid so edges don't swim; the box is centred on the GROUND ahead of
       the camera so low flight keeps shadows underneath.
     - casters are opted in AT RUNTIME by the per-frame hook below (near-band 3D vegetation,
       buildings, the car — never far billboards, sage or grass: sub-pixel + expensive), so the
       other modules' files stay untouched. Receivers: built-in Lambert (buildings, car, ground-
       cover grass) via receiveShadow; terrain + roads are custom shaders and sample the SAME
       map manually through the shared SHADOW_UNIFORMS contract (create-or-adopt, like
       CLOUD_UNIFORMS).
     - above ~600 m over the terrain the whole feature turns off (sun.castShadow=false empties
       the depth pass; uShadowOn zeroes the custom-shader taps). Both program variants cache
       after their first frame, so the toggle is cheap; hysteresis stops boundary flicker.
   Per-frame cost when live: 1 depth pass over the few casters inside the 260 m box (shadow-
   frustum culled) + 4 PCF taps/fragment on terrain+roads + the built-in Lambert PCF on
   receivers. Zero when off (altitude / deep night). */
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// DYNAMIC_SHADOWS: the camera-following cast-shadow box (near tree/building/car contact shadows).
// Disabled per user — as a ~260 m map that follows the camera it reads as a "box" of shadow that
// slides/rotates with the player, especially from the air. Turned OFF here → the world falls back to
// the baked 20 km horizon self-shadows (static, world-anchored, see terrain sunVisibility()), which
// carry the landscape shadowing with no moving box. Flip back to true to restore contact shadows.
const DYNAMIC_SHADOWS = true;
const SHADOW_CFG = { half: 130, dist: 420, texels: 2048, onY: 560, offY: 620, fwd: 70 };
sun.castShadow = false;                          // the hook flips it on once the world is ready
sun.shadow.mapSize.set(SHADOW_CFG.texels, SHADOW_CFG.texels);
sun.shadow.camera.left = -SHADOW_CFG.half; sun.shadow.camera.right = SHADOW_CFG.half;
sun.shadow.camera.top = SHADOW_CFG.half; sun.shadow.camera.bottom = -SHADOW_CFG.half;
sun.shadow.camera.near = 5; sun.shadow.camera.far = 1100;
// No shadow-only layer: r184's shadow pass culls against the MAIN camera's layers, so a layer
// the main camera cannot see never casts. Shadow-only proxies (the car box) instead live on
// layer 0 with colorWrite/depthWrite-false materials — invisible in colour passes, cast in depth.
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0002;                       // built-in receivers (walls, car body)
sun.shadow.normalBias = 0.5;                     // kills flat-wall acne without peter-panning
scene.add(sun.target);                           // target must be in-scene for matrix updates

/* shared shadow uniforms — terrain tiles & road ribbons adopt these very objects, so the one
   per-frame update here reaches every material. uShadowMtx.value IS sun.shadow.matrix (live
   reference, updated by the depth pass before the colour pass reads it). */
const SHADOW_UNIFORMS = window.SHADOW_UNIFORMS = {
  uShadowMap: { value: null },
  uShadowMtx: { value: sun.shadow.matrix },
  uShadowOn:  { value: 0 },
};

/* depth material for the photo-impostor vegetation: the default shadow depth material ignores
   map/alphaTest, so tree cards would cast solid quads. This one keeps the alpha cutout
   and replays the per-instance atlas-column offset (aUvOff) so every species casts its own
   silhouette. Built lazily — needs the scatter atlas texture. */
let _vegDepthMat = null;
function vegDepthMaterial(photoMat){
  if (_vegDepthMat) return _vegDepthMat;
  // alphaTest well BELOW the colour pass's 0.4: the depth pass minifies the atlas, and crown
  // interiors mip-average to alpha ~0.3-0.6 — at 0.5 every shadow texel flips lit/shadowed
  // individually and tree shade breaks into checkerboard dapple (seen at Colter Bay). 0.28
  // keeps crown cores solid while true cutout edges still shape the silhouette.
  _vegDepthMat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: photoMat.map, alphaTest: 0.28, side: THREE.DoubleSide });
  _vegDepthMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'attribute float aUvOff;\nattribute float aCap;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv.x += aUvOff;\n#endif')
      // top caps do NOT cast: the horizontal crown-window card is patchy alpha with no rim
      // fade in the depth pass — it printed a big checkered square beside every tree. The
      // crossed cards carry the silhouette; collapse cap verts so their tris are degenerate.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tif (aCap > 0.5) transformed = vec3(0.0);');
  };
  return _vegDepthMat;
}

const SHADOW_CASTS = { conifer: 1, spire: 1, aspen: 1, cottonwood: 1, snag: 1 }; // near-band 3D veg
const _shCenter = new THREE.Vector3(), _shRight = new THREE.Vector3(),
      _shUp = new THREE.Vector3(), _shFwd = new THREE.Vector3();
let _shadowLive = false;
let _expLast = performance.now();                // eye-adaptation clock (wall time; converges)
let _exposureEV = Math.log2(renderer.toneMappingExposure);
// Explicit clock scrubs are scene edits, not eye adaptation: make every material see the new
// exposure in the same frame. Continuous time playback still uses the bounded adaptation below.
function syncExposureNow(){
  const tgt = Math.max(0.25, Math.min(2.0,
    typeof window.TETON_EXPOSURE_TARGET === 'number' ? window.TETON_EXPOSURE_TARGET : 1.0));
  _exposureEV = Math.log2(tgt);
  renderer.toneMappingExposure = tgt;
  if (typeof postFX !== 'undefined' && postFX) postFX.params.exposure = tgt;
  window.TETON_EXPOSURE_CURRENT = tgt;
  _expLast = performance.now();
}
const _cloudSst = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
scene.onBeforeRender = function (_renderer, _scene, renderCamera) {
  // runs inside renderer.render BEFORE the shadow depth pass; scene graph is world-built only
  // after boot() flips `ready` (92-boot) — every binding referenced here exists by then.
  if (typeof ready === 'undefined' || !ready) return;
  // The scene is rendered more than once per frame: WaterBuilder's planar-mirror pre-pass runs
  // one extra render, and a sky-probe rebake runs six (CubeCamera). three fires this hook on
  // every one of them, so without this gate the shadow-box snap, the building-footprint scan
  // and the whole scatter-cell walk repeat 2-8x per frame, and the eye-adaptation integrator
  // steps more than once. All of it is main-view state — only the main camera should drive it.
  if (renderCamera && renderCamera !== camera) return;

  // ---- bounded analytic eye adaptation. Work in exposure-value space so the response is
  // perceptually uniform, use a dead-band to reject small weather/time jitter, and rate-limit
  // large changes so driving past trees cannot pump the image. Cockpit compensation is separate
  // from the outdoor target: the enclosed first-person cabin gets a small stable lift without
  // making exterior/chase views brighter.
  { const now = performance.now(); const dt = Math.min((now - _expLast) / 1000, 0.1); _expLast = now;
    let tgt = (typeof window.TETON_EXPOSURE_TARGET === 'number') ? window.TETON_EXPOSURE_TARGET : 1.0;
    if (typeof drive !== 'undefined' && drive.on)
      tgt *= Math.pow(2, drive.camMode === 2 ? 0.18 : 0.035);
    const targetEV = Math.log2(Math.max(0.25, Math.min(2.0, tgt)));
    let delta = targetEV - _exposureEV;
    if (Math.abs(delta) < 0.025) delta = 0;
    const tau = delta > 0 ? 2.4 : 1.35;            // eyes open more slowly than they contract
    let step = delta * (1 - Math.exp(-dt / tau));
    const maxStep = (delta > 0 ? 0.32 : 0.52) * dt; // bounded EV/s through abrupt time scrubs
    step = Math.max(-maxStep, Math.min(maxStep, step));
    _exposureEV += step;
    renderer.toneMappingExposure = Math.pow(2, _exposureEV);
    if (typeof postFX !== 'undefined' && postFX) postFX.params.exposure=renderer.toneMappingExposure;
    window.TETON_EXPOSURE_CURRENT = renderer.toneMappingExposure; }

  // ---- weather-driven cloud cover for the shared CLOUD_UNIFORMS (terrain/road/water cloud
  // shadows). Recomputed from scratch each render (NOT multiplied in place) so it is burst-safe;
  // this runs after terrain.update() in the frame, so it is the authority. Day-gated: the sun
  // must be up AND its colour warm (moonlight is cool, r<b) → zero at night automatically.
  if (window.CLOUD_UNIFORMS) {
    const dayCover = _cloudSst(0.04, 0.14, SUN_ANGLES.y) * _cloudSst(0.02, 0.12, SUN_COLOR.r - SUN_COLOR.b);
    const w = Math.max(0, Math.min(1, window.WEATHER == null ? 0.15 : +window.WEATHER));
    window.CLOUD_UNIFORMS.uCloudAmt.value = dayCover * (0.42 + 0.7 * w);
  }

  // Dynamic cast-shadow box disabled → keep the light out of the shadow pass and zero the custom-
  // shader taps (uShadowOn=0 makes terrain/road/trail sunCastShadow() early-return "lit"). Baked
  // horizon self-shadows are unaffected (separate path). Everything below is the live-shadow code.
  if (!DYNAMIC_SHADOWS) {
    if (sun.castShadow) sun.castShadow = false;
    if (SHADOW_UNIFORMS.uShadowOn.value !== 0) SHADOW_UNIFORMS.uShadowOn.value = 0;
    return;
  }

  // sun-following box centre: ground point ~70 m ahead of the camera, snapped (below) so the
  // map's texel grid never slides under the receivers (no shadow-edge swimming)
  camera.getWorldDirection(_shFwd); _shFwd.y = 0;
  if (_shFwd.lengthSq() > 1e-4) _shFwd.normalize(); else _shFwd.set(0, 0, 0);
  _shCenter.copy(camera.position).addScaledVector(_shFwd, SHADOW_CFG.fwd);
  _shCenter.y = sampleGround(_shCenter.x, _shCenter.z);

  // light-space texel snap (basis matches shadowCamera.lookAt with up=(0,1,0))
  _shRight.set(0, 1, 0).cross(SUN_DIR).normalize();
  _shUp.crossVectors(SUN_DIR, _shRight);
  const texel = (2 * SHADOW_CFG.half) / SHADOW_CFG.texels;
  const cu = _shCenter.dot(_shRight), cv = _shCenter.dot(_shUp);
  _shCenter.addScaledVector(_shRight, Math.round(cu / texel) * texel - cu)
           .addScaledVector(_shUp, Math.round(cv / texel) * texel - cv);
  sun.target.position.copy(_shCenter);
  sun.position.copy(_shCenter).addScaledVector(SUN_DIR, SHADOW_CFG.dist);
  sun.updateMatrixWorld();          // scene.updateMatrixWorld already ran this frame
  sun.target.updateMatrixWorld();

  // altitude gate (hysteresis): nothing readable above ~600 m — skip the whole feature
  const above = camera.position.y - sampleGround(camera.position.x, camera.position.z);
  _shadowLive = _shadowLive ? above < SHADOW_CFG.offY : above < SHADOW_CFG.onY;
  // window.SHADOW_FORCE_OFF: debug/A-B kill switch (views-*.json "shadow": false via 90-auto)
  // Gate on effective directional luminance (moonlight bakes intensity into SUN_COLOR magnitude
  // with sun.intensity=1, so the old `sun.intensity > 0.02` test no longer discriminates night):
  // moon shadows stay on when the moon is up + phased, off on moonless/deep dark.
  const _dirLum = (typeof window.TETON_DIRLUM === 'number') ? window.TETON_DIRLUM
                : sun.intensity * Math.max(sun.color.r, sun.color.g, sun.color.b);
  const on = _shadowLive && _dirLum > 0.03 && !window.SHADOW_FORCE_OFF;
  sun.castShadow = on;
  // custom shaders need the map texture; it is allocated by the first depth pass, so the very
  // first live frame keeps uShadowOn at 0 (invisible) and everything is set from frame 2 on
  SHADOW_UNIFORMS.uShadowMap.value = sun.shadow.map ? sun.shadow.map.texture : null;
  SHADOW_UNIFORMS.uShadowOn.value = (on && SHADOW_UNIFORMS.uShadowMap.value) ? 1 : 0;

  // ---- caster/receiver opt-in at runtime (other modules' files untouched) ----
  if (car && !car.userData.shadowTagged) {
    car.userData.shadowTagged = true;
    const proxy = car.userData.shadowProxy || null;
    car.traverse(o => { if (o.isMesh) { o.castShadow = proxy ? o === proxy : true;
      o.receiveShadow = o !== proxy;
      o.material.needsUpdate = true; } });
  }
  if (typeof buildingMgr !== 'undefined' && buildingMgr && buildingMgr.mesh) {
    if (!buildingMgr.mesh.userData.shadowTagged) {
      buildingMgr.mesh.userData.shadowTagged = true;
      buildingMgr.mesh.receiveShadow = true;
      buildingMgr.mesh.material.needsUpdate = true; // receiveShadow needs a program variant
    }
    // The buildings are ONE merged park-wide mesh, so its bounding sphere ALWAYS intersects
    // the shadow frustum — unconditional castShadow would pay the full ~70k-tri depth draw
    // every frame even in empty backcountry. Gate on any footprint bbox overlapping the
    // (padded) shadow box instead; recs scan early-exits near villages, ~3.4k AABB tests worst
    // case (<0.05 ms) out in the sage.
    let bHit = false;
    if (on) {
      const pad = SHADOW_CFG.half + 80;
      const x0 = _shCenter.x - pad, x1 = _shCenter.x + pad;
      const z0 = _shCenter.z - pad, z1 = _shCenter.z + pad;
      const recs = buildingMgr.recs;
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1) { bHit = true; break; }
      }
    }
    buildingMgr.mesh.castShadow = bHit;
  }
  if (groundCover && groundCover.mesh && !groundCover.mesh.userData.shadowTagged) {
    groundCover.mesh.userData.shadowTagged = true;
    groundCover.mesh.receiveShadow = true;          // grass receives, never casts
    groundCover.mesh.material.needsUpdate = true;
  }
  // near-band 3D vegetation casts; far billboard cells and sage never do. Flags are re-asserted
  // each frame (cheap: ~200 cells) because pooled meshes migrate between cells/bands.
  if (scatter) {
    for (const cell of scatter.cells.values()) {
      const near = cell.band === 0;
      for (const m of cell.meshes) {
        const want = on && near && SHADOW_CASTS[m.sp] === 1;
        if (m.mesh.castShadow !== want) m.mesh.castShadow = want;
        if (want && m.sp !== 'snag' && !m.mesh.customDepthMaterial)
          m.mesh.customDepthMaterial = vegDepthMaterial(scatter.photoMat);
      }
    }
  }
};

/* Experimental HDR post-processing is opt-in with `?postfx`; `?post8` selects its byte target.
   The default is the visually approved direct renderer (Three ACES + browser sRGB). */
const postFX = TETON_POST_ENABLED ? new PostFX(renderer) : null;
