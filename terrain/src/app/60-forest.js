'use strict';
/* 60-forest.js — instanced lodgepole pines (procedural fallback).
   DECLARES: treeGeometry, buildForest.
   CONSUMES: THREE, scene, sampleGround/SIZE (40), R_ISLAND/WATER_Y (10), fbm/smooth/clamp (00). */
/* ============================================================
   FORESTS — instanced lodgepole pines
   ============================================================ */
function treeGeometry(){
  const parts=[];
  const push=(geom,color)=>{
    const c=new THREE.Color(...color); const n=geom.attributes.position.count;
    const arr=new Float32Array(n*3);
    for(let i=0;i<n;i++){ arr[i*3]=c.r; arr[i*3+1]=c.g; arr[i*3+2]=c.b; }
    geom.setAttribute('color',new THREE.BufferAttribute(arr,3));
    parts.push(geom);
  };
  const trunk=new THREE.CylinderGeometry(0.35,0.55,3.2,5); trunk.translate(0,1.6,0);
  push(trunk,[0.26,0.19,0.12]);
  const c1=new THREE.ConeGeometry(2.9,6.5,6); c1.translate(0,6.0,0);   push(c1,[0.10,0.24,0.11]);
  const c2=new THREE.ConeGeometry(2.1,5.0,6); c2.translate(0,9.2,0);   push(c2,[0.12,0.28,0.13]);
  const c3=new THREE.ConeGeometry(1.3,3.6,6); c3.translate(0,11.8,0);  push(c3,[0.14,0.31,0.15]);
  // manual merge (BufferGeometryUtils is an addon, not three core)
  let vCount=0,iCount=0;
  for(const g of parts){ vCount+=g.attributes.position.count; iCount+=g.index.count; }
  const P=new Float32Array(vCount*3), N=new Float32Array(vCount*3), C=new Float32Array(vCount*3);
  const I=new Uint16Array(iCount);
  let vo=0,io=0;
  for(const g of parts){
    P.set(g.attributes.position.array,vo*3);
    g.computeVertexNormals();
    N.set(g.attributes.normal.array,vo*3);
    C.set(g.attributes.color.array,vo*3);
    const idx=g.index.array;
    for(let i=0;i<idx.length;i++) I[io+i]=idx[i]+vo;
    vo+=g.attributes.position.count; io+=idx.length;
  }
  const merged=new THREE.BufferGeometry();
  merged.setAttribute('position',new THREE.BufferAttribute(P,3));
  merged.setAttribute('normal',new THREE.BufferAttribute(N,3));
  merged.setAttribute('color',new THREE.BufferAttribute(C,3));
  merged.setIndex(new THREE.BufferAttribute(I,1));
  return merged;
}

function buildForest(){
  const MAX=9500;
  const mesh=new THREE.InstancedMesh(treeGeometry(),
    new THREE.MeshLambertMaterial({vertexColors:true}), MAX);
  const dummy=new THREE.Object3D(); const col=new THREE.Color();
  let count=0, tries=0;
  while(count<MAX && tries<70000){
    tries++;
    const x=(Math.random()-0.5)*SIZE*0.92, z=(Math.random()-0.5)*SIZE*0.92;
    if(Math.hypot(x,z)>R_ISLAND*0.9) continue;
    const h=sampleGround(x,z);
    if(h<WATER_Y+4 || h>335) continue;
    const s=(sampleGround(x+8,z)-h)/8, s2=(sampleGround(x,z+8)-h)/8;
    if(Math.hypot(s,s2)>0.7) continue;
    // clumping: dense at the mountain front & lakeshores, sparse in the sage flats
    const clump=fbm(x*0.0024+3, z*0.0024, 3);
    const front=smooth(280,70,Math.abs(x - (-560)));   // moraine forests along the range
    const density = clamp(0.15+0.85*front,0,1)*smooth(-0.35,0.35,clump);
    if(Math.random()>density) continue;
    const sc=0.7+Math.random()*1.0;
    dummy.position.set(x,h-0.4,z);
    dummy.scale.set(sc,sc*(0.9+Math.random()*0.35),sc);
    dummy.rotation.y=Math.random()*Math.PI*2;
    dummy.updateMatrix();
    mesh.setMatrixAt(count,dummy.matrix);
    const tint=0.8+Math.random()*0.4;
    mesh.setColorAt(count,col.setRGB(tint,tint,tint*0.95));
    count++;
  }
  mesh.count=count;
  if(mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
  scene.add(mesh);
  window.GT_farForest=mesh;   // let WaterBuilder include this band in lake reflections
}
