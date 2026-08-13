'use strict';
/* 70-labels.js — procedural place-name sprites + real GNIS label system (Skyrim-style HUD).
   DECLARES: labelGroup, makeLabel, buildLabels, REAL_LABEL_CLS, REAL_LABEL_MAXD, realLabels,
     makeRealLabelSprite, initRealLabels, updateRealLabels, COMPASS_* consts, compassHud,
     initCompassHud, drawCompassBar, discovery, triggerDiscovery, discoveryScan, splashClear,
     splashNearest, updateDiscovery, cycleLabelMode, saveHudShot.
   CONSUMES: THREE, scene/camera/renderer (20), terrain (40), PEAKS/LAKES/WATER_Y/riverX/
     terrainHeight (10), sampleGround (40), clamp/smooth/lerp (00), state (80, at call time),
     toast (86, at call time). */
/* ============================================================
   PLACE-NAME SPRITES
   ============================================================ */
const labelGroup=new THREE.Group(); labelGroup.name='legacyPlaceLabels'; scene.add(labelGroup);
function makeLabel(text,x,y,z,big){
  const c=document.createElement('canvas'); c.width=512; c.height=112;
  const g=c.getContext('2d');
  g.font=(big?'42':'34')+'px "Segoe UI", sans-serif';
  const w=g.measureText(text).width+56;
  g.fillStyle='rgba(10,18,24,0.55)';
  g.beginPath(); if(g.roundRect) g.roundRect((512-w)/2,26,w,60,30); else g.rect((512-w)/2,26,w,60);
  g.fill();
  g.strokeStyle='rgba(255,255,255,0.35)'; g.stroke();
  g.fillStyle='#f2f7fa'; g.textAlign='center'; g.textBaseline='middle';
  g.fillText(text,256,57);
  const tex=new THREE.CanvasTexture(c);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false}));
  const s=big?340:250;
  sp.scale.set(s,s*112/512,1); sp.position.set(x,y,z);
  labelGroup.add(sp);
}
function buildLabels(){
  for(const p of PEAKS.filter(p=>p.name.includes('ft')||p.name==='Middle Teton'))
    makeLabel(p.name,p.x,terrainHeight(p.x,p.z)+120,p.z,true);
  for(const L of LAKES) makeLabel(L.name,L.x,WATER_Y+60,L.z,false);
  makeLabel('Snake River', riverX(700)+10, WATER_Y+55, 700,false);
  makeLabel('Jackson Hole', 520, sampleGround(520,300)+90, 300, false);
}

/* ---- real-terrain place labels: labels.json → declutter sprites ----
   Only used on the real-USGS path. Lazy sprite build, per-class hover + accent dot,
   distance scale/fade by importance, ≤14 visible with hysteresis. L toggles the group. */
const REAL_LABEL_CLS={
  summit :{hover:50,dot:'#e6d3a8'}, lake   :{hover:25,dot:'#7fc2e8'},
  stream :{hover:25,dot:'#8fd0e8'}, falls  :{hover:25,dot:'#bfe6f6'},
  canyon :{hover:60,dot:'#d0bd94'}, glacier:{hover:40,dot:'#e2f0f8'},
  pass   :{hover:40,dot:'#cfc7b0'}, place  :{hover:20,dot:'#e4e2d2'},
  locale :{hover:20,dot:'#d6d4c4'}
};
const REAL_LABEL_MAXD={1:14000,2:7000,3:3500};
/* mode 0 = compass bar + single focus pill (default) · 1 = legacy full pill cloud · 2 = all off */
const realLabels={group:new THREE.Group(),list:[],on:true,mode:0,cullT:0,ready:false,_first:false};
realLabels.group.name='realPlaceLabels';
scene.add(realLabels.group); realLabels.group.visible=false;
const _lblV=new THREE.Vector3(), _lblSelX=new Float32Array(14), _lblSelY=new Float32Array(14);

function makeRealLabelSprite(l){
  const cls=REAL_LABEL_CLS[l.cls]||REAL_LABEL_CLS.place;
  const big=l.imp<=1, fs=big?46:38, pad=26, dotR=12, gap=20, H=96, h=64;
  const meas=(makeRealLabelSprite._m||(makeRealLabelSprite._m=document.createElement('canvas').getContext('2d')));
  meas.font=fs+'px "Segoe UI", sans-serif';
  const tw=meas.measureText(l.name).width;
  const W=Math.ceil(pad*2 + dotR*2 + gap + tw), y0=(H-h)/2;
  const c=document.createElement('canvas'); c.width=W; c.height=H;
  const g=c.getContext('2d');
  g.font=fs+'px "Segoe UI", sans-serif';
  g.fillStyle='rgba(10,18,24,0.60)';
  if(g.roundRect){ g.beginPath(); g.roundRect(1.5,y0,W-3,h,32); } else { g.beginPath(); g.rect(1.5,y0,W-3,h); }
  g.fill(); g.strokeStyle='rgba(255,255,255,0.34)'; g.lineWidth=2.5; g.stroke();
  g.fillStyle=cls.dot; g.beginPath(); g.arc(pad+dotR,H/2,dotR,0,7); g.fill();   // class accent dot
  g.fillStyle='#f3f8fb'; g.textAlign='left'; g.textBaseline='middle';
  g.fillText(l.name, pad+dotR*2+gap, H/2+1);
  const tex=new THREE.CanvasTexture(c);
  tex.generateMipmaps=false; tex.minFilter=THREE.LinearFilter; tex.magFilter=THREE.LinearFilter;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false,opacity:0}));
  sp.renderOrder=20; sp.position.set(l.x, terrain.heightAt(l.x,l.z)+cls.hover, l.z);
  sp.userData.ar=W/H;                          // pill aspect for per-frame scaling
  realLabels.group.add(sp);
  return sp;
}
function initRealLabels(data){
  realLabels.list=(data.labels||[]).map(l=>{ const imp=Math.min(3,Math.max(1,l.imp||3));
    const cls=REAL_LABEL_CLS[l.cls]||REAL_LABEL_CLS.place;
    return {name:l.name,x:l.x,z:l.z,cls:l.cls,imp,maxd:REAL_LABEL_MAXD[imp],hover:cls.hover,
            sprite:null,vis:0,target:0,d:1e9,y:null}; });
  try{ discovery.set=new Set(JSON.parse(localStorage.getItem('tetonDiscovered')||'[]')); }
  catch(e){ discovery.set=new Set(); }
  realLabels.ready=true;
}
function updateRealLabels(dt){
  if(!realLabels.ready){ return; }
  if(!compassHud.tried) initCompassHud();
  const hudOn = realLabels.on && realLabels.mode!==2;
  if(compassHud.el) compassHud.el.style.display = (hudOn && realLabels.mode===0)?'block':'none';
  updateDiscovery(dt);
  if(!hudOn){ realLabels.group.visible=false; return; }
  realLabels.group.visible=true;
  const cam=camera.position;
  realLabels.cullT+=dt;
  if(!realLabels._first || realLabels.cullT>0.5){          // declutter ~2 Hz
    realLabels._first=true; realLabels.cullT=0;
    for(const l of realLabels.list){                       // distances shared by pills/compass/discovery
      const dx=l.x-cam.x, dz=l.z-cam.z; l.d=Math.hypot(dx,dz);
    }
    discoveryScan(cam);
    if(realLabels.mode===0){
      // focus pill only: the in-range feature nearest screen-centre bearing (≤ ~4°)
      let best=null, bestA=FOCUS_ANG;
      for(const l of realLabels.list){
        l.target=0;
        if(l.d>l.maxd) continue;
        if(l.y===null) l.y=terrain.heightAt(l.x,l.z)+l.hover;
        const rel=_wrapAng(Math.atan2(l.x-cam.x,cam.z-l.z)+state.yaw);   // bearing − heading(−yaw)
        if(Math.abs(rel)>bestA) continue;
        _lblV.set(l.x,l.y,l.z).project(camera);
        if(_lblV.z>1) continue;                            // behind camera / clipped
        bestA=Math.abs(rel); best=l;
      }
      if(best) best.target=1;
    }else{                                                 // legacy: full declutter pill cloud
      const cand=[];
      for(const l of realLabels.list){
        if(l.d>l.maxd){ l.target=0; continue; }
        if(l.y===null) l.y=terrain.heightAt(l.x,l.z)+l.hover;
        l._sc=l.imp*1e5 + l.d - (l.target?2500:0);         // importance first, hysteresis keeps picks
        cand.push(l);
      }
      cand.sort((a,b)=>a._sc-b._sc);
      // pick ≤14, rejecting any that would overlap a higher-priority pick on screen (thins peak clusters)
      let shown=0;
      for(const l of cand){
        if(shown>=14){ l.target=0; continue; }
        _lblV.set(l.x,l.y,l.z).project(camera);
        if(_lblV.z>1){ l.target=0; continue; }             // behind camera / clipped
        const sxp=(_lblV.x*0.5+0.5)*innerWidth, syp=(-_lblV.y*0.5+0.5)*innerHeight;
        let clash=false;
        for(let i=0;i<shown;i++){ if(Math.abs(sxp-_lblSelX[i])<120 && Math.abs(syp-_lblSelY[i])<42){ clash=true; break; } }
        if(clash){ l.target=0; continue; }
        _lblSelX[shown]=sxp; _lblSelY[shown]=syp; shown++; l.target=1;
      }
    }
  }
  const k=1-Math.pow(0.0009,dt);
  for(const l of realLabels.list){
    if(l.target && !l.sprite) l.sprite=makeRealLabelSprite(l);
    if(!l.sprite) continue;
    const fadeIn=smooth(400,900,l.d), fadeOut=1-smooth(l.maxd*0.82,l.maxd,l.d);
    const want=l.target?clamp(fadeIn*fadeOut,0,1):0;
    l.vis=lerp(l.vis,want,k);
    l.sprite.material.opacity=l.vis;
    l.sprite.visible=l.vis>0.02;
    const sH=clamp(l.d*0.11,70,950)*(l.imp<=1?1.06:0.86);  // ~constant screen height, clamped
    l.sprite.scale.set(sH*l.sprite.userData.ar, sH, 1);
  }
  if(realLabels.mode===0 && compassHud.ctx && (compassHud.acc+=dt)>0.1){  // ~10 Hz DOM redraw
    compassHud.acc=0; drawCompassBar();
  }
}

/* ============================================================
   SKYRIM-STYLE HUD — compass bar + discovery splash (DOM/2D canvas, zero WebGL cost)
   ============================================================ */
const COMPASS_W=520, COMPASS_H=64, COMPASS_BAR=30;   // css px; canvas holds strip + focus name below
const COMPASS_HALF=1.05;                             // radians of bearing shown each side (~±60°)
const FOCUS_ANG=0.07;                                // ~4°: focus-pill / name-under-bar gate
const COMPASS_GLYPH={summit:'▲',lake:'~',stream:'~',falls:'~',glacier:'~',
                     canyon:'∨',pass:'∧',place:'⌂',locale:'⌂'};
const compassHud={el:null,ctx:null,tried:false,acc:9};
const _wrapAng=a=>{ a%=Math.PI*2; if(a>Math.PI)a-=Math.PI*2; else if(a<-Math.PI)a+=Math.PI*2; return a; };
function initCompassHud(){
  compassHud.tried=true;
  const el=document.getElementById('compass'); if(!el) return;
  const dpr=Math.min(devicePixelRatio||1,2);
  el.width=COMPASS_W*dpr; el.height=COMPASS_H*dpr;
  const ctx=el.getContext('2d'); ctx.scale(dpr,dpr);
  compassHud.el=el; compassHud.ctx=ctx;
}
function _compassStrip(g){
  g.beginPath();
  if(g.roundRect) g.roundRect(0.5,0.5,COMPASS_W-1,COMPASS_BAR-1,COMPASS_BAR/2);
  else g.rect(0.5,0.5,COMPASS_W-1,COMPASS_BAR-1);
}
function drawCompassBar(){
  const g=compassHud.ctx, W=COMPASS_W, BH=COMPASS_BAR, cam=camera.position;
  g.clearRect(0,0,W,COMPASS_H);
  g.fillStyle='rgba(12,20,26,0.62)'; _compassStrip(g); g.fill();
  g.strokeStyle='rgba(255,255,255,0.15)'; g.lineWidth=1; g.stroke();
  const heading=-state.yaw, span=(W/2-16)/COMPASS_HALF;   // px per radian of bearing
  g.save(); _compassStrip(g); g.clip();
  g.textAlign='center'; g.textBaseline='middle';
  for(let d=0;d<360;d+=15){                                // cardinal letters + 15° ticks
    const rel=_wrapAng(d*Math.PI/180-heading);
    if(Math.abs(rel)>COMPASS_HALF) continue;
    const x=W/2+rel*span, fade=1-smooth(0.72,1,Math.abs(rel)/COMPASS_HALF);
    if(d%90===0){
      g.font='600 13px "Segoe UI",sans-serif';
      g.fillStyle='rgba(238,243,246,'+(0.92*fade).toFixed(3)+')';
      g.fillText(['N','E','S','W'][d/90], x, BH/2+0.5);
    }else{
      const h=(d%45===0)?8:4;
      g.fillStyle='rgba(238,243,246,'+(0.45*fade).toFixed(3)+')';
      g.fillRect(x-0.5, BH/2-h/2, 1, h);
    }
  }
  // class glyphs for in-range features, positioned by bearing; nearest-to-centre gets its name
  let best=null, bestA=0.18;
  g.font='11px "Segoe UI",sans-serif';
  for(const l of realLabels.list){
    if(l.d>l.maxd) continue;                               // imp-based range (l.d refreshed ~2 Hz)
    const rel=_wrapAng(Math.atan2(l.x-cam.x,cam.z-l.z)-heading), a=Math.abs(rel);
    if(a>COMPASS_HALF) continue;
    const cls=REAL_LABEL_CLS[l.cls]||REAL_LABEL_CLS.place;
    g.globalAlpha=(1-smooth(0.72,1,a/COMPASS_HALF))*(l.imp<=1?0.95:0.65);
    g.fillStyle=cls.dot;
    g.fillText(COMPASS_GLYPH[l.cls]||'⌂', W/2+rel*span, BH-8);
    if(a<bestA){ bestA=a; best=l; }
  }
  g.globalAlpha=1; g.restore();
  g.fillStyle='rgba(255,255,255,0.85)';                    // centre notch (current heading)
  g.fillRect(W/2-0.5,2.5,1,5); g.fillRect(W/2-0.5,BH-7.5,1,5);
  if(best){                                                // only the centred feature is named
    const a=1-smooth(0.05,0.18,bestA);
    if(a>0.02){
      g.font='13px "Segoe UI",sans-serif'; g.textAlign='center'; g.textBaseline='middle';
      g.shadowColor='rgba(0,0,0,0.8)'; g.shadowBlur=4;
      g.fillStyle='rgba(238,243,246,'+(0.95*a).toFixed(3)+')';
      g.fillText(best.name, W/2, BH+18);
      g.shadowBlur=0;
    }
  }
}

/* ---- discovery splash: first visit within ~400 m of an imp≤2 feature (or a teleport that
   lands near one) fades a centred serif title in/out over ~2.8 s; persisted in localStorage. */
const discovery={el:null,nameEl:null,set:null,queue:[],active:null,t:0,alpha:0,lx:null,lz:null};
function triggerDiscovery(name){
  if(!discovery.set || discovery.set.has(name)) return;
  discovery.set.add(name); discovery.queue.push(name);
  try{ localStorage.setItem('tetonDiscovered',JSON.stringify([...discovery.set])); }catch(e){}
}
function discoveryScan(cam){                               // runs inside the ~2 Hz declutter pass
  if(!discovery.set) return;
  const first=discovery.lx===null;
  const tele=!first && Math.hypot(cam.x-discovery.lx,cam.z-discovery.lz)>800;
  discovery.lx=cam.x; discovery.lz=cam.z;
  if(first) return;                                        // no splash on initial spawn
  if(tele){                                                // fast travel: nearest imp≤2 within 3 km
    let best=null, bd=3000;
    for(const l of realLabels.list){ if(l.imp<=2 && l.d<bd){ bd=l.d; best=l; } }
    if(best) triggerDiscovery(best.name);
  }else{
    for(const l of realLabels.list) if(l.imp<=2 && l.d<400) triggerDiscovery(l.name);
  }
}
function splashClear(){                                    // capture aid: kill any live/queued splash
  discovery.queue.length=0; discovery.active=null; discovery.alpha=0;
  if(discovery.el) discovery.el.style.opacity=0;
}
function splashNearest(){                                  // capture aid: force splash, ignore discovered set
  let best=null, bd=1e9; const cam=camera.position;
  for(const l of realLabels.list){ const d=Math.hypot(l.x-cam.x,l.z-cam.z);
    if(l.imp<=2 && d<bd){ bd=d; best=l; } }
  if(!best) return;
  discovery.queue.length=0; discovery.active=best.name; discovery.t=0.6; discovery.alpha=1;
  if(discovery.nameEl) discovery.nameEl.textContent=best.name;
}
function updateDiscovery(dt){
  const d=discovery;
  if(!d.el){ d.el=document.getElementById('discovery'); d.nameEl=document.getElementById('discName');
    if(!d.el) return; }
  if(!d.active && d.queue.length && realLabels.on && realLabels.mode!==2){
    d.active=d.queue.shift(); d.t=0; d.alpha=0; d.nameEl.textContent=d.active;
  }
  if(!d.active){ if(d.el.style.opacity!=='0') d.el.style.opacity=0; return; }
  d.t+=dt;
  d.alpha=smooth(0,0.45,d.t)*(1-smooth(2.1,2.85,d.t));     // fade in · hold · fade out (~2.8 s)
  d.el.style.opacity=d.alpha.toFixed(3);
  if(d.t>2.85){ d.active=null; d.alpha=0; d.el.style.opacity=0; }
}
function cycleLabelMode(){                                 // L: compass+focus → legacy pills → off
  realLabels.mode=(realLabels.mode+1)%3;
  if(typeof toast==='function') toast('labels: '+['compass','classic pills','off'][realLabels.mode]);
}

/* ---- composite HUD capture: WebGL frame + compass canvas + splash text on one 2D canvas,
   POSTed like the minimap self-shots (auto-<name>-hud.png) — proves the DOM HUD headlessly. */
function saveHudShot(name){
  return new Promise(done=>{
    renderer.render(scene,camera);                         // fresh buffer (no preserveDrawingBuffer)
    const src=renderer.domElement, s=src.width/innerWidth; // css px → backing px
    const c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
    const g=c.getContext('2d');
    g.drawImage(src,0,0);
    if(compassHud.el && compassHud.el.style.display!=='none')
      g.drawImage(compassHud.el,(innerWidth-COMPASS_W)/2*s,14*s,COMPASS_W*s,COMPASS_H*s);
    if(discovery.active && discovery.alpha>0.01){          // redraw the DOM splash in canvas terms
      const a=discovery.alpha, cx=innerWidth/2*s; let y=innerHeight*0.23*s;
      g.textAlign='center'; g.textBaseline='top';
      g.shadowColor='rgba(0,0,0,0.8)'; g.shadowBlur=6*s;
      if('letterSpacing' in g) g.letterSpacing=(5*s)+'px';
      g.font=Math.round(11*s)+'px "Segoe UI",sans-serif';
      g.fillStyle='rgba(207,224,234,'+(0.9*a).toFixed(3)+')';
      g.fillText('LOCATION DISCOVERED',cx,y); y+=22*s;
      g.fillStyle='rgba(238,243,246,'+(0.7*a).toFixed(3)+')';
      g.fillRect(cx-120*s,y,240*s,Math.max(1,s)); y+=10*s;
      if('letterSpacing' in g) g.letterSpacing=(4*s)+'px';
      g.font=Math.round(40*s)+'px Georgia,serif';
      g.fillStyle='rgba(244,248,251,'+a.toFixed(3)+')';
      g.fillText(discovery.active,cx,y); y+=58*s;
      g.fillStyle='rgba(238,243,246,'+(0.7*a).toFixed(3)+')';
      g.fillRect(cx-120*s,y,240*s,Math.max(1,s));
      if('letterSpacing' in g) g.letterSpacing='0px';
      g.shadowBlur=0;
    }
    c.toBlob(async b=>{
      if(!b){ done(null); return; }
      done(await postShot(b,name+'-hud'));
    },'image/png');
  });
}
