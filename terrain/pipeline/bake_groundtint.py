#!/usr/bin/env python3
"""Bake terrain/public/groundtint.png — a coarse per-cell GROUND COLOUR map from the NAIP imagery.

GroundCover's near-field grass/sage cards were coloured from the NLCD class + rng, so a meadow got
one gold and a sage flat got one grey-green regardless of what the photography under the camera
actually looks like. This bakes the true local ground colour (gold meadow vs. grey sage vs. dry
dirt) so the cards can be tinted to match the draped imagery — killing the near-field-carpet vs.
photography seam.

Colour = mean RGB over the OPEN-GROUND pixels of each output cell, i.e. excluding tree pixels
(dark AND green>blue) and water pixels (blue>=green) so conifer shadow / lake blue don't drag the
tint. Cells with no open ground (solid forest / open water — where GroundCover grows nothing
anyway) fall back to the raw block mean. Output is coarse (default 20 m/px): ground colour varies
slowly and GroundCover samples it bilinearly, so a small map is plenty and costs ~9 MB in-browser.

Same world extent / origin / json schema as forestmask, so a GroundTint sampler mirrors ForestMask.

Usage: ./.venv/bin/python bake_groundtint.py            # bake, does NOT overwrite public
       ./.venv/bin/python bake_groundtint.py --write    # also write public/groundtint.{png,json}
"""
import json, os, sys, glob
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
IMG = os.path.join(PUB, 'imagery')

SRC_Z = 5            # source zoom to sample (5 m/px)
OUTPUT_RES = 20.0    # metres/px of the emitted tint map (coarse; tint varies slowly, ~9 MB RGB)
SAT = 1.12           # mild saturation lift so tufts read as vegetation, not washed grey


def load_meta():
    tj = json.load(open(os.path.join(PUB, 'tiles.json')))
    im = json.load(open(os.path.join(PUB, 'imagery.json')))
    gt = tj['geoTransform']
    return {'originE': gt[0], 'originN': gt[3], 'nativePx': im['nativePixelSize'],
            'width': im['width'], 'height': im['height'], 'tileSize': im['tileSize'],
            'world': tj['world'], 'maxZoom': im['maxZoom']}


def reconstruct(z, meta):
    """Paste all z tiles into one RGB array, cropped to the valid (non-padding) extent."""
    scale = 2 ** (meta['maxZoom'] - z)
    vw, vh, ts = meta['width'] // scale, meta['height'] // scale, meta['tileSize']
    xdirs = sorted(int(d) for d in os.listdir(os.path.join(IMG, str(z))) if d.isdigit())
    nx = max(xdirs) + 1
    ny = 0
    for x in xdirs:
        for f in os.listdir(os.path.join(IMG, str(z), str(x))):
            if f.endswith('.webp'):
                ny = max(ny, int(f[:-5]) + 1)
    canvas = np.full((ny * ts, nx * ts, 3), 118, np.uint8)
    for x in xdirs:
        for f in glob.glob(os.path.join(IMG, str(z), str(x), '*.webp')):
            y = int(os.path.basename(f)[:-5])
            canvas[y * ts:(y + 1) * ts, x * ts:(x + 1) * ts] = np.asarray(Image.open(f).convert('RGB'))
    return canvas[:vh, :vw], vw, vh


def main():
    write = '--write' in sys.argv
    meta = load_meta()
    print(f'reconstructing z{SRC_Z} imagery ...')
    rgb, vw, vh = reconstruct(SRC_Z, meta)
    print(f'  z{SRC_Z} raster {vw}x{vh}')
    R = rgb[:, :, 0].astype(np.float32); G = rgb[:, :, 1].astype(np.float32); B = rgb[:, :, 2].astype(np.float32)
    bright = (R + G + B) / 3.0
    gexc = G - 0.5 * (R + B)
    tree = (bright < 108.0) & (gexc > 6.0) & (G > B)     # matches forestmask's dark+green-dominant
    water = B >= G + 1.0                                 # blue lake / river
    ground = ~(tree | water)                             # open ground: grass / sage / dirt / rock

    src_res = meta['nativePx'] * (2 ** (meta['maxZoom'] - SRC_Z))
    f = max(1, int(round(OUTPUT_RES / src_res)))
    oh, ow = vh // f, vw // f
    out_res = src_res * f

    def blocks(a):
        return a[:oh * f, :ow * f].reshape(oh, f, ow, f)

    gm = blocks(ground.astype(np.float32)).sum(axis=(1, 3))          # open-ground px count per cell
    # mean RGB over open-ground px per cell; where a cell is all tree/water, fall back to raw mean
    out = np.zeros((oh, ow, 3), np.float32)
    for c, chan in enumerate((R, G, B)):
        gsum = blocks((chan * ground).astype(np.float32)).sum(axis=(1, 3))
        raw = blocks(chan).mean(axis=(1, 3))
        out[:, :, c] = np.where(gm > 0.5, gsum / np.maximum(gm, 1e-6), raw)

    if SAT != 1.0:                                                    # lift saturation about the cell luma
        luma = out @ np.array([0.299, 0.587, 0.114], np.float32)
        out = np.clip(luma[..., None] + (out - luma[..., None]) * SAT, 0, 255)

    tint = np.clip(out, 0, 255).astype(np.uint8)
    print(f'  output tint {ow}x{oh} @ {out_res:.1f} m/px  (all-tree/water cells {100*(gm<=0.5).mean():.1f}%)')

    rgba = np.zeros((oh, ow, 4), np.uint8); rgba[:, :, :3] = tint; rgba[:, :, 3] = 255
    Image.fromarray(rgba, 'RGBA').save(os.path.join(HERE, 'groundtint_new.png'))
    Image.fromarray(tint, 'RGB').save(os.path.join(HERE, 'groundtint_preview.png'))
    print('  wrote groundtint_new.png + groundtint_preview.png')

    js = {'crs': 'EPSG:32612', 'res': float(out_res), 'width': int(ow), 'height': int(oh),
          'originE': meta['originE'], 'originN': meta['originN'], 'url': 'groundtint.png',
          'world': meta['world'], 'encode': {'rgb': 'ground colour 0..255'},
          'source': f'NAIP z{SRC_Z} ({src_res:.1f} m) open-ground mean (tree+water excluded), '
                    f'downsampled to {out_res:.0f} m, sat x{SAT}'}
    json.dump(js, open(os.path.join(HERE, 'groundtint_new.json'), 'w'), indent=1)

    if write:
        Image.fromarray(rgba, 'RGBA').save(os.path.join(PUB, 'groundtint.png'))
        json.dump(js, open(os.path.join(PUB, 'groundtint.json'), 'w'), indent=1)
        print('  WROTE public/groundtint.{png,json}')


if __name__ == '__main__':
    main()
