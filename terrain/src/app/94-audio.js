'use strict';
/* ============================================================================
   94-audio.js — WebAudio ambience (LAST app module; loads after 92-boot.js).

   Fully SYNTHESISED — no audio assets on disk. A single AudioContext, built
   SUSPENDED (autoplay policy), stays silent until the first real user gesture
   (the overlay click that enters the park counts). 'K' toggles mute.

   Layers, all mixed under one master gain:
     · wind bed   — looping brown-noise → lowpass, slow seeded gusts (louder driving)
     · water lap  — looping noise → bandpass, tremolo; gain by distance to nearest
                    water (waterBuilder.lc.waterAt / surfaceAt, or procedural WATER_Y)
     · birds      — scheduled chirps by day (density ∝ 1-nightAmt, dawn boost)
     · crickets   — trilled 4.6 kHz bed, gated on nightAmt
     · engine     — saw+sub → lowpass, pitch ∝ |drive.speed|, only in drive mode

   Runs its OWN requestAnimationFrame loop so it never touches 92-boot's animate().
   Reads shared-scope globals live: camera(20), drive(82), nightAmt(30),
   waterBuilder/terrain/sampleGround(40), WATER_Y(10), ready(92).

   DECLARES: window.AUDIO. CONSUMES: the globals above (all read at call-time).

   HEADLESS CAVEAT: sound cannot be verified without ears. In headless capture the
   overlay is hidden programmatically (not a gesture) so the context never resumes
   and the page stays silent + error-free. See the flag list at the bottom of the
   file for what a human must confirm by ear.
   ============================================================================ */
(function(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC){ console.info('[audio] WebAudio unavailable — ambience disabled.'); return; }

  /* deterministic PRNG (xorshift32) — chirp timing/pitch reproducible, no Date.now */
  let _s = 0x1a2b3c4d ^ 0x9e3779b9;
  const rnd = ()=>{ _s^=_s<<13; _s>>>=0; _s^=_s>>>17; _s^=_s<<5; _s>>>=0; return _s/4294967296; };

  let ctx=null, master=null;
  let started=false, muted=false;
  let windGain, windLP, windWhistle, waterGain, waterLap, crickGain, engGain, engOsc1, engOsc2, engLP;
  let roadNoiseGain;
  let engStarted=false;

  const MASTER_LEVEL = 0.85;      // headroom under the ACES-lit visuals; ears set final volume

  /* ---- looping noise buffers (seeded → identical every load) ---- */
  function noiseBuffer(sec, kind){
    const n = (ctx.sampleRate*sec)|0;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last=0;
    for(let i=0;i<n;i++){
      const white = rnd()*2-1;
      if(kind==='brown'){ last=(last+0.02*white)/1.02; d[i]=last*3.4; }
      else d[i]=white;
    }
    return buf;
  }
  const gainNode = v => { const g=ctx.createGain(); g.gain.value=v; return g; };

  function init(){
    ctx = new AC();                                   // starts 'suspended' with no gesture
    master = gainNode(0);                             // hard-silent until first gesture (+ !mute)
    master.connect(ctx.destination);

    /* ——— WIND BED: brown noise → lowpass; a thin bandpass whistle rides gusts ——— */
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuffer(5,'brown'); windSrc.loop = true;
    windLP = ctx.createBiquadFilter(); windLP.type='lowpass'; windLP.frequency.value=420; windLP.Q.value=0.6;
    windGain = gainNode(0.0);
    windSrc.connect(windLP).connect(windGain).connect(master);

    const whSrc = ctx.createBufferSource();
    whSrc.buffer = noiseBuffer(5,'white'); whSrc.loop = true;
    const whBP = ctx.createBiquadFilter(); whBP.type='bandpass'; whBP.frequency.value=1100; whBP.Q.value=1.2;
    windWhistle = gainNode(0.0);
    whSrc.connect(whBP).connect(windWhistle).connect(master);

    /* ——— WATER LAP: noise → bandpass → lowpass → tremolo → proximity gain ——— */
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = noiseBuffer(4,'white'); wSrc.loop = true;
    const wBP = ctx.createBiquadFilter(); wBP.type='bandpass'; wBP.frequency.value=950; wBP.Q.value=0.7;
    const wLP = ctx.createBiquadFilter(); wLP.type='lowpass'; wLP.frequency.value=2100;
    waterLap = gainNode(0.7);                          // tremolo carrier (0.4..1.0 via LFO below)
    waterGain = gainNode(0.0);                         // proximity level (driven each tick)
    wSrc.connect(wBP).connect(wLP).connect(waterLap).connect(waterGain).connect(master);
    const lapLFO = ctx.createOscillator(); lapLFO.type='sine'; lapLFO.frequency.value=0.55;
    lapLFO.connect(gainNode(0.3)).connect(waterLap.gain);   // ±0.3 around 0.7 → gentle lapping

    /* ——— CRICKETS: 4.6 kHz square → bandpass → trill-gated → nightAmt gate ——— */
    const crickOsc = ctx.createOscillator(); crickOsc.type='square'; crickOsc.frequency.value=4600;
    const crickOsc2 = ctx.createOscillator(); crickOsc2.type='square'; crickOsc2.frequency.value=4640; // slight chorus
    const crickBP = ctx.createBiquadFilter(); crickBP.type='bandpass'; crickBP.frequency.value=4600; crickBP.Q.value=7;
    const crickTrem = gainNode(0.5);                  // gated 0..1 by the trill LFO
    crickGain = gainNode(0.0);                         // overall night gate (driven each tick)
    crickOsc.connect(crickBP); crickOsc2.connect(crickBP);
    crickBP.connect(crickTrem).connect(crickGain).connect(master);
    const trillLFO = ctx.createOscillator(); trillLFO.type='square'; trillLFO.frequency.value=24; // ~24 Hz trill
    trillLFO.connect(gainNode(0.5)).connect(crickTrem.gain); // square ±1 ×0.5 +0.5 base → 0..1 buzz

    /* ——— ENGINE: sawtooth + half-freq sub → lowpass; pitch/level by speed ——— */
    engOsc1 = ctx.createOscillator(); engOsc1.type='sawtooth'; engOsc1.frequency.value=55;
    engOsc2 = ctx.createOscillator(); engOsc2.type='sine';     engOsc2.frequency.value=27.5;
    engLP = ctx.createBiquadFilter(); engLP.type='lowpass'; engLP.frequency.value=600; engLP.Q.value=3;
    engGain = gainNode(0.0);
    engOsc1.connect(engLP); engOsc2.connect(engLP); engLP.connect(engGain).connect(master);

    /* road/tire layer: deterministic noise intensity comes directly from fixed-step physics. */
    const roadSrc=ctx.createBufferSource();roadSrc.buffer=noiseBuffer(3,'white');roadSrc.loop=true;
    const roadBP=ctx.createBiquadFilter();roadBP.type='bandpass';roadBP.frequency.value=780;roadBP.Q.value=.7;
    roadNoiseGain=gainNode(0);roadSrc.connect(roadBP).connect(roadNoiseGain).connect(master);

    // start every persistent source/LFO now; they run silently until the context resumes
    windSrc.start(); whSrc.start(); wSrc.start();
    lapLFO.start(); trillLFO.start(); crickOsc.start(); crickOsc2.start();
    engOsc1.start(); engOsc2.start();roadSrc.start();engStarted=true;

    window.AUDIO = {
      ctx,
      get state(){ return ctx.state; },
      get started(){ return started; },
      get muted(){ return muted; },
      resume, mute:setMuted,
    };
    makeHint();
    requestAnimationFrame(frame);
  }

  /* ---- master gate: silent until a gesture, and while muted ---- */
  function applyMaster(){
    if(!ctx) return;
    const g = (started && !muted) ? MASTER_LEVEL : 0.0;
    master.gain.setTargetAtTime(g, ctx.currentTime, 0.05);
  }
  function resume(){
    if(!ctx) return;
    if(ctx.state==='suspended') ctx.resume().catch(()=>{});
    if(!started){ started=true; showHint(); }
    applyMaster();
  }
  function setMuted(m){ muted = (m===undefined) ? !muted : !!m; applyMaster(); showHint(); }

  /* first real user gesture resumes audio (the overlay click that enters the park counts).
     Passive / no preventDefault / no pointer-lock calls → pointer capture untouched. */
  const onGesture = ()=>resume();
  addEventListener('pointerdown', onGesture, {passive:true});
  addEventListener('touchstart',  onGesture, {passive:true});
  addEventListener('keydown', e=>{
    if(e.code==='KeyK'){ setMuted(); }                // mute toggle — 'K' is otherwise unbound
    resume();                                         // any key also counts as the enabling gesture
  });

  /* ---- on-screen hint (created in JS; only the <script> tag touches the HTML) ---- */
  let hintEl=null, hintTimer=null;
  function makeHint(){
    hintEl = document.createElement('div');
    hintEl.id = 'audioHint';
    hintEl.style.cssText =
      'position:fixed;bottom:44px;left:50%;transform:translateX(-50%);z-index:25;'+
      'pointer-events:none;user-select:none;font:11px/1.4 "Segoe UI",system-ui,sans-serif;'+
      'letter-spacing:.12em;color:rgba(238,243,246,.72);text-shadow:0 1px 3px rgba(0,0,0,.7);'+
      'background:rgba(12,20,26,.5);border:1px solid rgba(255,255,255,.13);border-radius:999px;'+
      'padding:5px 13px;backdrop-filter:blur(6px);opacity:0;transition:opacity .4s';
    (document.body||document.documentElement).appendChild(hintEl);
  }
  function showHint(){
    if(!hintEl) return;
    hintEl.textContent = muted ? '🔇 muted · K to unmute'
                               : (started ? '🔊 ambient sound · K to mute'
                                          : '🔈 click or press a key for sound');
    hintEl.style.opacity = 1;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(()=>{ if(hintEl) hintEl.style.opacity=0; }, 3800);
  }

  /* ---- nearest-water probe (throttled) ---- */
  function isWater(x,z){
    if(typeof waterBuilder!=='undefined' && waterBuilder){
      if(waterBuilder.lc && waterBuilder.lc.waterAt) return !!waterBuilder.lc.waterAt(x,z);
      if(waterBuilder.surfaceAt) return waterBuilder.surfaceAt(x,z)!=null;
    }
    if((typeof terrain==='undefined' || !terrain) &&
       typeof WATER_Y!=='undefined' && typeof sampleGround==='function')
      return sampleGround(x,z) < WATER_Y - 0.2;
    return false;
  }
  const WATER_RADII = [0,30,80,160,300,500,800];
  const NANG = 6;
  let waterProx = 0, proxAcc = 0;
  function updateWaterProx(){
    const p = camera.position;
    if(isWater(p.x,p.z)){ waterProx = 1; return; }
    let best = Infinity;
    for(let ri=1; ri<WATER_RADII.length; ri++){
      const r = WATER_RADII[ri];
      for(let a=0; a<NANG; a++){
        const ang = (a/NANG)*Math.PI*2 + ri*0.7;      // stagger rings so spokes don't align
        if(isWater(p.x+Math.cos(ang)*r, p.z+Math.sin(ang)*r)){ best=r; break; }
      }
      if(best<Infinity) break;
    }
    waterProx = best<Infinity ? Math.max(0, 1 - best/900) : 0;
  }

  /* ---- bird / cricket scheduler (look-ahead) ---- */
  let nextBird = 0;
  function schedule(now){
    const night = (typeof nightAmt!=='undefined') ? nightAmt : 0;
    const dayAmt = 1 - night;
    if(nextBird < now) nextBird = now + 0.5;
    while(nextBird < now + 0.4){                       // ~0.4 s look-ahead
      if(dayAmt > 0.25) chirp(nextBird, dayAmt);
      // denser calls in daylight, long gaps at night; dawn/dusk edges get an extra lift
      const dawn = 1 + 1.2*Math.max(0, 1 - Math.abs(dayAmt-0.5)*2); // peak near twilight balance
      const gap = (0.9 + rnd()*3.2) / (0.15 + dayAmt*dawn);
      nextBird += gap;
    }
  }
  function chirp(t, amt){
    const o = ctx.createOscillator(); o.type = rnd()<0.5 ? 'sine' : 'triangle';
    const g = gainNode(0);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const f0 = 1900 + rnd()*2600;
    o.frequency.setValueAtTime(f0*0.8, t);
    o.frequency.exponentialRampToValueAtTime(f0*1.35, t+0.05);
    o.frequency.exponentialRampToValueAtTime(f0*0.95, t+0.12);
    const peak = 0.05 + 0.05*rnd()*amt;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.11+rnd()*0.06);
    if(pan){ pan.pan.value = rnd()*2-1; o.connect(g).connect(pan).connect(master); }
    else o.connect(g).connect(master);
    o.start(t); o.stop(t+0.35);
  }

  /* ---- per-frame parameter drive ---- */
  let last = 0;
  let nextHaptic=0;
  function frame(){
    requestAnimationFrame(frame);
    if(!ctx) return;
    const now = ctx.currentTime;
    const dt = last ? Math.min(now-last, 0.1) : 0.016; last = now;

    const driving = (typeof drive!=='undefined' && drive && drive.on);
    const speed = driving ? Math.abs(drive.speed||0) : 0;
    const spd = Math.min(speed/38, 1);                 // 0..1 normalised road speed
    const night = (typeof nightAmt!=='undefined') ? nightAmt : 0;
    const feedback=window.GT_DRIVE_FEEDBACK||{engineLoad:0,tireScrub:0,dust:0,impact:0};

    // wind gusts — seeded time-noise (two sines) + a lift from driving speed
    const gust = 0.5 + 0.5*Math.sin(now*0.23) * Math.sin(now*0.07+1.3);
    const drift = driving ? spd*0.5 : 0;
    windGain.gain.setTargetAtTime(0.055 + 0.05*gust + 0.09*drift, now, 0.4);
    windLP.frequency.setTargetAtTime(360 + 260*gust + 900*drift, now, 0.4);
    windWhistle.gain.setTargetAtTime(0.006 + 0.02*gust*gust + 0.05*drift, now, 0.5);

    // water proximity (probe ~8 Hz)
    if((proxAcc += dt) > 0.12 && typeof ready!=='undefined' && ready){ proxAcc=0; try{ updateWaterProx(); }catch(_){} }
    waterGain.gain.setTargetAtTime(0.18*waterProx, now, 0.35);

    // crickets rise into the night, fade by day
    crickGain.gain.setTargetAtTime(0.05*Math.max(0, night-0.35)/0.65, now, 0.6);

    // engine: fundamental + sub track speed; a hair of idle lump when stopped in the car
    if(engStarted){
      const f = 52 + spd*150 + feedback.engineLoad*28;
      engOsc1.frequency.setTargetAtTime(f, now, 0.08);
      engOsc2.frequency.setTargetAtTime(f*0.5, now, 0.08);
      engLP.frequency.setTargetAtTime(360 + spd*900, now, 0.1);
      engGain.gain.setTargetAtTime(driving ? (0.05 + 0.08*spd + 0.06*feedback.engineLoad) : 0.0, now, 0.15);
    }
    roadNoiseGain.gain.setTargetAtTime(driving?
      0.11*Math.min(1,feedback.dust*.75+feedback.tireScrub):0,now,.08);
    if(driving&&now>=nextHaptic&&(feedback.impact>.08||feedback.tireScrub>.35)){
      nextHaptic=now+.12;
      const pad=window.GT_activeGamepad&&navigator.getGamepads?
        window.GT_activeGamepad(navigator.getGamepads()):null;
      const actuator=pad&&(pad.vibrationActuator||pad.hapticActuators&&pad.hapticActuators[0]);
      const pulse=actuator&&actuator.playEffect&&actuator.playEffect('dual-rumble',{
        duration:90,strongMagnitude:feedback.impact,weakMagnitude:Math.max(feedback.tireScrub*.45,feedback.dust*.2)
      });
      pulse&&pulse.catch&&pulse.catch(()=>{});
    }

    schedule(now);
  }

  // build the (suspended) graph as soon as the DOM body exists
  if(document.body) init();
  else addEventListener('DOMContentLoaded', init, {once:true});
})();

/* ============================================================================
   MUST BE CONFIRMED BY EAR (headless cannot verify sound):
     1. After clicking "enter the park", ambience fades in; the hint reads
        "🔊 ambient sound · K to mute".
     2. 'K' mutes and unmutes; hint updates. No effect on movement/look/pointer-lock.
     3. Wind bed is always present and gusts slowly; it swells when driving fast.
     4. Walking to Jenny/Jackson Lake or the Snake River raises a water-lap layer
        that fades out again away from shorelines.
     5. Daytime (press [ / ] or T) has intermittent bird chirps; deep night
        (t≈0.98) replaces them with a cricket trill.
     6. Enter drive (G): an engine note appears and its pitch rises with speed;
        it stops when you park.
     7. No audio clicks/pops on toggles; no console errors.
   ============================================================================ */
