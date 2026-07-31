'use strict';
/* 89-heldmap.js — a 3D held paper map raised with 'N'.
   DECLARES: HeldMap.
   CONSUMES: THREE (20), renderer/scene-agnostic (own scene+cam), terrain (40) via init,
     realLabels (70) place names, drive/camera/state (82/80/20) for the live pin, toast (86),
     window.GT_TILE_CDN + terrain/public/imagery + roads.json.
   RENDER: a camera-locked parchment viewmodel drawn in a depth-cleared overlay pass AFTER the
     main scene render — its own scene + ortho camera, rendered to the default framebuffer with
     autoClear off and renderer.clearDepth() first, so the paper's depth starts fresh and always
     draws over the world without clipping terrain (an independent overlay technique — NOT the
     near-plane tweak 82-drive.js/fpNear uses for first-person cabin geometry). The texture is an
     aged-parchment CANVAS built by reusing 88-minimap.js's world→tile compositing (tileBounds/
     blit over imagery/1/0/{0,1}.webp), overlaid with roads, imp≤1 place labels, fold lines, a
     compass rose, legend, title and a live "you are here" pin + heading arrow.
   Legible at night: MeshBasicMaterial toneMapped:false + tex.encoding=sRGBEncoding (unaffected by
     the ACES/exposure hook), so the paper reads at full authored brightness in deep dark. */
const HeldMap=(function(){
  // ---- parchment canvas geometry (portrait paper) ----------------------------------------
  const MAPW=960, MAPH=1240, OP=46;                 // canvas px + outer deckle padding
  const paperAR=MAPW/MAPH;
  const baseCv=document.createElement('canvas');    // static art (parchment+tiles+roads+labels+chrome)
  baseCv.width=MAPW; baseCv.height=MAPH;
  const texCv=document.createElement('canvas');     // bound to the texture: base blit + live pin
  texCv.width=MAPW; texCv.height=MAPH;
  const texCtx=texCv.getContext('2d');
  const tileCv=document.createElement('canvas');    // world-extent imagery composite (like minimap base)
  let tileW=1, tileH=768;

  // ---- world→canvas transform state ------------------------------------------------------
  let spanX=0,spanZ=0,dataMinX=0,dataMinZ=0,dataMaxX=0,dataMaxZ=0,rootSpan=0;
  let mapT={ax:0,ay:0,s:1}, mapRect={x0:0,y0:0,x1:MAPW,y1:MAPH};
  const WX=x=>mapT.ax+(x-dataMinX)*mapT.s;
  const WY=z=>mapT.ay+(z-dataMinZ)*mapT.s;

  // ---- module state ----------------------------------------------------------------------
  let _terrainOK=false, _built=false, _baseReady=false, _dirty=true;
  let _tileReady=false, _roads=null, _labelList=null;
  let _up=false, _raise=0, _acc=0;

  // deterministic RNG (stable aged-paper art across headless captures)
  let _seed=1337;
  const reseed=s=>{ _seed=(s>>>0)||1; };
  const rnd=()=>{ _seed=(_seed*1664525+1013904223)>>>0; return _seed/4294967296; };
  const clampN=(v,a,b)=>v<a?a:v>b?b:v;
  function roundRect(c,x,y,w,h,r){ c.beginPath();
    c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
    c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

  // ---- tile compositing (mirrors 88-minimap.js) ------------------------------------------
  const TILEBASE=(typeof window!=='undefined' && window.GT_TILE_CDN) || 'terrain/public/';
  const loadImg=url=>new Promise((res,rej)=>{ const i=new Image();
    if(/^https?:/.test(url)) i.crossOrigin='anonymous';   // off-origin (R2) tiles stay canvas-safe
    i.onload=()=>res(i); i.onerror=()=>rej(new Error(url)); i.src=url; });
  function tileBounds(z,x,y){ const s=rootSpan/Math.pow(2,z);
    return {minX:dataMinX+x*s, minZ:dataMinZ+y*s, s}; }
  function blit(bctx,img,tb){                        // draw a tile's data-overlap into tileCv
    const aX=Math.max(tb.minX,dataMinX), bX=Math.min(tb.minX+tb.s,dataMaxX);
    const aZ=Math.max(tb.minZ,dataMinZ), bZ=Math.min(tb.minZ+tb.s,dataMaxZ);
    if(bX<=aX||bZ<=aZ) return;
    bctx.drawImage(img,
      (aX-tb.minX)/tb.s*img.width, (aZ-tb.minZ)/tb.s*img.height,
      (bX-aX)/tb.s*img.width,      (bZ-aZ)/tb.s*img.height,
      (aX-dataMinX)/spanX*tileW,   (aZ-dataMinZ)/spanZ*tileH,
      (bX-aX)/spanX*tileW,         (bZ-aZ)/spanZ*tileH);
  }
  async function loadTiles(){
    const g=tileCv.getContext('2d');
    g.fillStyle='#3a4636'; g.fillRect(0,0,tileW,tileH);
    try{                                             // z1 quad (west column carries all the data)
      const [a,b]=await Promise.all([loadImg(TILEBASE+'imagery/1/0/0.webp'),
                                     loadImg(TILEBASE+'imagery/1/0/1.webp')]);
      blit(g,a,tileBounds(1,0,0)); blit(g,b,tileBounds(1,0,1)); _tileReady=true; return;
    }catch(e){}
    try{ const z=await loadImg(TILEBASE+'imagery/0/0/0.webp'); blit(g,z,tileBounds(0,0,0)); _tileReady=true; }
    catch(e){ _tileReady=false; }                    // leave the flat relief fill under the parchment wash
  }
  async function loadRoads(){
    try{ const shared=window.transportSurface&&window.GT_transportFeatures
        ? window.GT_transportFeatures(window.transportSurface.snapshot(),s=>s.vehicleAllowed):null;
      const list=shared&&shared.length?shared.map(f=>({id:f.featureId,class:f.classification,
        name:f.name,pts:f.pts})):await (await fetch('terrain/public/roads.json')).json();
      _roads=list.map(f=>({id:f.id||f.featureId||null,name:f.name||null,cls:f.class,pts:f.pts}));
    }catch(e){ _roads=[]; }
  }

  // ---- CANVAS PAINTERS (all fully written) -----------------------------------------------
  function paintParchment(g){
    const bg=g.createLinearGradient(0,0,MAPW,MAPH);
    bg.addColorStop(0,'#efe2c0'); bg.addColorStop(0.5,'#e8d9b3'); bg.addColorStop(1,'#dfcda1');
    g.fillStyle=bg; g.fillRect(0,0,MAPW,MAPH);
    reseed(4211);                                    // foxing stains
    for(let i=0;i<28;i++){
      const x=rnd()*MAPW, y=rnd()*MAPH, r=28+rnd()*130, a=(0.03+rnd()*0.06).toFixed(3);
      const st=g.createRadialGradient(x,y,0,x,y,r);
      st.addColorStop(0,'rgba(120,86,44,'+a+')'); st.addColorStop(1,'rgba(120,86,44,0)');
      g.fillStyle=st; g.beginPath(); g.arc(x,y,r,0,7); g.fill();
    }
    reseed(9001); g.lineWidth=1;                     // paper fibres (warm + pale flecks)
    for(let i=0;i<1000;i++){
      const x=rnd()*MAPW, y=rnd()*MAPH, len=2+rnd()*5, ang=rnd()*7;
      const warm=rnd()<0.5;
      g.strokeStyle='rgba('+(warm?'150,120,70':'255,250,230')+','+(0.03+rnd()*0.05).toFixed(3)+')';
      g.beginPath(); g.moveTo(x,y); g.lineTo(x+Math.cos(ang)*len,y+Math.sin(ang)*len); g.stroke();
    }
    const vg=g.createRadialGradient(MAPW/2,MAPH/2,MAPH*0.30,MAPW/2,MAPH/2,MAPH*0.72);
    vg.addColorStop(0,'rgba(58,38,14,0)'); vg.addColorStop(1,'rgba(58,38,14,0.30)');
    g.fillStyle=vg; g.fillRect(0,0,MAPW,MAPH);       // aged-edge vignette
  }

  function drawMapArea(g){
    const x0=mapRect.x0, y0=mapRect.y0, uw=mapRect.x1-x0, uh=mapRect.y1-y0;
    g.save();
    g.beginPath(); g.rect(x0,y0,uw,uh); g.clip();
    g.fillStyle='#cabf9f'; g.fillRect(x0,y0,uw,uh);  // pale relief base (shows if tiles fail)
    if(_tileReady){
      g.imageSmoothingEnabled=true; g.globalAlpha=0.94;
      g.drawImage(tileCv,0,0,tileW,tileH, x0,y0,uw,uh);
      g.globalAlpha=1;
      g.globalCompositeOperation='color';            // age imagery to sepia (keeps terrain luminance)
      g.fillStyle='rgba(122,92,50,0.55)'; g.fillRect(x0,y0,uw,uh);
      g.globalCompositeOperation='source-over';
      g.fillStyle='rgba(226,210,170,0.22)'; g.fillRect(x0,y0,uw,uh);  // parchment wash over the print
    }
    g.restore();
    // neat cartouche frame around the surveyed area
    g.strokeStyle='rgba(60,42,18,0.85)'; g.lineWidth=2.4; g.strokeRect(x0,y0,uw,uh);
    g.strokeStyle='rgba(120,90,50,0.5)'; g.lineWidth=1; g.strokeRect(x0-4,y0-4,uw+8,uh+8);
  }

  function drawRoads(g){
    if(!_roads||!_roads.length) return;
    g.save();
    g.beginPath(); g.rect(mapRect.x0,mapRect.y0,mapRect.x1-mapRect.x0,mapRect.y1-mapRect.y0); g.clip();
    g.lineJoin='round'; g.lineCap='round';
    for(const f of _roads){
      const p=f.pts; if(!p||p.length<2) continue;
      g.beginPath(); g.moveTo(WX(p[0][0]),WY(p[0][1]));
      for(let i=1;i<p.length;i++) g.lineTo(WX(p[i][0]),WY(p[i][1]));
      if(f.cls==='highway'){ g.setLineDash([]);
        g.strokeStyle='rgba(120,44,26,0.9)'; g.lineWidth=3.2; g.stroke();
        g.strokeStyle='rgba(214,150,88,0.85)'; g.lineWidth=1.1; g.stroke(); }   // ink casing + fill
      else if(f.cls==='park_paved'){ g.setLineDash([]);
        g.strokeStyle='rgba(70,48,26,0.88)'; g.lineWidth=2.1; g.stroke(); }
      else if(f.cls==='gravel'){ g.setLineDash([6,4]);
        g.strokeStyle='rgba(110,84,48,0.82)'; g.lineWidth=1.6; g.stroke(); }
      else { g.setLineDash([2,4]);
        g.strokeStyle='rgba(90,68,40,0.72)'; g.lineWidth=1.3; g.stroke(); }
    }
    g.setLineDash([]);
    g.restore();
  }

  function drawPlaces(g){
    const list=(_labelList&&_labelList.length)?_labelList
             :(typeof realLabels!=='undefined'&&realLabels.list)?realLabels.list:null;
    if(!list) return;
    g.save();
    g.beginPath(); g.rect(mapRect.x0,mapRect.y0,mapRect.x1-mapRect.x0,mapRect.y1-mapRect.y0); g.clip();
    g.font='600 14px Georgia, "Times New Roman", serif'; g.textBaseline='middle'; g.textAlign='left';
    const placed=[];
    for(const l of list){
      if((l.imp||3)>1) continue;                     // imp≤1 place labels only (spec)
      const mx=WX(l.x), my=WY(l.z);
      if(mx<mapRect.x0+4||mx>mapRect.x1-4||my<mapRect.y0+4||my>mapRect.y1-4) continue;
      const tw=g.measureText(l.name).width;
      const bx0=mx+7, by0=my-8, bx1=mx+11+tw, by1=my+8;
      if(bx1>mapRect.x1-2) continue;
      let hit=false;
      for(const b of placed){ if(bx0<b.x1&&bx1>b.x0&&by0<b.y1&&by1>b.y0){ hit=true; break; } }
      if(hit) continue;
      placed.push({x0:bx0,y0:by0,x1:bx1,y1:by1});
      g.fillStyle='rgba(60,42,18,0.92)'; g.beginPath(); g.arc(mx,my,2.6,0,7); g.fill();
      g.strokeStyle='rgba(60,42,18,0.5)'; g.lineWidth=1; g.beginPath(); g.arc(mx,my,4.6,0,7); g.stroke();
      g.lineWidth=3; g.strokeStyle='rgba(240,230,200,0.85)'; g.strokeText(l.name,mx+9,my);  // halo
      g.fillStyle='#2c1e0c'; g.fillText(l.name,mx+9,my);
    }
    g.restore();
  }

  function drawFolds(g){
    g.save();
    const vx=[MAPW*0.25,MAPW*0.5,MAPW*0.75], hy=[MAPH*0.5];
    for(const x of vx){
      g.strokeStyle='rgba(60,44,20,0.10)'; g.lineWidth=2;
      g.beginPath(); g.moveTo(x,OP*0.5); g.lineTo(x,MAPH-OP*0.5); g.stroke();
      g.strokeStyle='rgba(255,248,224,0.20)'; g.lineWidth=1;
      g.beginPath(); g.moveTo(x+1.4,OP*0.5); g.lineTo(x+1.4,MAPH-OP*0.5); g.stroke();
    }
    for(const y of hy){
      g.strokeStyle='rgba(60,44,20,0.10)'; g.lineWidth=2;
      g.beginPath(); g.moveTo(OP*0.5,y); g.lineTo(MAPW-OP*0.5,y); g.stroke();
      g.strokeStyle='rgba(255,248,224,0.20)'; g.lineWidth=1;
      g.beginPath(); g.moveTo(OP*0.5,y+1.4); g.lineTo(MAPW-OP*0.5,y+1.4); g.stroke();
    }
    g.restore();
  }

  function drawCompass(g){
    const r=42, cx=mapRect.x1-r-18, cy=mapRect.y0+r+18;
    g.save();
    g.beginPath(); g.arc(cx,cy,r+7,0,7); g.fillStyle='rgba(244,232,200,0.82)'; g.fill();
    g.strokeStyle='rgba(90,64,32,0.75)'; g.lineWidth=1.4; g.stroke();
    g.beginPath(); g.arc(cx,cy,r-4,0,7); g.strokeStyle='rgba(90,64,32,0.4)'; g.lineWidth=1; g.stroke();
    // 4 diagonal minor points (grey), then 4 cardinal kites (N in red — map is north-up)
    const kite=(ang,rr,fill)=>{
      const tx=cx+Math.sin(ang)*rr, ty=cy-Math.cos(ang)*rr;
      const bl=rr*0.16;
      const lx=cx+Math.sin(ang+Math.PI/2)*bl, ly=cy-Math.cos(ang+Math.PI/2)*bl;
      const rx=cx+Math.sin(ang-Math.PI/2)*bl, ry=cy-Math.cos(ang-Math.PI/2)*bl;
      g.beginPath(); g.moveTo(tx,ty); g.lineTo(lx,ly); g.lineTo(cx,cy); g.lineTo(rx,ry); g.closePath();
      g.fillStyle=fill; g.fill(); g.strokeStyle='rgba(40,26,10,0.6)'; g.lineWidth=0.7; g.stroke();
    };
    for(let i=0;i<4;i++) kite(Math.PI/4+i*Math.PI/2, r*0.60, 'rgba(120,96,58,0.85)');
    kite(Math.PI/2, r, 'rgba(74,52,24,0.92)');       // E
    kite(Math.PI,   r, 'rgba(74,52,24,0.92)');       // S
    kite(3*Math.PI/2,r,'rgba(74,52,24,0.92)');       // W
    kite(0,         r, 'rgba(150,40,26,0.95)');      // N (red)
    g.fillStyle='#2c1e0c'; g.font='700 13px Georgia, serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText('N',cx,cy-r-13); g.fillText('S',cx,cy+r+13);
    g.fillText('E',cx+r+13,cy); g.fillText('W',cx-r-13,cy);
    g.restore();
  }

  function drawLegend(g){
    const bx=OP+18, by=MAPH-OP-128, bw=MAPW-2*(OP+18), bh=110;
    g.save();
    roundRect(g,bx,by,bw,bh,10);
    g.fillStyle='rgba(244,232,200,0.85)'; g.fill();
    g.strokeStyle='rgba(90,64,32,0.72)'; g.lineWidth=1.6; g.stroke();
    g.fillStyle='#3a2a12'; g.textBaseline='middle'; g.textAlign='left';
    g.font='700 15px Georgia, serif'; g.fillText('LEGEND',bx+16,by+18);
    const entries=[['Highway','rgba(120,44,26,0.95)',3.0,[]],
                   ['Park Road','rgba(70,48,26,0.9)',2.1,[]],
                   ['Gravel','rgba(110,84,48,0.9)',1.6,[6,4]],
                   ['Trail','rgba(90,68,40,0.85)',1.3,[2,4]]];
    let ly=by+42; g.font='13px Georgia, serif';
    for(const [name,col,lw,dash] of entries){
      g.strokeStyle=col; g.lineWidth=lw; g.setLineDash(dash); g.lineCap='round';
      g.beginPath(); g.moveTo(bx+18,ly); g.lineTo(bx+62,ly); g.stroke(); g.setLineDash([]);
      g.fillStyle='#3a2a12'; g.fillText(name,bx+72,ly);
      ly+=18;
    }
    // scale bar (world metres via the fitted transform) — pick a round length near 150 px
    const mPerPx=1/mapT.s, cands=[500,1000,2000,5000,10000,20000];
    let best=cands[0];
    for(const c of cands) if(Math.abs(c/mPerPx-150)<Math.abs(best/mPerPx-150)) best=c;
    const barPx=best/mPerPx, sx=bx+bw-barPx-26, sy=by+bh-30, seg=barPx/4;
    for(let i=0;i<4;i++){ g.fillStyle=i%2?'#f4e8c8':'#3a2a12'; g.fillRect(sx+i*seg,sy-3,seg,6); }
    g.strokeStyle='#3a2a12'; g.lineWidth=1.4; g.strokeRect(sx,sy-3,barPx,6);
    g.fillStyle='#3a2a12'; g.font='11px Georgia, serif'; g.textAlign='center'; g.textBaseline='top';
    g.fillText('0',sx,sy+6); g.fillText((best/1000)+' km',sx+barPx,sy+6);
    g.restore();
  }

  function drawTitle(g){
    const cx=MAPW/2, ty=OP+14;
    g.save(); g.textAlign='center'; g.textBaseline='alphabetic';
    g.fillStyle='#2c1e0c'; g.font='700 40px Georgia, "Times New Roman", serif';
    g.fillText('GRAND TETON',cx,ty+32);
    g.font='italic 17px Georgia, serif'; g.fillStyle='#4a3418';
    g.fillText('NATIONAL PARK · WYOMING',cx,ty+58);
    const ry=ty+72, hw=MAPW*0.30;                    // decorative rule with centre diamond
    g.strokeStyle='rgba(74,52,24,0.72)'; g.lineWidth=1.4;
    g.beginPath(); g.moveTo(cx-hw,ry); g.lineTo(cx-12,ry); g.moveTo(cx+12,ry); g.lineTo(cx+hw,ry); g.stroke();
    g.fillStyle='rgba(74,52,24,0.82)';
    g.beginPath(); g.moveTo(cx,ry-5); g.lineTo(cx+6,ry); g.lineTo(cx,ry+5); g.lineTo(cx-6,ry); g.closePath(); g.fill();
    g.restore();
  }

  function drawEdge(g){
    g.save();
    reseed(9137);
    const inset=OP-8, step=26;
    for(const off of [0,5]){                         // hand-jittered double rule → deckled border
      g.strokeStyle= off? 'rgba(90,64,32,0.5)':'rgba(60,42,20,0.82)';
      g.lineWidth= off?1:2;
      const x0=inset+off, y0=inset+off, x1=MAPW-inset-off, y1=MAPH-inset-off;
      g.beginPath(); g.moveTo(x0,y0);
      for(let x=x0+step;x<=x1;x+=step) g.lineTo(x,y0+(rnd()-0.5)*1.8);
      for(let y=y0+step;y<=y1;y+=step) g.lineTo(x1+(rnd()-0.5)*1.8,y);
      for(let x=x1-step;x>=x0;x-=step) g.lineTo(x,y1+(rnd()-0.5)*1.8);
      for(let y=y1-step;y>=y0;y-=step) g.lineTo(x0+(rnd()-0.5)*1.8,y);
      g.closePath(); g.stroke();
    }
    for(const [cx,cy] of [[0,0],[MAPW,0],[0,MAPH],[MAPW,MAPH]]){   // corner curl shadows
      const cg=g.createRadialGradient(cx,cy,4,cx,cy,150);
      cg.addColorStop(0,'rgba(50,32,10,0.30)'); cg.addColorStop(1,'rgba(50,32,10,0)');
      g.fillStyle=cg; g.fillRect(0,0,MAPW,MAPH);
    }
    g.restore();
  }

  // ---- live "you are here" pin + heading arrow -------------------------------------------
  function drawPin(g){
    const pc=(typeof drive!=='undefined'&&drive.on)?drive.pos:camera.position;
    const yaw=(typeof state!=='undefined')?state.yaw:0;
    const px=clampN(WX(pc.x),mapRect.x0+6,mapRect.x1-6);
    const py=clampN(WY(pc.z),mapRect.y0+6,mapRect.y1-6);
    g.save();
    g.beginPath(); g.arc(px,py,13,0,7); g.fillStyle='rgba(200,30,20,0.18)'; g.fill();   // soft glow
    // heading arrow: glyph points up (=north, −z world); canvas y tracks +z, so world forward
    // (−sin yaw,−cos yaw) is reached by rotating the up glyph by −yaw (verified vs 88-minimap).
    g.save(); g.translate(px,py); g.rotate(-yaw);
    g.beginPath(); g.moveTo(0,-21); g.lineTo(8,5); g.lineTo(0,-2); g.lineTo(-8,5); g.closePath();
    g.fillStyle='rgba(190,25,20,0.95)'; g.fill();
    g.strokeStyle='rgba(60,10,5,0.85)'; g.lineWidth=1.2; g.stroke();
    g.restore();
    g.beginPath(); g.arc(px,py,5.5,0,7); g.fillStyle='#c81e14'; g.fill();               // pin head
    g.lineWidth=2; g.strokeStyle='#fff5e6'; g.stroke();
    g.beginPath(); g.arc(px,py,2,0,7); g.fillStyle='#fff'; g.fill();
    g.restore();
  }

  // ---- base build + per-frame repaint ----------------------------------------------------
  function computeXform(){
    const rx0=OP+16, ry0=OP+94, rx1=MAPW-OP-16, ry1=MAPH-OP-152;   // map window inside title/legend bands
    const s=Math.min((rx1-rx0)/spanX,(ry1-ry0)/spanZ);
    const uw=spanX*s, uh=spanZ*s;
    const ax=rx0+((rx1-rx0)-uw)/2, ay=ry0+((ry1-ry0)-uh)/2;
    mapT={ax,ay,s}; mapRect={x0:ax,y0:ay,x1:ax+uw,y1:ay+uh};
  }
  function buildBaseNow(){
    const g=baseCv.getContext('2d');
    g.setTransform(1,0,0,1,0,0);
    g.clearRect(0,0,MAPW,MAPH);
    paintParchment(g);
    drawMapArea(g);
    drawRoads(g);
    drawPlaces(g);
    drawFolds(g);
    drawCompass(g);
    drawLegend(g);
    drawTitle(g);
    drawEdge(g);
    _baseReady=true; _dirty=true;
  }
  function ensureBuilt(){
    if(_built||!_terrainOK) return;
    _built=true;
    buildBaseNow();                                  // instant parchment (no tiles yet)
    loadRoads().then(()=>{ buildBaseNow(); });        // roads + labels (realLabels ready by now)
    loadTiles().then(()=>{ buildBaseNow(); });        // aged imagery composite
  }
  function repaint(){
    if(!_baseReady) return;
    texCtx.setTransform(1,0,0,1,0,0);
    texCtx.clearRect(0,0,MAPW,MAPH);
    texCtx.drawImage(baseCv,0,0);
    drawPin(texCtx);
    tex.needsUpdate=true;
  }

  // ---- three.js viewmodel: own scene + ortho camera, depth-cleared overlay pass ----------
  const scene2=new THREE.Scene();
  // PERSPECTIVE (not ortho): gives the paper real foreshortening so, tilted + held low, it reads as an
  // object in your hands in the world rather than a flat 2D overlay. Camera at origin looking -Z.
  const cam2=new THREE.PerspectiveCamera(52, 1, 0.03, 20);
  const tex=new THREE.CanvasTexture(texCv);
  tex.colorSpace = THREE.SRGBColorSpace;                   // stay in display space (bypasses the ACES hook)
  tex.generateMipmaps=false; tex.minFilter=THREE.LinearFilter; tex.magFilter=THREE.LinearFilter;
  tex.anisotropy=4;
  const mat=new THREE.MeshBasicMaterial({map:tex, toneMapped:false, transparent:true});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(paperAR,1), mat);
  mesh.renderOrder=2; scene2.add(mesh);
  // (drop-shadow plane removed — in the held viewmodel it read as an odd dark shape behind the paper)

  function update(dt){
    if(!_terrainOK) return;
    const tgt=_up?1:0;
    _raise += (tgt-_raise)*(1-Math.pow(0.0006,dt));  // frame-rate independent ease
    if(tgt===0 && _raise<0.001) _raise=0;
    if(_raise>0.001){
      _acc+=dt;
      if(_dirty || _acc>0.06){ _acc=0; _dirty=false; repaint(); }   // ~15 Hz live pin, else on demand
    }
  }
  // HELD POSE (all tunable): the paper sits low + in front, tilted back toward the face like a map in
  // your hands, with a tiny yaw/sway. It slides up from below the frame on raise.
  const FOV=52, TILT=-0.60, YAW=0.06, REST_Y=-0.20, REST_Z=-1.22, SH=0.94, HID_Y=-1.75;
  function render(renderer){
    if(!_terrainOK || _raise<=0.001) return;
    cam2.fov=FOV; cam2.aspect=innerWidth/innerHeight; cam2.updateProjectionMatrix();
    const e=_raise*_raise*(3-2*_raise);              // smoothstep the rise
    const y=HID_Y+(REST_Y-HID_Y)*e;                  // slide up into the held rest position
    const tilt=TILT*e;                               // lays flatter while being raised, settles at TILT
    mesh.rotation.set(tilt, YAW, 0.015);  mesh.position.set(0.02, y, REST_Z);  mesh.scale.set(SH, SH, 1);
    const prevAC=renderer.autoClear;
    renderer.setRenderTarget(null);                  // draw straight to the screen buffer
    renderer.autoClear=false;
    renderer.clearDepth();                           // fresh depth on the default buffer: paper never clips terrain
    renderer.render(scene2,cam2);
    renderer.autoClear=prevAC;
  }

  return {
    init(terrain){
      if(!terrain||!terrain.m){ _terrainOK=false; return; }
      _terrainOK=true;
      const m=terrain.m, px=m.geoTransform[1];
      spanX=m.width*px; spanZ=m.height*px;
      dataMinX=-spanX/2; dataMinZ=-spanZ/2; dataMaxX=spanX/2; dataMaxZ=spanZ/2;
      rootSpan=m.tileSize*Math.pow(2,m.maxZoom)*px;
      tileH=768; tileW=Math.max(1,Math.round(768*spanX/spanZ));
      tileCv.width=tileW; tileCv.height=tileH;
      computeXform();
    },
    setLabels(list){ _labelList=list; if(_built) buildBaseNow(); },
    toggle(){
      if(!_terrainOK){ if(typeof toast==='function') toast('map unavailable here'); return; }
      ensureBuilt();
      _up=!_up; _dirty=true;
      if(typeof toast==='function') toast(_up?'map raised':'map lowered');
    },
    update, render, isUp:()=>_up
  };
})();
