'use strict';
/* 84-input.js — keyboard/mouse/touch handlers, HUD mode label, wheel zoom.
   DECLARES: locked, overlay, isTouch, updateMode (+ touch handlers).
   CONSUMES: state/drive (80/82), enter/exitDrive/exitDrive (82), realLabels/labelGroup/terrain (70/40),
     Minimap (88), respawn (80), day/updateSun (30), saveShot (86), camera/renderer (20). */
addEventListener('keydown',e=>{
  state.keys[e.code]=true;
  if(e.code==='KeyF'){ if(drive.on){ exitDrive(); state.fly=true; } else state.fly=!state.fly; state.vel.y=0; updateMode(); }
  if(e.code==='KeyG'){ if(drive.on) exitDrive(); else enterDrive(); }
  if(e.code==='KeyC' && drive.on){ // camera cycle: far chase -> near chase -> first person
    drive.camMode=(drive.camMode+1)%3;
    if(drive.camMode<2){ drive.camDist = drive.camMode===1 ? 7.5 : 14; drive.snapCam=true; }
    else { drive.fpYaw=0; state.pitch=clamp(state.pitch,-0.55,0.4); }
  }
  if(e.code==='KeyL'){ if(terrain){ cycleLabelMode(); } else { labelGroup.visible=!labelGroup.visible; } }
  if(e.code==='KeyM'){ Minimap.cycle(); }
  if(e.code==='KeyN'){ HeldMap.toggle(); }           // raise/lower the held paper map
  if(e.code==='KeyR'){ respawn(); }
  if(e.code==='KeyT'){ day.play=!day.play; }
  if(e.code==='KeyP' && DEV){ saveShot(); }        // dev-only: needs serve.py's /shot inbox
  if(e.code==='KeyO'){ if(window.GT_toggleSettings) window.GT_toggleSettings(); }
  if(e.code==='BracketLeft'){ day.t=(day.t-0.01+1)%1; updateSun(true); requestSkyEnvironmentRebake(); }
  if(e.code==='BracketRight'){ day.t=(day.t+0.01)%1; updateSun(true); requestSkyEnvironmentRebake(); }
  if(e.code==='Space') e.preventDefault();
});
addEventListener('keyup',e=>state.keys[e.code]=false);

const overlay=document.getElementById('overlay');
const isTouch='ontouchstart' in window && navigator.maxTouchPoints>0;
if(isTouch){ document.body.classList.add('touchmode');
  document.getElementById('ctaText').textContent='Tap to enter the park';
  document.getElementById('hint').textContent='Drag right side to look · joystick to move';
}
let locked=false;
overlay.addEventListener('click',()=>{
  if(!ready) return;
  overlay.classList.add('hidden');
  if(!isTouch) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange',()=>{
  locked=document.pointerLockElement===renderer.domElement;
  if(!locked && !isTouch) overlay.classList.remove('hidden');
});
renderer.domElement.addEventListener('click',()=>{ if(!isTouch&&!locked&&ready) renderer.domElement.requestPointerLock(); });
document.addEventListener('mousemove',e=>{
  if(!locked) return;
  if(drive.on && drive.camMode===2){   // first person: look yaws off the heading, then eases back
    drive.fpYaw = clamp(drive.fpYaw - e.movementX*0.0022, -2.4, 2.4);
    drive.fpHold = 0.4;                // ~0.4 s after the mouse stops, 82-drive recentres
    state.pitch = clamp(state.pitch - e.movementY*0.0022, -0.55, 0.4);
    return;
  }
  state.yaw -= e.movementX*0.0022;
  state.pitch = clamp(state.pitch - e.movementY*0.0022, -1.45, 1.45);
});

/* touch: joystick + look drag + buttons */
if(isTouch){
  const joy=document.getElementById('joy'), knob=document.getElementById('joyknob');
  let joyId=null, lookId=null, lx=0, ly=0;
  const jc=()=>{ const r=joy.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; };
  addEventListener('touchstart',e=>{
    for(const t of e.changedTouches){
      const r=joy.getBoundingClientRect();
      if(t.clientX>=r.left-20&&t.clientX<=r.right+20&&t.clientY>=r.top-20&&t.clientY<=r.bottom+20&&joyId===null){ joyId=t.identifier; }
      else if(lookId===null && t.clientX>innerWidth*0.4){ lookId=t.identifier; lx=t.clientX; ly=t.clientY; }
    }
  },{passive:true});
  addEventListener('touchmove',e=>{
    for(const t of e.changedTouches){
      if(t.identifier===joyId){
        const c=jc(); let dx=(t.clientX-c.x)/50, dy=(t.clientY-c.y)/50;
        const m=Math.hypot(dx,dy); if(m>1){dx/=m;dy/=m;}
        state.touch.mx=dx; state.touch.mz=dy;
        knob.style.transform=`translate(calc(-50% + ${dx*34}px), calc(-50% + ${dy*34}px))`;
      } else if(t.identifier===lookId){
        state.yaw -= (t.clientX-lx)*0.005;
        state.pitch = clamp(state.pitch-(t.clientY-ly)*0.005,-1.45,1.45);
        lx=t.clientX; ly=t.clientY;
      }
    }
  },{passive:true});
  addEventListener('touchend',e=>{
    for(const t of e.changedTouches){
      if(t.identifier===joyId){ joyId=null; state.touch.mx=state.touch.mz=0; knob.style.transform='translate(-50%,-50%)'; }
      if(t.identifier===lookId) lookId=null;
    }
  });
  const bind=(id,down,up)=>{ const el=document.getElementById(id);
    el.addEventListener('touchstart',e=>{e.preventDefault();down();});
    el.addEventListener('touchend',e=>{e.preventDefault();up&&up();});
  };
  bind('btnFly',()=>{ // cycle walk → fly → drive → walk; label shows the NEXT mode
    const b=document.getElementById('btnFly');
    if(drive.on){ exitDrive(); state.fly=false; b.textContent='FLY'; }
    else if(!state.fly){ state.fly=true; state.vel.y=0; b.textContent='DRIVE'; }
    else { state.fly=false; enterDrive(); b.textContent=drive.on?'WALK':'FLY'; }
    updateMode(); });
  bind('btnUp',()=>state.touch.up=1,()=>state.touch.up=0);
  bind('btnDown',()=>state.touch.down=1,()=>state.touch.down=0);
}

function updateMode(){
  document.getElementById('mode').textContent = drive.on ? '🚙 DRIVE' : state.fly ? '🪶 FLY' : '⛰ WALK';
}
addEventListener('wheel',e=>{ if(drive.on) drive.camDist=clamp(drive.camDist+e.deltaY*0.012,6,26); },{passive:true});
