'use strict';
/* Opt-in streaming benchmark. Loaded as a classic script only for ?benchmark=1 so it can
   exercise the same lexical controls as a player without adding production globals/hooks. */
(async function runStreamingBenchmark(){
  const params=new URLSearchParams(location.search);
  if(params.get('benchmark')!=='1') return;
  const {buildBenchmarkReport,captureRendererTelemetry}=await import('./aggregation.js');
  const scale=Math.max(0.1,Math.min(10,Number(params.get('benchmarkScale'))||1));
  const warmupMs=Math.max(0,Math.min(120000,Number(params.get('benchmarkWarmupMs'))||0));
  const idleTimeoutMs=Math.max(0,Math.min(120000,
    Number(params.get('benchmarkIdleTimeoutMs'))||30000));
  const telemetryNames=['GT_STREAMING','GT_VEGETATION_STREAMING','GT_GROUND_COVER_STREAMING'];
  const frames=[], longTasks=[], phases=[], telemetry=Object.fromEntries(telemetryNames.map(name=>[name,[]]));
  telemetry.RENDERER=[];
  let observer=null, previousFrame=performance.now(), sampling=true;

  window.GT_BENCHMARK_STATUS={state:'waiting',route:'forward-turn-teleport',scale};
  await until(()=>typeof ready!=='undefined'&&ready,120000);
  if(warmupMs){
    window.GT_BENCHMARK_STATUS={state:'warming',route:'forward-turn-teleport',scale,warmupMs};
    await new Promise(resolve=>setTimeout(resolve,warmupMs));
  }
  const startedAt=performance.now();
  window.GT_BENCHMARK_STATUS={state:'running',route:'forward-turn-teleport',scale,startedAt};

  if(typeof PerformanceObserver!=='undefined' &&
     PerformanceObserver.supportedEntryTypes?.includes('longtask')){
    observer=new PerformanceObserver(list=>{
      for(const entry of list.getEntries()) longTasks.push({startTime:entry.startTime,duration:entry.duration});
    });
    observer.observe({type:'longtask',buffered:true});
  }
  function sampleFrame(now){
    if(!sampling) return;
    const duration=now-previousFrame;
    previousFrame=now;
    if(duration>0&&duration<5000) frames.push(duration);
    for(const name of telemetryNames){
      const value=window[name];
      if(value) telemetry[name].push({atMs:now-startedAt,value:clone(value)});
    }
    telemetry.RENDERER.push({atMs:now-startedAt,value:captureRendererTelemetry(renderer)});
    requestAnimationFrame(sampleFrame);
  }
  requestAnimationFrame(now=>{ previousFrame=now; requestAnimationFrame(sampleFrame); });

  await phase('forward',6000*scale,()=>{
    state.keys.KeyW=true;
    state.keys.ShiftLeft=true;
  },()=>{ state.keys.KeyW=false; state.keys.ShiftLeft=false; });
  const startYaw=state.yaw;
  await phase('turn',3000*scale,null,null,progress=>{
    state.yaw=startYaw+Math.PI*smoothstep(progress);
    camera.rotation.y=state.yaw;
  });
  await phase('post-turn-forward',4000*scale,()=>{ state.keys.KeyW=true; },()=>{ state.keys.KeyW=false; });
  await phase('teleport-settle',8000*scale,()=>{
    const destination=FT_DESTS.find(item=>item.name==='Cascade Canyon')||FT_DESTS[2];
    fastTravel(destination);
  });
  const idleResult=await idlePhase(idleTimeoutMs);

  sampling=false;
  observer?.disconnect();
  const report=buildBenchmarkReport({
    startedAt,
    endedAt:performance.now(),
    frames,
    longTasks,
    telemetry,
    phases,
    environment:{
      userAgent:navigator.userAgent,
      hardwareConcurrency:navigator.hardwareConcurrency||null,
      devicePixelRatio:window.devicePixelRatio,
      viewport:{width:innerWidth,height:innerHeight},
      url:location.href,
      threeRevision:window.THREE?.REVISION||null,
      renderWorker:params.get('renderWorker')==='1',
      farPatches:params.get('farPatches')==='1',
      warmupMs,
      idleTimeoutMs,
      idleSettled:idleResult.settled,
      idleWaitMs:idleResult.elapsedMs,
      idleFinal:idleResult.final,
    },
  });
  window.GT_BENCHMARK_REPORT=report;
  window.GT_exportBenchmarkReport=()=>downloadReport(report);
  window.GT_BENCHMARK_STATUS={state:'complete',route:'forward-turn-teleport',scale,report};
  console.info('[benchmark] streaming route complete',report);
  dispatchEvent(new CustomEvent('gt:benchmark-complete',{detail:report}));
  if(params.get('benchmarkDownload')==='1') downloadReport(report);

  async function phase(name,durationMs,enter,leave,tick){
    const phaseStart=performance.now();
    enter?.();
    while(performance.now()-phaseStart<durationMs){
      tick?.(Math.min(1,(performance.now()-phaseStart)/durationMs));
      await nextFrame();
    }
    leave?.();
    phases.push({name,startedMs:phaseStart-startedAt,endedMs:performance.now()-startedAt});
  }
  async function idlePhase(timeoutMs){
    const phaseStart=performance.now();
    let final=idleSnapshot();
    while(timeoutMs>0 && !final.idle && performance.now()-phaseStart<timeoutMs){
      await nextFrame();
      final=idleSnapshot();
    }
    const elapsedMs=performance.now()-phaseStart;
    phases.push({name:'idle-settle',startedMs:phaseStart-startedAt,
      endedMs:performance.now()-startedAt,settled:final.idle,final});
    return {settled:final.idle,elapsedMs,final};
  }
})().catch(error=>{
  window.GT_BENCHMARK_STATUS={state:'failed',error:String(error?.stack||error)};
  console.error('[benchmark]',error);
});

function nextFrame(){ return new Promise(resolve=>requestAnimationFrame(resolve)); }
function smoothstep(value){ return value*value*(3-2*value); }
function clone(value){
  try{return structuredClone(value);}catch(_error){return JSON.parse(JSON.stringify(value));}
}
function idleSnapshot(){
  const terrain=window.GT_STREAMING||{};
  const workers=terrain.workers||{};
  const worldIndex=terrain.worldIndex||{};
  const vegetation=window.GT_VEGETATION_STREAMING||{};
  const ground=window.GT_GROUND_COVER_STREAMING||{};
  const final={
    terrainFetchActive:terrain.fetchActive||0,
    terrainFetchQueued:terrain.fetchQueued||0,
    terrainUploadQueued:terrain.uploadQueued||0,
    workerQueued:workers.queued||0,
    workerRunning:workers.running||0,
    worldIndexPending:worldIndex.pending||0,
    vegetationQueued:vegetation.queuedCells||0,
    vegetationCandidateJobs:vegetation.candidateJobs||0,
    vegetationSnapshotActive:vegetation.snapshotActiveCells||0,
    groundQueued:ground.queuedCells||0,
    groundPending:ground.pendingJobs||0,
    groundSampling:ground.samplingCells||0,
    groundWorldIndexSampling:ground.worldIndexSamplingCells||0,
  };
  final.idle=Object.values(final).every(value=>value===0);
  return final;
}
function until(predicate,timeoutMs){
  const started=performance.now();
  return new Promise((resolve,reject)=>{
    const poll=()=>{
      if(predicate()) resolve();
      else if(performance.now()-started>timeoutMs) reject(new Error('Timed out waiting for application readiness'));
      else setTimeout(poll,100);
    };
    poll();
  });
}
function downloadReport(report){
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
  const anchor=document.createElement('a');
  anchor.href=URL.createObjectURL(blob);
  anchor.download=`grand-teton-streaming-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(anchor.href),1000);
}
