'use strict';
/* ============================================================================
   00-core.js — FOUNDATION (first app module)

   LOAD-ORDER MANIFEST (all classic scripts; they share ONE top-level lexical
   scope, so bindings below are visible to every later file with no imports):
     00-core     errors hook, Simplex noise, fbm/ridged, clamp/smooth/lerp
     10-worldgen R_ISLAND WATER_Y PEAKS LAKES, riverX, terrainHeight
     20-scene    scene/camera/renderer, fog, sun+hemi lights, light refs
     30-sun-sky  day, lightArc/updateSun/clockLabel, skyUniforms + sky mesh
     40-terrain  SIZE SEG collGrid, sampleGround, RoadIndex/roadQuery, buildTerrain
     50-water    waterMat, buildWater
     60-forest   treeGeometry, buildForest
     70-labels   labelGroup/makeLabel/buildLabels + real GNIS labels, compass HUD, discovery
     80-controls state, SPAWN, respawn, movement consts
     82-drive    drive/CAR/car, placeCar, enter/exitDrive, driveStep
     84-input    key/mouse/touch handlers, updateMode, wheel
     86-capture  toast, saveShot
     88-minimap  Minimap module, saveMinimapShot
     90-auto     AUTO, settleStreams, runAuto
     92-boot     proceduralStages, boot(), step(), animate(), resize

   DECLARES (consumed everywhere): PAGE_ERRS, Simplex, sx, sx2, fbm, ridged,
     clamp, smooth, lerp.  CONSUMES: nothing (this is the root).
   ============================================================================ */
/* DEV = local dev only (localhost / file://). Public deploys are non-local, so dev-only
   features (P-key screenshot → serve.py POST) stay quiet for visitors. */
const DEV = ['localhost','127.0.0.1',''].includes(location.hostname);

/* page errors ride along in screenshot metadata — headless review shots diagnose themselves */
const PAGE_ERRS=[];
addEventListener('error',e=>{ if(PAGE_ERRS.length<8) PAGE_ERRS.push(String(e.message).slice(0,300)); });
{ const _cerr=console.error.bind(console);
  console.error=(...a)=>{ if(PAGE_ERRS.length<8) PAGE_ERRS.push(a.map(String).join(' ').slice(0,300)); _cerr(...a); }; }

/* ============================================================
   Simplex noise (2D) — Stefan Gustavson's public-domain method
   ============================================================ */
class Simplex {
  constructor(seed=1337){
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for(let i=0;i<256;i++) perm[i]=i;
    let s = seed>>>0;
    const rnd=()=>{ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s/4294967295; };
    for(let i=255;i>0;i--){ const j=(rnd()*(i+1))|0; const t=perm[i];perm[i]=perm[j];perm[j]=t; }
    for(let i=0;i<512;i++) this.p[i]=perm[i&255];
    this.grad=[[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  }
  noise(x,y){
    const F=0.3660254037844386, G=0.21132486540518713;
    const s=(x+y)*F, i=Math.floor(x+s), j=Math.floor(y+s);
    const t=(i+j)*G, X0=i-t, Y0=j-t, x0=x-X0, y0=y-Y0;
    const i1 = x0>y0?1:0, j1 = x0>y0?0:1;
    const x1=x0-i1+G, y1=y0-j1+G, x2=x0-1+2*G, y2=y0-1+2*G;
    const ii=i&255, jj=j&255;
    let n=0, t0=0.5-x0*x0-y0*y0;
    if(t0>0){ t0*=t0; const g=this.grad[this.p[ii+this.p[jj]]&7]; n+=t0*t0*(g[0]*x0+g[1]*y0); }
    let t1=0.5-x1*x1-y1*y1;
    if(t1>0){ t1*=t1; const g=this.grad[this.p[ii+i1+this.p[jj+j1]]&7]; n+=t1*t1*(g[0]*x1+g[1]*y1); }
    let t2=0.5-x2*x2-y2*y2;
    if(t2>0){ t2*=t2; const g=this.grad[this.p[ii+1+this.p[jj+1]]&7]; n+=t2*t2*(g[0]*x2+g[1]*y2); }
    return 70*n;
  }
}
const sx = new Simplex(20260710);
const sx2 = new Simplex(48151623);

function fbm(x,y,oct){
  let a=0.5,f=1,sum=0,norm=0;
  for(let o=0;o<oct;o++){ sum+=a*sx.noise(x*f,y*f); norm+=a; a*=0.5; f*=2.03; }
  return sum/norm; // -1..1
}
function ridged(x,y,oct){
  let a=0.55,f=1,sum=0,norm=0;
  for(let o=0;o<oct;o++){
    let n=1-Math.abs(sx2.noise(x*f,y*f)); n*=n;
    sum+=a*n; norm+=a; a*=0.5; f*=2.11;
  }
  return sum/norm; // 0..1, sharp crests
}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,v)=>{ const t=clamp((v-a)/(b-a),0,1); return t*t*(3-2*t); };
const lerp=(a,b,t)=>a+(b-a)*t;
