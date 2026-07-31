"""Validate the baked SDF: sample known points, print distance + nearest class.

Reads terrain/public/roads.png + roads-meta.json and also computes an exact
brute-force distance from roads.json for a few points to confirm the raster
agrees with the vector source.

Run: .venv/bin/python roads/validate.py   (from terrain/pipeline/)
"""
import json
import math
import os

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PNG_PATH = os.path.join(ROOT, 'public', 'roads.png')
META_PATH = os.path.join(ROOT, 'public', 'roads-meta.json')
ROADS_PATH = os.path.join(ROOT, 'public', 'roads.json')

CLASS_NAME = {0: 'none', 64: 'track', 128: 'gravel', 192: 'park_paved', 255: 'highway'}


def sample(img, meta, x, z):
  res = meta['res']
  px = int((x - meta['originX']) / res)
  py = int((z - meta['originZ']) / res)
  if not (0 <= px < meta['width'] and 0 <= py < meta['height']):
    return None
  r, g, b = img[py, px]
  dist = r / 255.0 * meta['distMax']
  return dist, CLASS_NAME.get(int(g), '?'), int(g)


def exact_dist(roads, x, z):
  """Brute-force nearest centerline distance + class from the vector data."""
  best, bcls = 1e18, None
  for road in roads:
    pts = road['pts']
    for i in range(len(pts) - 1):
      ax, az = pts[i]
      bx, bz = pts[i + 1]
      dx, dz = bx - ax, bz - az
      seg2 = dx * dx + dz * dz
      if seg2 == 0:
        t = 0.0
      else:
        t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / seg2))
      qx, qz = ax + t * dx, az + t * dz
      d = math.hypot(x - qx, z - qz)
      if d < best:
        best, bcls = d, road['class']
  return best, bcls


def main():
  meta = json.load(open(META_PATH))
  roads = json.load(open(ROADS_PATH))
  img = np.asarray(Image.open(PNG_PATH).convert('RGB'))
  print('raster %dx%d @ %.2f m/px, origin (%.1f, %.1f)'
        % (meta['width'], meta['height'], meta['res'], meta['originX'], meta['originZ']))

  # Anchor near a highway vertex and a park_paved vertex from the actual data
  hw = next(r for r in roads if r['class'] == 'highway')
  hx, hz = hw['pts'][len(hw['pts']) // 2]
  pp = next(r for r in roads if r['class'] == 'park_paved' and (r.get('name') or '').startswith('Teton Park'))
  tx, tz = pp['pts'][len(pp['pts']) // 2]
  gv = next(r for r in roads if r['class'] == 'gravel')
  gx, gz = gv['pts'][len(gv['pts']) // 2]

  pts = [
    ('ON highway "%s"' % (hw.get('name') or '?'), hx, hz),
    ('100 m off that highway', hx + 100.0, hz),
    ('ON Teton Park Rd', tx, tz),
    ('30 m off Teton Park Rd', tx + 30.0, tz),
    ('ON gravel "%s"' % (gv.get('name') or '?'), gx, gz),
    ('45 m off that gravel (beyond distMax)', gx + 45.0, gz),
    ('world center (0,0)', 0.0, 0.0),
    ('far NE corner-ish', 12000.0, -18000.0),
    ('mid valley (-430, 0)', -430.0, 0.0),
    ('deep offroad (5000, 8000)', 5000.0, 8000.0),
  ]
  print('\n%-38s %10s %8s %6s | %10s %-11s' %
        ('point (world x,z)', 'raster_d', 'class', 'g', 'exact_d', 'exact_cls'))
  print('-' * 96)
  for label, x, z in pts:
    s = sample(img, meta, x, z)
    ed, ec = exact_dist(roads, x, z)
    if s is None:
      print('%-38s %10s (outside raster) | %10.1f %-11s' % (label, '-', ed, ec))
      continue
    d, cname, g = s
    flag = '' if abs(d - min(ed, meta['distMax'])) < meta['res'] * 1.5 else '  <-- CHECK'
    print('%-38s %9.1fm %8s %6d | %9.1fm %-11s%s'
          % (label, d, cname, g, ed, ec, flag))


if __name__ == '__main__':
  main()
