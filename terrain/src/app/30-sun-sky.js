'use strict';
/* 30-sun-sky.js — time-of-day sun/moon arc + sky shader dome. Runs updateSun() once.
   DECLARES: day, SOLAR_DIR, nightAmt, lightArc, updateSun, clockLabel, skyUniforms, sky,
   skyEnvironment/requestSkyEnvironmentRebake.
   CONSUMES: THREE, scene/sun/hemi and light refs (20-scene), smooth/lerp (00-core). */
/* ——— time of day: full 24 h. 0 = midnight, 0.25 = ~6 am, 0.5 = noon. T plays, [ ] scrub ———
   The sun follows an ENE→S→WNW arc; the moon runs the same arc 12 h out of phase. Whichever is
   up becomes the "active light" (SUN_DIR/SUN_COLOR/SUN_ANGLES), so terrain, water, trees AND the
   baked horizon shadows all just follow it — moonlit mountains cast moon shadows. */
const day = { t: 0.42, play: false };                    // ~10 am: classic east-face light
const SOLAR_DIR = new THREE.Vector3();                   // true sun dir (may be below horizon)
let nightAmt = 0;
// Terrain uses this low-frequency sky colour for its deliberately analytic glints.  Meshes use
// the PMREM below; keeping this value shared avoids trying to sample Three's private cube-UV atlas
// from the custom terrain shader.
const TERRAIN_ENV_UNIFORMS = window.TERRAIN_ENV_UNIFORMS = window.TERRAIN_ENV_UNIFORMS ||
  { uEnvColor:{ value:new THREE.Color(0.20,0.30,0.48) }, uWet:{ value:0 } };

/* ——— M3 night/weather model — deterministic, settable, day-look preserved ———
   weather  0 clear → 1 overcast; moon PHASE 0 new(dark) → 1 full(bright). Both are settable
   globals (window.WEATHER / window.MOON_PHASE) with deterministic defaults; ?weather=/?phase=
   URL params seed the default for headless A/B captures. NO Date.now anywhere. */
const _QS = new URLSearchParams(location.search);
const WEATHER_DEFAULT = _QS.has('weather') ? Math.max(0,Math.min(1,+_QS.get('weather'))) : 0.15;
const PHASE_OVERRIDE  = _QS.has('phase')   ? Math.max(0,Math.min(1,+_QS.get('phase')))   : null;
let weather = WEATHER_DEFAULT;
window.WEATHER = weather;                                 // settable at runtime; updateSun re-reads
const NIGHT_EXPOSURE_CEIL = 1.42;                         // hard ceiling — night never reads as day
function moonPhaseDefault(t){
  // deterministic phase from time-of-day so the standard night captures differ without a param:
  // dim/new moon in the pre-midnight deep night (t≈0.98), waxing to a bright pre-dawn moon
  // (t≈0.05), honouring the capture convention (0.98 moonless, 0.05 moonlit).
  const w = t < 0.5 ? t : t - 1.0;                        // continuous through midnight
  return smooth(-0.07, 0.09, w);
}
function lightArc(t){                                    // t 0..1 (24 h) → az/el of a body
  const az = -0.35 + (t - 0.25)*(Math.PI + 0.7);         // horizon-crossing matched to elevation
  const el = 1.16*Math.sin(2*Math.PI*(t - 0.25));
  return { az, el };
}
const TETON_LIGHT_UNIFORMS = window.TETON_LIGHT_UNIFORMS =
  window.TETON_LIGHT_UNIFORMS || { uNight:{ value:0 } };
function updateSun(immediateExposure=false){
  const s = lightArc(day.t);                             // sun
  const m = lightArc((day.t + 0.5) % 1);                 // moon, counter-phased
  SOLAR_DIR.set(Math.cos(s.az)*Math.cos(s.el), Math.sin(s.el), Math.sin(s.az)*Math.cos(s.el));
  nightAmt = 1 - smooth(-0.16, 0.02, Math.sin(s.el));    // 1 = full night (sun ~9°+ below)
  TETON_LIGHT_UNIFORMS.uNight.value = nightAmt;
  weather = Math.max(0, Math.min(1, (window.WEATHER==null ? WEATHER_DEFAULT : +window.WEATHER)));
  const phase = PHASE_OVERRIDE!=null ? PHASE_OVERRIDE
              : (window.MOON_PHASE!=null ? Math.max(0,Math.min(1,+window.MOON_PHASE))
                                         : moonPhaseDefault(day.t));

  const sunUp = s.el > -0.02;
  const a = sunUp ? s : m;                               // active light
  SUN_DIR.set(Math.cos(a.az)*Math.cos(a.el), Math.sin(Math.max(a.el,0.03)), Math.sin(a.az)*Math.cos(a.el)).normalize();
  SUN_ANGLES.set((a.az%(Math.PI*2)+Math.PI*2)%(Math.PI*2), Math.max(a.el, 0.03));

  // WARM RAMP widened so golden hour reads across the whole low-sun arc, not just the last few
  // degrees at el≈0. 0=deep-orange (sun on horizon) → 1=neutral white (sun high). Reaching up to
  // sin(el)≈0.85 means the light is already amber by ~28° (t≈0.68) and deep orange by ~12° (0.72),
  // while noon/0.42 (sin≈0.88) stays white — day look preserved.
  const warm = smooth(0.0, 0.85, Math.sin(s.el));        // day warmth from the TRUE sun
  if (sunUp){
    // One HDR directional value is shared by built-in and custom materials. Keep the sun
    // decisively above skylight (roughly 3–5× at midday), while clouds move energy from direct
    // light into the diffuse hemisphere rather than changing the overall exposure.
    // Calibrated against linearised NAIP albedo. The previous 1.70 clear-noon ceiling was
    // compensating for the old display-referred path and clipped pale grass/rock in HDR.
    const direct = (0.18 + 1.12*smooth(0.0,0.22,Math.sin(s.el))) * (1.0 - 0.55*weather);
    // Low sun retains its warm horizon colour, but high sun must converge on neutral D65-like
    // daylight. The old (1.00, 0.94, 0.82) ceiling permanently amber-tinted even midday scenes.
    SUN_COLOR.setRGB(1.0, lerp(0.42,1.0,warm), lerp(0.15,1.0,warm)).multiplyScalar(direct);
    sun.intensity = 1.0;                                // SUN_COLOR carries shared HDR energy
  } else {
    // MOONLIGHT ≠ sky ambient. The custom terrain/water/road shaders read uSunColor with NO
    // separate intensity uniform, so the effective moon brightness is baked into SUN_COLOR's
    // MAGNITUDE (a cool blue-white hue × a small scalar) — that is what stops moonlit terrain
    // from rendering at full daylight strength. moonI folds moon elevation, phase and cloud.
    const moonEl    = smooth(-0.05, 0.28, Math.sin(m.el));
    const phaseTerm = 0.05 + 0.95*phase*phase;           // new → faint earthshine, full → bright
    const moonI     = 0.185 * moonEl * phaseTerm * (1.0 - 0.5*weather);
    SUN_COLOR.setRGB(0.52*moonI, 0.63*moonI, 0.98*moonI);
    sun.intensity = 1.0;                                 // colour carries intensity (matches terrain)
  }
  sun.color.copy(SUN_COLOR);
  sun.position.copy(SUN_DIR).multiplyScalar(1000);
  // effective directional luminance — shared with the shadow gate + eye adaptation (20-scene)
  const dirLum = Math.max(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b) * sun.intensity;
  window.TETON_DIRLUM = dirLum;

  // ambient/hemi CRUSHED at night so moonless unlit terrain approaches black; day floor intact.
  hemi.intensity = lerp(0.008, 0.16 + 0.27*smooth(0.0,0.30,Math.sin(s.el)), 1-nightAmt);
  hemi.intensity *= 1.0 + 0.70*weather*(1-nightAmt);     // overcast transfers energy to skylight
  AMB_COLOR.setRGB(lerp(0.50,0.008,nightAmt), lerp(0.57,0.012,nightAmt), lerp(0.70,0.026,nightAmt));
  AMB_COLOR.addScalar(weather*(0.14*(1-nightAmt) + 0.010*nightAmt));   // skylight lift toward gray

  // Stable analytic exposure target (bounded/smoothed in 20-scene). Day = neutral 1.0; night lifts to
  // reveal moon/stars/settlements but is HARD-CAPPED so near-zero-ambient terrain stays black.
  let expT = 1.0;
  if (nightAmt > 0){
    const nightExp = NIGHT_EXPOSURE_CEIL - 0.5*smooth(0.0, 0.13, dirLum);   // moonless→ceil, moonlit→lower
    expT = lerp(1.0, nightExp, nightAmt);
  }
  expT *= 1.0 - 0.10*weather;                            // overcast flattens slightly
  window.TETON_EXPOSURE_TARGET = Math.min(expT, NIGHT_EXPOSURE_CEIL);
  if(immediateExposure) syncExposureNow();

  // valley mist / humidity haze — dawn window + weather (cheap: distance-fog + sky horizon band)
  const dawnHaze = smooth(0.13,0.22,day.t) * (1.0 - smooth(0.28,0.37,day.t));
  const humidity = Math.min(1, dawnHaze*0.85 + 0.35*weather*(1-nightAmt));

  // fog: day blue-gray → dawn amber → night near-black blue
  const dayR=lerp(0.82,0.72,warm), dayG=lerp(0.70,0.81,warm), dayB=lerp(0.60,0.90,warm);
  scene.fog.color.setRGB(lerp(dayR,0.020,nightAmt), lerp(dayG,0.030,nightAmt), lerp(dayB,0.055,nightAmt));
  if (weather>0){                                        // overcast greys the distance
    const g = lerp(0.34,0.72,1-nightAmt);
    _fogTmp.setRGB(g, g+0.02, g+0.05);
    scene.fog.color.lerp(_fogTmp, weather*0.6);
  }
  if (humidity>0){                                       // humid veil: warm-white, pulled nearer
    _fogTmp.setRGB(0.86,0.80,0.72);
    scene.fog.color.lerp(_fogTmp, humidity*0.4);
  }
  scene.fog.near = 1800 - 650*humidity;

  skyUniforms.uSolar.value.copy(SOLAR_DIR);
  skyUniforms.uNight.value = nightAmt;
  skyUniforms.uWeather.value = weather;
  skyUniforms.uHumidity.value = humidity;
  TERRAIN_ENV_UNIFORMS.uEnvColor.value.setRGB(
    lerp(0.24, 0.002, nightAmt) * (1.0 - 0.35*weather),
    lerp(0.34, 0.003, nightAmt) * (1.0 - 0.30*weather),
    lerp(0.55, 0.008, nightAmt) * (1.0 - 0.20*weather));
  TERRAIN_ENV_UNIFORMS.uWet.value = weather;
  if(window.skyEnvironment) skyEnvironment.noteTime(day.t);
}
const _fogTmp = new THREE.Color();
function clockLabel(){
  const h = day.t*24;
  const hh = Math.floor(h), mm = Math.floor((h-hh)*60);
  return `${((hh+11)%12)+1}:${mm<10?'0':''}${mm} ${hh<12?'am':'pm'}`;
}

/* ============================================================
   SKY — gradient scattering, sun disc + glow, drifting clouds
   ============================================================ */
const skyUniforms = { uSun:{value:SUN_DIR}, uTime:{value:0},
                      uSolar:{value:new THREE.Vector3(0,1,0)}, uNight:{value:0},
                      uWeather:{value:WEATHER_DEFAULT}, uHumidity:{value:0} };
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(9500, 48, 24),
  new THREE.ShaderMaterial({
    side:THREE.BackSide, depthWrite:false, fog:false,
    uniforms: skyUniforms,
    vertexShader:`
      varying vec3 vDir;
      void main(){ vDir = normalize(position);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader:`
      uniform vec3 uSun;        // active light (sun by day, moon by night)
      uniform vec3 uSolar;      // true sun direction, may be below horizon
      uniform float uNight;     // 0 day → 1 full night
      uniform float uWeather;   // 0 clear → 1 overcast
      uniform float uHumidity;  // 0 dry → 1 dawn/humid valley haze
      uniform float uTime;
      varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float hash3(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                   mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
      }
      float fbm(vec2 p){
        float s=0.0,a=0.5;
        for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.13+vec2(31.4,17.7); a*=0.5; }
        return s;
      }
      void main(){
        vec3 d = normalize(vDir);
        float y = max(d.y,-0.08);
        float solY = uSolar.y;
        // ——— day gradient ———
        vec3 zenith  = vec3(0.16,0.36,0.72);
        vec3 mid     = vec3(0.44,0.64,0.88);
        vec3 horizon = vec3(0.80,0.87,0.93);
        vec3 col = mix(horizon, mix(mid,zenith,smoothstep(0.18,0.85,y)), smoothstep(0.0,0.22,y));
        // golden hour: warm the low sky, deepen the zenith as the TRUE sun drops. Onset widened
        // (starts ~0.55 = 33° elevation) so the warm cast builds gradually through the afternoon
        // gold rather than snapping on in the last few degrees; dies out as the sun sinks (the
        // twilight ember below then carries the horizon into night).
        float lowSun = smoothstep(0.55, -0.06, solY) * smoothstep(-0.30, -0.02, solY);
        vec3 sunH = normalize(vec3(uSolar.x, max(uSolar.y,0.0), uSolar.z));
        float sunSide = 0.5+0.5*dot(normalize(vec3(d.x,0.0,d.z)), normalize(vec3(sunH.x,0.0,sunH.z)));
        col = mix(col, vec3(0.98,0.50,0.24), lowSun*(0.34+0.5*sunSide)*(1.0-smoothstep(0.0,0.72,y)));
        col *= 1.0 - 0.32*lowSun*smoothstep(0.22,0.95,y);
        // ——— night gradient + stars ———
        vec3 nightCol = mix(vec3(0.030,0.045,0.085), vec3(0.006,0.010,0.024), smoothstep(0.0,0.6,y));
        if(uNight > 0.01){
          // stars: 3D cell hash, subtle twinkle
          vec3 cell = d*230.0;
          vec3 fc = fract(cell)-0.5; vec3 ic = floor(cell);
          float h = hash3(ic);
          float star = smoothstep(0.35,0.05,length(fc)) * step(0.984,h);
          star *= 0.55 + 0.45*sin(uTime*2.5 + h*40.0);
          nightCol += vec3(0.9,0.95,1.0)*star*1.2*smoothstep(-0.02,0.12,d.y);
          // milky way: soft band
          vec3 mwN = normalize(vec3(0.55,0.25,0.65));
          float band = exp(-14.0*abs(dot(d,mwN)));
          nightCol += vec3(0.10,0.11,0.16)*band*(0.4+0.6*fbm(d.xz*7.0+3.0))*smoothstep(0.0,0.2,d.y);
        }
        col = mix(col, nightCol, uNight);
        // ——— twilight ember — warm horizon afterglow that SURVIVES the night mix ———
        // Driven by the true sun so it is on the correct schedule for BOTH ends of the day: it
        // ramps in as the sun nears the horizon, peaks just as it sets, then fades through a
        // deep-orange→magenta band and is gone by astronomical dusk (~-24°). Because it is applied
        // after the uNight blend, the 0.72→0.80 stretch reads as a dying dusk instead of the old
        // hard cut to a flat blue-black night — without touching nightAmt (night model preserved).
        {
          float ember = smoothstep(0.28, -0.02, solY) * smoothstep(-0.50, -0.12, solY);
          vec3 emberCol = mix(vec3(1.0,0.34,0.12), vec3(0.68,0.22,0.42), smoothstep(-0.02,-0.32,solY));
          float band = (1.0 - smoothstep(0.0, 0.46, y)) * (0.32 + 0.68*sunSide);
          col = mix(col, emberCol, ember*band*0.64);
          // cool twilight wedge — lifts the low sky out of black AFTER the sun sets so dusk (0.80)
          // reads as deep-blue twilight rather than snapping to full night. Gated to only appear
          // once the sun is below the horizon (0 at el=0, so the peak-sunset glow is untouched)
          // and gone by astronomical dusk (~-30°), keeping deep night at 0.98 dark.
          float twi = smoothstep(-0.02, -0.16, solY) * smoothstep(-0.54, -0.20, solY);
          col = mix(col, vec3(0.10,0.13,0.27), twi*(1.0-smoothstep(0.06,0.55,y))*0.55);
        }
        // ——— overcast: flatten & brighten the sky toward luminous grey (skylight lift) ———
        vec3 overcast = mix(vec3(0.60,0.64,0.70), vec3(0.80,0.82,0.86), smoothstep(0.0,0.7,y));
        overcast = mix(overcast*vec3(0.10,0.12,0.16), overcast, 1.0-uNight);
        col = mix(col, overcast, uWeather*0.72*(1.0 - 0.55*uNight));
        // ——— active-body disc + glow (sun by day, smaller cooler moon at night) ———
        // NOTE: tuned for the ACES-tonemapped pipeline. Pre-tonemap these terms clipped to a
        // small white point; under ACES the old wide halo (pow 40 * 0.35) rendered as a huge
        // gradated bloom — the sun read oversized. Tighter falloffs + lower energy restore a
        // compact disc with a modest glow.
        float lAmt = max(dot(d,uSun),0.0);
        vec3 discCol = mix(vec3(1.0,0.93,0.78), vec3(0.92,0.96,1.05), uNight);
        col += discCol*pow(lAmt, mix(2400.0, 3200.0, uNight))*mix(6.0, 2.0, uNight);
        col += mix(vec3(1.0,0.9,0.7), vec3(0.35,0.45,0.65), uNight)*pow(lAmt,160.0)*mix(0.22,0.08,uNight);
        col += vec3(1.0,0.75,0.45)*pow(max(dot(d,sunH),0.0),6.0)*0.10*(1.0-smoothstep(0.0,0.5,y))*(1.0-uNight);
        // ——— layered clouds: cumulus (primary) + high cirrus + weather systems ———
        if(d.y>0.015){
          float fade = smoothstep(0.010,0.14,d.y);
          vec2 driftA = vec2(uTime*0.006, uTime*0.0022);
          vec2 driftB = vec2(uTime*0.011,-uTime*0.004);
          // CUMULUS — puffy primary layer on a low projection plane (parallaxed by altitude)
          vec2 uvC = d.xz/(d.y+0.16);
          float cu = fbm(uvC*1.35 + driftA);
          cu += 0.5*fbm(uvC*3.2 - driftA*2.0);
          float cumThresh = mix(0.74, 0.38, uWeather);        // lower clear-sky end → fair-weather cumulus by default (no overcast dimming)
          float cumulus = smoothstep(cumThresh, cumThresh+0.26, cu);
          // BANK — a second, MORE-parallaxed (lower plane) cumulus deck low on the horizon: larger,
          // slower, only in the lower sky → the layer separation gives the sky real depth in motion.
          vec2 uvC2 = d.xz/(d.y+0.07);
          float cu2 = fbm(uvC2*0.85 + driftA*0.45);
          float bank = smoothstep(mix(0.70,0.50,uWeather), mix(0.94,0.78,uWeather), cu2)
                     * smoothstep(0.015,0.12,d.y) * (1.0 - smoothstep(0.20,0.48,d.y));
          // CIRRUS — high thin stretched streaks on a higher (less-parallaxed) plane
          vec2 uvH = d.xz/(d.y+0.34);
          float ci = fbm(vec2(uvH.x*0.7, uvH.y*3.6) + driftB);
          float cirrus = smoothstep(0.55,0.96,ci) * (0.30 + 0.55*uWeather);
          // SYSTEMS — broad overcast sheet as weather → 1
          float sys = smoothstep(0.30,0.85, fbm(uvC*0.6 + driftA*0.5)) * smoothstep(0.35,1.0,uWeather);
          float cover = clamp(max(max(cumulus, sys), 0.72*bank) + 0.5*cirrus, 0.0, 1.0);
          float shade = fbm(uvC*2.2 + driftA + 7.0);
          // VOLUMETRIC self-shadowing: compare cloud density to a sunward-offset sample — a point that
          // thins toward the sun is a lit edge/top (bright rim), one with denser cloud sunward of it is
          // shadowed (dark underside). Turns the flat mask into puffs with real light-driven form.
          vec2 sunUV = normalize(vec2(sunH.x, sunH.z) + 1e-4) * 0.05;
          float cuSun = fbm((uvC + sunUV)*1.35 + driftA) + 0.5*fbm((uvC + sunUV)*3.2 - driftA*2.0);
          float lit = smoothstep(-0.12, 0.28, cu - cuSun);    // 0 shadowed → 1 sunlit
          vec3 cloudCol = mix(vec3(0.64,0.68,0.76), vec3(1.02,1.0,0.98), smoothstep(0.30,0.85,shade));
          cloudCol *= mix(1.0, mix(0.58, 1.18, lit), 1.0-uNight);   // day: dark base → bright sunlit top
          // sunrise/sunset glow — warm the sun-facing cloud sides as the true sun sits low.
          // Onset widened to ~0.55 (33°) so clouds catch afternoon gold well before the horizon,
          // and the low-end fade carried to -0.34 so cloud tops keep a warm rim into early dusk.
          float low = smoothstep(0.55,-0.05,solY) * smoothstep(-0.34,-0.02,solY);
          float sunFace = pow(max(dot(normalize(vec3(d.x,0.0,d.z)), normalize(vec3(sunH.x,0.0,sunH.z))),0.0), 2.0);
          vec3 warmGlow = mix(vec3(1.0,0.40,0.18), vec3(1.0,0.70,0.40), smoothstep(0.0,0.7,shade));
          cloudCol = mix(cloudCol, warmGlow, low*(0.42+0.55*sunFace)*(1.0-uNight));
          cloudCol += vec3(0.30,0.19,0.07)*pow(lAmt,3.0)*0.34*(1.0-uNight);
          // night clouds: faint cool silhouettes, dim moonlit tops
          cloudCol = mix(cloudCol, vec3(0.016,0.024,0.044)+vec3(0.05,0.06,0.08)*shade, uNight);
          col = mix(col, cloudCol, cover*fade*mix(0.92, 0.78, uNight));
        }
        // ——— valley mist / humidity haze — low luminous band hugging the horizon ———
        float hz = 1.0 - smoothstep(0.0, 0.17, d.y);
        vec3 mistCol = mix(vec3(0.72,0.78,0.86), vec3(0.96,0.83,0.66), 1.0-smoothstep(0.0,0.35,solY));
        col = mix(col, mistCol, uHumidity*hz*0.6*(1.0 - 0.75*uNight));
        gl_FragColor = vec4(col,1.0);
      }`
  })
);
sky.name='skyDome';
scene.add(sky);
// Sky-only image based lighting.  The dome is on a private layer, so the cubemap never captures
// terrain, water (which keeps its planar-reflection pass), vehicles, or the capture camera itself.
// Both render targets intentionally live at the world origin: sky shading is directional, not a
// local probe, and these resources are replaced/disposed as a pair only on a throttled rebake.
sky.layers.set(1);
camera.layers.enable(1);
const _skyProbePos = new THREE.Vector3();   // scratch: dome position parked during a probe bake
const skyEnvironment = window.skyEnvironment = new (class SkyEnvironment {
  constructor(){
    this.raw = null; this.pmrem = null; this.generator = null; this.cube = null;
    this.dirty = true; this.explicit = false; this.lastT = null; this.lastBake = -Infinity;
    this.threshold = 0.025;  // 36 simulated minutes: enough to materially change reflections
    this.minInterval = 1.5;  // no rebake-per-frame while time is playing
  }
  noteTime(t){
    if(this.lastT === null || Math.abs(((t-this.lastT+0.5)%1)-0.5) >= this.threshold) this.dirty=true;
  }
  request(){ this.dirty=true; this.explicit=true; }
  update(){
    // The interval protects continuous clock playback from a PMREM bake every frame. A manual
    // time scrub is explicitly requested and must bypass it; otherwise image-based materials
    // retain the previous sky for as long as 1.5 s after direct/hemi lighting has changed.
    if(!this.dirty || (!this.explicit && performance.now()-this.lastBake < this.minInterval*1000)) return;
    this.generator = this.generator || new THREE.PMREMGenerator(renderer);
    this.generator.compileCubemapShader();
    // Probe resources are built once and re-rendered in place. Allocating a fresh 6-face cube
    // target + CubeCamera + PMREM target per bake (and disposing the previous pair) made every
    // rebake a GPU allocation stall — visible as a hitch roughly every 7.5 s of wall clock while
    // the clock plays. fromCubemap() reuses a supplied target, so scene.environment keeps the
    // same texture object and simply observes the new content.
    const raw = this.raw || (this.raw = new THREE.WebGLCubeRenderTarget(128, { generateMipmaps:false, colorSpace: THREE.NoColorSpace }));
    const cube = this.cube || (this.cube = new THREE.CubeCamera(0.1, 12000, raw));
    // The visible dome follows the player; temporarily centre it on the world-anchored probe so
    // even long fly-outs cannot put the probe outside the sphere.
    const visibleSkyPos=_skyProbePos.copy(sky.position); sky.position.set(0,0,0); sky.updateMatrixWorld();
    cube.layers.set(1); cube.position.set(0,0,0); cube.update(renderer, scene);
    sky.position.copy(visibleSkyPos);
    this.pmrem = this.generator.fromCubemap(raw.texture, this.pmrem);
    scene.environment=this.pmrem.texture;
    this.lastT=day.t; this.lastBake=performance.now(); this.dirty=false; this.explicit=false;
  }
  dispose(){
    if(scene.environment===this.pmrem?.texture) scene.environment=null;
    this.raw?.dispose(); this.pmrem?.dispose(); this.generator?.dispose();
  }
})();
function requestSkyEnvironmentRebake(){ skyEnvironment.request(); }
updateSun();                       // needs skyUniforms — first call lives here
