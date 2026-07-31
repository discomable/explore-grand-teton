export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateCandidateRandoms({
  cx, cz, cellSize = 256, treeCandidates, shrubCandidates,
}, cancelled) {
  const tree = new Float64Array(treeCandidates * 13);
  // Keep spatial invariants beside the exact RNG stream. These values are independent of
  // terrain/landcover state and can therefore be prepared safely while the cell is queued.
  // Float64 intentionally preserves the old main-thread arithmetic exactly.
  const treeSpatial = new Float64Array(treeCandidates * 5);
  const treeRng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x9E3779B9);
  for (let i = 0; i < tree.length; i++) {
    if ((i & 4095) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    tree[i] = treeRng();
  }
  for (let i = 0; i < treeCandidates; i++) {
    if ((i & 255) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    const r = i * 13, o = i * 5;
    const x = cx * cellSize + tree[r] * cellSize;
    const z = cz * cellSize + tree[r + 1] * cellSize;
    treeSpatial[o] = x;
    treeSpatial[o + 1] = z;
    treeSpatial[o + 2] = clumpNoise(x, z);
    treeSpatial[o + 3] = clumpNoise(x * 0.35 + 57.3, z * 0.35 - 113.7);
    treeSpatial[o + 4] = clumpNoise(x + 1731, z - 917);
  }

  const shrub = new Float64Array(shrubCandidates * 8);
  const shrubSpatial = new Float64Array(shrubCandidates * 2);
  const shrubRng = mulberry32(((cx * 83492791) ^ (cz * 297121507) ^ 0x51AB1E) >>> 0);
  for (let i = 0; i < shrub.length; i++) {
    if ((i & 4095) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    shrub[i] = shrubRng();
  }
  for (let i = 0; i < shrubCandidates; i++) {
    const r = i * 8, o = i * 2;
    shrubSpatial[o] = cx * cellSize + shrub[r] * cellSize;
    shrubSpatial[o + 1] = cz * cellSize + shrub[r + 1] * cellSize;
  }
  return { tree, treeSpatial, shrub, shrubSpatial };
}

function vhash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function clumpNoise(x, z) {
  const gx = x / 90, gz = z / 90, ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return lerp(lerp(vhash(ix, iz), vhash(ix + 1, iz), u),
              lerp(vhash(ix, iz + 1), vhash(ix + 1, iz + 1), u), v);
}

const TREE_DENSITY = { 41: .65, 42: .90, 43: .75, 52: .02, 71: .006,
  90: .50, 95: .03, 190: .18 };
const SHRUB_DENSITY = { 41: .10, 42: .06, 43: .10, 52: .80, 71: .30, 90: .25, 95: .45 };
const SPECIES = { conifer: 0, spire: 1, aspen: 2, cottonwood: 3, snag: 4, bb: 5 };
const VARIANTS = [[0, 1, 2], [3], [4, 5], [6, 7], null];
const sstep = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* Phase two consumes only immutable point-query results captured on the main thread. Keeping
 * those queries out of the worker avoids copying the large live terrain/landcover indexes while
 * moving the branch-heavy acceptance/species/pose/tint pass off the animation thread. */
export function processTreeSnapshot(payload, cancelled) {
  const { tree, treeSpatial, snapshot, band, coreMin, hasDotData, bandDensity, bandScale,
    treelineY, spireY0, spireY1, aspenMaxY, baseMeshM } = payload;
  const rows = [];
  for (let i = 0; i < snapshot.length / 10; i++) {
    if ((i & 255) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    const r = i * 13, so = i * 5, q = i * 10;
    if (((i * 2654435761) >>> 0) % 1024 >= bandDensity * 1024) continue;
    const cls = snapshot[q], evh = snapshot[q + 1], evc = snapshot[q + 2];
    const h = snapshot[q + 3], fp = snapshot[q + 4];
    if (!TREE_DENSITY[cls] || snapshot[q + 5] || snapshot[q + 6] > .55 ||
        snapshot[q + 9]) continue;
    if (evh >= 0 && evh < 3 && h > treelineY - 450) continue;
    let d = TREE_DENSITY[cls];
    d *= d > .2 ? .15 + .85 * sstep(.30, .62, treeSpatial[so + 2])
                : .06 + 2.1 * sstep(.38, .80, treeSpatial[so + 3]);
    if (evc >= 0) d *= Math.max(.2, Math.min(1.15, evc / 55));
    if (fp > -2) {
      if (hasDotData && fp < coreMin) continue;
      d *= sstep(.12, .50, fp);
    }
    if (tree[r + 2] > d) continue;
    const tl = 1 - sstep(treelineY - 150, treelineY, h);
    if (tl <= 0 || tree[r + 9] > tl) continue;

    let sp = 'conifer', rp = tree[r + 6], rt = tree[r + 7];
    if (cls === 41) sp = rp < .80 ? 'aspen' : 'conifer';
    else if (cls === 43) sp = rp < .45 ? 'aspen' : 'conifer';
    else if (cls === 90) sp = rp < .50 ? 'cottonwood' : (rp < .82 ? 'spire' : 'aspen');
    else if (cls === 190) sp = 'cottonwood';
    if (sp === 'conifer') {
      if (rt < sstep(spireY0, spireY1, h)) sp = 'spire';
      else if (rt > .968 && (cls === 42 || cls === 43)) sp = 'snag';
    }
    if (sp === 'aspen') {
      if (h > aspenMaxY) sp = 'spire';
      else if (treeSpatial[so + 4] < .42) sp = 'conifer';
    }
    const variants = VARIANTS[SPECIES[sp]];
    const col = variants ? variants[(tree[r + 12] * variants.length) | 0] : 0;
    const krum = 1 + (.55 - 1) * sstep(treelineY - 260, treelineY - 30, h);
    let base = .72 + tree[r + 3] * .85;
    if (evh > 0) base = Math.max(.5, Math.min(2, evh / baseMeshM)) * (.85 + tree[r + 3] * .30);
    let s0 = base * krum;
    if (sp === 'aspen') s0 *= .72;
    if (sp === 'cottonwood') s0 *= 1.30;
    if (cls === 190) s0 *= .62;
    if (cls === 52 || cls === 71) s0 *= .55;
    const roadLimit = snapshot[q + 8] + 3 + 2 * Math.min(1, Math.max(0, (s0 - .9) * 2));
    if (snapshot[q + 7] < roadLimit) continue;
    const s = s0 * bandScale;
    let tilt = (tree[r + 8] - .5) * .09;
    if (band > 0) {
      if (sp === 'snag') continue;
      sp = 'bb'; tilt = 0;
    }
    const t = .93 + tree[r + 10] * .14, tint = tree[r + 11];
    rows.push(treeSpatial[so], treeSpatial[so + 1], h, SPECIES[sp], s,
      s * (.85 + tree[r + 4] * .4), tree[r + 5] * Math.PI * 2, tilt,
      t * (.97 + tint * .06), t, t * (.95 + tint * .08), col / 8);
  }
  return Float64Array.from(rows);
}

/* Shrub acceptance and presentation is the remaining branch-heavy near-cell pass. Query results
 * are captured incrementally on the main thread, while this function preserves the original
 * candidate order, RNG stream, cap semantics, scale, pose, and tint exactly. */
export function processShrubSnapshot(payload, cancelled) {
  const { shrub, shrubSpatial, shrubSnapshot, maxShrubs, sageY0, sageY1 } = payload;
  const rows = [];
  let accepted = 0;
  for (let i = 0; i < shrubSnapshot.length / 6 && accepted < maxShrubs; i++) {
    if ((i & 255) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    const r = i * 8, so = i * 2, q = i * 6;
    const cls = shrubSnapshot[q], h = shrubSnapshot[q + 1];
    const sd = SHRUB_DENSITY[cls] || 0;
    if (!sd || shrub[r + 2] > sd || shrubSnapshot[q + 2]) continue;
    if (shrubSnapshot[q + 3] < shrubSnapshot[q + 4] + .5 ||
        shrubSnapshot[q + 5]) continue;
    if (shrub[r + 7] > 1 - sstep(sageY0, sageY1, h)) continue;
    const s = .5 + shrub[r + 3] * .55;
    const t = .75 + shrub[r + 5] * .5;
    const rabbitbrush = shrub[r + 6] > .88;
    rows.push(shrubSpatial[so], shrubSpatial[so + 1], h, s,
      s * (.8 + shrub[r + 5] * .4), shrub[r + 4] * Math.PI * 2,
      rabbitbrush ? t * 1.08 : t * (.94 + shrub[r + 6] * .12),
      t, rabbitbrush ? t * .55 : t * (.9 + shrub[r + 6] * .15));
    accepted++;
  }
  return Float64Array.from(rows);
}

/* Imagery dots already contain their stable world position and strength. The main thread snapshots
 * only the live terrain/exclusion queries; deterministic dot hashing and instance presentation can
 * then run here without transferring the underlying park-wide point index. */
export function processDotSnapshot(payload, cancelled) {
  const { dotSnapshot, band, coreMin, bandScale, maxTrees, spireY0, spireY1 } = payload;
  const rows = [];
  let accepted = 0;
  for (let i = 0; i < dotSnapshot.length / 10 && accepted < maxTrees; i++) {
    if ((i & 255) === 0 && cancelled?.()) throw new DOMException('cancelled', 'AbortError');
    const q = i * 10;
    const pi = dotSnapshot[q], px = dotSnapshot[q + 1], pz = dotSnapshot[q + 2];
    const str = dotSnapshot[q + 3], fp = dotSnapshot[q + 4], h = dotSnapshot[q + 5];
    const pKeep = band === 0 ? 1 : band === 1 ? .82 : .64;
    if (band > 0 && ((pi * 2654435761) >>> 0) % 1024 >= pKeep * 1024) continue;
    if (fp > -2 && fp >= coreMin) continue;
    if (dotSnapshot[q + 6] ||
        dotSnapshot[q + 7] < dotSnapshot[q + 8] + 3 ||
        dotSnapshot[q + 9]) continue;
    const prng = mulberry32(((Math.round(px * 8) * 73856093) ^
      (Math.round(pz * 8) * 19349663) ^ 0xD07) >>> 0);
    const rr = prng(), ry = prng(), rb = prng(), rc = prng(), rw = prng(), rq = prng();
    const preserve = fp === -3;
    let sp = preserve ? 'cottonwood' :
      (rb < sstep(spireY0, spireY1, h) ? 'spire' : 'conifer');
    const variants = VARIANTS[SPECIES[sp]];
    const col = variants[(rc * variants.length) | 0];
    const s = (preserve ? .46 + str * .20 : 1.05 + str * .9) * bandScale;
    let tilt = (ry - .5) * .09;
    if (band > 0) { sp = 'bb'; tilt = 0; }
    const t = .93 + rw * .14;
    rows.push(px, pz, h, SPECIES[sp], s, s * (.85 + ry * .4),
      rr * Math.PI * 2, tilt, t * (.97 + rq * .06), t,
      t * (.95 + rq * .08), col / 8);
    accepted++;
  }
  return Float64Array.from(rows);
}
