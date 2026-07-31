'use strict';
/* 88-minimap.js — DOM 2D-canvas minimap module + minimap screenshot POST.
   DECLARES: Minimap, saveMinimapShot.
   CONSUMES: THREE (none directly), camera/drive/car/state (20/82/80), isTouch (84), toast (86). */
/* ============================================================
   MINIMAP — DOM 2D-canvas overlay (zero WebGL cost).
   Base = the app's own imagery tiles composited to world extent (north = top).
   Overlays (roads, player arrow + wedge, car, imp-1 names) at ~10 Hz, north-up.
   M cycles off → park overview → 3 km follow. Pure 2D; no per-frame allocation.
   ============================================================ */
const Minimap=(function(){
  const S=230;
  let cv=null, ctx=null, DPR=1, active=false, mode=1;
  const base=document.createElement('canvas'), bctx=base.getContext('2d');
  let baseReady=false, basePromise=null, roads=null, imp1=null;
  let spanX=0,spanZ=0,rootSpan=0,dataMinX=0,dataMinZ=0,dataMaxX=0,dataMaxZ=0,baseW=0,baseH=0;
  // draw-time transform + label-rect scratch (module-scoped — no per-frame allocation)
  let cx=0,cz=0,sc=1,ox=S/2,oy=S/2;
  const SX=x=>ox+(x-cx)*sc, SY=z=>oy+(z-cz)*sc;
  const _lr=new Float32Array(256);            // placed label boxes: x0,y0,x1,y1 ×64

  function roundRect(c,x,y,w,h,r){ c.beginPath();
    c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
    c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
  function tileBounds(z,x,y){ const s=rootSpan/Math.pow(2,z);
    return {minX:dataMinX+x*s, minZ:dataMinZ+y*s, s}; }
  function blit(img,tb){                              // draw a tile's data-overlap into base
    const aX=Math.max(tb.minX,dataMinX), bX=Math.min(tb.minX+tb.s,dataMaxX);
    const aZ=Math.max(tb.minZ,dataMinZ), bZ=Math.min(tb.minZ+tb.s,dataMaxZ);
    if(bX<=aX||bZ<=aZ) return;
    bctx.drawImage(img,
      (aX-tb.minX)/tb.s*img.width, (aZ-tb.minZ)/tb.s*img.height,
      (bX-aX)/tb.s*img.width,      (bZ-aZ)/tb.s*img.height,
      (aX-dataMinX)/spanX*baseW,   (aZ-dataMinZ)/spanZ*baseH,
      (bX-aX)/spanX*baseW,         (bZ-aZ)/spanZ*baseH);
  }
  const loadImg=url=>new Promise((res,rej)=>{ const i=new Image();
    if(/^https?:/.test(url)) i.crossOrigin='anonymous';   // off-origin (R2) tiles: keep canvas untainted
    i.onload=()=>res(i); i.onerror=()=>rej(new Error(url)); i.src=url; });
  // bulk imagery may be off-origin (see TerrainStreamer._tileBase / window.GT_TILE_CDN)
  const TILEBASE=(typeof window!=='undefined' && window.GT_TILE_CDN) || 'terrain/public/';
  async function buildBase(){
    bctx.fillStyle='#14202a'; bctx.fillRect(0,0,baseW,baseH);
    try{                                              // z1 quad (west column carries all the data)
      const [a,b]=await Promise.all([loadImg(TILEBASE+'imagery/1/0/0.webp'),
                                     loadImg(TILEBASE+'imagery/1/0/1.webp')]);
      blit(a,tileBounds(1,0,0)); blit(b,tileBounds(1,0,1)); baseReady=true; return;
    }catch(e){}
    try{ const z=await loadImg(TILEBASE+'imagery/0/0/0.webp'); blit(z,tileBounds(0,0,0)); }
    catch(e){/* leave flat fill */}
    baseReady=true;
  }
  async function loadRoads(){
    try{ const shared=window.transportSurface&&window.GT_transportFeatures
        ? window.GT_transportFeatures(window.transportSurface.snapshot(),s=>s.vehicleAllowed):null;
      const list=shared&&shared.length?shared.map(f=>({id:f.featureId,class:f.classification,
        name:f.name,pts:f.pts})):await (await fetch('terrain/public/roads.json')).json();
      roads=list.map(f=>{ const p=f.pts; let x0=1e9,z0=1e9,x1=-1e9,z1=-1e9;
        for(const q of p){ if(q[0]<x0)x0=q[0]; if(q[0]>x1)x1=q[0]; if(q[1]<z0)z0=q[1]; if(q[1]>z1)z1=q[1]; }
        return {id:f.id||f.featureId||null,name:f.name||null,cls:f.class,pts:p,
          bx0:x0,bz0:z0,bx1:x1,bz1:z1}; });
    }catch(e){ roads=[]; }
  }
  function setLabels(list){                           // precompute imp-1 name widths once
    const t=document.createElement('canvas').getContext('2d');
    t.font='9px "Segoe UI",sans-serif';
    imp1=(list||[]).filter(l=>(l.imp||3)<=1)
      .map(l=>({name:l.name,x:l.x,z:l.z,w:Math.ceil(t.measureText(l.name).width)}));
  }
  function applyMode(){ if(cv) cv.style.display = (active&&mode!==0)?'block':'none'; }
  function init(terrain){
    cv=document.getElementById('minimap'); if(!cv||!terrain||!terrain.m) return;
    DPR=Math.min(devicePixelRatio||1,2);
    cv.width=S*DPR; cv.height=S*DPR; ctx=cv.getContext('2d'); ctx.scale(DPR,DPR);
    const m=terrain.m, px=m.geoTransform[1];
    spanX=m.width*px; spanZ=m.height*px;
    dataMinX=-spanX/2; dataMinZ=-spanZ/2; dataMaxX=spanX/2; dataMaxZ=spanZ/2;
    rootSpan=m.tileSize*Math.pow(2,m.maxZoom)*px;
    baseH=800; baseW=Math.round(800*spanX/spanZ); base.width=baseW; base.height=baseH;
    mode=isTouch?0:1; active=true;
    basePromise=buildBase(); loadRoads(); applyMode();
  }
  function setXform(){
    if(mode===1){ cx=0; cz=0; sc=Math.min(S/spanX,S/spanZ); }   // park overview, fit extent
    else { const c=drive.on?drive.pos:camera.position; cx=c.x; cz=c.z; sc=S/3000; } // 3 km follow
    ox=S/2; oy=S/2;
  }
  function draw(){
    if(!active||mode===0||!ctx) return;
    setXform();
    ctx.clearRect(0,0,S,S);
    ctx.save(); roundRect(ctx,0,0,S,S,15); ctx.clip();
    ctx.fillStyle='#0c1620'; ctx.fillRect(0,0,S,S);
    if(baseReady){                                    // one image draw places the whole extent
      const x0=SX(dataMinX), y0=SY(dataMinZ);
      ctx.drawImage(base, x0,y0, SX(dataMaxX)-x0, SY(dataMaxZ)-y0);
    }
    if(roads){                                        // cull by visible world window (S px, uniform sc)
      const hv=(S/2)/sc, vx0=cx-hv,vx1=cx+hv,vz0=cz-hv,vz1=cz+hv;
      for(const f of roads){
        if(f.bx1<vx0||f.bx0>vx1||f.bz1<vz0||f.bz0>vz1) continue;
        const p=f.pts; ctx.beginPath(); ctx.moveTo(SX(p[0][0]),SY(p[0][1]));
        for(let i=1;i<p.length;i++) ctx.lineTo(SX(p[i][0]),SY(p[i][1]));
        if(f.cls==='highway'){ ctx.strokeStyle='rgba(255,208,120,0.95)'; ctx.lineWidth=mode===2?2.6:1.9; }
        else if(f.cls==='park_paved'){ ctx.strokeStyle='rgba(238,242,247,0.82)'; ctx.lineWidth=mode===2?1.9:1.3; }
        else if(f.cls==='gravel'){ ctx.strokeStyle='rgba(214,206,190,0.7)'; ctx.lineWidth=mode===2?1.5:1.0; }
        else { ctx.strokeStyle='rgba(210,214,218,0.6)'; ctx.lineWidth=mode===2?1.3:0.9; }
        ctx.stroke();
      }
    }
    if(mode===1 && imp1){                             // overview: imp-1 names, deconflicted
      ctx.font='9px "Segoe UI",sans-serif'; ctx.textBaseline='middle'; ctx.textAlign='left';
      let ln=0;                                       // count of placed boxes in _lr
      for(const l of imp1){ const mx=SX(l.x), my=SY(l.z);
        if(mx<3||mx>S-3||my<8||my>S-6) continue;
        const bx0=mx+3, by0=my-5, bx1=mx+7+l.w, by1=my+6;
        let hit=false;                                // skip if it overlaps an already-placed name
        for(let i=0;i<ln*4;i+=4){ if(bx0<_lr[i+2]&&bx1>_lr[i]&&by0<_lr[i+3]&&by1>_lr[i+1]){ hit=true; break; } }
        if(hit) continue;
        if(ln<64){ _lr[ln*4]=bx0; _lr[ln*4+1]=by0; _lr[ln*4+2]=bx1; _lr[ln*4+3]=by1; ln++; }
        ctx.fillStyle='#ffd98a'; ctx.fillRect(mx-1.5,my-1.5,3,3);
        ctx.fillStyle='rgba(4,10,14,0.66)'; ctx.fillRect(bx0,by0,l.w+4,11);
        ctx.fillStyle='#eaf2f6'; ctx.fillText(l.name,mx+5,my+0.5);
      }
    }
    // car marker (small square)
    if(car&&car.visible){ const qx=SX(drive.pos.x), qy=SY(drive.pos.z);
      ctx.fillStyle='#ffcf6b'; ctx.fillRect(qx-3,qy-3,6,6);
      ctx.strokeStyle='rgba(0,0,0,.6)'; ctx.lineWidth=1; ctx.strokeRect(qx-3,qy-3,6,6); }
    // player: view wedge + arrow (world forward = (-sin yaw,-cos yaw); north-up so +z is down)
    const pc=drive.on?drive.pos:camera.position, pmx=SX(pc.x), pmy=SY(pc.z), yaw=state.yaw;
    const wl=mode===1?26:58, hf=0.575;                // ~66° fov half-angle
    ctx.beginPath(); ctx.moveTo(pmx,pmy);
    ctx.lineTo(pmx-Math.sin(yaw+hf)*wl, pmy-Math.cos(yaw+hf)*wl);
    ctx.lineTo(pmx-Math.sin(yaw-hf)*wl, pmy-Math.cos(yaw-hf)*wl);
    ctx.closePath(); ctx.fillStyle='rgba(150,200,255,0.18)'; ctx.fill();
    ctx.save(); ctx.translate(pmx,pmy); ctx.rotate(-yaw);
    ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(5,6); ctx.lineTo(0,2.5); ctx.lineTo(-5,6); ctx.closePath();
    ctx.fillStyle='#fff'; ctx.fill(); ctx.strokeStyle='rgba(0,40,80,.7)'; ctx.lineWidth=1; ctx.stroke();
    ctx.restore();
    // north tick
    ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.font='bold 10px sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='top'; ctx.fillText('N',S/2,4);
    ctx.strokeStyle='rgba(255,255,255,.6)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(S/2,15); ctx.lineTo(S/2,19); ctx.stroke();
    ctx.restore();
  }
  return { init, setLabels, draw,
    cycle(){ if(!active) return; mode=(mode+1)%3; applyMode(); toast('minimap: '+['off','park','3 km'][mode]); },
    setMode(m){ mode=m; applyMode(); },
    isActive:()=>active, ensureBase:()=>basePromise||Promise.resolve() };
})();

/* POST the minimap's own 2D canvas via the /shot endpoint (auto-<name>-minimap.png) */
function saveMinimapShot(name){
  return new Promise(done=>{
    const cv=document.getElementById('minimap');
    if(!cv){ done(null); return; }
    cv.toBlob(async b=>{
      if(!b){ done(null); return; }
      done(await postShot(b,name));
    },'image/png');
  });
}
