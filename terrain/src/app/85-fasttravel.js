'use strict';
/* 85-fasttravel.js — Esc-menu fast travel to popular park spots.
   DECLARES: FT_DESTS, fastTravel, buildFastTravelMenu (runs at load).
   CONSUMES: camera/state (80), sampleGround (40), drive/exitDrive (82), EYE (80),
     waterBuilder/terrain (40), updateMode (84), overlay (84). `ready` (92) read at click time.
   The Esc overlay doubles as the menu: chips teleport, then the click bubbles to the overlay's
   own handler which hides it and re-locks the pointer — no extra plumbing. */

/* World coords from labels.json / buildings.json (GNIS + OSM); poses hand-tuned to face the
   classic view. mode 'walk' snaps to ground; 'fly' hovers alt metres above it. */
const FT_DESTS=[
  { name:'Trailhead',            x:60,     z:190,     yaw:2.05, pitch:-0.05, mode:'walk' },
  { name:'Jenny Lake',           x:175,    z:-1800,   yaw:1.50, pitch:0.02,  mode:'walk' },
  { name:'Cascade Canyon',       x:-2177,  z:-3503,   yaw:1.60, pitch:0.06,  mode:'walk' },
  { name:'Moulton Barn',         x:4890,   z:8280,    yaw:1.50, pitch:0.02,  mode:'walk' },
  { name:'Chapel · Moose',       x:820,    z:8360,    yaw:1.52, pitch:0.02,  mode:'walk' },
  { name:'Snake River · Dornans',x:1167,   z:8700,    yaw:1.60, pitch:0.00,  mode:'walk' },
  { name:'Taggart Lake',         x:-2380,  z:3500,    yaw:1.80, pitch:0.02,  mode:'walk' },
  { name:'Oxbow Bend',           x:14076,  z:-14218,  yaw:1.20, pitch:0.00,  mode:'walk' },
  { name:'Jackson Lake Lodge',   x:11700,  z:-15790,  yaw:1.57, pitch:0.00,  mode:'walk' },
  { name:'Colter Bay',           x:6360,   z:-18660,  yaw:1.10, pitch:0.00,  mode:'walk' },
  { name:'Signal Mtn Summit',    x:12597,  z:-12682,  yaw:1.35, pitch:-0.06, mode:'walk' },
  { name:'Grand Teton · Air',    x:-5800,  z:-1100,   yaw:2.36, pitch:-0.12, mode:'fly', alt:300 },
];

function fastTravel(d){
  if(typeof ready!=='undefined' && !ready) return;
  if(drive.on) exitDrive();                     // park the car where it stands
  let x=d.x, z=d.z;
  // never drop the player into water (lake-centre labels etc.) — nudge east until dry
  if(terrain && waterBuilder && waterBuilder.lc){
    for(let i=0;i<40 && waterBuilder.lc.waterAt(x,z);i++) x+=12;
  }
  state.yaw=d.yaw; state.pitch=d.pitch; state.vel.set(0,0,0);
  state.fly = d.mode==='fly';
  const gy=sampleGround(x,z);
  camera.position.set(x, gy + (state.fly ? (d.alt||120) : EYE), z);
  state.onGround = !state.fly;
  updateMode();
}

(function buildFastTravelMenu(){
  const grid=document.getElementById('ftGrid');
  if(!grid) return;
  for(const d of FT_DESTS){
    const b=document.createElement('button');
    b.className='ft';
    b.textContent=(d.mode==='fly'?'✈ ':'')+d.name;
    b.addEventListener('click',()=>fastTravel(d));  // bubbles to overlay: hides + re-locks pointer
    grid.appendChild(b);
  }
})();
