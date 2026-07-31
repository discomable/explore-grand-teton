#!/usr/bin/env python3
"""Re-bake terrain/public/forestmask.png at a FINER resolution from the NAIP imagery tiles.

The old mask was baked from z3 (20 m) imagery. This classifies from z5 (5 m) imagery — so tree
clumps are resolved 4x finer — then downsamples the probability to a memory-safe OUTPUT_RES
(default 10 m, 2x finer than the old 20 m). The runtime (ScatterManager.ForestMask.probAt) reads
res/width/height/originE/originN from forestmask.json, so a finer mask is drop-in.

Classifier (same idea as the documented recipe): forest = DARK and GREEN-DOMINANT.
  prob = smoothstep_down(brightness, DARK_HI..DARK_LO) * smoothstep_up(green_excess, G_LO..G_HI)
then a small box blur. Tune the four thresholds + inspect forestmask_overlay.png before shipping.

Usage: ./.venv/bin/python bake_forestmask.py            # bake + overlay, does NOT overwrite
       ./.venv/bin/python bake_forestmask.py --write    # also overwrite public/forestmask.{png,json}
"""
import json, os, sys, glob
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
IMG = os.path.join(PUB, 'imagery')

SRC_Z = 5            # source zoom to classify (5 m/px)
OUTPUT_RES = 10.0    # metres/px of the emitted mask (memory-safe; 2x finer than the old 20 m)

# --- classifier thresholds (tune via the overlay) ---
DARK_LO, DARK_HI = 58.0, 108.0     # brightness: <=LO fully "dark", >=HI not dark (conifers ~45-70)
G_LO, G_HI = 1.0, 10.0             # green_excess = G-0.5(R+B): mild green rejects grey rock/shadow + blue water
BLUR = 1                           # box-blur radius in output px (0 = none)
# Saturating remap applied AFTER the 5m->10m block-average. Averaging the finer classification
# dilutes canopy gaps, so a real stand comes out ~0.4-0.6 — but ScatterManager's placement gates
# (FAR.maskMin 0.42, near sstep(0.12,0.50)) were tuned for the old 20m mask that saturated to ~1 on
# forest, so un-remapped the finer mask THINS trees on real tree-blobs. This pushes forest back to
# ~1 (median 0.58->~0.9) while keeping non-forest low and edges graded, matching the old magnitude.
REMAP_LO, REMAP_HI = 0.09, 0.71


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def load_meta():
    tj = json.load(open(os.path.join(PUB, 'tiles.json')))
    im = json.load(open(os.path.join(PUB, 'imagery.json')))
    gt = tj['geoTransform']            # [originE, px, 0, originN, 0, -px]
    return {
        'originE': gt[0], 'originN': gt[3], 'nativePx': im['nativePixelSize'],
        'width': im['width'], 'height': im['height'], 'tileSize': im['tileSize'],
        'world': tj['world'],
    }


def reconstruct(z, meta):
    """Paste all z tiles into one RGB array, cropped to the valid (non-padding) extent."""
    scale = 2 ** (im_maxzoom() - z)             # native px per this-zoom px
    vw = meta['width'] // scale                 # valid width/height at this zoom
    vh = meta['height'] // scale
    ts = meta['tileSize']
    xdirs = sorted(int(d) for d in os.listdir(os.path.join(IMG, str(z))) if d.isdigit())
    nx = max(xdirs) + 1
    ny = 0
    for x in xdirs:
        for f in os.listdir(os.path.join(IMG, str(z), str(x))):
            if f.endswith('.webp'):
                ny = max(ny, int(f[:-5]) + 1)
    canvas = np.full((ny * ts, nx * ts, 3), 118, np.uint8)   # 118 = the pad grey
    for x in xdirs:
        for f in glob.glob(os.path.join(IMG, str(z), str(x), '*.webp')):
            y = int(os.path.basename(f)[:-5])
            canvas[y * ts:(y + 1) * ts, x * ts:(x + 1) * ts] = np.asarray(Image.open(f).convert('RGB'))
    return canvas[:vh, :vw], vw, vh


def im_maxzoom():
    return json.load(open(os.path.join(PUB, 'imagery.json')))['maxZoom']


def main():
    write = '--write' in sys.argv
    meta = load_meta()
    print(f'reconstructing z{SRC_Z} imagery ...')
    rgb, vw, vh = reconstruct(SRC_Z, meta)
    print(f'  z{SRC_Z} raster {vw}x{vh}')
    R = rgb[:, :, 0].astype(np.float32); G = rgb[:, :, 1].astype(np.float32); B = rgb[:, :, 2].astype(np.float32)
    bright = (R + G + B) / 3.0
    gexc = G - 0.5 * (R + B)
    # dark & green-excess & green>blue (the last rejects blue lake water, which is dark+weakly-green)
    prob = smoothstep(DARK_HI, DARK_LO, bright) * smoothstep(G_LO, G_HI, gexc) * smoothstep(-1.0, 5.0, G - B)
    prob = prob.astype(np.float32)

    # downsample from source res (5 m) to OUTPUT_RES by block-averaging the probability
    src_res = meta['nativePx'] * (2 ** (im_maxzoom() - SRC_Z))
    f = max(1, int(round(OUTPUT_RES / src_res)))
    oh, ow = vh // f, vw // f
    prob = prob[:oh * f, :ow * f].reshape(oh, f, ow, f).mean(axis=(1, 3))
    out_res = src_res * f
    prob = smoothstep(REMAP_LO, REMAP_HI, prob)     # restore forest magnitude (see note above)

    if BLUR > 0:                                    # cheap box blur (separable, wrap-safe via pad)
        from scipy.ndimage import uniform_filter
        prob = uniform_filter(prob, size=2 * BLUR + 1, mode='nearest')

    mask = np.clip(prob * 255.0, 0, 255).astype(np.uint8)
    print(f'  output mask {ow}x{oh} @ {out_res:.1f} m/px  (forest px {100*(mask>40).mean():.1f}%)')

    # RGBA png: R = probability (matches ForestMask: reads channel 0 /255)
    rgba = np.zeros((oh, ow, 4), np.uint8); rgba[:, :, 0] = mask; rgba[:, :, 3] = 255
    Image.fromarray(rgba, 'RGBA').save(os.path.join(HERE, 'forestmask_new.png'))

    # verification overlay: imagery (downsampled) with the mask painted red where prob>0.4
    ds = rgb[:oh * f, :ow * f].reshape(oh, f, ow, f, 3).mean(axis=(1, 3)).astype(np.uint8)
    ov = ds.copy(); red = mask > 100
    ov[red] = (0.45 * ov[red] + 0.55 * np.array([220, 30, 30])).astype(np.uint8)
    Image.fromarray(ov, 'RGB').save(os.path.join(HERE, 'forestmask_overlay.png'))
    print('  wrote forestmask_new.png + forestmask_overlay.png')

    js = {
        'crs': 'EPSG:32612', 'res': float(out_res), 'width': int(ow), 'height': int(oh),
        'originE': meta['originE'], 'originN': meta['originN'], 'url': 'forestmask.png',
        'world': meta['world'], 'encode': {'probR': {'scale': 255.0}},
        'source': f'NAIP z{SRC_Z} ({src_res:.1f} m) darkness+green-excess, downsampled to {out_res:.0f} m; '
                  f'smoothstep(bright {DARK_HI:.0f}->{DARK_LO:.0f})*smoothstep(gexc {G_LO:.0f}->{G_HI:.0f}), box blur {BLUR}',
    }
    json.dump(js, open(os.path.join(HERE, 'forestmask_new.json'), 'w'), indent=1)

    if write:
        import shutil
        shutil.copy(os.path.join(PUB, 'forestmask.png'), os.path.join(PUB, 'forestmask.png.bak'))
        shutil.copy(os.path.join(PUB, 'forestmask.json'), os.path.join(PUB, 'forestmask.json.bak'))
        Image.fromarray(rgba, 'RGBA').save(os.path.join(PUB, 'forestmask.png'))
        json.dump(js, open(os.path.join(PUB, 'forestmask.json'), 'w'), indent=1)
        print('  WROTE public/forestmask.{png,json} (old backed up to *.bak)')


if __name__ == '__main__':
    main()
