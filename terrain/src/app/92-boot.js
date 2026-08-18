'use strict';
/* 92-boot.js — step(), world build + boot(), main animate() loop, resize (last module).
   DECLARES: step, ready, loadmsg, proceduralStages, boot, clock, statsEl, uw, statTick, mmAcc, animate.
   CONSUMES: essentially everything above (runs the app). */
let driveAccumulator=0;
const DRIVE_FIXED_STEP=1/120;
const terrainPrediction={position:new THREE.Vector3(),velocity:new THREE.Vector3(),
  rawVelocity:new THREE.Vector3(),euler:new THREE.Euler(0,0,0,'YXZ'),yaw:0,pitch:0,ready:false};
function updateTerrainPrediction(dt){
  if(!terrain||!terrain.setPredictionState) return;
  const p=terrainPrediction, safeDt=Math.max(1/240,dt);
  p.euler.setFromQuaternion(camera.quaternion,'YXZ');
  if(!p.ready){
    p.position.copy(camera.position); p.yaw=p.euler.y; p.pitch=p.euler.x; p.ready=true;
    terrain.setPredictionState({mode:drive.on?'drive':state.fly?'fly':'walk',velocity:p.velocity,
      yawRate:0,pitchRate:0,teleported:false});
    return;
  }
  const distance=camera.position.distanceTo(p.position), teleported=distance>2000;
  p.rawVelocity.subVectors(camera.position,p.position).divideScalar(safeDt);
  if(teleported) p.velocity.set(0,0,0); else p.velocity.lerp(p.rawVelocity,0.45);
  const angleDelta=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
  const yawRate=teleported?0:angleDelta(p.euler.y,p.yaw)/safeDt;
  const pitchRate=teleported?0:angleDelta(p.euler.x,p.pitch)/safeDt;
  terrain.setPredictionState({mode:drive.on?'drive':state.fly?'fly':'walk',velocity:p.velocity,
    yawRate,pitchRate,teleported});
  p.position.copy(camera.position); p.yaw=p.euler.y; p.pitch=p.euler.x;
}
function step(dt){
  if(drive.on){
    pollGamepad();                            // once per frame, not once per fixed substep
    driveAccumulator=Math.min(driveAccumulator+dt,DRIVE_FIXED_STEP*5);
    let catchups=0;
    while(driveAccumulator>=DRIVE_FIXED_STEP&&catchups++<5){
      driveStep(DRIVE_FIXED_STEP);
      driveAccumulator-=DRIVE_FIXED_STEP;
    }
    return;
  }
  driveAccumulator=0;
  const k=state.keys;
  const fwd=(k.KeyW?1:0)-(k.KeyS?1:0) - state.touch.mz;
  const strf=(k.KeyD?1:0)-(k.KeyA?1:0) + state.touch.mx;
  const sprint=k.ShiftLeft||k.ShiftRight;
  const sy=Math.sin(state.yaw), cy=Math.cos(state.yaw);

  if(state.fly){
    const sp=(sprint?FLYFAST:FLY);
    const dir=new THREE.Vector3(
      -sy*Math.cos(state.pitch), Math.sin(state.pitch), -cy*Math.cos(state.pitch));
    const right=new THREE.Vector3(cy,0,-sy);
    const move=new THREE.Vector3().addScaledVector(dir,fwd).addScaledVector(right,strf);
    if(k.Space||state.touch.up) move.y+=1;
    if(k.KeyC||k.ControlLeft||state.touch.down) move.y-=1;
    if(move.lengthSq()>0) move.normalize();
    state.vel.lerp(move.multiplyScalar(sp), 1-Math.pow(0.0008,dt));
    camera.position.addScaledVector(state.vel,dt);
  } else {
    const sp=(sprint?SPRINT:WALK);
    const move=new THREE.Vector3(-sy*fwd + cy*strf, 0, -cy*fwd - sy*strf);
    if(move.lengthSq()>0) move.normalize().multiplyScalar(sp);
    state.vel.x=lerp(state.vel.x,move.x,1-Math.pow(0.0001,dt));
    state.vel.z=lerp(state.vel.z,move.z,1-Math.pow(0.0001,dt));
    state.vel.y-=G*dt;
    if((k.Space||state.touch.up)&&state.onGround){ state.vel.y=JUMP; state.onGround=false; }
    camera.position.addScaledVector(state.vel,dt);
    // buildings are solid: undo the horizontal move if it ends inside a footprint (below roof)
    if(window.buildingBlocked && buildingBlocked(camera.position.x,camera.position.z,camera.position.y-EYE+1.0)){
      camera.position.x-=state.vel.x*dt; camera.position.z-=state.vel.z*dt;
      state.vel.x=0; state.vel.z=0;
    }
    const gy=sampleGround(camera.position.x,camera.position.z)+EYE;
    if(camera.position.y<=gy){ camera.position.y=gy; state.vel.y=0; state.onGround=true; }
    else state.onGround=false;
  }
  if(camera.position.y<-1500) respawn();

  camera.rotation.order='YXZ';
  camera.rotation.y=state.yaw; camera.rotation.x=state.pitch;
}

/* ============================================================
   BUILD & RUN
   ============================================================ */
let ready=false;
let buildingMgr=null;                       // BuildingManager instance (real-terrain branch only)
let landmarkMgr=null;                       // model-backed named structures with distance LODs
let propScatter=null;                       // PropScatter: boulders/deadfall/fences (M4 props lane)
let wildlife=null;                          // WildlifeManager: habitat-placed animal herds (wildlife lane)
let trailBuilder=null;                      // TrailBuilder: OSM foot trails draped as dirt tread
let bridgeBuilder=null;                     // BridgeBuilder: derived decks where roads cross water (M6)
let signBuilder=null;                       // fixed-yaw NPS guide, plaque and stop-sign geometry
const loadmsg=document.getElementById('loadmsg');
const bootStarted=performance.now();
const bootTimings=window.GT_BOOT_TIMINGS={startedAt:+bootStarted.toFixed(1),stages:{}};
function markBootStage(name,started){
  bootTimings.stages[name]=+(performance.now()-started).toFixed(1);
}
function deferBootWork(fn){
  return new Promise(resolve=>{
    const run=()=>Promise.resolve().then(fn).then(resolve,err=>{
      console.info('[boot] deferred consumer unavailable.',err&&err.message||err);
      resolve();
    });
    if(typeof requestIdleCallback==='function') requestIdleCallback(run,{timeout:250});
    else setTimeout(run,0);
  });
}

function publishTransportSurface(){
  const ts=window.transportSurface;
  if(!ts) return;
  ts.beginUpdate();
  ts.clear();
  try{
  if(roadRibbon){
    const ordinal={};
    for(const run of roadRibbon._ways||[]){
      const mesh=roadRibbon.meshes&&roadRibbon.meshes[run.cls],pos=mesh&&mesh.geometry.attributes.position;
      const normal=mesh&&mesh.geometry.attributes.normal;
      if(!pos) continue;
      const sections=[];
      for(let q=0;q<run.n;q++){
        const section=[],base=run.v0+q*run.stride;
        for(let c=0;c<run.stride;c++){
          const v=base+c;
          section.push({x:pos.getX(v),y:pos.getY(v),z:pos.getZ(v),
            nx:normal&&normal.getX(v),ny:normal&&normal.getY(v),nz:normal&&normal.getZ(v),
            _sourcePosition:pos,_sourceNormal:normal,_sourceIndex:v});
        }
        sections.push(section);
      }
      const n=ordinal[run.cls]=(ordinal[run.cls]||0)+1;
      const options={classification:run.cls,halfWidth:run.cfg.w*.5,
        featureId:run.featureId||`osm-${run.cls}-${n}`,name:run.name||null,
        structureId:run.tags&&run.tags.bridge==='yes'?`${run.featureId}:bridge`:null};
      const taggedSpeed=run.tags&&Number.parseFloat(run.tags.maxspeed);
      if(taggedSpeed>0) options.speedLimit=/mph/i.test(run.tags.maxspeed)?taggedSpeed*.44704:taggedSpeed/3.6;
      ts.addStrip(sections,options);
    }
    // Junction query geometry is exactly the rendered fan index/position data. This
    // prevents terrain fallback at mouths and preserves priority-road ownership.
    for(const fan of roadRibbon._fans||[]){
      const mesh=roadRibbon.meshes&&roadRibbon.meshes[fan.cls],pos=mesh&&mesh.geometry.attributes.position;
      const normal=mesh&&mesh.geometry.attributes.normal;
      if(!pos) continue;
      const point=v=>({x:pos.getX(v),y:pos.getY(v),z:pos.getZ(v),
        nx:normal&&normal.getX(v),ny:normal&&normal.getY(v),nz:normal&&normal.getZ(v),
        _sourcePosition:pos,_sourceNormal:normal,_sourceIndex:v}),triangles=[];
      for(let k=0;k<fan.count-1;k++){
        const k1=(k+1)%(fan.count-1);
        triangles.push([point(fan.v0),point(fan.v0+1+k1),point(fan.v0+1+k)]);
      }
      const junctionHalfWidth={highway:4.5,park_paved:3.75,gravel:2.5,track:1.5}[fan.cls]||3;
      ts.addPatch(triangles,{classification:fan.cls,halfWidth:junctionHalfWidth,
        featureId:`junction:${fan.nx.toFixed(2)}:${fan.nz.toFixed(2)}`,junction:true});
    }
  }
  if(trailBuilder&&trailBuilder.mesh){
    const pos=trailBuilder.mesh.geometry.attributes.position;
    const normal=trailBuilder.mesh.geometry.attributes.normal;
    let n=0;
    for(const trail of trailBuilder._trails||[]){
      const sections=[];
      for(let q=0;q<trail.n;q++){
        const section=[],base=trail.v0+q*trail.stride;
        // Natural disturbed margins are visual terrain-convergence geometry, not walking
        // authority. Publish the exact three rendered tread rows; structures publish all rows.
        const c0=trail.structureKind?0:trail.treadLeft;
        const c1=trail.structureKind?trail.stride-1:trail.treadRight;
        for(let c=c0;c<=c1;c++){
          const v=base+c;
          section.push({x:pos.getX(v),y:pos.getY(v),z:pos.getZ(v),
            nx:normal&&normal.getX(v),ny:normal&&normal.getY(v),nz:normal&&normal.getZ(v),
            _sourcePosition:pos,_sourceNormal:normal,_sourceIndex:v});
        }
        sections.push(section);
      }
      const classification=trail.classification||'trail';
      const defaultWidth=classification==='primitive_trail'?.4:classification==='steps'?.75:
        classification==='boardwalk'?1:.6;
      const taggedWidth=trail.tags&&Number.parseFloat(trail.tags.width);
      ts.addStrip(sections,{classification,halfWidth:(taggedWidth>0?taggedWidth*.5:defaultWidth),
        featureId:trail.featureId||`osm-trail-${++n}`,name:trail.name||null,
        structureId:trail.tags&&trail.tags.bridge==='yes'?`${trail.featureId}:footbridge`:null});
    }
  }
  }finally{ ts.endUpdate(); }
  window.roadQuery=(x,z)=>{
    const out={};
    if(!ts.nearest(x,z,128,null,out)) return {dist:1e9,class:null,name:null};
    const cls=out.kind==='major_highway'?'highway':out.kind==='park_paved_road'?'park_paved':
      out.kind==='gravel_road'?'gravel':out.vehicleAllowed?'track':'trail';
    return {dist:out.distance,class:cls,name:null,featureId:out.featureId,
      vehicleAllowed:out.vehicleAllowed,pedestrianAllowed:out.pedestrianAllowed};
  };
  window.dispatchEvent(new CustomEvent('transport-surface-ready',{detail:ts.snapshot()}));
  const wi=window.GT_APP&&window.GT_APP.worldIndex;
  if(wi){
    const install=()=>wi.installTransportSnapshot(ts.snapshot())
      .catch(e=>console.info('[transport] worker snapshot unavailable',e&&e.message||e));
    if(wi.ready) install(); else wi.initialized&&wi.initialized.then(install);
  }
}
let transportPublishTimer=0;
function scheduleTransportPublish(){
  clearTimeout(transportPublishTimer);
  transportPublishTimer=setTimeout(()=>{
    if((roadRibbon&&roadRibbon._pass)||(trailBuilder&&trailBuilder._pass)){
      scheduleTransportPublish();return;
    }
    const ts=window.transportSurface;
    if(ts&&ts.syncAuthoredGeometry()){
      window.dispatchEvent(new CustomEvent('transport-surface-ready',{detail:ts.snapshot()}));
    }
  },100);
}
window.addEventListener('transport-geometry-updated',scheduleTransportPublish);

// Procedural fallback stages (used when real terrain tiles aren't available).
const proceduralStages=[
  ['Carving the Teton fault block…', buildTerrain],
  ['Anchoring the island…', buildUnderside],
  ['Filling Jenny & Jackson Lakes…', buildWater],
  ['Planting the lodgepole forests…', buildForest],
  ['Naming the summits…', buildLabels],
];

/* Local dev serves tiles from ./terrain/public, but a fresh clone has no baked pyramid
 * (~483 MB, hosted on R2 — see DEPLOY.md), so every tile request would 404 and the world
 * would come up empty. Probe the z0 root tile once and, if it is absent, stream from R2
 * instead. Costs one request when tiles ARE present, and makes `git clone && npm run dev`
 * work with no setup. `node scripts/dev-setup.mjs` is the offline alternative.
 * Skipped when ?tiles= was given explicitly, so forcing local stays forced. */
async function resolveTileSource(){
  if(window.GT_TILE_CDN || window.GT_TILE_EXPLICIT || !window.GT_TILE_R2) return;
  try{
    const probe=await fetch('terrain/public/tiles/0/0/0.webp',{method:'HEAD'});
    if(probe.ok) return;                            // local pyramid present — keep it
  }catch(e){ return; }                              // file:// or offline — procedural fallback
  window.GT_TILE_CDN=window.GT_TILE_R2;
  console.info('[tiles] no local pyramid — streaming from R2. Run `node scripts/dev-setup.mjs` for offline dev.');
}

async function boot(){
  let landcover=null;
  // CPU-side road sampler for drive-mode grip + HUD (independent of terrain; safe if missing)
  buildRoadIndex().catch(e=>console.info('[roads] index unavailable', e&&e.message||e));
  // Must settle BEFORE TerrainStreamer.init() reads the manifests and starts streaming.
  await resolveTileSource();
  // 1) Try real USGS terrain (base-only). Needs http:// serving + a generated terrain/public/tiles.json.
  if(window.TerrainStreamer){
    try{
      const started=performance.now();
      loadmsg.textContent='Loading USGS elevation…';
      const t=new TerrainStreamer({ scene, camera, renderer, manifestUrl:TERRAIN_MANIFEST,
                                    sun:SUN_DIR, sunColor:SUN_COLOR, sunAngles:SUN_ANGLES,
                                    ambient:AMB_COLOR });
      await t.init();
      terrain=t;
      window.GT_terrain=t;
      // Settings loads after boot starts. Reconcile with its current persisted/query preset once
      // available; 96-settings also calls this directly on every subsequent quality change.
      if(typeof window.GT_qualityInfo==='function') t.setQuality(window.GT_qualityInfo().current);
      markBootStage('terrain',started);
    }catch(err){
      terrain=null;
      console.info('[terrain] real terrain unavailable — using procedural world.', err && err.message||err);
    }
  }

  // 2) Build the world.
  if(terrain){
    // Real geometry + collision from the streamer; procedural mesh/underside skipped.
    // Real water & forests from the baked NLCD/NHD landcover mask, if it's been generated.
    if(window.Landcover){
      try{
        const started=performance.now();
        loadmsg.textContent='Reading NLCD landcover & NHD water…';
        landcover=await new Landcover(LANDCOVER_MANIFEST).init();
        waterBuilder=new WaterBuilder({scene, terrain, landcover, sun:SUN_DIR, sunColor:SUN_COLOR, ambient:AMB_COLOR, fog:scene.fog}).build();
        // Public settings hook: keep this as the sole window reference to the lexical instance.
        // Applying now covers a persisted low/balanced preset before the asynchronous water bake
        // finishes; 96-settings also retains its deferred fallback for slow boot paths.
        window.GT_waterBuilder=waterBuilder;
        if(typeof window.GT_applyQuality==='function') window.GT_applyQuality();
        waterMat=waterBuilder.material;              // main loop drives uTime
        markBootStage('landcoverWater',started);
      }catch(err){
        console.info('[landcover] not available — bare terrain only.', err && err.message||err);
      }
    }
    // bridges (M6): DETECT water crossings BEFORE the ribbons so the ribbon can grade its ONE profile
    // up to clear the water (bridgeFloor). detect() awaits the water bake. Deck geometry is built
    // AFTER, reading the finished running surface. See BridgeBuilder — no independent deck datum.
    if(window.BridgeBuilder){
      try{
        const started=performance.now();
        loadmsg.textContent='Spanning the Snake River crossings…';
        bridgeBuilder=await new BridgeBuilder({scene, terrain, sampleGround, water:waterBuilder,
          roadsUrl:'terrain/public/roads.json'}).detect();
        markBootStage('bridgesDetect',started);
      }catch(err){ console.info('[bridges] detect unavailable.', err && err.message||err); }
    }
    // real ribbon roads draped on the terrain (graceful skip if roads.json / module absent)
    if(window.RoadRibbon){
      try{
        const started=performance.now();
        loadmsg.textContent='Paving Teton Park Road…';
        roadRibbon=await new RoadRibbon({scene,camera, sampleGround, terrain, roadsUrl:'terrain/public/roads.json',
          bridgeFloor: bridgeBuilder && bridgeBuilder.bridgeFloor,
          sun:SUN_DIR, sunColor:SUN_COLOR, ambient:AMB_COLOR, fog:scene.fog}).build();
        markBootStage('roads',started);
      }catch(err){ console.info('[roads] ribbons unavailable.', err && err.message||err); }
    }
    // decks/parapets/piers built AFTER the ribbon so the deck top ≡ the finished running surface
    if(bridgeBuilder){ try{ bridgeBuilder.build(roadRibbon); }catch(err){ console.info('[bridges] build failed.', err && err.message||err); } }
    // The park's foot trails draped as thin dirt tread. Complete this before publishing the
    // authoritative surface so walking and exclusion consumers never observe a partial network.
    if(window.TrailBuilder){
      try{
        const started=performance.now();
        loadmsg.textContent='Treading the Jenny Lake & Cascade trails…';
        trailBuilder=await new TrailBuilder({scene,camera,sampleGround,terrain,
          roadDetails:roadRibbon&&roadRibbon._detailRecords,
          trailsUrl:'terrain/public/trails.json',
          sun:SUN_DIR, sunColor:SUN_COLOR, ambient:AMB_COLOR, fog:scene.fog}).build();
        markBootStage('trails',started);
      }catch(err){ console.info('[trails] unavailable.', err && err.message||err); }
    }
    publishTransportSurface();
    loadmsg.textContent='Trailhead ready — real USGS terrain.';
  }else{
    for(const [msg,fn] of proceduralStages){
      loadmsg.textContent=msg;
      await new Promise(r=>setTimeout(r,30));
      fn();
    }
    if(window.RoadRibbon){
      try{ roadRibbon=await new RoadRibbon({scene,camera, sampleGround, roadsUrl:'terrain/public/roads.json',
        sun:SUN_DIR, sunColor:SUN_COLOR, ambient:AMB_COLOR, fog:scene.fog}).build(); }
      catch(err){ console.info('[roads] ribbons unavailable.', err && err.message||err); }
    }
    if(window.SignBuilder){ try{ signBuilder=await new SignBuilder({scene, sampleGround,transportSurface:window.transportSurface}).build(); }catch(err){ console.info('[signs] unavailable.', err && err.message||err); } }
    if(window.TrailBuilder){
      try{ trailBuilder=await new TrailBuilder({scene,camera,sampleGround,
        roadDetails:roadRibbon&&roadRibbon._detailRecords,trailsUrl:'terrain/public/trails.json',
        sun:SUN_DIR, sunColor:SUN_COLOR, ambient:AMB_COLOR, fog:scene.fog}).build(); }
      catch(err){ console.info('[trails] unavailable.', err && err.message||err); }
    }
    publishTransportSurface();
    loadmsg.textContent='Trail ready — Cathedral Group ahead.';
  }
  respawn();
  ready=true;
  window.GT_READY_MS=+performance.now().toFixed(1);
  bootTimings.critical=+(performance.now()-bootStarted).toFixed(1);
  window.dispatchEvent(new CustomEvent('gt-ready',{detail:bootTimings}));

  // Everything below consumes the final authoritative transport snapshot but is not needed for
  // movement or the first responsive frame. Keeping it beyond `ready` removes large vegetation
  // downloads/bucketing and decorative OSM consumers from the interaction critical path.
  const optionalStarted=performance.now();
  const deferred=[];
  if(terrain&&landcover){
    deferred.push(deferBootWork(async()=>{
      const started=performance.now();
      if(window.ScatterManager) scatter=await new ScatterManager({
        scene,terrain,landcover,water:waterBuilder}).init();
      if(window.GroundCover) groundCover=new GroundCover({
        scene,camera,terrain,landcover,water:waterBuilder});
      if(window.PropScatter&&!/[?&]noprops/.test(location.search)) propScatter=
        new PropScatter({scene,terrain,landcover,water:waterBuilder}).init();
      if(window.WildlifeManager&&!/[?&]nowild/.test(location.search)) wildlife=
        new WildlifeManager({scene,terrain,landcover,water:waterBuilder}).init();
      markBootStage('natureConsumers',started);
    }));
    deferred.push(deferBootWork(async()=>{
      const started=performance.now();
      const tasks=[];
      // Which footprints a landmark model replaces comes from landmarks.json,
      // so adding a landmark does not also mean editing a list here and
      // leaving a generic extrusion standing inside the new model.
      const replacementNames=await fetch('terrain/public/landmarks.json')
        .then(r=>r.json())
        .then(d=>(d.landmarks||[]).map(l=>l.footprintName||l.name).filter(Boolean))
        .catch(()=>['T. A. Moulton Barn']);
      if(window.BuildingManager) tasks.push(new BuildingManager({
        scene,terrain,sampleGround,transportSurface:window.transportSurface,
        url:'terrain/public/buildings.json',
        replacementNames}).build().then(v=>{ buildingMgr=v; }));
      if(window.LandmarkManager&&!/[?&]nolandmarks/.test(location.search)) tasks.push(
        new LandmarkManager({scene,camera,terrain,sampleGround,
          url:'terrain/public/landmarks.json'}).build().then(v=>{ landmarkMgr=v; }));
      tasks.push(fetch('terrain/public/labels.json').then(r=>r.json()).then(ld=>{
        initRealLabels(ld);
        Minimap.init(terrain); Minimap.setLabels(realLabels.list);
        HeldMap.init(terrain); HeldMap.setLabels(realLabels.list);
      }));
      if(window.SignBuilder) tasks.push(new SignBuilder({
        scene,terrain,sampleGround,transportSurface:window.transportSurface
      }).build().then(v=>{ signBuilder=v; }));
      await Promise.allSettled(tasks);
      markBootStage('mapBuiltConsumers',started);
    }));
  }
  window.GT_OPTIONAL_READY=Promise.all(deferred).then(()=>{
    bootTimings.optional=+(performance.now()-optionalStarted).toFixed(1);
    window.dispatchEvent(new CustomEvent('gt-optional-ready',{detail:bootTimings}));
  });
  // Automated certification still waits for the complete visual world; interactive users do not.
  if(AUTO) window.GT_OPTIONAL_READY.then(()=>runAuto()).catch(err=>{
    const message=String(err && (err.stack||err.message)||err).slice(0,1200);
    console.error('[auto]',message);
    // Bypass postShot's intentional error gate so a failed automation run leaves a diagnostic
    // sidecar instead of only timing out with Chrome's console hidden.
    renderer.domElement.toBlob(blob=>{
      if(!blob) return;
      const meta=Object.assign(captureMeta('automation-failure'),{autoFailure:message});
      fetch('/shot?meta='+encodeURIComponent(JSON.stringify(meta)),{method:'POST',body:blob});
    },'image/png');
  });
}
boot();

const clock=new THREE.Clock();
const statsEl=document.getElementById('stats');
const uw=document.getElementById('underwater');
let statTick=0, mmAcc=0;
// live perf meter: raw frame interval (NOT the physics-clamped dt), EMA + worst-of-window
const perf={ ms:16.7, worst:16.7, _last:performance.now() };
function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),0.05);
  { const now=performance.now(), raw=now-perf._last; perf._last=now;
    if(raw>0&&raw<1000){ perf.ms+=(raw-perf.ms)*0.12; perf.worst=Math.max(perf.worst*0.96, raw);
      window.GT_FRAME_MS=perf.ms; } }
  if(ready){
    step(dt);
    // Publish the new sun/hemi/ambient state before any manager updates material state. Rendering
    // happened later already, but this ordering also prevents manager-side uniform copies and
    // newly compiled vegetation materials from observing the preceding TOD frame.
    if(day.play){ day.t=(day.t+dt/300)%1; updateSun(); }   // full 24 h in ~5 min
    if(terrain){ updateTerrainPrediction(dt); terrain.update(); } // render now + warm predicted view
    if(scatter) scatter.update(camera.position, camera);  // stream forest + prioritize visible close detail
    if(groundCover) groundCover.update(camera.position); // near-field grass & sage carpet
    if(propScatter) propScatter.update(camera.position); // sparse boulders/deadfall/fence props
    if(wildlife) wildlife.update(camera.position, dt);    // habitat-placed animal herds (wander + LOD)
    // Surface refinements are individually amortized, but overlapping road + trail + water work
    // can still exceed the Accessible frame floor. Serialize them without changing their output.
    if(!(waterBuilder&&waterBuilder._refining)){
      if(roadRibbon&&roadRibbon._pass) roadRibbon.update();
      else if(trailBuilder&&trailBuilder._pass) trailBuilder.update();
      else if(((window.GT_TRANSPORT_UPDATE_PHASE=(window.GT_TRANSPORT_UPDATE_PHASE||0)+1)&1)){
        if(roadRibbon) roadRibbon.update();
      }else if(trailBuilder) trailBuilder.update();
    }
    if(buildingMgr) buildingMgr.update();         // re-base buildings onto finer streamed height
    if(landmarkMgr) landmarkMgr.update();         // switch landmark LOD and re-base after streaming
    if(realLabels.ready) updateRealLabels(dt);     // real-terrain place names (declutter + fade)
    if(Minimap.isActive() && (mmAcc+=dt)>0.1){ mmAcc=0; Minimap.draw(); } // ~10 Hz, skips when hidden
    HeldMap.update(dt);                             // held paper map (N): ease raise + repaint live pin
    // A static clock produces one initial sky-only capture.  Thereafter the manager rebakes only
    // after a material time change (or an explicit scrub), never as a per-frame render pass.
    // Transport cells pick their LOD and emit their visible index runs here, once per frame with
    // the main camera — not implicitly per render pass as the old THREE.LOD nodes did.
    if(roadRibbon&&roadRibbon.updateRenderCells) roadRibbon.updateRenderCells(camera);
    if(trailBuilder&&trailBuilder.updateRenderCells) trailBuilder.updateRenderCells(camera);
    skyEnvironment.update();
    skyUniforms.uTime.value+=dt;
    if(waterMat) waterMat.uniforms.uTime.value+=dt;
    sky.position.copy(camera.position);
    let under=false;
    if(terrain){
      const sy=waterBuilder && waterBuilder.surfaceAt(camera.position.x,camera.position.z);
      under = sy!==null && sy!==undefined && camera.position.y < sy;
    }else{
      under = camera.position.y < WATER_Y+0.4 &&
        sampleGround(camera.position.x,camera.position.z) < WATER_Y;
    }
    uw.style.display = under ? 'block':'none';
    if((statTick+=dt)>0.2){
      statTick=0;
      // real terrain: true elevation (datum + metres) in feet; procedural: playful conversion
      const alt = terrain ? Math.round((terrain.datum + camera.position.y)*3.281)
                          : Math.round(6200+camera.position.y*1.8);
      const fps=Math.round(1000/perf.ms);
      const driveHud=drive.on?(Math.round(Math.abs(drive.speed)*2.237)+' mph · '+
        (vehiclePhysicsState?vehiclePhysicsState.gear:'D')+' · '+
        (vehiclePhysicsState?vehiclePhysicsState.surface:'terrain')+
        (drive.roadName?' · '+drive.roadName:'')):'';
      statsEl.innerHTML=`${fps} fps · ${perf.ms.toFixed(1)} ms · ${renderer.info.render.calls} calls<br>ALT ${alt.toLocaleString()} ft · ${clockLabel()}${day.play?' ▸':''}<br>${drive.on?driveHud:state.fly?'soaring':'on foot'}`;
    }
  }
  // Reflection PRE-PASS: render the planar mirror once, before the main scene render, rather than
  // nested inside a water mesh's onBeforeRender. The nested (re-entrant) render intermittently
  // produced an empty mirror under load; a top-of-frame pre-pass is non-re-entrant and robust.
  if(ready && waterBuilder){ camera.updateMatrixWorld(); waterBuilder._reflectPass(renderer, camera); }
  if(postFX && postFX.enabled){ postFX.render(scene,camera); }
  else { renderer.setRenderTarget(null); renderer.render(scene,camera); }
  if(ready) HeldMap.render(renderer);              // held paper map (N): depth-cleared overlay pass, LAST
}
animate();

addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});
addEventListener('beforeunload',()=>skyEnvironment.dispose());
