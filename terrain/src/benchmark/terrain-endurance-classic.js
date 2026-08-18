'use strict';
/* Local-only pathological terrain movement certification. Loaded only for ?terrainEndurance=1.
   It moves the benchmark camera directly through deterministic poses; renderer quality, terrain
   LOD, shaders, movement physics, and streaming policy remain untouched. */
(async function runTerrainEndurance(){
  const params=new URLSearchParams(location.search);
  if(params.get('terrainEndurance')!=='1') return;
  const {buildTerrainEnduranceReport,requestRates}=await import('./aggregation.js');
  const manifest=await (await fetch('terrain-endurance-routes.json')).json();
  if(manifest.schema!=='grand-teton-terrain-endurance-routes/v1'||manifest.version!==1)
    throw new Error('unsupported terrain endurance route manifest');
  const tilesManifest=await (await fetch('terrain/public/tiles.json')).json();
  for(const route of manifest.routes) if(route.kind==='tile-boundary'&&!route.boundary){
    const extent=(route.axis==='x'?tilesManifest.width:tilesManifest.height)*
      tilesManifest.geoTransform[1];
    const rootSpan=tilesManifest.tileSize*Math.pow(2,tilesManifest.maxZoom)*
      tilesManifest.geoTransform[1];
    route.boundary={axis:route.axis,zoom:route.zoom,boundaryIndex:route.boundaryIndex,
      coordinate:-extent/2+route.boundaryIndex*rootSpan/Math.pow(2,route.zoom),
      startAlong:route.startAlong||0,tileSpan:rootSpan/Math.pow(2,route.zoom)};
  }
  const selected=new Set((params.get('enduranceRoutes')||'').split(',').filter(Boolean));
  const routes=selected.size?manifest.routes.filter(route=>selected.has(route.id)):manifest.routes;
  if(!routes.length||routes.length!==selected.size&&selected.size)
    throw new Error('terrain endurance route selection is invalid');

  window.GT_TERRAIN_ENDURANCE_STATUS={state:'waiting'};
  await until(()=>typeof ready!=='undefined'&&ready&&typeof terrain!=='undefined'&&terrain,120000);
  overlay?.classList?.add('hidden');
  if(typeof realLabels!=='undefined'&&realLabels){realLabels.on=false;labelGroup.visible=false;}
  if(drive.on){drive.on=false;updateMode();}
  state.fly=true;state.vel.set(0,0,0);
  terrain.showGpuMs(true);

  let contextLosses=0;
  renderer.domElement.addEventListener('webglcontextlost',()=>contextLosses++);
  const scenarios=[];
  for(let repetition=1;repetition<=manifest.repetitions;repetition++){
    for(const route of routes){
      window.GT_TERRAIN_ENDURANCE_STATUS={state:'prewarming',route:route.id,repetition};
      applyPose(route,0);
      const prewarm=await waitForTerrainIdle(30000);
      if(!prewarm.settled) console.warn('[terrain-endurance] prewarm did not settle',route.id);
      window.GT_TERRAIN_ENDURANCE_STATUS={state:'running',route:route.id,repetition};
      const scenario=await measureScenario(route,repetition,manifest.telemetryHz,requestRates);
      window.GT_TERRAIN_ENDURANCE_STATUS={state:'settling',route:route.id,repetition};
      scenario.prewarm=prewarm;
      scenario.settle=await waitForTerrainIdle(30000);
      scenario.settled=settledMemory();
      scenario.phases.push({name:'settled',atMs:scenario.durationMs+scenario.settle.elapsedMs});
      scenarios.push(scenario);
    }
  }
  const browserErrors=typeof PAGE_ERRS!=='undefined'?PAGE_ERRS.slice():[];
  const failedRequests=typeof CAPTURE_FAILED_REQUESTS!=='undefined'?
    CAPTURE_FAILED_REQUESTS.slice():[];
  const report=buildTerrainEnduranceReport({
    scenarios,browserErrors,failedRequests,contextLosses,manifestVersion:manifest.version,
    environment:{
      userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency||null,
      deviceMemoryGB:navigator.deviceMemory||null,devicePixelRatio,
      viewport:{width:innerWidth,height:innerHeight},threeRevision:THREE.REVISION,
      quality:window.GT_STREAMING?.quality||null,
      timerBackend:window.GT_STREAMING?.timer?.backend||terrain.gpuBackend||'uninitialized',
      routeIds:routes.map(route=>route.id),repetitions:manifest.repetitions,
      telemetryHz:manifest.telemetryHz,
      genericMeshRoots:Object.keys(window.GT_RENDER_BREAKDOWN?.main?.roots||{})
        .filter(name=>name==='Mesh'),
    },
  });
  window.GT_TERRAIN_ENDURANCE_REPORT=report;
  window.GT_TERRAIN_ENDURANCE_STATUS={state:'uploading',report};
  const response=await fetch('/terrain-endurance',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
  if(!response.ok) throw new Error('terrain endurance report upload failed: HTTP '+response.status);
  window.GT_TERRAIN_ENDURANCE_STATUS={state:'complete',report};
  document.title=report.gate.passed?'TERRAIN_ENDURANCE_PASS':'TERRAIN_ENDURANCE_FAIL';

  async function measureScenario(route,repetition,telemetryHz,rateFn){
    const frames=new OnlineDurations(),gpu=new OnlineDurations(),spikes=[];
    const coverageFailures=[],capacityFailures=[],phases=[{name:'start',atMs:0}];
    const started=performance.now(),durationMs=route.durationSeconds*1000;
    let previous=started,lastTelemetry=-Infinity,lastGpuId=-1;
    let memoryPeak=0,warmOnlyPeak=0,trianglesPeak=0,leafPeak=0;
    let telemetrySamples=0,coverageFailureCount=0,capacityFailureCount=0;
    const startCounters=clone(window.GT_STREAMING?.requests?.total||{});
    const startLod=clone(terrain._lodStats||{});
    let finalCounters=startCounters;
    await new Promise((resolve,reject)=>{
      function frame(now){
        try{
          const elapsed=now-started;
          applyPose(route,Math.min(1,elapsed/durationMs));
          const delta=now-previous;previous=now;
          // No upper cutoff: the frameHang hard gate exists precisely for pathological stalls,
          // so a 6 s hang must land in the histogram and spike list rather than being discarded.
          if(delta>0){
            frames.add(delta);
            keepWorstLazy(spikes,delta,24,()=>({atMs:round(elapsed),durationMs:round(delta),
              streaming:cheapStreamingSnapshot()}));
          }
          const timer=terrain.gpuTimerSample;
          if(timer&&timer.id!==lastGpuId){lastGpuId=timer.id;gpu.add(timer.ms);}
          const frameCoverage=terrain.visibleTerrainCoverage;
          if(frameCoverage&&!frameCoverage.complete){
            coverageFailureCount++;
            if(coverageFailures.length<24) coverageFailures.push({atMs:round(elapsed),
              ratio:frameCoverage.ratio,missingLeaves:(frameCoverage.missingLeaves||[]).slice(0,8),
              sourceState:describeMissingSources(frameCoverage.missingLeaves||[])});
          }
          if(now-lastTelemetry>=1000/telemetryHz){
            lastTelemetry=now;telemetrySamples++;
            const stream=window.GT_STREAMING||{};
            const owned=stream.memory?.totalTerrainOwnedBytes||0;
            const warm=stream.ownership?.exclusive?.warmOnly?.totalBytes||0;
            memoryPeak=Math.max(memoryPeak,owned);warmOnlyPeak=Math.max(warmOnlyPeak,warm);
            trianglesPeak=Math.max(trianglesPeak,stream.lod?.terrainTriangles||0);
            leafPeak=Math.max(leafPeak,stream.lod?.leafCount||0);
            finalCounters=clone(stream.requests?.total||finalCounters);
            const retries=(finalCounters.capacityRetries||0)-(startCounters.capacityRetries||0);
            if(retries>capacityFailureCount){
              capacityFailureCount=retries;
              if(capacityFailures.length<24) capacityFailures.push({atMs:round(elapsed),retries});
            }
          }
          if(elapsed<durationMs) requestAnimationFrame(frame);else resolve();
        }catch(error){reject(error);}
      }
      requestAnimationFrame(frame);
    });
    const frameSummary=frames.summary();
    const counterDelta=rateFn(startCounters,finalCounters,durationMs).delta;
    const finalLod=terrain._lodStats||{};
    const lodSwaps=Math.max(0,(finalLod.cumulativeSwaps||0)-(startLod.cumulativeSwaps||0));
    return {id:route.id,kind:route.kind,repetition,durationMs:round(performance.now()-started),
      configuredDurationMs:durationMs,prewarmed:true,telemetrySamples,
      frames:frameSummary,gpu:gpu.count?{backend:'gpu-timer',...gpu.summary()}:
        {backend:terrain.gpuBackend==='gpu-timer'?'gpu-timer-unavailable':'cpu-fallback',count:0},
      worstFrameSpikes:spikes,coverageFailures,coverageFailureCount,
      capacityFailures,capacityFailureCount,counterDelta,
      rates:rateFn(startCounters,finalCounters,durationMs),
      lod:{swaps:lodSwaps,swapsPerFrame:frames.count?lodSwaps/frames.count:0,
        trianglesPeak,leafPeak,
        fallbackFrames:Math.max(0,(finalLod.fallbackFrames||0)-(startLod.fallbackFrames||0))},
      memory:{peakTerrainOwnedBytes:memoryPeak,peakWarmOnlyBytes:warmOnlyPeak},phases};
  }

  function applyPose(route,progress){
    const t=progress*route.durationSeconds;
    let x=0,z=0,agl=1200,yaw=0,pitch=-0.08;
    if(route.kind==='linear'){
      [x,agl,z]=route.origin;
      x+=route.heading[0]*route.speedMps*t;z+=route.heading[1]*route.speedMps*t;
      yaw=Math.atan2(-route.heading[0],-route.heading[1]);
    }else if(route.kind==='turns'){
      const leg=Math.floor(t/route.turnPeriodSeconds),phase=(t%route.turnPeriodSeconds);
      const direction=leg%2===0?1:-1;
      const distance=(leg%2===0?phase:route.turnPeriodSeconds-phase)*route.speedMps;
      [x,agl,z]=route.origin;x+=route.heading[0]*distance;z+=route.heading[1]*distance;
      yaw=Math.atan2(-route.heading[0]*direction,-route.heading[1]*direction);
    }else if(route.kind==='altitude-cycle'){
      [x,,z]=route.origin;
      const wave=(1-Math.cos(progress*Math.PI*2*route.cycles))/2;
      agl=route.minimumAglMeters+(route.maximumAglMeters-route.minimumAglMeters)*wave;
      yaw=2.2;
    }else if(route.kind==='teleports'){
      const index=Math.min(route.points.length-1,Math.floor(t/route.periodSeconds)%route.points.length);
      [x,z]=route.points[index];agl=route.altitudeAglMeters;yaw=(index*Math.PI*.73)%(Math.PI*2);
    }else if(route.kind==='rotation'){
      [x,agl,z]=route.origin;yaw=(t/route.rotationPeriodSeconds)*Math.PI*2;
    }else if(route.kind==='target'){
      const [ox,oy,oz]=route.origin,[tx,ty,tz]=route.target;
      const dx=tx-ox,dz=tz-oz,length=Math.hypot(dx,dz),distance=Math.min(length,route.speedMps*t);
      x=ox+dx/length*distance;z=oz+dz/length*distance;agl=oy+(ty-oy)*(distance/length);
      yaw=Math.atan2(-dx,-dz);
    }else if(route.kind==='tile-boundary'){
      const distance=route.speedMps*t,b=route.boundary;
      if(b.axis==='x'){x=b.coordinate;z=b.startAlong+distance;yaw=Math.PI;}
      else{x=b.startAlong+distance;z=b.coordinate;yaw=-Math.PI/2;}
      agl=route.altitudeAglMeters;
    }
    const ground=sampleGround(x,z);
    camera.position.set(x,ground+agl,z);state.yaw=yaw;state.pitch=pitch;
    state.fly=true;state.vel.set(0,0,0);
    camera.rotation.order='YXZ';camera.rotation.set(pitch,yaw,0);
  }

  async function waitForTerrainIdle(timeoutMs){
    const started=performance.now();let calmSince=null,final=cheapStreamingSnapshot();
    while(performance.now()-started<timeoutMs){
      await nextFrame();final=cheapStreamingSnapshot();
      if(final.idle){calmSince=calmSince??performance.now();if(performance.now()-calmSince>=1000)
        return {settled:true,elapsedMs:round(performance.now()-started),final};}
      else calmSince=null;
    }
    return {settled:false,elapsedMs:round(performance.now()-started),final};
  }
  function cheapStreamingSnapshot(){
    const stream=window.GT_STREAMING||{},workers=stream.workers||{},world=stream.worldIndex||{};
    const result={fetchActive:stream.fetchActive||0,fetchQueued:stream.fetchQueued||0,
      uploadQueued:stream.uploadQueued||0,workerQueued:workers.queued||0,
      workerRunning:workers.running||0,worldIndexPending:world.pending||0,
      coverageComplete:stream.visibleTerrainCoverage?.complete===true};
    result.idle=result.fetchActive===0&&result.fetchQueued===0&&result.uploadQueued===0&&
      result.workerQueued===0&&result.workerRunning===0&&result.worldIndexPending===0&&
      result.coverageComplete;
    return result;
  }
  function settledMemory(){
    const stream=window.GT_STREAMING||{};
    return {totalTerrainOwnedBytes:stream.memory?.totalTerrainOwnedBytes||0,
      residentTerrainBytes:stream.memory?.residentTerrainBytes||0,
      warmOnlyBytes:stream.ownership?.exclusive?.warmOnly?.totalBytes||0,
      memory:clone(stream.memory||{}),ownership:clone(stream.ownership||{}),
      requests:clone(stream.requests||{}),lod:clone(stream.lod||{})};
  }
  function describeMissingSources(keys){
    return keys.slice(0,8).map(key=>{
      let [z,x,y]=key.split('/').map(Number);const ancestors=[];
      for(;z>=0;z--,x>>=1,y>>=1){
        const source=terrain.hCache.get(`${z}/${x}/${y}`);
        ancestors.push({key:`${z}/${x}/${y}`,state:source?.state||'absent',
          layer:source?.layer??null,persistent:!!source?.persistent,
          decoded:!!source?.decoded,poolReady:!!terrain.arrayPool?.height?.getReady?.(source?.key,false)});
      }
      const mesh=terrain.meshes.get(key);
      return {key,mesh:mesh?{lastShown:mesh.lastShown,visible:!!mesh.mesh?.visible}:null,ancestors};
    });
  }
})().catch(error=>{
  const previousStatus=window.GT_TERRAIN_ENDURANCE_STATUS;
  window.GT_TERRAIN_ENDURANCE_STATUS={state:'failed',error:String(error?.stack||error),previousStatus};
  document.title='TERRAIN_ENDURANCE_ERROR';console.error('[terrain-endurance]',error);
  fetch('/terrain-endurance-error',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({schema:'grand-teton-terrain-endurance-error/v1',
      createdAt:new Date().toISOString(),error:String(error?.stack||error),
      status:window.GT_TERRAIN_ENDURANCE_STATUS})}).catch(()=>{});
});

class OnlineDurations{
  constructor(){this.count=0;this.total=0;this.min=Infinity;this.max=0;this.bins=new Uint32Array(5001);}
  add(value){if(!Number.isFinite(value)||value<0)return;this.count++;this.total+=value;
    this.min=Math.min(this.min,value);this.max=Math.max(this.max,value);
    this.bins[Math.min(5000,Math.floor(value))]++;}
  percentile(fraction){const target=Math.max(1,Math.ceil(this.count*fraction));let seen=0;
    for(let i=0;i<this.bins.length;i++){seen+=this.bins[i];if(seen>=target)return i;}return this.max;}
  summary(){const over=threshold=>{let count=0;for(let i=Math.floor(threshold)+1;i<this.bins.length;i++)count+=this.bins[i];return count;};
    return {count:this.count,meanMs:round(this.count?this.total/this.count:0),
      minMs:round(this.count?this.min:0),p50Ms:this.percentile(.5),p95Ms:this.percentile(.95),
      p99Ms:this.percentile(.99),maxMs:round(this.max),over16_7:over(16.7),over25:over(25),
      over40:over(40),over50:over(50),over100:over(100)};}
}
function keepWorstLazy(entries,durationMs,limit,makeEntry){
  if(entries.length>=limit&&durationMs<=entries[entries.length-1].durationMs)return;
  entries.push(makeEntry());entries.sort((a,b)=>b.durationMs-a.durationMs);
  if(entries.length>limit)entries.length=limit;
}
function nextFrame(){return new Promise(resolve=>requestAnimationFrame(resolve));}
function until(predicate,timeoutMs){const started=performance.now();return new Promise((resolve,reject)=>{
  const poll=()=>{if(predicate())resolve();else if(performance.now()-started>timeoutMs)
    reject(new Error('timed out waiting for application readiness'));else setTimeout(poll,100);};poll();});}
function clone(value){try{return structuredClone(value);}catch(_){return JSON.parse(JSON.stringify(value));}}
function round(value){return Math.round(value*1000)/1000;}
