export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ten fixed draws per candidate, matching GroundCover's historical sequence exactly.
export function generateGroundCoverRandoms({ cx, cz, candidates, v2 }, cancelled) {
  const salt = v2 ? 0x62B10E : 0x6C0FFEE;
  const rng = mulberry32(((cx * 73856093) ^ (cz * 19349663) ^ salt) >>> 0);
  const randoms = new Float64Array(candidates * 10);
  for (let i = 0; i < randoms.length; i++) {
    if ((i & 4095) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    randoms[i] = rng();
  }
  return randoms;
}

const DENSITY = { 71: 1.0, 52: 0.95, 41: 0.45, 42: 0.40, 43: 0.45, 90: 0.85, 95: 0.95 };
const sstep = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const vhash = (x, z) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function patchNoise(x, z, scale, salt) {
  const gx = x / scale, gz = z / scale, ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const h = (a, b) => vhash(a + salt * 17.13, b - salt * 11.71);
  const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * u;
  const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * u;
  return a + (b - a) * v;
}
function clumpNoise(x, z) {
  const oct = S => patchNoise(x, z, S, 0);
  return oct(22) * 0.62 + oct(7.3) * 0.38;
}

// Matches THREE.Object3D's default XYZ Euler + scale + translation matrix composition.
function matrixXYZ(out, offset, x, y, z, rx, ry, rz, sx, sy, sz) {
  const c1 = Math.cos(rx / 2), c2 = Math.cos(ry / 2), c3 = Math.cos(rz / 2);
  const s1 = Math.sin(rx / 2), s2 = Math.sin(ry / 2), s3 = Math.sin(rz / 2);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  out[offset] = (1 - (yy + zz)) * sx; out[offset + 1] = (xy + wz) * sx;
  out[offset + 2] = (xz - wy) * sx; out[offset + 3] = 0;
  out[offset + 4] = (xy - wz) * sy; out[offset + 5] = (1 - (xx + zz)) * sy;
  out[offset + 6] = (yz + wx) * sy; out[offset + 7] = 0;
  out[offset + 8] = (xz + wy) * sz; out[offset + 9] = (yz - wx) * sz;
  out[offset + 10] = (1 - (xx + yy)) * sz; out[offset + 11] = 0;
  out[offset + 12] = x; out[offset + 13] = y; out[offset + 14] = z; out[offset + 15] = 1;
}

export function finalizeGroundCover(payload, cancelled) {
  const { v2, candidates, perCell, densityScale = 1 } = payload;
  const randoms = new Float64Array(payload.randoms);
  const samples = new Float64Array(payload.samples); // x,z,h,hx,hz,tintR,tintG,tintB
  const classes = new Uint8Array(payload.classes);
  const flags = new Uint8Array(payload.flags); // bit0 water, bit1 road, bit2 building, bit3 tint
  const matrices = new Float32Array(perCell * 16);
  const colors = new Float32Array(perCell * 3);
  const atlas = new Float32Array(perCell);
  let n = 0;
  for (let i = 0; i < candidates && n < perCell; i++) {
    if ((i & 511) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    const o = i * 10, p = i * 8;
    const rd = randoms[o + 2], rv = randoms[o + 3], rs = randoms[o + 4];
    const ry = randoms[o + 5], rr = randoms[o + 6], rt = randoms[o + 7];
    const rq = randoms[o + 8], rh = randoms[o + 9];
    const x = samples[p], z = samples[p + 1], h = samples[p + 2], cls = classes[i];
    if (flags[i] & 7 || rh < sstep(870, 950, h)) continue;
    let v, cr, cg, cb, s, wide = 1, tall = 1, rx = 0, rz = 0;
    if (!v2) {
      let d = DENSITY[cls] || 0;
      if (!d || rd > d * (0.88 + 0.22 * clumpNoise(x, z))) continue;
      const flower = (cls === 71 || cls === 52) && vhash(x * 2.3 + 11, z * 1.9 - 7) < 0.14;
      let tintK = 0;
      if (flower) {
        v = 4; const t = 0.90 + rq * 0.20; cr = cg = cb = t; s = 0.50 + rs * 0.45;
      } else if (cls === 71 || cls === 90 || cls === 95) {
        v = 0; const t = 0.85 + rq * 0.30; cr = t * 0.86; cg = t; cb = t * 0.64;
        s = 0.55 + rs * 0.55; tintK = 0.30;
      } else if (cls === 52) {
        if (rv < 0.30) {
          v = 2; const t = 0.74 + rq * 0.28; cr = t * 0.98; cg = t; cb = t * 0.86;
          s = 0.32 + rs * 0.34;
        } else {
          v = 1; const t = 0.80 + rq * 0.26; cr = t * 1.02; cg = t; cb = t * 0.90;
          s = 0.30 + rs * 0.30;
        }
        tintK = 0.55;
      } else {
        v = 3; const t = 0.65 + rq * 0.35; cr = t * 0.90; cg = t; cb = t * 0.90;
        s = 0.30 + rs * 0.40; tintK = 0.30;
      }
      if (tintK && (flags[i] & 8)) {
        const refs = [[.42,.60,.28],[.64,.68,.48],[.40,.46,.32],[.21,.29,.17],[.55,.60,.42]];
        const ref = refs[v], tr = samples[p + 5], tg = samples[p + 6], tb = samples[p + 7];
        const tl = .299 * tr + .587 * tg + .114 * tb;
        const rl = .299 * ref[0] + .587 * ref[1] + .114 * ref[2];
        const k = tl > 1e-3 ? rl / tl : 1, jit = .9 + rq * .2;
        const clmp = m => Math.max(.6, Math.min(1.5, m)) * jit;
        cr += (clmp(tr * k / ref[0]) - cr) * tintK;
        cg += (clmp(tg * k / ref[1]) - cg) * tintK;
        cb += (clmp(tb * k / ref[2]) - cb) * tintK;
        cr = Math.min(1, cr); cg = Math.min(1, cg); cb = Math.min(1, cb);
      }
      tall = .80 + ry * .45;
      rz = (rt - .5) * .14;
    } else {
      const lush = cls === 71 || cls === 90 || cls === 95;
      const sage = cls === 52, forest = cls === 41 || cls === 42 || cls === 43;
      if (!lush && !sage && !forest) continue;
      const sx = samples[p + 3] / 5, sz = samples[p + 4] / 5;
      if (Math.hypot(sx, sz) > (sage ? .62 : lush ? .40 : .52)) continue;
      const zone = patchNoise(x, z, 68, cls * .13);
      const stand = patchNoise(x, z, lush ? 13 : 17, cls * .31 + 2);
      const bunch = patchNoise(x, z, 3.8, cls * .47 + 7);
      const openCut = lush ? .13 : sage ? .22 : .34;
      const base = lush ? 1.08 : sage ? .94 : .58;
      const standEdge = sstep(openCut - .09, openCut + .13, stand);
      const zoneEdge = sage ? sstep(.16,.34,zone) : forest ? sstep(.25,.45,zone) : 1;
      const community = densityScale * base * standEdge * zoneEdge *
        (.30 + .88 * sstep(openCut,.82,stand)) *
        (.48 + .72 * sstep(.22,.82,bunch));
      const inside = rd <= community;
      const straw = payload.grassLod && sage && !inside && rd < .46 * densityScale && bunch > .20 && zone > .10;
      if (!inside && !straw) continue;
      const pick = vhash(x * 1.71 + 5, z * 1.37 - 9);
      if (straw) {
        v = 11; const t = .94 + rq * .06; cr=t; cg=t*.97; cb=t*.87;
        s=.28+rs*.24; wide=.76+rv*.24; tall=.50+ry*.18;
      } else if (lush) {
        if (patchNoise(x,z,9,19) > .78 && vhash(x*2.1,z*2.3) < .055) {
          v=9; cr=.93; cg=.94; cb=.88; s=.30+rs*.27; wide=.72;
        } else {
          v=pick<.42?0:pick<.84?1:2; const t=.88+rq*.12; cr=t*.94; cg=t; cb=t*.86;
          s=.42+rs*.48; tall=.82+ry*.24;
        }
      } else if (sage) {
        if (patchNoise(x,z,11,31) > .54 && pick < .34) {
          v=pick<.16?6:7; const t=.86+rq*.12; cr=t*.94; cg=t*.98; cb=t*.88;
          s=.34+rs*.34; wide=1.35+rv*.32; tall=.68+ry*.18;
        } else {
          v=pick<.45?3:pick<.83?4:5; const t=.87+rq*.12; cr=t; cg=t*.98; cb=t*.88;
          s=.27+rs*.32; wide=.86+rv*.25;
        }
      } else {
        v=pick<.76?8:10; const t=.80+rq*.14; cr=t*.93; cg=t*.97; cb=t*.84;
        s=.27+rs*.34; wide=.78+rv*.30;
      }
      if (flags[i] & 8) {
        const tr=samples[p+5], tg=samples[p+6], tb=samples[p+7];
        const lum=.299*tr+.587*tg+.114*tb;
        const nr=Math.min(.88,tr*(.62/Math.max(.25,lum)));
        const ng=Math.min(.88,tg*(.62/Math.max(.25,lum)));
        const nb=Math.min(.82,tb*(.62/Math.max(.25,lum)));
        const k=lush?.18:.30; cr+=(nr-cr)*k; cg+=(ng-cg)*k; cb+=(nb-cb)*k;
      }
      rx=Math.max(-.14,Math.min(.14,sz*.32));
      rz=Math.max(-.14,Math.min(.14,-sx*.32))+(rt-.5)*.05;
    }
    matrixXYZ(matrices, n * 16, x, h - (v2 ? .065 : .03), z, rx, rr*Math.PI*2, rz,
      s*wide, s*tall, s*wide);
    colors[n*3]=cr; colors[n*3+1]=cg; colors[n*3+2]=cb; atlas[n]=v; n++;
  }
  return { used: n, matrices, colors, atlas };
}
