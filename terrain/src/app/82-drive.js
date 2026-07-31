'use strict';
/* 82-drive.js — drive mode: pickup physics + chase/first-person cam (builds the car on load).
   DECLARES: drive, CAR, car, carWheels, headLights, placeCar, waterBlocked, enterDrive,
     exitDrive, driveStep, ensureCarModel (+ internals procParts/carFPHide/carLightMats/
     lightPool/swapCarModel and scratch _carEuler/_carQuat/_camTarget/_camDesired/_fpEye).
   CONSUMES: THREE, scene/camera (20), sampleGround/RoadIndex/roadQuery/ROAD_HW/terrain/
     waterBuilder (40), WATER_Y (10), state (80), toast (86), nightAmt (30), respawn (80),
     updateMode (84), clamp/smooth/lerp (00). */
/* ============================================================
   DRIVE MODE — a forest-service pickup around Jackson Hole
   Kinematic feel-first physics: W/S throttle+brake, A/D steer,
   4 ground-sampled contact points -> position + pitch/roll.
   camMode (C key): 0 far chase, 1 near chase, 2 first person.
   ============================================================ */
const drive={
  on:false, used:false, yaw:1.4, speed:0, steer:0, spin:0,
  camDist:11, camMode:0, fpYaw:0, fpHold:0, snapCam:false, roadName:null,
  beam:1, _hPrev:false,          // headlight beam: 0 off · 1 dipped · 2 full (H key cycles)
  // Presentation mirrors the authoritative suspension outputs owned by ArcadeVehiclePhysics.
  suspV:0, pitchS:0, rollS:0,
  camVel:new THREE.Vector3(),    // FP-eye follow velocity (damps residual buzz off the body)
  pos:new THREE.Vector3(54,0,182)
};
const CAR={ WB:1.42, TR:0.80, WHEEL_R:0.34, WADE:0.5 }; // half wheelbase / half track (m)
const ROAD_LIFT=0.25;   // mirrors RoadRibbon LIFT — the asphalt rides this far above graded terrain,
                        // so on-road the car must seat +LIFT or its wheels sink into the ribbon (M5.2)
const FP_EYE={x:-0.37, y:1.45, z:-0.25}; // driver's eye in car space (left seat, mid-cab; raised to
                                         //  ~headrest-top height for a commanding SUV seating view)
let car=null, carWheels=[], headLights=[];
const drivingInput=window.DrivingInput?new window.DrivingInput():null;
const vehiclePhysics=window.GT_VEHICLE_PHYSICS;
const vehiclePhysicsState=vehiclePhysics?vehiclePhysics.createVehicleState({
  x:drive.pos.x,z:drive.pos.z,yaw:drive.yaw,speed:drive.speed}):null;
let procParts=[], carFPHide=[], carLightMats={head:null,brake:null,dash:null}; // FP-hidden parts + lens mats
(function buildCar(){
  // PBR is essential here: scene.environment is the sky PMREM.  Unlike Lambert this gives the
  // painted body and glass a single, correctly renderer-tonemapped reflection response.
  const mat=new THREE.MeshStandardMaterial({vertexColors:true, metalness:0.18, roughness:0.48,
    envMapIntensity:0.85, toneMapped:true});
  const paint=(g,c)=>{ const n=g.attributes.position.count, arr=new Float32Array(n*3);
    for(let i=0;i<n;i++){ arr[i*3]=c[0]; arr[i*3+1]=c[1]; arr[i*3+2]=c[2]; }
    g.setAttribute('color',new THREE.BufferAttribute(arr,3)); return g; };
  car=new THREE.Group();
  const add=(g,c,parent)=>{ const m=new THREE.Mesh(paint(g,c),mat); (parent||car).add(m);
    procParts.push(m); return m; };
  // body slabs — muted forest-service green over a tan chassis; low sedan stance, wheels tucked under
  const skid=new THREE.BoxGeometry(1.62,0.22,4.90); skid.translate(0,0.40,0);
  add(skid,[0.45,0.40,0.30]);
  const body=new THREE.BoxGeometry(1.80,0.52,4.80); body.translate(0,0.72,0);
  add(body,[0.24,0.35,0.22]);
  const win=new THREE.BoxGeometry(1.66,0.28,1.70); win.translate(0,1.06,0.25);
  const winM=add(win,[0.10,0.14,0.17]);
  const cab=new THREE.BoxGeometry(1.60,0.46,2.20); cab.translate(0,1.16,0.15);
  const cabM=add(cab,[0.21,0.30,0.19]);
  carFPHide=[winM,cabM];                 // procedural glasshouse blocks the FP eye — hide it
  // headlight lenses
  for(const hx of [-0.62,0.62]){
    const lens=new THREE.BoxGeometry(0.30,0.16,0.10); lens.translate(hx,0.80,-2.40);
    add(lens,[0.92,0.87,0.62]);
  }
  // wheels: pivot group (front pair steers) + spinning cylinder, tucked under the body
  const wg=paint(new THREE.CylinderGeometry(CAR.WHEEL_R,CAR.WHEEL_R,0.30,9),[0.07,0.07,0.08]);
  wg.rotateZ(Math.PI/2);                         // axle along local x
  for(const [wx,wz,front] of [[-CAR.TR,-CAR.WB,1],[CAR.TR,-CAR.WB,1],[-CAR.TR,CAR.WB,0],[CAR.TR,CAR.WB,0]]){
    const pivot=new THREE.Group(); pivot.position.set(wx,CAR.WHEEL_R,wz);
    const mesh=new THREE.Mesh(wg,new THREE.MeshStandardMaterial({vertexColors:true, metalness:0.05,
      roughness:0.76, envMapIntensity:0.45, toneMapped:true})); pivot.add(mesh); car.add(pivot);
    procParts.push(pivot);
    carWheels.push({pivot,mesh,front});
  }
  // headlights — on after dark while driving; aimed to pool ~9 m out so the
  // beam actually reads on dark asphalt from the first-person seat
  for(const hx of [-0.6,0.6]){
    const sp=new THREE.SpotLight(0xfff0c8, 0, 120, 0.55, 0.5, 1.0);   // longer throw for trees/grass ahead
    sp.position.set(hx,0.78,-2.4);
    sp.target.position.set(hx,-1.6,-22);
    car.add(sp); car.add(sp.target); headLights.push(sp);
  }
  car.visible=false;                   // no car in the world until first drive (G)
  scene.add(car);
})();
/* Headlight ground pool — the road/terrain ShaderMaterials ignore dynamic lights, so the
   spot beams alone never read on the asphalt. Back them with one cheap additive decal laid
   over the road where the spots aim (~4–13 m ahead of the bumper). Night-only, 1 draw call,
   procedural 64×64 radial sprite (deterministic, no asset). */
let lightPool=null;
(function buildLightPool(){
  const cv=document.createElement('canvas'); cv.width=cv.height=64;
  const c2=cv.getContext('2d');
  const grad=c2.createRadialGradient(32,40,3,32,36,30);  // hot spot biased toward the near edge
  grad.addColorStop(0,'rgba(255,238,196,0.95)');
  grad.addColorStop(0.5,'rgba(255,222,160,0.34)');
  grad.addColorStop(1,'rgba(255,210,140,0)');
  c2.fillStyle=grad; c2.fillRect(0,0,64,64);
  lightPool=new THREE.Mesh(
    new THREE.PlaneGeometry(6.6,16.0),
    new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(cv),transparent:true,
      blending:THREE.AdditiveBlending,depthWrite:false,fog:false,opacity:0}));
  lightPool.rotation.order='YXZ';        // yaw-then-lay-flat, same convention as the car euler
  lightPool.renderOrder=4;               // after the opaque road ribbon
  lightPool.visible=false;
  scene.add(lightPool);
})();
/* ---- terrain-aware headlights (ROADMAP M3) --------------------------------------------------
   SpotLights above light the built-in Lambert materials (buildings, groundcover grass) but NOT
   the terrain/road CUSTOM ShaderMaterials — so the beams never read on the asphalt or sagebrush.
   Fix: publish a shared HEADLIGHT_UNIFORMS block (create-or-adopt, like SHADOW_UNIFORMS) that the
   terrain + road fragment shaders sample per-fragment (cone test + falloff + Lambert). This module
   is the PRODUCER: driveStep writes the two beam origins/directions + cone params every frame while
   driving after dark, and zeroes the master intensity (uHLParams.w) by day / when parked / off.
   Two thin additive cones give the beams a faint volumetric presence in the air. */
const HEADLIGHT_UNIFORMS = window.HEADLIGHT_UNIFORMS = window.HEADLIGHT_UNIFORMS ||
  { uHLPos:   { value: [new THREE.Vector3(1e6,1e6,1e6), new THREE.Vector3(1e6,1e6,1e6)] },
    uHLDir:   { value: [new THREE.Vector3(0,0,-1), new THREE.Vector3(0,0,-1)] },
    uHLColor: { value: new THREE.Color(1.0,0.92,0.76) },
    uHLParams:{ value: new THREE.Vector4(0.974,0.866,40.0,0.0) } };
// per-mode beam recipe: cosInner (hot core) · cosOuter (cone edge) · range m · downward tilt rad
const BEAM={ 1:{ci:0.970,co:0.845,range:70,tilt:-0.26,vtan:0.60,vop:0.075},   // dipped: medium throw
             2:{ci:0.986,co:0.935,range:120,tilt:-0.08,vtan:0.38,vop:0.060} }; // full: long throw, near-level
// URL override so headless captures can force a beam state: ...&beam=0|1|2
const _beamOverride=(()=>{ const b=new URLSearchParams(location.search).get('beam');
  return b===null?null:Math.max(0,Math.min(2,+b|0)); })();
let beamCones=[];
(function buildBeamCones(){
  // unit cone: apex at origin, axis along -z (car forward), base ring at z=-1; open-ended so it
  // reads as scattered light not a solid ice-cream cone. Kept in the SCENE (not parented to the
  // car) so 20-scene's shadow-tag traversal never turns these additive volumes into casters.
  const g=new THREE.ConeGeometry(1,1,18,1,true);
  g.translate(0,-0.5,0); g.rotateX(Math.PI/2);
  for(let i=0;i<2;i++){
    const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xfff0c8,transparent:true,
      blending:THREE.AdditiveBlending,depthWrite:false,fog:false,opacity:0,side:THREE.DoubleSide}));
    m.renderOrder=5; m.visible=false; m.frustumCulled=false;
    scene.add(m); beamCones.push(m);
  }
})();
/* ---- real car model (matching Three addon loader is installed by the module bootstrap) ---- */
let carModelReq=false;
function ensureCarModel(){
  if(carModelReq) return; carModelReq=true;
  window.carModelLoading=true;                         // 90-auto settle waits on this
  const done=()=>{ window.carModelLoading=false; };
  new THREE.GLTFLoader().load('terrain/public/models/interior-car.glb',
    g=>{ try{ swapCarModel(g); }catch(e){ console.warn('car model swap failed',e); } done(); },
    undefined,
    e=>{ console.warn('car model load failed',e); done(); });
}
function swapCarModel(gltf){
  const root=gltf.scene;
  for(const p of procParts) car.remove(p);              // procedural slab pickup out
  procParts=[]; carWheels.length=0; carFPHide=[];       // full model carries its own cabin — nothing to hide in FP
  // AUTO-FIT (Range Rover, CC-BY): node transforms are heavily baked (odd per-node scales + a root
  // rotation), so don't trust raw coords — measure the LOADED world bbox and map it into car-local
  // space (forward -z, up +y, origin at ground, length ~4.8 m). Robust to whatever the export baked.
  root.updateWorldMatrix(true, true);
  const bb=new THREE.Box3().setFromObject(root), sz=new THREE.Vector3(); bb.getSize(sz);
  if(sz.x>sz.z) root.rotation.y+=Math.PI/2;             // make the long axis the z (forward) axis
  root.rotation.y+=Math.PI;                             // this model faces +z; flip so its front is -z (travel dir)
  root.updateWorldMatrix(true, true); bb.setFromObject(root); bb.getSize(sz);
  root.scale.multiplyScalar(4.8/Math.max(sz.z,1e-3));   // ~4.8 m long
  root.updateWorldMatrix(true, true); bb.setFromObject(root);
  const ctr=bb.getCenter(new THREE.Vector3());
  root.position.set(-ctr.x, -bb.min.y, -ctr.z);         // centre X/Z on the car origin, sit on the ground
  car.add(root); car.userData.carRoot=root;
  // the model authored its windscreen/windows as OPAQUE (why the glass looked solid) — make it real
  // glass so you can see out from the driver's seat; tag headlight/brake lens mats if present.
  const darkTrim=new THREE.MeshStandardMaterial({ color:0x17161a, metalness:0.0, roughness:0.9, side:THREE.DoubleSide, envMapIntensity:0.25, toneMapped:true }); // interior dark trim = dash colour
  root.traverse(o=>{
    if(!o.isMesh||!o.material) return;
    o.castShadow=true; o.receiveShadow=true;
    let m=o.material;
    // GLTFs can contain legacy/Basic materials. Normalize every visible model surface to a PBR
    // material while retaining maps, vertex colours, alpha and emissive values from the asset.
    if(!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial){
      const p=new THREE.MeshStandardMaterial(); p.copy(m); p.metalness=0.08; p.roughness=0.62; m=o.material=p;
    }
    m.toneMapped=true; m.envMapIntensity=0.8;
    if(m.name==='Glass'){
      // Only the window/windscreen glass may be transparent. The roof panel shares the Glass material
      // with the windows — tell them apart by shape (roof glass is a flat, low-height sheet) and make
      // it SOLID DARK; keep the tall window glass clear so you can still see out.
      o.geometry.computeBoundingBox();
      const yspan=o.geometry.boundingBox.max.y-o.geometry.boundingBox.min.y;
      if(yspan<0.5) o.material=darkTrim;                // roof → solid dark
      else {
        // Keep the loader's Standard glass model. A low-roughness Physical material made the new
        // sky PMREM dominate at grazing exterior angles, so nominally 16%-opaque windows read as
        // solid mirrors in chase view even though they remained clear from inside the cabin.
        const glass=m.clone();
        glass.transparent=true; glass.opacity=0.16; glass.depthWrite=false; glass.side=THREE.DoubleSide;
        glass.roughness=0.28; glass.metalness=0.0; glass.envMapIntensity=0.35; glass.toneMapped=true;
        o.material=glass; m=glass;
      } // windows → clear glass with a restrained sky reflection
    } else {
      // everything that ISN'T window glass must be SOLID from the inside — the model's shells are
      // single-sided, so from the cabin you'd see straight through the body/roof/pillars. Double-side
      // them so the interior is fully enclosed and opaque.
      m.side=THREE.DoubleSide;
    }
    if(m.name==='Headlights'){ carLightMats.head=m; m.emissive=new THREE.Color(0xffdf9a); }
    if(m.name==='BrakeLight'){ carLightMats.brake=m; m.emissive=new THREE.Color(0xff2a1a); }
  });
  // cabin fill: the interior sits in roof shadow, so a dim short-range warm point light parented to
  // the car lifts the dash/seats/wheel without spilling into the wider scene.
  // two generous, gentle-falloff (decay 1) fills — front and rear of the cabin — so the whole
  // interior reads, not just the dash. Parented to the car; short range keeps them off the scene.
  for(const cz of [-0.4, 0.5]){
    const cl=new THREE.PointLight(0xfff2e2, 1.3, 5.0, 1.0); cl.position.set(0, 1.15, cz); car.add(cl); // dim: dark interior stays dark, just readable
  }
  // steering wheel (the model ships none): dark torus rim + hub + 3 spokes at the driver.
  // A small emissive floor preserves its silhouette in the deeply shadowed cabin without lifting
  // the entire interior or making the dark trim look self-lit.
  const wtrim=new THREE.MeshStandardMaterial({ color:0x242424, metalness:0.0, roughness:0.72,
    envMapIntensity:0.18, emissive:0x080706, emissiveIntensity:0.35, toneMapped:true });
  const wheel=new THREE.Group();
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.18,0.022,14,32), wtrim));
  const whub=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.03,12), wtrim); whub.rotation.x=Math.PI/2; wheel.add(whub);
  for(let a=0;a<3;a++){ const sp=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.02,0.016), wtrim);
    sp.rotation.z=a*2.094; sp.position.set(Math.cos(a*2.094)*0.09, Math.sin(a*2.094)*0.09, 0); wheel.add(sp); }
  wheel.position.set(-0.37,1.22,-0.55); wheel.rotation.x=-0.5;   // raised to a natural driving position under the raised eye
  wheel.traverse(o=>{ o.castShadow=false; o.receiveShadow=false; });
  car.add(wheel); car.userData.wheelMesh=wheel;
  // functional headlights: two warm emissive lenses at the RR's front (the model's own lamps are
  // just flat palette colour). Tagged as carLightMats.head so the night ramp in driveStep lights
  // them — the car's headlights visibly switch ON and the beam reads as emanating from the lamps.
  const lampMat=new THREE.MeshStandardMaterial({ color:0x201d18, emissive:new THREE.Color(0xffe6bc), emissiveIntensity:0 });
  carLightMats.head=lampMat;
  for(const lx of [-0.72,0.72]){
    const lamp=new THREE.Mesh(new THREE.CircleGeometry(0.15,18), lampMat);
    lamp.position.set(lx,0.64,-2.40); lamp.rotation.y=Math.PI; // lens faces forward (-z, travel dir)
    lamp.castShadow=false; lamp.receiveShadow=false; car.add(lamp);
  }
  car.userData.shadowTagged=false;
  return;   // (procedural cabin below is superseded by the real modeled interior)
}
/* If (x,z) sits on (or near) a road, shift it into the right-hand travel lane (US drives on the
   right): find the nearest centreline point + road tangent, then offset half a lane to the
   driver's right relative to `yaw`.
   maxDist controls how far a spawn may reach for a road:
     · null/omitted → only snaps when actually on the carriageway (halfW+1) — the legacy behaviour,
       so re-placement / scripted captures are unchanged.
     · a number (m) → snaps to the nearest lane within that radius, e.g. enterDrive pulls a car that
       lands out in the sagebrush onto the road it was aiming for (M4 road-drive-tpr fix). The bucket
       scan widens to cover the radius so distant roads are actually found. */
function snapToLane(x,z,yaw,maxDist){
  if(!RoadIndex.ready) return null;
  const R=RoadIndex, cx=Math.floor(x/R.cell), cz=Math.floor(z/R.cell);
  const rad=maxDist!=null ? Math.max(1,Math.ceil(maxDist/R.cell)) : 1;  // cells to scan each way
  let best=1e9, bx=0,bz=0, tx=0,tz=0, bcls=null; const seen=R._seen; seen.clear();
  for(let j=-rad;j<=rad;j++) for(let i=-rad;i<=rad;i++){
    const arr=R.buckets.get((cx+i)+','+(cz+j)); if(!arr) continue;
    for(const si of arr){
      if(seen.has(si)) continue; seen.add(si);
      const s=R.segs[si], dx=s.bx-s.ax, dz=s.bz-s.az, l2=dx*dx+dz*dz;
      let t=l2>0?((x-s.ax)*dx+(z-s.az)*dz)/l2:0; t=t<0?0:t>1?1:t;
      const px=s.ax+t*dx, pz=s.az+t*dz, d=Math.hypot(x-px,z-pz);
      if(d<best){ best=d; bx=px; bz=pz; const l=Math.sqrt(l2)||1; tx=dx/l; tz=dz/l; bcls=s.cls; }
    }
  }
  const halfW=ROAD_HW[bcls]||0;
  const tol=maxDist!=null ? maxDist : halfW+1;
  if(best>tol) return null;                           // no road in reach → spawn in place
  // orient tangent along travel (car forward at yaw is (-sin,-cos) in xz)
  const fx=-Math.sin(yaw), fz=-Math.cos(yaw);
  if(tx*fx+tz*fz<0){ tx=-tx; tz=-tz; }
  // driver's-right normal of the travel tangent, offset to the lane centre
  const rnx=tz, rnz=-tx, lane=halfW*0.5;
  return { x:bx+rnx*lane, z:bz+rnz*lane };
}
// A spawning car reaches this far (m) for a road so entering never strands it out in the sagebrush
// off the carriageway (M4 road-drive-tpr). Beyond it, snapToLane finds nothing and the car spawns
// in place. Every existing drive spawn is either already on-road or >100 m from any road, so this
// only fills the 5–60 m "just missed the road" band. Headless captures inherit it through the
// scripted placeCar path; ...&entersnap=N (deterministic, like ?beam=N) overrides the radius.
const ENTER_SNAP=60;
const _enterSnap=(()=>{ const v=new URLSearchParams(location.search).get('entersnap');
  return v===null?null:Math.max(0,+v||0); })();
function placeCar(x,z,yaw,snapR){
  ensureCarModel();                    // kick off the real model on first car use
  car.visible=true;
  const r=snapR!=null ? snapR : (_enterSnap!=null ? _enterSnap : ENTER_SNAP);
  const lane=snapToLane(x,z,yaw,r); if(lane){ x=lane.x; z=lane.z; }
  drive.yaw=yaw; drive.speed=0; drive.steer=0;
  drive.pos.set(x, sampleGround(x,z), z);
  car.position.copy(drive.pos);
  car.quaternion.setFromEuler(new THREE.Euler(0,yaw,0,'YXZ'));
}
function waterBlocked(x,z){
  // a detected bridge deck spans the water here — the car drives across it, so never block on the
  // crossing (else it bounces off mid-river). The deck surface is the one ridden by sampleGround.
  if(roadRibbon && roadRibbon.drivableSurfaceAt && roadRibbon.drivableSurfaceAt(x,z)!=null) return false;
  // real terrain: the DEM is hydro-flattened (lake ground == surface), so depth is meaningless —
  // block on the 10 m NLCD/NHD water mask itself. Procedural: true depth vs wheel height.
  if(terrain) return !!(waterBuilder && waterBuilder.lc && waterBuilder.lc.waterAt(x,z));
  return sampleGround(x,z) < WATER_Y-CAR.WADE;
}
function enterDrive(){
  if(waterBlocked(camera.position.x,camera.position.z)){ toast('too deep to drive here'); return; }
  drive.on=true; drive.used=true;
  placeCar(camera.position.x, camera.position.z, state.yaw, ENTER_SNAP);  // pull onto a nearby road
  if(state.pitch>-0.06) state.pitch=-0.18;
  state.pitch=clamp(state.pitch,-0.9,0.05);
  state.vel.set(0,0,0);
  updateMode();
}
function exitDrive(){
  drive.on=false;
  const s=Math.sin(drive.yaw), c=Math.cos(drive.yaw);
  camera.position.set(drive.pos.x+c*2.4, 0, drive.pos.z-s*2.4);   // step out the right door
  camera.position.y=sampleGround(camera.position.x,camera.position.z)+EYE;
  state.vel.set(0,0,0); state.yaw=drive.yaw;
  for(const h of headLights) h.intensity=0;
  lightPool.visible=false;
  HEADLIGHT_UNIFORMS.uHLParams.value.w=0;      // terrain/road shaders early-out to zero cost
  for(const cn of beamCones) cn.visible=false;
  if(carLightMats.head) carLightMats.head.emissiveIntensity=0;
  if(carLightMats.brake) carLightMats.brake.emissiveIntensity=0;
  if(carLightMats.dash) carLightMats.dash.emissiveIntensity=0;
  if(carLightMats.binnacle) carLightMats.binnacle.emissiveIntensity=0;
  fpNear(false);                             // restore the near plane when leaving the car
  for(const o of carFPHide) o.visible=true;  // parked truck keeps its glasshouse
  updateMode();
}
const _carEuler=new THREE.Euler(0,0,0,'YXZ'), _carQuat=new THREE.Quaternion();
let _origNear=null;   // saved camera.near — lowered in FP so the close cabin (door/dash/wheel) doesn't clip
function fpNear(on){  // set/restore the near plane for first person; no-op if already there
  if(on){ if(_origNear===null) _origNear=camera.near; if(camera.near!==0.12){ camera.near=0.12; camera.updateProjectionMatrix(); } }
  else if(_origNear!==null && camera.near!==_origNear){ camera.near=_origNear; camera.updateProjectionMatrix(); }
}
const _camTarget=new THREE.Vector3(), _camDesired=new THREE.Vector3(), _fpEye=new THREE.Vector3();
const _hlTiltQ=new THREE.Quaternion(), _hlAxisX=new THREE.Vector3(1,0,0); // beam-cone tilt about local x
/* Gamepad snapshot, refreshed exactly once per rendered frame by pollGamepad() (called from
   step() in 92-boot). navigator.getGamepads() allocates a fresh GamepadList plus a Gamepad
   object per connected pad on EVERY call in Chrome, and driveStep runs on a 1/120 s fixed step
   — up to 5 substeps per frame. Every substep reads the same physical input, so one poll per
   frame is behaviourally identical at a fifth of the garbage. */
let _padSnapshot=null;
function pollGamepad(){
  _padSnapshot=window.GT_activeGamepad&&navigator.getGamepads?
    window.GT_activeGamepad(navigator.getGamepads()):null;
  return _padSnapshot;
}
function driveStep(dt){
  const k=state.keys;
  const pad=_padSnapshot;
  const command=drivingInput?drivingInput.update(dt,{keys:k,touch:state.touch,gamepad:pad}):null;
  const throttle=command?(command.throttle-command.brake):
    clamp((k.KeyW?1:0)-(k.KeyS?1:0)-state.touch.mz,-1,1);
  const steerIn=command?-command.steer:
    clamp((k.KeyA?1:0)-(k.KeyD?1:0)-state.touch.mx,-1,1);
  drive.steer=command?steerIn:lerp(drive.steer,steerIn,1-Math.pow(0.001,dt));
  if(command&&command.reset&&!k.KeyR) respawn();
  if(command&&command.cameraCycle&&!k.KeyC){
    drive.camMode=(drive.camMode+1)%3;
    if(drive.camMode<2){ drive.camDist=drive.camMode===1?7.5:14;drive.snapCam=true; }
    else { drive.fpYaw=0;state.pitch=clamp(state.pitch,-0.55,0.4); }
  }

  const s=Math.sin(drive.yaw), c=Math.cos(drive.yaw);
  const fx=-s, fz=-c, rx=c, rz=-s;                    // forward / right in world xz
  const P=drive.pos;

  // road surface under the car: on-road = grip + full top speed; off-road = ~60% cap + jitter.
  // If no roads are baked (index never loaded) we can't tell — fall back to legacy full-grip
  // behaviour so drive mode is unchanged when roads.json is absent.
  const surface={};
  const hasSurface=!!(window.transportSurface&&window.transportSurface.sample(P.x,P.z,surface,
    {filter:s=>s.vehicleAllowed}));
  const rq=hasSurface?{dist:Math.abs(surface.lateralOffset),class:
    surface.kind==='major_highway'?'highway':surface.kind==='park_paved_road'?'park_paved':
    surface.kind==='gravel_road'?'gravel':'track',name:surface.name||null}:RoadIndex.ready?roadQuery(P.x,P.z):null;
  const halfW=hasSurface?surface.halfWidth:(rq&&rq.class?(ROAD_HW[rq.class]||0):0);
  const onRoad = hasSurface || (rq ? !!(rq.class && rq.class!=='trail' && rq.dist < halfW+1.2) : true);
  const roadCentral = (onRoad&&rq) ? (1-smooth(halfW*0.5, halfW+1.2, rq.dist)) : 0; // 1 on centre → 0 at shoulder
  drive.roadName=(rq && onRoad)?(rq.name||null):null;

  if(vehiclePhysicsState){
    Object.assign(vehiclePhysicsState,{x:P.x,z:P.z,yaw:drive.yaw,speed:drive.speed,steer:-drive.steer});
    const env={
      sample:(x,z)=>{
        const hit={};
        return window.transportSurface&&window.transportSurface.sample(x,z,hit,
          {filter:s=>s.vehicleAllowed,margin:1.25})?hit:{y:sampleGround(x,z),surface:'terrain',grip:.42,
            roughness:.78,rollingResistance:.075};
      },
      heightAt:(x,z)=>sampleGround(x,z),
      validAt:(x,z)=>Number.isFinite(sampleGround(x,z)),
      isSubmerged:(x,z,y)=>waterBlocked(x,z)&&Number.isFinite(y),
      vehicleUpY:()=>Math.cos(drive.rollS)*Math.cos(drive.pitchS),
      slopeAlong:(x,z,dx,dz)=>(sampleGround(x+dx*5,z+dz*5)-sampleGround(x,z))/5,
      sweep:(from,to,hit)=>{
        const distance=Math.max(.5,Math.hypot(to.x-from.x,to.z-from.z));
        const cliff=!onRoad&&Math.abs(sampleGround(to.x,to.z)-sampleGround(from.x,from.z))/distance>1.2;
        const rail=bridgeBuilder&&bridgeBuilder.sweepDeckBarrier&&
          bridgeBuilder.sweepDeckBarrier(from,to,{radius:1.0},hit);
        const blocked=cliff||waterBlocked(to.x,to.z)||rail||
          (window.buildingBlocked&&buildingBlocked(to.x,to.z,P.y+1));
        if(blocked&&!rail){ hit.normalX=(from.x-to.x)/distance;hit.normalZ=(from.z-to.z)/distance; }
        return blocked;
      }
    };
    const cmd=command||{throttle:Math.max(0,throttle),brake:Math.max(0,-throttle),
      reverseIntent:throttle<0,steer:-steerIn};
    vehiclePhysics.stepVehicle(vehiclePhysicsState,cmd,env,dt);
    if(vehiclePhysicsState.recoveryRequested){
      window.GT_DRIVE_RECOVERY_REASON=vehiclePhysicsState.recoveryReason;
      respawn();
      return;
    }
    P.x=vehiclePhysicsState.x;P.z=vehiclePhysicsState.z;
    drive.yaw=vehiclePhysicsState.yaw;drive.speed=vehiclePhysicsState.speed;
    window.GT_DRIVE_FEEDBACK=vehiclePhysicsState.feedback;
    window.GT_DRIVE_TELEMETRY=vehiclePhysicsState.telemetry;
    const suspension=vehiclePhysicsState.suspension;
    P.y=suspension.y; drive.suspV=suspension.heaveVelocity;
    drive.pitchS=suspension.pitch; drive.rollS=suspension.roll;
  }

  _carEuler.set(drive.pitchS, drive.yaw, drive.rollS);
  car.quaternion.setFromEuler(_carEuler);
  car.position.copy(P);

  // wheels spin with speed; fronts visually steer
  drive.spin+=drive.speed/CAR.WHEEL_R*dt;
  for(const w of carWheels){
    w.mesh.rotation.x=-drive.spin;
    if(w.front) w.pivot.rotation.y=drive.steer*0.45;
  }
  // H cycles beam state (off -> dipped -> full); headless captures may force it via ?beam=N.
  // Edge-detect the key here (84-input just records state.keys) so all beam logic stays local.
  if(k.KeyH && !drive._hPrev){ drive.beam=(drive.beam+1)%3;
    toast(['headlights off','dipped beams','full beams'][drive.beam]); }
  drive._hPrev=!!k.KeyH;
  const beamMode=_beamOverride!==null?_beamOverride:drive.beam;
  const lampAmt=smooth(0.25,0.6,nightAmt);      // night gate: 0 by day, 1 in deep night
  const hlAmt=beamMode>0?lampAmt:0;             // master: off state kills every car light too
  // legacy SpotLights (buildings/grass) + lamp-lens glow follow the same gate
  for(const h of headLights) h.intensity=3.0*hlAmt;
  if(carLightMats.head) carLightMats.head.emissiveIntensity=2.5*hlAmt;
  if(carLightMats.dash) carLightMats.dash.emissiveIntensity=0.55*lampAmt;   // subtle instrument glow after dark
  if(carLightMats.binnacle) carLightMats.binnacle.emissiveIntensity=0.9*lampAmt; // brighter cluster behind the wheel
  if(carLightMats.brake)                       // brake glow + dim night running lights
    carLightMats.brake.emissiveIntensity=(throttle<0&&drive.speed>0.5?1.4:0)+0.5*hlAmt;

  // ---- terrain-aware beams: publish the two lamp cones into HEADLIGHT_UNIFORMS so the terrain +
  // road custom shaders light the ground/asphalt ahead. Origins at the lamp lenses; directions
  // are the car-forward axis tilted down per beam mode (so beams pitch with the car on grades).
  const rec=BEAM[beamMode]||BEAM[1];
  const HP=HEADLIGHT_UNIFORMS.uHLPos.value, HD=HEADLIGHT_UNIFORMS.uHLDir.value;
  HP[0].set(-0.72,0.64,-2.40).applyQuaternion(car.quaternion).add(car.position);  // origins AT the RR lamp lenses
  HP[1].set( 0.72,0.64,-2.40).applyQuaternion(car.quaternion).add(car.position);
  HD[0].set(0,rec.tilt,-1).applyQuaternion(car.quaternion).normalize();
  HD[1].copy(HD[0]);                            // both beams parallel
  HEADLIGHT_UNIFORMS.uHLParams.value.set(rec.ci, rec.co, rec.range, 4.0*hlAmt);   // softer falloff carries further; ease intensity so near-field doesn't blow out

  // volumetric beam cones RETIRED (M5.4): at 31 m radius they read as a big grey cone filling the
  // sky — exactly the "cone that lights up the sky" to avoid. The real light is the per-fragment
  // ground bounce (HEADLIGHT_UNIFORMS shader, lights scenery by its own albedo) + the light-pool
  // decal. Keep the meshes allocated but never show them (easy to re-enable a subtle beam later).
  for(const cn of beamCones) cn.visible=false;

  // light-pool decal RETIRED (M5.4): a floating additive hot-spot 8 m ahead read as detached from
  // the car. The real light is now the per-fragment beam bounce from the lamp lenses (above) +
  // the SpotLights on Lambert objects — a single connected source. Keep the mesh, never show it.
  lightPool.visible=false;

  const fp=drive.camMode===2;
  for(const o of carFPHide) o.visible=!fp;     // glasshouse out of the way in first person

  if(fp){
    fpNear(true);                                // close cabin geometry must not clip the near plane
    // first person: eye at the driver's seat, hood in view; mouse yaws ±2.4 rad
    // off the heading (84-input feeds drive.fpYaw) and eases back after release
    drive.fpHold-=dt;
    if(drive.fpHold<=0) drive.fpYaw*=Math.pow(0.05,dt);
    state.pitch=clamp(state.pitch,-0.55,0.4);
    // eye is RIGIDLY on the seat — no positional damping here, or the cabin drifts ahead of the
    // camera while driving. The body is already spring-smoothed at the suspension (5.1), so the eye
    // rides smoothly without a filter that would lag the forward motion.
    _fpEye.set(FP_EYE.x,FP_EYE.y,FP_EYE.z).applyQuaternion(car.quaternion).add(car.position);
    camera.position.copy(_fpEye);
    drive.snapCam=false;
    camera.rotation.order='YXZ';
    camera.rotation.set(state.pitch, drive.yaw+drive.fpYaw, 0);
    state.yaw=drive.yaw;                       // no jump when hopping back to chase / on foot
  }else{
    fpNear(false);                               // restore the default near plane outside first person
    // chase cam: mouse orbits, eases back behind the car once rolling
    const recen=(1-Math.pow(0.3,dt))*smooth(1.5,8,Math.abs(drive.speed));
    state.yaw+=Math.atan2(Math.sin(drive.yaw-state.yaw),Math.cos(drive.yaw-state.yaw))*recen;
    const la=clamp(drive.speed*0.30,-3,8);
    _camTarget.set(P.x+fx*la, P.y+2.1, P.z+fz*la);
    const cp=Math.cos(state.pitch), sp2=Math.sin(state.pitch), dist=drive.camDist;
    _camDesired.set(_camTarget.x+Math.sin(state.yaw)*cp*dist,
                    _camTarget.y-sp2*dist,
                    _camTarget.z+Math.cos(state.yaw)*cp*dist);
    const cg=sampleGround(_camDesired.x,_camDesired.z)+1.2;
    if(_camDesired.y<cg) _camDesired.y=cg;
    if(drive.snapCam){ camera.position.copy(_camDesired); drive.snapCam=false; }
    else camera.position.lerp(_camDesired,1-Math.pow(0.000001,dt));
    camera.lookAt(_camTarget);
  }

  if(P.y<-1500 || camera.position.y<-1500) respawn();
}
