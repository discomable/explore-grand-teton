'use strict';
/* 86-capture.js — toast + POST screenshot with camera/render metadata to serve.py.
   DECLARES: toastEl, toastTimer, toast, captureMeta, postShot, saveShot.
   CONSUMES: renderer/scene/camera (20), state (80), day (30), terrain (40), PAGE_ERRS (00). */
/* ——— P: save a versioned screenshot (+ camera metadata) into shots/ for review ——— */
const toastEl=document.getElementById('toast');
let toastTimer=null;
const CAPTURE_FAILED_REQUESTS=[];
function captureRequestFailure(url, detail){
  if(CAPTURE_FAILED_REQUESTS.length<16)
    CAPTURE_FAILED_REQUESTS.push({url:String(url).slice(0,500), detail:String(detail).slice(0,300)});
}
// Fetches initiated after the capture subsystem loads include terrain streams and capture uploads.
// Keep their failures in the sidecar instead of losing the request-level diagnostic in DevTools.
{ const _fetch=window.fetch.bind(window);
  window.fetch=async function(...args){
    const url=args[0] instanceof Request?args[0].url:args[0];
    try{
      const response=await _fetch(...args);
      if(!response.ok) captureRequestFailure(url, response.status+' '+response.statusText);
      return response;
    }catch(err){
      // Terrain streaming deliberately aborts stale imagery requests after a camera move. That is
      // successful cancellation, not a failed required request.
      if(!(err&&err.name==='AbortError')) captureRequestFailure(url, err);
      throw err;
    }
  };
}
function captureMeta(name){
  const params=new URLSearchParams(location.search);
  const applicationReady=typeof ready!=='undefined' && ready===true;
  const consoleErrors=PAGE_ERRS.slice();
  const gl=typeof renderer!=='undefined' ? renderer.getContext() : null;
  const debug=gl && gl.getExtension('WEBGL_debug_renderer_info');
  const sceneBreakdown=[];
  if(typeof scene!=='undefined'&&scene) for(const root of scene.children){
    let draws=0,triangles=0,objects=0;
    root.traverse?.(object=>{
      if(!object.visible||!object.geometry||!object.material) return;
      const index=object.geometry.index,position=object.geometry.attributes?.position;
      const base=index?index.count/3:(position?position.count/3:0);
      const instances=object.isInstancedMesh?object.count||0:1;
      draws+=Array.isArray(object.material)?object.material.length:1;
      triangles+=base*instances; objects++;
    });
    if(draws||triangles) sceneBreakdown.push({
      name:root.name||root.type,draws,objects,triangles:Math.round(triangles)
    });
  }
  sceneBreakdown.sort((a,b)=>b.triangles-a.triangles);
  const meta={
    browserVersion:params.get('captureBrowser')||navigator.userAgent,
    commitSha:params.get('captureCommit')||'unknown',
    worktreeDirty:params.get('captureDirty')==='1',
    viewport:{width:innerWidth, height:innerHeight, devicePixelRatio:devicePixelRatio},
    route:location.pathname,
    query:location.search,
    // Keep `errors` for existing screenshot tooling while exposing the more explicit name.
    errors:consoleErrors,
    consoleErrors,
    failedRequests:CAPTURE_FAILED_REQUESTS.slice(),
    applicationReady,
    visibleTerrainCoverage:terrain&&terrain.coverageSnapshot?
      terrain.coverageSnapshot():null,
    bootTimings:window.GT_BOOT_TIMINGS||null,
    headless:/HeadlessChrome/i.test(navigator.userAgent),
    hardwareConcurrency:navigator.hardwareConcurrency||null,
    deviceMemoryGB:navigator.deviceMemory||null,
    treeDetailCount:window.__TREE_DETAIL_COUNT==null?0:window.__TREE_DETAIL_COUNT,
    treeDetailCap:window.__TREE_DETAIL_CAP==null?0:window.__TREE_DETAIL_CAP,
    atlasClean:!/[?&]atlasclean=0(?:&|$)/.test(location.search),
    groundCover:!/[?&]groundcover=0(?:&|$)/.test(location.search),
    groundCoverV2:!/[?&]groundv2=0(?:&|$)/.test(location.search),
    groundCoverLod:!/[?&]grasslod=0(?:&|$)/.test(location.search),
    groundCoverCount:window.__GROUND_COVER_COUNT==null?0:window.__GROUND_COVER_COUNT,
    groundCoverCap:window.__GROUND_COVER_CAP==null?0:window.__GROUND_COVER_CAP,
    transport: {
      revision: window.transportSurface ? window.transportSurface.revision : 0,
      roads: typeof roadRibbon!=='undefined' && roadRibbon ? {...roadRibbon.stats} : null,
      trails: typeof trailBuilder!=='undefined' && trailBuilder ? {...trailBuilder.stats} : null,
      bridges: typeof bridgeBuilder!=='undefined' && bridgeBuilder ?
        bridgeBuilder.spans.map(span=>{
          const a=span.deckCl[0],b=span.deckCl[span.deckCl.length-1];
          return {class:span.cls,center:[(a.x+b.x)*.5,(a.z+b.z)*.5],
            start:[a.x,a.z],end:[b.x,b.z],deckY:span.deckY};
        }) : [],
    },
    sceneBreakdown:sceneBreakdown.slice(0,24),
    webgl:gl ? {
      version:gl.getParameter(gl.VERSION),
      shadingLanguageVersion:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),
      renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)
    } : null,
  };
  if(name) meta.name=name;
  return meta;
}
function captureFailure(meta){
  if(!meta.applicationReady) return 'application is not ready';
  if(meta.consoleErrors.length) return 'browser errors were reported';
  return null;
}
async function postShot(blob, name, extra={}){
  const meta=Object.assign(captureMeta(name), extra);
  const failure=captureFailure(meta);
  if(failure){ toast('shot failed — '+failure); return null; }
  try{
    const r=await fetch('/shot?meta='+encodeURIComponent(JSON.stringify(meta)),{method:'POST',body:blob});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j=await r.json();
    return j.name;
  }catch(err){ toast('shot failed — is serve.py running?'); return null; }
}
function toast(msg){
  toastEl.textContent=msg; toastEl.style.opacity=1;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.style.opacity=0, 2200);
}
function saveShot(name, extra={}){
  return new Promise(done=>{
    // render-cost probe: median CPU submit time over a short burst (deterministic A/B proxy;
    // it is submit time, not full GPU time, but tracks scene complexity for perf comparisons).
    // The final burst render doubles as the fresh capture buffer (no preserveDrawingBuffer).
    const ms=[];
    for(let i=0;i<32;i++){ const t=performance.now(); renderer.render(scene,camera); ms.push(performance.now()-t); }
    ms.sort((a,b)=>a-b);
    const renderMs=+ms[16].toFixed(2);
    renderer.domElement.toBlob(async b=>{
      if(!b){ toast('shot failed'); done(null); return; }
      const meta={ pos:camera.position.toArray().map(v=>+v.toFixed(1)),
                   yaw:+state.yaw.toFixed(3), pitch:+state.pitch.toFixed(3),
                   fly:state.fly, timeOfDay:+day.t.toFixed(3), realTerrain:!!terrain };
      const sceneInfo=postFX && postFX.lastSceneInfo;
      meta.calls=sceneInfo?sceneInfo.calls:renderer.info.render.calls;
      meta.tris=sceneInfo?sceneInfo.triangles:renderer.info.render.triangles;
      meta.renderMs=renderMs;
      meta.geometries=renderer.info.memory.geometries;
      meta.textures=renderer.info.memory.textures;
      meta.quality=window.GT_qualityInfo ? window.GT_qualityInfo().current : 'unknown';
      meta.weather=+(window.WEATHER==null?0:window.WEATHER).toFixed(3);
      meta.season=+(window.SEASON==null?0:window.SEASON).toFixed(3);
      meta.experimentalPoc=/[?&]poc(?:&|$)/.test(location.search);
      meta.foliage3d=/[?&]foliage3d(?:&|$)/.test(location.search);
      meta.landmarkDraftRun=landmarkMgr&&landmarkMgr.draftRun||null;
      meta.coldStartInteractiveMs=window.GT_READY_MS||null;
      meta.gpuMs=terrain && terrain.gpuMs!=null ? +terrain.gpuMs.toFixed(2) : null;
      meta.gpuTimerBackend=terrain ? terrain.gpuBackend : null;
      meta.exposure=+(window.TETON_EXPOSURE_CURRENT||renderer.toneMappingExposure||1).toFixed(3);
      meta.renderPipeline=postFX ? Object.assign({enabled:true},postFX.status) :
        {enabled:false,hdr:false,targetType:'default-framebuffer',toneMapping:'three-aces',outputEncoding:'srgb'};
      meta.terrainCache=terrain ? terrain.memorySnapshot() : null;
      if(performance.memory) meta.jsHeapMB=+(performance.memory.usedJSHeapSize/1048576).toFixed(1);
      Object.assign(meta,extra);
      const saved=await postShot(b,name,meta);
      if(saved) toast('saved shots/'+saved);
      done(saved);
    },'image/png');
  });
}
