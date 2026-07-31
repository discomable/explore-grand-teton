"""Render roads/preview.png: class-colored overlay of the baked SDF (PIL only).

Left: distance channel (bright = on road). Right: nearest-class colors.
Run: .venv/bin/python roads/preview.py   (from terrain/pipeline/)
"""
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PNG_PATH = os.path.join(ROOT, 'public', 'roads.png')
META_PATH = os.path.join(ROOT, 'public', 'roads-meta.json')
OUT = os.path.join(os.path.dirname(__file__), 'preview.png')

CLASS_COLOR = {
  64: (150, 150, 150),    # track  - grey
  128: (200, 140, 60),    # gravel - tan
  192: (70, 130, 230),    # park_paved - blue
  255: (230, 60, 60),     # highway - red
}


def main():
  meta = json.load(open(META_PATH))
  img = np.asarray(Image.open(PNG_PATH).convert('RGB'))
  h, w = img.shape[:2]
  scale = max(1, max(h, w) // 1400)
  small = img[::scale, ::scale]
  sh, sw = small.shape[:2]

  # dilate near-road so thin lines survive downsampling: any pixel within distMax
  near = small[:, :, 0] < 200  # < ~31 m
  dist_vis = np.zeros((sh, sw, 3), np.uint8)
  dist_vis[near] = (255 - small[near][:, 0:1]).repeat(3, axis=1)  # brighter closer

  cls_vis = np.full((sh, sw, 3), 20, np.uint8)
  g = small[:, :, 1]
  for v, col in CLASS_COLOR.items():
    m = g == v
    cls_vis[m] = col

  gap = 8
  canvas = np.full((sh, sw * 2 + gap, 3), 255, np.uint8)
  canvas[:, :sw] = dist_vis
  canvas[:, sw + gap:] = cls_vis
  Image.fromarray(canvas, 'RGB').save(OUT)
  print('wrote %s (%dx%d, downsample x%d)  left=distance right=class'
        % (OUT, canvas.shape[1], canvas.shape[0], scale))
  print('legend: track=grey gravel=tan park_paved=blue highway=red')


if __name__ == '__main__':
  main()
