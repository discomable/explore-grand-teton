#!/usr/bin/env python3
"""Park-wide HYBRID tree-dot bake: detect EDGE / scattered tree crowns across the whole park and
write their world positions as a compact binary. Dense closed-canopy crowns are intentionally
DROPPED — the renderer fills those with the cheap procedural scatter (you can't read individual
placement in a solid canopy anyway). This keeps the point set ~an order of magnitude smaller than
detecting every crown, while still snapping the VISIBLE scattered/edge trees onto the real dots.

Tiled by row-bands so the 746 Mpx native raster never loads at once. Detector matches the region
prototype (bake_treepoints.py): local maxima of darkness*green in native 1.25 m imagery. "Edge" =
the local forest fraction (in a ~40 m window) is below EDGE_MAX.

World mapping (from tiles.json/imagery.json): x = col*1.25 - 14160, z = row*1.25 - 20590.

Output (pipeline/, and --write copies to public/):
  treepoints.bin  : [uint32 count][int16 x[count]][int16 z[count]][uint8 strength[count]]  (metres)
  treepoints_meta.json : {count, cellSize, edgeMax, source}

Usage: ./.venv/bin/python bake_treepoints_full.py [--write]
"""
import json, os, sys, glob, struct
import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter, maximum_filter

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
IMG = os.path.join(PUB, 'imagery')

SRC_Z = 7                        # native 1.25 m
MIN_SPACING_M = 6.0
DARK_LO, DARK_HI = 58.0, 108.0
G_LO, G_HI = 1.0, 10.0
TREENESS_MIN = 0.25
EDGE_MAX = 1.01                  # FULL mode: keep every crown (edges AND dense core). <1.0 = edges only.
EDGE_WIN_M = 40.0
CELL_M = 256                     # per-cell cap grid (matches ScatterManager cellSize)
CELL_CAP = 450                   # keep at most this many (strongest) crowns per cell -> flat draw cost
BAND_TROWS = 4                   # tile-rows processed per band (512 px each) — caps memory
OVERLAP_TROWS = 1               # context rows on each side so max-filter is seamless at band seams


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def load_meta():
    im = json.load(open(os.path.join(PUB, 'imagery.json')))
    tj = json.load(open(os.path.join(PUB, 'tiles.json')))
    gt = tj['geoTransform']
    px = im['nativePixelSize'] * (2 ** (im['maxZoom'] - SRC_Z))
    cE, cN = tj['world']['centerEasting'], tj['world']['centerNorthing']
    return {'px': px, 'ts': im['tileSize'], 'W': im['width'], 'H': im['height'],
            'x_off': gt[0] - cE, 'z_off': cN - gt[3], 'world': tj['world']}   # x=col*px+x_off, z=row*px+z_off


def load_band(z, col_dirs, tr_lo, tr_hi, ts):
    """Assemble tile-rows [tr_lo, tr_hi) across all columns into one RGB array (pad grey = 118)."""
    ncol = max(col_dirs) + 1
    canvas = np.full(((tr_hi - tr_lo) * ts, ncol * ts, 3), 118, np.uint8)
    for cx in col_dirs:
        for f in glob.glob(os.path.join(IMG, str(z), str(cx), '*.webp')):
            ty = int(os.path.basename(f)[:-5])
            if ty < tr_lo or ty >= tr_hi:
                continue
            canvas[(ty - tr_lo) * ts:(ty - tr_lo + 1) * ts, cx * ts:(cx + 1) * ts] = \
                np.asarray(Image.open(f).convert('RGB'))
    return canvas


def main():
    write = '--write' in sys.argv
    m = load_meta()
    px, ts = m['px'], m['ts']
    col_dirs = sorted(int(d) for d in os.listdir(os.path.join(IMG, str(SRC_Z))) if d.isdigit())
    ntrows = 0
    for cx in col_dirs:
        for f in os.listdir(os.path.join(IMG, str(SRC_Z), str(cx))):
            if f.endswith('.webp'):
                ntrows = max(ntrows, int(f[:-5]) + 1)
    win = max(3, int(round(MIN_SPACING_M / px)) | 1)
    edge_win = max(3, int(round(EDGE_WIN_M / px)) | 1)
    print(f'z{SRC_Z} {px} m/px, {len(col_dirs)} cols x {ntrows} tile-rows; band={BAND_TROWS} trows, win={win}, edgewin={edge_win}')

    xs_all, zs_all, ss_all = [], [], []
    for t0 in range(0, ntrows, BAND_TROWS):
        t1 = min(ntrows, t0 + BAND_TROWS)
        lo, hi = max(0, t0 - OVERLAP_TROWS), min(ntrows, t1 + OVERLAP_TROWS)
        rgb = load_band(SRC_Z, col_dirs, lo, hi, ts)
        R, G, B = rgb[:, :, 0].astype(np.float32), rgb[:, :, 1].astype(np.float32), rgb[:, :, 2].astype(np.float32)
        treeness = smoothstep(DARK_HI, DARK_LO, (R + G + B) / 3.0) * \
                   smoothstep(G_LO, G_HI, G - 0.5 * (R + B)) * smoothstep(-1.0, 5.0, G - B)
        treeness = uniform_filter(treeness.astype(np.float32), size=3)
        localdens = uniform_filter((treeness > TREENESS_MIN).astype(np.float32), size=edge_win)
        peaks = (treeness == maximum_filter(treeness, size=win)) & (treeness > TREENESS_MIN) & (localdens < EDGE_MAX)
        ys, xs = np.nonzero(peaks)
        grow = lo * ts + ys                                   # global pixel row
        keep = (grow >= t0 * ts) & (grow < t1 * ts)           # core band only (dedupe overlap)
        gcol = xs[keep]
        grow = grow[keep]
        xs_all.append(gcol.astype(np.float64) * px + m['x_off'])
        zs_all.append(grow.astype(np.float64) * px + m['z_off'])
        ss_all.append(treeness[ys[keep], xs[keep]])
        print(f'  band trows [{t0},{t1})  +{keep.sum()} pts  (total {sum(len(a) for a in xs_all)})')
        del rgb, R, G, B, treeness, localdens, peaks

    X = np.concatenate(xs_all); Z = np.concatenate(zs_all); S = np.concatenate(ss_all)
    print(f'  {len(X):,} raw crowns -> capping to {CELL_CAP}/cell (strongest)')
    # per-cell cap: sort by (cell, strength desc), keep the top CELL_CAP of each cell. Bounds the
    # point count AND the runtime draw count, and drops the WEAKEST crowns first (denser canopy keeps
    # more), so the thinning tracks real canopy density instead of leaving cell-aligned gradients.
    cell = (np.floor(X / CELL_M).astype(np.int64) + 4096) * 8192 + (np.floor(Z / CELL_M).astype(np.int64) + 4096)
    order = np.lexsort((-S, cell))                     # cells contiguous, strongest first within each
    cs = cell[order]
    uniq, inv, counts = np.unique(cs, return_inverse=True, return_counts=True)
    start = np.zeros(len(uniq), np.int64); start[1:] = np.cumsum(counts)[:-1]
    rank = np.arange(len(cs)) - start[inv]
    sel = order[rank < CELL_CAP]
    X, Z, S = X[sel], Z[sel], S[sel]
    n = len(X)
    xi = np.clip(np.round(X), -32768, 32767).astype('<i2')
    zi = np.clip(np.round(Z), -32768, 32767).astype('<i2')
    si = np.clip(np.round(S * 255), 0, 255).astype('<u1')
    buf = struct.pack('<I', n) + xi.tobytes() + zi.tobytes() + si.tobytes()
    open(os.path.join(HERE, 'treepoints.bin'), 'wb').write(buf)
    full = EDGE_MAX >= 1.0
    meta = {'count': int(n), 'cellSize': CELL_M, 'edgeMax': EDGE_MAX, 'cellCap': CELL_CAP,
            'coreMin': 2.0 if full else 0.55,   # >1 => FULL: points everywhere, procedural trees off
            'minSpacing': MIN_SPACING_M,
            'source': f'NAIP z{SRC_Z} ({px} m) {"ALL" if full else "edge"} crowns, cap {CELL_CAP}/cell; x=col*{px}-14160, z=row*{px}-20590'}
    json.dump(meta, open(os.path.join(HERE, 'treepoints_meta.json'), 'w'))
    print(f'\nTOTAL {n:,} points -> treepoints.bin ({len(buf)/1e6:.1f} MB)')

    if write:
        import shutil
        shutil.copy(os.path.join(HERE, 'treepoints.bin'), os.path.join(PUB, 'treepoints.bin'))
        shutil.copy(os.path.join(HERE, 'treepoints_meta.json'), os.path.join(PUB, 'treepoints_meta.json'))
        print('  copied treepoints.bin + treepoints_meta.json -> public/')


if __name__ == '__main__':
    main()
