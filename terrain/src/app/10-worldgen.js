'use strict';
/* 10-worldgen.js — procedural geography.
   DECLARES: R_ISLAND, WATER_Y, PEAKS, LAKES, riverX, terrainHeight.
   CONSUMES (00-core): fbm, ridged, clamp, smooth, lerp. */
/* ============================================================
   Geography — a stylised but faithful map of the park
   x−  = west (Teton Range) · x+ = east (Jackson Hole)
   z−  = north (Jackson Lake / Moran) · z+ = south
   ============================================================ */
const R_ISLAND = 1950;          // island radius
const WATER_Y  = 34;            // lake / river surface
const PEAKS = [ // name, x, z, amp, sigma, label height
  {name:'Grand Teton · 13,775 ft', x:-790, z:  70, amp:300, sig:150},
  {name:'Mount Owen',              x:-855, z: -95, amp:210, sig:120},
  {name:'Teewinot',                x:-720, z: -35, amp:150, sig:100},
  {name:'Middle Teton',            x:-800, z: 240, amp:230, sig:130},
  {name:'South Teton',             x:-820, z: 400, amp:190, sig:120},
  {name:'Mount Moran · 12,610 ft', x:-905, z:-950, amp:260, sig:190},
];
const LAKES = [
  {name:'Jenny Lake',   x:-430, z: 150, sx:190, sz:210, bed:16},
  {name:'Jackson Lake', x:-540, z:-1080, sx:300, sz:520, bed:12},
  {name:'Leigh Lake',   x:-500, z:-430, sx:130, sz:150, bed:18},
  {name:'Phelps Lake',  x:-560, z: 640, sx:110, sz:120, bed:18},
];

function riverX(z){ return 300 + 210*Math.sin(z*0.00115+0.7) + 80*Math.sin(z*0.0034); }

function terrainHeight(x,z){
  const r = Math.hypot(x,z)/R_ISLAND;
  if(r>1.03) return -70;

  // Jackson Hole valley floor — rolling sagebrush flats
  let h = 56 + 18*fbm(x*0.0011+5, z*0.0011, 3) + 6*fbm(x*0.006, z*0.006, 2);
  // gentle eastern foothills (Gros Ventre side)
  h += Math.max(0,(x-620))*0.075*(1+0.5*fbm(x*0.002,z*0.002,2));

  // ——— Teton Range: sharp fault-block ridge, steep east face ———
  const rx = -800 + 130*Math.sin(z*0.00125) + 45*Math.sin(z*0.004+2);
  const dd = x>rx ? (x-rx)*1.75 : (rx-x)*0.95;      // asymmetric: abrupt east wall
  const ridgeFall = Math.exp(-(dd*dd)/(2*360*360));
  const zmask = smooth(1750,1450,Math.abs(z));
  const rn = ridged(x*0.0028, z*0.0028, 5);
  let range = ridgeFall*zmask*(230 + 640*rn);

  // named summit boosts
  for(const p of PEAKS){
    const dx=x-p.x, dz=z-p.z;
    const g = Math.exp(-(dx*dx+dz*dz)/(2*p.sig*p.sig));
    range += g*p.amp*(0.75+0.5*rn)*zmask;
  }
  h += range;

  // ——— Snake River: only carves the valley, not the peaks ———
  if(range < 60){
    const dRiv = Math.abs(x - riverX(z));
    const carve = smooth(95,22,dRiv)*(1-range/60);
    h = lerp(h, 24, clamp(carve,0,1)*0.95);
  }

  // ——— glacial lakes at the mountain front ———
  for(const L of LAKES){
    const dx=(x-L.x)/L.sx, dz=(z-L.z)/L.sz;
    const g = Math.exp(-(dx*dx+dz*dz)*1.6);
    h = lerp(h, L.bed, clamp(g*1.9,0,1));
  }

  // ——— floating-island fade ———
  const m = smooth(1.0,0.86,r);
  h = lerp(-48, h, m*m*(0.6+0.4*m));
  return h;
}
