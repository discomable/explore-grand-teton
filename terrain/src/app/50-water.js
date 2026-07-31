'use strict';
/* 50-water.js — procedural animated water sheet.
   DECLARES: waterMat, buildWater.
   CONSUMES: THREE, scene, SUN_DIR/FOG_COLOR (20-scene), R_ISLAND/WATER_Y (10). */
/* ============================================================
   WATER — lakes + Snake River (one animated sheet)
   ============================================================ */
let waterMat;
function buildWater(){
  const g = new THREE.CircleGeometry(R_ISLAND*0.86, 96);
  g.rotateX(-Math.PI/2);
  waterMat = new THREE.ShaderMaterial({
    transparent:true, fog:false,
    uniforms:{ uTime:{value:0}, uSun:{value:SUN_DIR}, uFogColor:{value:FOG_COLOR},
               uFogNear:{value:scene.fog.near}, uFogFar:{value:scene.fog.far} },
    vertexShader:`
      varying vec3 vWorld;
      void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vWorld=wp.xyz;
        gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader:`
      uniform float uTime; uniform vec3 uSun; uniform vec3 uFogColor;
      uniform float uFogNear; uniform float uFogFar;
      varying vec3 vWorld;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                   mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
      }
      void main(){
        vec2 p=vWorld.xz*0.06;
        float w1=vnoise(p+vec2(uTime*0.05,uTime*0.03));
        float w2=vnoise(p*2.7-vec2(uTime*0.07,uTime*0.02));
        vec3 n=normalize(vec3((w1-0.5)*0.35,1.0,(w2-0.5)*0.35));
        vec3 V=normalize(cameraPosition-vWorld);
        float fres=pow(1.0-max(dot(V,n),0.0),3.0);
        vec3 deep=vec3(0.05,0.18,0.22), skyc=vec3(0.55,0.72,0.87);
        vec3 col=mix(deep,skyc,0.25+0.75*fres);
        vec3 H=normalize(V+uSun);
        col+=vec3(1.0,0.95,0.85)*pow(max(dot(n,H),0.0),240.0)*2.5;
        col+=vec3(0.10,0.14,0.14)*(w1*w2);
        float fd=length(vWorld-cameraPosition);
        col=mix(col,uFogColor,smoothstep(uFogNear,uFogFar,fd));
        gl_FragColor=vec4(col,0.92);
      }`
  });
  const m=new THREE.Mesh(g,waterMat); m.position.y=WATER_Y; scene.add(m);
}
