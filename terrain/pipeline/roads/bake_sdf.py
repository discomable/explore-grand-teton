"""Bake terrain/public/roads.png (+ roads-meta.json) from terrain/public/roads.json.

Encoding (RGB, 8-bit):
  R = distance to nearest road centerline, 0..255 over 0..40 m (>=40 m clamps to 255)
  G = class of nearest road: 0 none (>=40 m), 64 track, 128 gravel, 192 park_paved, 255 highway
  B = 0 (free)

Extent = bbox of all roads + 200 m margin. Target resolution 2 m/px; m/px is
raised (0.05 m steps) until both dimensions fit in 8192 px.

Pixel mapping (recorded in roads-meta.json):
  world x = originX + (px + 0.5) * res
  world z = originZ + (py + 0.5) * res      (row 0 = north edge, min z)

Run: .venv/bin/python roads/bake_sdf.py   (from terrain/pipeline/)
"""
import json
import math
import os

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ROADS_PATH = os.path.join(ROOT, 'public', 'roads.json')
PNG_PATH = os.path.join(ROOT, 'public', 'roads.png')
META_PATH = os.path.join(ROOT, 'public', 'roads-meta.json')

MARGIN = 200.0
MAX_DIM = 8192
BASE_RES = 2.0
DIST_MAX = 40.0
CLASS_VAL = {'track': 64, 'gravel': 128, 'park_paved': 192, 'highway': 255}


def main():
  roads = json.load(open(ROADS_PATH))
  xs = [p[0] for r in roads for p in r['pts']]
  zs = [p[1] for r in roads for p in r['pts']]
  x0, x1 = min(xs) - MARGIN, max(xs) + MARGIN
  z0, z1 = min(zs) - MARGIN, max(zs) + MARGIN
  ext = max(x1 - x0, z1 - z0)
  res = max(BASE_RES, math.ceil(ext / MAX_DIM / 0.05) * 0.05)
  width = int(math.ceil((x1 - x0) / res))
  height = int(math.ceil((z1 - z0) / res))
  print('extent x [%.0f, %.0f] z [%.0f, %.0f] -> %dx%d px @ %.2f m/px'
        % (x0, x1, z0, z1, width, height, res))
  assert width <= MAX_DIM and height <= MAX_DIM

  # --- rasterize centerlines; roads.json is sorted so higher classes overwrite
  cls = np.zeros((height, width), dtype=np.uint8)
  step = res * 0.5
  n_samples = 0
  for r in roads:
    v = CLASS_VAL[r['class']]
    pts = np.asarray(r['pts'], dtype=np.float64)
    seg = np.diff(pts, axis=0)
    lens = np.hypot(seg[:, 0], seg[:, 1])
    for i in range(len(seg)):
      n = max(2, int(lens[i] / step) + 1)
      t = np.linspace(0.0, 1.0, n)
      sx = pts[i, 0] + t * seg[i, 0]
      sz = pts[i, 1] + t * seg[i, 1]
      px = np.clip(((sx - x0) / res).astype(np.int32), 0, width - 1)
      py = np.clip(((sz - z0) / res).astype(np.int32), 0, height - 1)
      cls[py, px] = v
      n_samples += n
  on_road = cls > 0
  print('rasterized %d samples, %d road pixels (%.2f%%)'
        % (n_samples, int(on_road.sum()), 100.0 * on_road.mean()))

  # --- distance transform (meters) + nearest-road class
  dist, (iy, ix) = ndimage.distance_transform_edt(
    ~on_road, sampling=res, return_indices=True)
  near_cls = cls[iy, ix]
  del iy, ix

  r_chan = np.clip(dist / DIST_MAX * 255.0, 0, 255).astype(np.uint8)
  g_chan = np.where(dist < DIST_MAX, near_cls, 0).astype(np.uint8)
  b_chan = np.zeros_like(r_chan)
  img = np.dstack([r_chan, g_chan, b_chan])
  Image.fromarray(img, 'RGB').save(PNG_PATH, optimize=True)

  meta = {
    'originX': round(x0, 2),
    'originZ': round(z0, 2),
    'res': round(res, 4),
    'width': width,
    'height': height,
    'distMax': DIST_MAX,
    'encoding': {
      'R': 'distance to nearest road centerline, 0..255 maps 0..%g m (clamped)' % DIST_MAX,
      'G': 'class of nearest road: 0 none (beyond distMax), 64 track, 128 gravel, 192 park_paved, 255 highway',
      'B': 'unused (0)',
    },
    'mapping': 'worldX = originX + (px + 0.5) * res; worldZ = originZ + (py + 0.5) * res; u = (worldX - originX) / (width * res); v = (worldZ - originZ) / (height * res)',
    'classes': ['track', 'gravel', 'park_paved', 'highway'],
    'source': 'OpenStreetMap via Overpass (2026-07-10)',
    'attribution': '(c) OpenStreetMap contributors, ODbL 1.0',
  }
  with open(META_PATH, 'w') as f:
    json.dump(meta, f, indent=2)
  print('wrote %s (%.1f MB) and %s'
        % (PNG_PATH, os.path.getsize(PNG_PATH) / 1e6, META_PATH))


if __name__ == '__main__':
  main()
