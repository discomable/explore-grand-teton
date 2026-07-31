"""Build terrain/public/trails.json from the OSM Overpass extract.

Source: terrain/pipeline/data/osm/trails_pois.osm.json (way["highway"=path|footway], out geom)
        (c) OpenStreetMap contributors, ODbL 1.0.

World frame (terrain/public/tiles.json): EPSG:32612,
  world x = easting - centerEasting, world z = centerNorthing - northing.
  (identical projection to roads/build_roads.py so trails register in the same frame.)

Output: list of {class:"trail", name?, pts:[[x,z],...]} — foot trails only, dirt tread.
Geometry is clipped to the terrain world extent and Douglas-Peucker simplified with a
2 m tolerance (tighter than roads: switchbacks/loops must survive).

Run: .venv/bin/python trails/build_trails.py   (from terrain/pipeline/)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from roads.utm import wgs84_to_utm12
from roads.build_roads import clip_polyline, simplify  # reuse the exact road pipeline helpers
from roads.node_polylines import node_self_intersections

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OSM_PATH = os.path.join(ROOT, 'pipeline', 'data', 'osm', 'trails_pois.osm.json')
TILES_PATH = os.path.join(ROOT, 'public', 'tiles.json')
OUT_PATH = os.path.join(ROOT, 'public', 'trails.json')

SIMPLIFY_TOL = 2.0  # meters — keep switchbacks/loops crisp
FOOT = {'path', 'footway', 'steps'}
# footways that are really engineered/paved surfaces are not "dirt trail" tread — but they are
# still narrow pedestrian ways; we render them all as one thin dirt ribbon (no markings). We DO
KEEP_TAGS = ('highway', 'surface', 'width', 'bridge', 'layer', 'access',
             'smoothness', 'foot', 'bicycle', 'sac_scale', 'trail_visibility')


def main():
  tiles = json.load(open(TILES_PATH))
  world = tiles['world']
  cE, cN = world['centerEasting'], world['centerNorthing']
  gt = tiles['geoTransform']
  xmin = gt[0] - cE
  xmax = gt[0] + tiles['width'] * gt[1] - cE
  zmin = cN - gt[3]
  zmax = cN - (gt[3] + tiles['height'] * gt[5])
  print('world extent x [%.1f, %.1f]  z [%.1f, %.1f]' % (xmin, xmax, zmin, zmax))

  data = json.load(open(OSM_PATH))
  trails = []
  n_ways = n_dropped = n_pts_in = n_pts_out = 0
  for el in data['elements']:
    if el.get('type') != 'way' or 'geometry' not in el:
      continue
    tags = el.get('tags', {})
    hw = tags.get('highway')
    if hw not in FOOT or tags.get('area') == 'yes':
      n_dropped += 1
      continue
    name = tags.get('name') or None
    pts = []
    for g in el['geometry']:
      e, n = wgs84_to_utm12(g['lat'], g['lon'])
      pts.append((e - cE, cN - n))
    n_pts_in += len(pts)
    if hw == 'steps':
      classification = 'steps'
    elif tags.get('bridge') == 'yes' and tags.get('surface') == 'wood':
      classification = 'boardwalk'
    elif tags.get('sac_scale') not in (None, 'hiking') or tags.get('trail_visibility') in ('bad', 'horrible', 'no'):
      classification = 'primitive_trail'
    else:
      classification = 'trail'
    way_pieces = []
    for piece in clip_polyline(pts, xmin, xmax, zmin, zmax):
      sp = simplify(piece, SIMPLIFY_TOL)
      if len(sp) < 2:
        continue
      rounded = [(round(x, 1), round(z, 1)) for x, z in sp]
      way_pieces.extend(node_self_intersections(rounded))
    for piece_index, sp in enumerate(way_pieces):
      feature_id = 'osm-way-%s' % el['id']
      rec = {'id': feature_id if piece_index == 0 else '%s:%d' % (feature_id, piece_index),
             'osmId': el['id'], 'class': classification,
             'pts': [[x, z] for x, z in sp],
             'tags': {k: tags[k] for k in KEEP_TAGS if k in tags}}
      if name:
        rec['name'] = name
      trails.append(rec)
      n_pts_out += len(sp)
    n_ways += 1

  print('ways kept %d (dropped %d non-foot), segments %d, pts %d -> %d' %
        (n_ways, n_dropped, len(trails), n_pts_in, n_pts_out))
  if trails:
    bx = [p[0] for r in trails for p in r['pts']]
    bz = [p[1] for r in trails for p in r['pts']]
    print('trails bbox x [%.0f, %.0f]  z [%.0f, %.0f]' % (min(bx), max(bx), min(bz), max(bz)))
  with open(OUT_PATH, 'w') as f:
    json.dump(trails, f, separators=(',', ':'))
  print('wrote %s (%.2f MB)' % (OUT_PATH, os.path.getsize(OUT_PATH) / 1e6))


if __name__ == '__main__':
  main()
