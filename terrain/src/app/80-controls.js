'use strict';
/* 80-controls.js — first-person state + respawn + movement constants.
   DECLARES: state, SPAWN, respawn, EYE, G, WALK, SPRINT, FLY, FLYFAST, JUMP.
   CONSUMES: THREE, camera (20), sampleGround (40), drive/placeCar (82, at call time). */
/* ============================================================
   CONTROLS — first-person walk & fly
   ============================================================ */
const state={
  yaw:2.05, pitch:-0.06, fly:false, onGround:false,
  vel:new THREE.Vector3(), keys:{},
  touch:{mx:0,mz:0,up:0,down:0}
};
const SPAWN=new THREE.Vector3(60, 0, 190);
function respawn(){
  state.vel.set(0,0,0); state.yaw=2.05; state.pitch=-0.05;
  if(drive.on){                              // R while driving: car + chase cam back to trailhead
    placeCar(SPAWN.x, SPAWN.z, 1.4);
    state.yaw=1.4; state.pitch=-0.18; drive.snapCam=true;
  }else{
    camera.position.copy(SPAWN);
    camera.position.y=sampleGround(SPAWN.x,SPAWN.z)+3;
  }
}
const EYE=1.8, G=42, WALK=10, SPRINT=30, FLY=70, FLYFAST=220, JUMP=15;
