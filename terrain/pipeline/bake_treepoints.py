#!/usr/bin/env python3
"""PROTOTYPE — detect individual tree dots in the NAIP imagery and bake their WORLD positions.

Unlike forestmask.png (a probability field that only gates a RANDOM scatter), this finds the
actual dark tree crowns in the native 1.25 m imagery and emits a point per crown, so the renderer
can place a billboard ON each dot. Scoped to one region (the moraine forest) for the prototype.

Detector: treeness = darkness * green-dominance (same discriminator as the mask). Smooth to crown
scale, then take local maxima with a minimum spacing (non-max via a maximum_filter window) so each
crown yields one point. In closed canopy the maxima pack in at canopy spacing; on scattered
sage-edge trees they land on the individual dots — which is exactly where alignment matters.

Outputs (in pipeline/): treepoints.json (world [x,z,strength] list + region), treepoints_overlay.png
(region imagery with a marker on every detected point — CHECK THIS before wiring the renderer).

Usage: ./.venv/bin/python bake_treepoints.py           # detect + overlay
       ./.venv/bin/python bake_treepoints.py --write   # also copy treepoints.json to ../public/
"""
import json, os, sys, glob
import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter, maximum_filter

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
IMG = os.path.join(PUB, 'imagery')

# --- prototype region in WORLD coords (moraine forest, where shots 74-76 were taken) ---
REGION_X = (-1500.0, -400.0)
REGION_Z = (200.0, 1100.0)

SRC_Z = 7                       # native 1.25 m imagery — resolves individual crowns
MIN_SPACING_M = 6.0             # min distance between trees (crown ~ this wide)
DARK_LO, DARK_HI = 58.0, 108.0  # same tree discriminator as forestmask
G_LO, G_HI = 1.0, 10.0
TREENESS_MIN = 0.25             # reject weak (non-forest) maxima


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def load_meta():
    tj = json.load(open(os.path.join(PUB, 'tiles.json')))
    im = json.load(open(os.path.join(PUB, 'imagery.json')))
    gt = tj['geoTransform']
    return {'originE': gt[0], 'originN': gt[3], 'px': im['nativePixelSize'], 'ts': im['tileSize'],
            'maxZoom': im['maxZoom'], 'cE': tj['world']['centerEasting'], 'cN': tj['world']['centerNorthing'],
            'world': tj['world']}


def crop_region(m):
    """Assemble ONLY the z7 tiles overlapping REGION into a cropped RGB array + its pixel origin."""
    px = m['px'] * (2 ** (m['maxZoom'] - SRC_Z))     # 1.25 at z7
    # world -> native pixel (col=east, row=south); see ForestMask.probAt registration
    col0 = (REGION_X[0] + m['cE'] - m['originE']) / px
    col1 = (REGION_X[1] + m['cE'] - m['originE']) / px
    row0 = (m['originN'] - (m['cN'] - REGION_Z[0])) / px
    row1 = (m['originN'] - (m['cN'] - REGION_Z[1])) / px
    c0, c1 = int(np.floor(min(col0, col1))), int(np.ceil(max(col0, col1)))
    r0, r1 = int(np.floor(min(row0, row1))), int(np.ceil(max(row0, row1)))
    ts = m['ts']
    tx0, tx1 = c0 // ts, c1 // ts
    ty0, ty1 = r0 // ts, r1 // ts
    canvas = np.full(((ty1 - ty0 + 1) * ts, (tx1 - tx0 + 1) * ts, 3), 118, np.uint8)
    for tx in range(tx0, tx1 + 1):
        for f in glob.glob(os.path.join(IMG, str(SRC_Z), str(tx), '*.webp')):
            ty = int(os.path.basename(f)[:-5])
            if ty < ty0 or ty > ty1:
                continue
            canvas[(ty - ty0) * ts:(ty - ty0 + 1) * ts, (tx - tx0) * ts:(tx - tx0 + 1) * ts] = \
                np.asarray(Image.open(f).convert('RGB'))
    crop = canvas[r0 - ty0 * ts:r1 - ty0 * ts, c0 - tx0 * ts:c1 - tx0 * ts]
    return crop, c0, r0, px


def main():
    write = '--write' in sys.argv
    m = load_meta()
    rgb, c0, r0, px = crop_region(m)
    H, W = rgb.shape[:2]
    print(f'region raster {W}x{H} @ {px} m/px  ({REGION_X} x {REGION_Z})')
    R, G, B = rgb[:, :, 0].astype(np.float32), rgb[:, :, 1].astype(np.float32), rgb[:, :, 2].astype(np.float32)
    bright = (R + G + B) / 3.0
    gexc = G - 0.5 * (R + B)
    treeness = smoothstep(DARK_HI, DARK_LO, bright) * smoothstep(G_LO, G_HI, gexc) * smoothstep(-1.0, 5.0, G - B)
    treeness = uniform_filter(treeness.astype(np.float32), size=3)    # merge px-noise into crown blobs

    win = max(3, int(round(MIN_SPACING_M / px)) | 1)                  # odd window ~ min spacing
    mx = maximum_filter(treeness, size=win)
    peaks = (treeness == mx) & (treeness > TREENESS_MIN)
    ys, xs = np.nonzero(peaks)
    strength = treeness[ys, xs]
    print(f'  detected {len(xs)} tree points (min spacing {MIN_SPACING_M} m, window {win}px)')

    # native pixel -> world (inverse of the registration above)
    E = m['originE'] + (c0 + xs) * px
    N = m['originN'] - (r0 + ys) * px
    wx = E - m['cE']
    wz = m['cN'] - N
    pts = [[round(float(a), 2), round(float(b), 2), round(float(s), 3)] for a, b, s in zip(wx, wz, strength)]

    js = {'crs': 'EPSG:32612', 'regionX': list(REGION_X), 'regionZ': list(REGION_Z),
          'count': len(pts), 'minSpacing': MIN_SPACING_M, 'world': m['world'], 'points': pts,
          'source': f'NAIP z{SRC_Z} ({px} m) darkness*green local maxima, spacing {MIN_SPACING_M} m'}
    json.dump(js, open(os.path.join(HERE, 'treepoints.json'), 'w'))
    print(f'  wrote treepoints.json ({len(pts)} pts)')

    # verification overlay: region imagery with a 3px magenta cross on every detected point
    ov = rgb.copy()
    for x, y in zip(xs, ys):
        ov[max(0, y - 2):y + 3, x] = (255, 0, 255)
        ov[y, max(0, x - 2):x + 3] = (255, 0, 255)
    Image.fromarray(ov, 'RGB').save(os.path.join(HERE, 'treepoints_overlay.png'))
    print('  wrote treepoints_overlay.png  (check the crosses sit on the dark dots)')

    if write:
        import shutil
        shutil.copy(os.path.join(HERE, 'treepoints.json'), os.path.join(PUB, 'treepoints.json'))
        print('  copied treepoints.json -> public/')


if __name__ == '__main__':
    main()
