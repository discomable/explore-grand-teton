"""Build terrain/public/roads.json from the OSM Overpass extract.

Source: terrain/pipeline/data/osm/roads.osm.json (way["highway"], out geom)
        (c) OpenStreetMap contributors, ODbL 1.0.

World frame (terrain/public/tiles.json): EPSG:32612,
  world x = easting - centerEasting, world z = centerNorthing - northing.

Output: list of {class, name?, pts:[[x,z],...]} with classes
  highway | park_paved | gravel | track
Geometry is clipped to the terrain world extent and Douglas-Peucker
simplified with a 3 m tolerance.

Run: .venv/bin/python roads/build_roads.py   (from terrain/pipeline/)
"""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utm import wgs84_to_utm12
from node_polylines import node_self_intersections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OSM_PATH = os.path.join(ROOT, 'pipeline', 'data', 'osm', 'roads.osm.json')
TILES_PATH = os.path.join(ROOT, 'public', 'tiles.json')
OUT_PATH = os.path.join(ROOT, 'public', 'roads.json')
TRANSPORT_PATH = os.path.join(ROOT, 'public', 'transport.json')
TRAILS_PATH = os.path.join(ROOT, 'public', 'trails.json')
OVERRIDES_PATH = os.path.join(ROOT, 'pipeline', 'roads', 'transport-overrides.json')
CHUNK_SIZE = 2048.0

SIMPLIFY_TOL = 3.0  # meters

DRIVABLE = {
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'track',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
}
MAJOR = {'motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link'}
UNPAVED = {'gravel', 'unpaved', 'dirt', 'ground', 'compacted', 'fine_gravel',
           'earth', 'grass', 'sand', 'pebblestone', 'rock', 'mud', 'wood'}
PAVED = {'asphalt', 'paved', 'concrete', 'chipseal', 'paving_stones', 'concrete:plates'}
US_REF = re.compile(r'\bUS[ -]?(26|89|191|287)\b')
GRAVEL_NAMES = ('Mormon Row', 'Antelope Flats', 'Two Ocean', 'Shadow Mountain',
                'Grassy Lake', 'River Road', 'Spring Gulch')


def classify(tags):
  hw = tags.get('highway')
  surface = tags.get('surface', '')
  name = tags.get('name', '')
  ref = tags.get('ref', '')
  if hw in MAJOR or US_REF.search(ref):
    return 'highway'
  if hw == 'track':
    return 'track'
  if surface in UNPAVED or tags.get('tracktype') in ('grade3', 'grade4', 'grade5'):
    return 'track' if hw == 'service' else 'gravel'
  if hw == 'service':
    # paved or unknown-surface service roads (campground loops, parking, driveways)
    return 'park_paved' if surface in PAVED else 'track'
  if hw in ('secondary', 'tertiary', 'secondary_link', 'tertiary_link',
            'residential', 'living_street'):
    return 'park_paved'
  # unclassified: park backroads default to gravel unless tagged paved / known paved
  if surface in PAVED:
    return 'park_paved'
  if any(k in name for k in GRAVEL_NAMES):
    return 'gravel'
  return 'gravel'


def clip_polyline(pts, xmin, xmax, zmin, zmax):
  """Liang-Barsky clip of a polyline to a bbox; returns list of sub-polylines."""
  out = []
  cur = []
  for i in range(len(pts) - 1):
    (x0, z0), (x1, z1) = pts[i], pts[i + 1]
    dx, dz = x1 - x0, z1 - z0
    t0, t1 = 0.0, 1.0
    ok = True
    for p, q in ((-dx, x0 - xmin), (dx, xmax - x0), (-dz, z0 - zmin), (dz, zmax - z0)):
      if p == 0:
        if q < 0:
          ok = False
          break
      else:
        r = q / p
        if p < 0:
          if r > t1:
            ok = False
            break
          if r > t0:
            t0 = r
        else:
          if r < t0:
            ok = False
            break
          if r < t1:
            t1 = r
    if not ok:
      if len(cur) >= 2:
        out.append(cur)
      cur = []
      continue
    a = (x0 + t0 * dx, z0 + t0 * dz)
    b = (x0 + t1 * dx, z0 + t1 * dz)
    if not cur:
      cur = [a]
    cur.append(b)
    if t1 < 1.0:  # exits the box
      if len(cur) >= 2:
        out.append(cur)
      cur = []
  if len(cur) >= 2:
    out.append(cur)
  return out


def simplify(pts, tol):
  """Iterative Douglas-Peucker."""
  if len(pts) <= 2:
    return list(pts)
  keep = [False] * len(pts)
  keep[0] = keep[-1] = True
  stack = [(0, len(pts) - 1)]
  tol2 = tol * tol
  while stack:
    i0, i1 = stack.pop()
    if i1 <= i0 + 1:
      continue
    x0, z0 = pts[i0]
    x1, z1 = pts[i1]
    dx, dz = x1 - x0, z1 - z0
    seg2 = dx * dx + dz * dz
    best, bi = -1.0, -1
    for i in range(i0 + 1, i1):
      px, pz = pts[i]
      if seg2 == 0:
        d2 = (px - x0) ** 2 + (pz - z0) ** 2
      else:
        t = ((px - x0) * dx + (pz - z0) * dz) / seg2
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        d2 = (px - x0 - t * dx) ** 2 + (pz - z0 - t * dz) ** 2
      if d2 > best:
        best, bi = d2, i
    if best > tol2:
      keep[bi] = True
      stack.append((i0, bi))
      stack.append((bi, i1))
  return [p for p, k in zip(pts, keep) if k]


def main():
  tiles = json.load(open(TILES_PATH))
  world = tiles['world']
  cE, cN = world['centerEasting'], world['centerNorthing']
  gt = tiles['geoTransform']
  # world extent from the DEM raster
  xmin = gt[0] - cE
  xmax = gt[0] + tiles['width'] * gt[1] - cE
  zmin = cN - gt[3]
  zmax = cN - (gt[3] + tiles['height'] * gt[5])
  print('world extent x [%.1f, %.1f]  z [%.1f, %.1f]' % (xmin, xmax, zmin, zmax))

  data = json.load(open(OSM_PATH))
  overrides = json.load(open(OVERRIDES_PATH)) if os.path.exists(OVERRIDES_PATH) else {}
  roads = []
  n_ways = n_dropped = n_pts_in = n_pts_out = 0
  for el in data['elements']:
    if el.get('type') != 'way' or 'geometry' not in el:
      continue
    tags = el.get('tags', {})
    hw = tags.get('highway')
    if hw not in DRIVABLE or tags.get('area') == 'yes':
      n_dropped += 1
      continue
    feature_id = 'osm-way-%s' % el['id']
    override = overrides.get(feature_id, {})
    if override.get('exclude'):
      continue
    cls = override.get('classification') or classify(tags)
    name = tags.get('name') or tags.get('ref') or None
    pts = []
    for g in el['geometry']:
      e, n = wgs84_to_utm12(g['lat'], g['lon'])
      pts.append((e - cE, cN - n))
    n_pts_in += len(pts)
    if override.get('alignment'):
      pts = [tuple(p) for p in override['alignment']]
    way_pieces = []
    for piece in clip_polyline(pts, xmin, xmax, zmin, zmax):
      sp = simplify(piece, SIMPLIFY_TOL)
      if len(sp) < 2:
        continue
      rounded = [(round(x, 1), round(z, 1)) for x, z in sp]
      way_pieces.extend(node_self_intersections(rounded))
    for piece_index, sp in enumerate(way_pieces):
      rec = {'id': feature_id if piece_index == 0 else '%s:%d' % (feature_id, piece_index),
             'osmId': el['id'], 'class': cls,
             'pts': [[x, z] for x, z in sp]}
      if name:
        rec['name'] = name
      keep_tags = ('highway', 'ref', 'surface', 'width', 'lanes', 'oneway', 'bridge',
                   'layer', 'access', 'smoothness', 'tracktype', 'foot', 'bicycle', 'maxspeed')
      rec['tags'] = {k: tags[k] for k in keep_tags if k in tags}
      if 'width' in override:
        rec['width'] = override['width']
      if 'bridgeType' in override:
        rec['bridgeType'] = override['bridgeType']
      roads.append(rec)
      n_pts_out += len(sp)
    n_ways += 1

  from collections import Counter
  cc = Counter(r['class'] for r in roads)
  print('ways kept %d (dropped %d non-drivable), segments %d, pts %d -> %d' %
        (n_ways, n_dropped, len(roads), n_pts_in, n_pts_out))
  print('classes:', dict(cc))
  bx = [p[0] for r in roads for p in r['pts']]
  bz = [p[1] for r in roads for p in r['pts']]
  print('roads bbox x [%.0f, %.0f]  z [%.0f, %.0f]' % (min(bx), max(bx), min(bz), max(bz)))
  # class order: draw priority for downstream consumers (highway last/wins)
  order = {'track': 0, 'gravel': 1, 'park_paved': 2, 'highway': 3}
  roads.sort(key=lambda r: order[r['class']])
  with open(OUT_PATH, 'w') as f:
    # Compatibility projection; runtime renderers accept the enriched records too.
    json.dump(roads, f, separators=(',', ':'))
  print('wrote %s (%.1f MB)' % (OUT_PATH, os.path.getsize(OUT_PATH) / 1e6))
  features = list(roads)
  if os.path.exists(TRAILS_PATH):
    features.extend(json.load(open(TRAILS_PATH)))
  chunks = {}
  for road in features:
    keys = set()
    for (ax, az), (bx, bz) in zip(road['pts'], road['pts'][1:]):
      min_cx, max_cx = math.floor(min(ax, bx) / CHUNK_SIZE), math.floor(max(ax, bx) / CHUNK_SIZE)
      min_cz, max_cz = math.floor(min(az, bz) / CHUNK_SIZE), math.floor(max(az, bz) / CHUNK_SIZE)
      # Conservative segment-AABB ownership: diagonal segments may be referenced by an extra
      # cell, but no visible/query segment can ever cross an unowned streamed cell.
      for cx in range(min_cx, max_cx + 1):
        for cz in range(min_cz, max_cz + 1):
          keys.add('%d,%d' % (cx, cz))
    for key in keys:
      chunks.setdefault(key, []).append(road['id'])
  transport = {
    'version': 1,
    'attribution': 'OpenStreetMap contributors, ODbL 1.0',
    'coordinateSystem': 'EPSG:32612 local world metres',
    'chunkSize': CHUNK_SIZE,
    'features': features,
    'chunks': dict(sorted((k, sorted(v)) for k, v in chunks.items())),
  }
  with open(TRANSPORT_PATH, 'w') as f:
    json.dump(transport, f, separators=(',', ':'), sort_keys=True)
  print('wrote %s (%.1f MB, %d chunks)' %
        (TRANSPORT_PATH, os.path.getsize(TRANSPORT_PATH) / 1e6, len(chunks)))


if __name__ == '__main__':
  main()
