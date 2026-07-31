'use strict';
/* 40-terrain.js — collision grid + ground sampler, road index, procedural terrain + underside.
   DECLARES: SIZE, SEG, COLL_N, collGrid, terrain, waterBuilder, scatter, groundCover,
     TERRAIN_MANIFEST, LANDCOVER_MANIFEST, sampleGround, ROAD_HW, RoadIndex, buildRoadIndex,
     roadQuery (also window.roadQuery), buildTerrain, buildUnderside.
   CONSUMES: THREE, scene, SUN_DIR/FOG_COLOR (20-scene), terrainHeight/WATER_Y/R_ISLAND (10),
     fbm/clamp/smooth/lerp (00-core). */
/* ============================================================
   TERRAIN
   ============================================================ */
const SIZE = 4200, SEG = 400;
const COLL_N = 512; // collision grid
const collGrid = new Float32Array((COLL_N+1)*(COLL_N+1));

let terrain=null;                          // TerrainStreamer instance when real USGS terrain is active
let waterBuilder=null, scatter=null, groundCover=null; // real lakes/river + streamed NLCD forests + near grass
let roadRibbon=null;                       // real ribbon road meshes (replaces the baked SDF splat)
const TERRAIN_MANIFEST='terrain/public/tiles.json';
const LANDCOVER_MANIFEST='terrain/public/landcover.json';
function sampleGround(x,z){
  const ts=window.transportSurface;
  if(ts){
    const mode=(typeof drive!=='undefined'&&drive.on)?'drive':'walk';
    const h=ts.heightAt(x,z,mode);
    if(h!==null) return h;
  }
  // BRIDGES (M6): over a detected water crossing the ribbon publishes ONE graded running surface;
  // physics (4 wheels + walking player) rides THAT, not the riverbed underneath. Non-null only on
  // bridge sections, so the entire normal road/terrain network is untouched. See BridgeBuilder.
  if(roadRibbon && roadRibbon.drivableSurfaceAt){
    const d=roadRibbon.drivableSurfaceAt(x,z); if(d!=null) return d;
  }
  if(terrain) return terrain.heightAt(x,z); // real elevation (meters, datum-relative)
  const u = clamp((x/SIZE+0.5)*COLL_N,0,COLL_N-0.001);
  const v = clamp((z/SIZE+0.5)*COLL_N,0,COLL_N-0.001);
  const i=u|0, j=v|0, fu=u-i, fv=v-j, N=COLL_N+1;
  const a=collGrid[j*N+i], b=collGrid[j*N+i+1], c=collGrid[(j+1)*N+i], d=collGrid[(j+1)*N+i+1];
  return lerp(lerp(a,b,fu), lerp(c,d,fu), fv);
}

/* ---- roads: CPU-side nearest-segment sampler from roads.json ----
   Grid-bucketed classed centerlines. Each segment is rasterised into ~cell-sized buckets along
   its length; roadQuery(x,z) scans the query cell + 8 neighbours -> ~O(1) nearest-segment lookup.
   Coords in roads.json are world [x, z] metres, same frame as the terrain. */
const ROAD_HW={track:1.8,gravel:3.0,park_paved:4.0,highway:6.0};
const RoadIndex={cell:48, buckets:new Map(), segs:[], ready:false, _seen:new Set()};
async function buildRoadIndex(){
  const list=await (await fetch('terrain/public/roads.json')).json();
  for(const f of list){
    const pts=f.pts; if(!pts||pts.length<2) continue;
    const cls=f.class, name=f.name||null;
    for(let i=0;i+1<pts.length;i++){
      const a=pts[i], b=pts[i+1], si=RoadIndex.segs.length;
      RoadIndex.segs.push({ax:a[0],az:a[1],bx:b[0],bz:b[1],cls,name});
      const dx=b[0]-a[0], dz=b[1]-a[1], len=Math.hypot(dx,dz);
      const steps=Math.max(1,Math.ceil(len/RoadIndex.cell));
      for(let s=0;s<=steps;s++){
        const t=s/steps, x=a[0]+dx*t, z=a[1]+dz*t;
        const key=Math.floor(x/RoadIndex.cell)+','+Math.floor(z/RoadIndex.cell);
        let arr=RoadIndex.buckets.get(key);
        if(!arr){ arr=[]; RoadIndex.buckets.set(key,arr); }
        if(arr[arr.length-1]!==si) arr.push(si);
      }
    }
  }
  RoadIndex.ready=true;
  const wi=window.GT_APP&&window.GT_APP.worldIndex;
  if(wi){
    const install=()=>wi.installRoadIndex({
      segments:RoadIndex.segs,buckets:RoadIndex.buckets,cell:RoadIndex.cell,halfWidths:ROAD_HW
    }).catch(e=>console.info('[roads] worker index unavailable',e&&e.message||e));
    if(wi.ready) install(); else wi.initialized&&wi.initialized.then(install);
  }
}
function _segDist(px,pz,ax,az,bx,bz){
  const dx=bx-ax, dz=bz-az, l2=dx*dx+dz*dz;
  let t=l2>0?((px-ax)*dx+(pz-az)*dz)/l2:0; t=t<0?0:t>1?1:t;
  return Math.hypot(px-(ax+t*dx), pz-(az+t*dz));
}
function roadQuery(x,z){
  const R=RoadIndex;
  if(!R.ready) return {dist:1e9, class:null, name:null};
  const cx=Math.floor(x/R.cell), cz=Math.floor(z/R.cell);
  let best=1e9, bcls=null, bname=null;
  const seen=R._seen; seen.clear();
  for(let j=-1;j<=1;j++) for(let i=-1;i<=1;i++){
    const arr=R.buckets.get((cx+i)+','+(cz+j));
    if(!arr) continue;
    for(const si of arr){
      if(seen.has(si)) continue; seen.add(si);
      const s=R.segs[si], d=_segDist(x,z,s.ax,s.az,s.bx,s.bz);
      if(d<best){ best=d; bcls=s.cls; bname=s.name; }
    }
  }
  return {dist:best, class:bcls, name:bname};
}
window.roadQuery=roadQuery;

function buildTerrain(){
  for(let j=0;j<=COLL_N;j++){
    const z=(j/COLL_N-0.5)*SIZE;
    for(let i=0;i<=COLL_N;i++) collGrid[j*(COLL_N+1)+i]=terrainHeight((i/COLL_N-0.5)*SIZE, z);
  }
  const geo = new THREE.PlaneGeometry(SIZE,SIZE,SEG,SEG);
  geo.rotateX(-Math.PI/2);
  const pos = geo.attributes.position;
  for(let i=0;i<pos.count;i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();

  // — colouring: sagebrush flats, forest belt, alpine meadow, granite, snow —
  const colors = new Float32Array(pos.count*3);
  const nrm = geo.attributes.normal;
  const C = {
    sage:[0.52,0.55,0.38], meadow:[0.42,0.53,0.28], forest:[0.16,0.30,0.16],
    rock:[0.53,0.53,0.56], scree:[0.60,0.58,0.55], snow:[0.94,0.96,1.0],
    sand:[0.62,0.57,0.45], bed:[0.30,0.36,0.30], dirt:[0.42,0.36,0.28]
  };
  const mixc=(o,a,b,t)=>{ o[0]=lerp(a[0],b[0],t); o[1]=lerp(a[1],b[1],t); o[2]=lerp(a[2],b[2],t); };
  const tmp=[0,0,0];
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i);
    const slope = 1-nrm.getY(i); // 0 flat → 1 vertical
    const n1 = fbm(x*0.004,z*0.004,3), n2 = fbm(x*0.02+9,z*0.02,2);
    let c;
    if(y < WATER_Y+2.5){                    // lakebed & riverbed
      mixc(tmp,C.bed,C.sand,smooth(WATER_Y-8,WATER_Y+2.5,y)); c=tmp;
    } else if(y < 125){                     // valley: sagebrush with meadow patches
      mixc(tmp,C.sage,C.meadow,clamp(0.5+0.7*n1,0,1)); c=tmp;
    } else if(y < 330){                     // conifer belt
      mixc(tmp,C.forest,C.meadow,clamp(0.35+0.5*n2,0,1)*0.5); c=tmp;
    } else if(y < 470){                     // alpine meadow → scree
      mixc(tmp,C.meadow,C.scree,smooth(330,470,y)); c=tmp;
    } else { c=C.rock; }
    // steep faces are bare granite
    if(slope>0.32){ mixc(tmp, c===tmp?[tmp[0],tmp[1],tmp[2]]:c, C.rock, smooth(0.32,0.55,slope)); c=tmp; }
    // snow: high & not too steep, ragged edge
    const snowLine = 480 + 90*n1;
    if(y>snowLine && slope<0.52){
      mixc(tmp, c===tmp?[tmp[0],tmp[1],tmp[2]]:c, C.snow, smooth(snowLine,snowLine+70,y)*smooth(0.52,0.30,slope));
      c=tmp;
    }
    // couloir snow streaks on the east faces
    if(y>380 && slope>0.3 && n2>0.45){ mixc(tmp,c===tmp?[tmp[0],tmp[1],tmp[2]]:c,C.snow,0.5*smooth(380,450,y)); c=tmp; }
    const v=0.94+0.12*fbm(x*0.05,z*0.05,2);
    colors[i*3]=c[0]*v; colors[i*3+1]=c[1]*v; colors[i*3+2]=c[2]*v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors,3));

  const mat = new THREE.ShaderMaterial({
    uniforms:{
      uSun:{value:SUN_DIR}, uFogColor:{value:FOG_COLOR},
      uFogNear:{value:scene.fog.near}, uFogFar:{value:scene.fog.far}
    },
    vertexShader:`
      varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld;
      void main(){
        vColor=color; vNormal=normal;
        vec4 wp = modelMatrix*vec4(position,1.0); vWorld=wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader:`
      uniform vec3 uSun; uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
      varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                   mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
      }
      void main(){
        vec3 n=normalize(vNormal);
        // ground detail so close-ups don't look flat
        float d = vnoise(vWorld.xz*0.35)*0.6 + vnoise(vWorld.xz*1.6)*0.4;
        vec3 base = vColor*(0.90+0.20*d);
        float diff = max(dot(n,uSun),0.0);
        float amb = mix(0.30,0.52,n.y*0.5+0.5);
        vec3 col = base*(vec3(amb)*vec3(0.78,0.86,1.0) + vec3(1.0,0.94,0.84)*diff*1.12);
        float fd = length(vWorld-cameraPosition);
        col = mix(col, uFogColor, smoothstep(uFogNear,uFogFar,fd));
        gl_FragColor = vec4(col,1.0);
      }`,
    vertexColors:true
  });
  scene.add(new THREE.Mesh(geo, mat));
  return mat;
}

/* ============================================================
   FLOATING-ISLAND UNDERSIDE — jagged rock taper
   ============================================================ */
function buildUnderside(){
  const AN=140, TN=18, TIP=-1050;
  const positions=[], colors=[], indices=[];
  for(let t=0;t<=TN;t++){
    const ft=t/TN;
    for(let a=0;a<=AN;a++){
      const ang=a/AN*Math.PI*2;
      const nse = fbm(Math.cos(ang)*3+ft*5, Math.sin(ang)*3+ft*4, 3);
      const rad = R_ISLAND*Math.pow(1-ft,1.25)*(0.98+0.14*nse*(1-ft));
      const x=Math.cos(ang)*rad, z=Math.sin(ang)*rad;
      let y;
      if(t===0){ y = terrainHeight(Math.cos(ang)*R_ISLAND*0.995, Math.sin(ang)*R_ISLAND*0.995); }
      else { y = lerp(-46, TIP, ft*ft) + 90*nse*(1-ft) - 40*ft*Math.abs(fbm(ang*2.5,ft*6,2)); }
      positions.push(x,y,z);
      const strat = 0.5+0.5*Math.sin(y*0.05+nse*3);
      const r0=lerp(0.30,0.42,strat), g0=lerp(0.26,0.35,strat), b0=lerp(0.24,0.30,strat);
      const dark = lerp(1.0,0.55,ft);
      colors.push(r0*dark,g0*dark,b0*dark);
    }
  }
  for(let t=0;t<TN;t++) for(let a=0;a<AN;a++){
    const i0=t*(AN+1)+a, i1=i0+1, i2=i0+AN+1, i3=i2+1;
    indices.push(i0,i2,i1, i1,i2,i3);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  g.setIndex(indices); g.computeVertexNormals();
  scene.add(new THREE.Mesh(g,new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide})));
}
