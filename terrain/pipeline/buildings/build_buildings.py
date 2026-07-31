#!/usr/bin/env python3
"""Build terrain/public/buildings.json — building footprints in world coords.

Sources:
  - OSM buildings (terrain/pipeline/data/osm/buildings.osm.json, Overpass out-geom)
    (c) OpenStreetMap contributors, ODbL.
  - Microsoft Building Footprints (terrain/pipeline/data/ms_buildings/Wyoming.geojson.zip),
    ODbL. Streamed straight out of the zip — nothing is extracted to disk.

World frame: EPSG:32612, x = easting - centerEasting, z = centerNorthing - northing
(from terrain/public/tiles.json). Clipped to x +-14160, z +-20590.

Stdlib only + the hand-rolled UTM converter at terrain/pipeline/roads/utm.py.
"""
import io
import json
import math
import os
import sys
import zipfile
import zlib
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
PIPELINE = os.path.dirname(HERE)
TERRAIN = os.path.dirname(PIPELINE)
sys.path.insert(0, os.path.join(PIPELINE, 'roads'))
from utm import wgs84_to_utm12  # noqa: E402

OSM_PATH = os.path.join(PIPELINE, 'data', 'osm', 'buildings.osm.json')
MS_ZIP = os.path.join(PIPELINE, 'data', 'ms_buildings', 'Wyoming.geojson.zip')
TILES_PATH = os.path.join(TERRAIN, 'public', 'tiles.json')
ROADS_PATH = os.path.join(TERRAIN, 'public', 'roads.json')
LABELS_PATH = os.path.join(TERRAIN, 'public', 'labels.json')
OUT_PATH = os.path.join(TERRAIN, 'public', 'buildings.json')

X_MAX = 14160.0
Z_MAX = 20590.0
# Generous lat/lon prefilter around the extent (checked exactly in world coords after).
LAT_MIN, LAT_MAX = 43.40, 44.00
LON_MIN, LON_MAX = -111.15, -110.40

SIMPLIFY_TOL = 0.75       # m, Douglas-Peucker
MIN_AREA = 12.0           # m^2
DEDUPE_R = 15.0           # m, MS centroid vs OSM centroid
MAX_BUILDINGS = 6000

CLASS_HEIGHT = {
  'lodge': 9.0, 'commercial': 6.5, 'residential': 5.5,
  'barn': 7.0, 'outbuilding': 3.5, 'generic': 5.0,
}

with open(TILES_PATH) as f:
  _world = json.load(f)['world']
CE = _world['centerEasting']
CN = _world['centerNorthing']


def to_world(lat, lon):
  e, n = wgs84_to_utm12(lat, lon)
  return e - CE, CN - n


# ---------------------------------------------------------------- geometry

def centroid(ring):
  """Area-weighted polygon centroid; falls back to vertex mean if degenerate."""
  a = 0.0
  cx = 0.0
  cz = 0.0
  npts = len(ring)
  for i in range(npts):
    x0, z0 = ring[i]
    x1, z1 = ring[(i + 1) % npts]
    cr = x0 * z1 - x1 * z0
    a += cr
    cx += (x0 + x1) * cr
    cz += (z0 + z1) * cr
  if abs(a) < 1e-9:
    return (sum(p[0] for p in ring) / npts, sum(p[1] for p in ring) / npts)
  a *= 0.5
  return cx / (6.0 * a), cz / (6.0 * a)


def area(ring):
  s = 0.0
  npts = len(ring)
  for i in range(npts):
    x0, z0 = ring[i]
    x1, z1 = ring[(i + 1) % npts]
    s += x0 * z1 - x1 * z0
  return abs(s) * 0.5


def signed_area(ring):
  s = 0.0
  npts = len(ring)
  for i in range(npts):
    x0, z0 = ring[i]
    x1, z1 = ring[(i + 1) % npts]
    s += x0 * z1 - x1 * z0
  return s * 0.5


def simplify_dp(pts, tol):
  """Douglas-Peucker on an open point list (iterative)."""
  if len(pts) < 3:
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
    dx = x1 - x0
    dz = z1 - z0
    seg2 = dx * dx + dz * dz
    dmax2 = -1.0
    imax = -1
    for i in range(i0 + 1, i1):
      px, pz = pts[i]
      if seg2 <= 1e-12:
        d2 = (px - x0) ** 2 + (pz - z0) ** 2
      else:
        t = ((px - x0) * dx + (pz - z0) * dz) / seg2
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        qx = x0 + t * dx
        qz = z0 + t * dz
        d2 = (px - qx) ** 2 + (pz - qz) ** 2
      if d2 > dmax2:
        dmax2 = d2
        imax = i
    if dmax2 > tol2:
      keep[imax] = True
      stack.append((i0, imax))
      stack.append((imax, i1))
  return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring, tol):
  """Simplify a closed ring given as an unclosed vertex list."""
  if len(ring) < 3:
    return ring
  closed = ring + [ring[0]]
  out = simplify_dp(closed, tol)
  if len(out) > 1 and out[0] == out[-1]:
    out = out[:-1]
  # drop consecutive duplicates
  dedup = []
  for p in out:
    if not dedup or p != dedup[-1]:
      dedup.append(p)
  return dedup


# ---------------------------------------------------------------- OSM parsing

def stitch_outer_rings(members):
  """Assemble outer-way member geometries (lat/lon lists) into closed rings."""
  segs = [[(g['lat'], g['lon']) for g in m['geometry']]
          for m in members if m.get('role') == 'outer' and 'geometry' in m]
  rings = []
  segs = [s for s in segs if len(s) >= 2]
  while segs:
    ring = segs.pop(0)
    progressed = True
    while ring[0] != ring[-1] and progressed:
      progressed = False
      for i, s in enumerate(segs):
        if s[0] == ring[-1]:
          ring += s[1:]
        elif s[-1] == ring[-1]:
          ring += list(reversed(s))[1:]
        elif s[-1] == ring[0]:
          ring = s[:-1] + ring
        elif s[0] == ring[0]:
          ring = list(reversed(s))[:-1] + ring
        else:
          continue
        segs.pop(i)
        progressed = True
        break
    if ring[0] == ring[-1] and len(ring) >= 4:
      rings.append(ring[:-1])
  return rings


def parse_height(tags):
  """Explicit height in metres from OSM tags, or None."""
  h = tags.get('height') or tags.get('building:height')
  if h:
    try:
      return float(str(h).replace('m', '').replace("'", '').strip())
    except ValueError:
      pass
  lv = tags.get('building:levels')
  if lv:
    try:
      return float(lv) * 3.2 + 1.0
    except ValueError:
      pass
  return None


LODGE_WORDS = ('lodge', 'hotel', 'inn', 'motel', 'visitor', 'chapel', 'church',
               'ranch', 'resort', 'guest')
LANDMARK_WORDS = ('lodge', 'visitor', 'chapel', 'church', 'inn', 'hotel',
                  'ranch', 'barn', 'historic', 'museum', 'school', 'station')
# Explicit named landmarks that don't carry lodge/visitor/historic tags.
LANDMARK_NAMES = ('dornan', 'triangle x', 'colter bay', 'homestead')


def classify(tags):
  name = (tags.get('name') or '').lower()
  btype = (tags.get('building') or 'yes').lower()
  tourism = (tags.get('tourism') or '').lower()
  amenity = (tags.get('amenity') or '').lower()
  historic = (tags.get('historic') or '').lower()
  if (tourism in ('hotel', 'motel', 'chalet', 'alpine_hut', 'guest_house',
                  'information', 'museum')
      or btype in ('hotel', 'chapel', 'church')
      or amenity in ('place_of_worship',)
      or any(w in name for w in LODGE_WORDS)):
    return 'lodge'
  if (btype in ('commercial', 'retail', 'office', 'supermarket', 'restaurant',
                'kiosk', 'public', 'government', 'school', 'fire_station',
                'warehouse', 'industrial', 'hospital', 'train_station',
                'transportation')
      or amenity in ('restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'fuel',
                     'post_office', 'bank', 'school', 'fire_station', 'ranger_station',
                     'marketplace', 'clinic', 'library', 'townhall')
      or ('store' in name or 'market' in name or 'grocery' in name)):
    return 'commercial'
  if btype in ('house', 'residential', 'detached', 'cabin', 'apartments',
               'bungalow', 'dormitory', 'static_caravan', 'hut', 'semidetached_house'):
    return 'residential'
  if btype in ('barn', 'farm', 'farm_auxiliary', 'stable', 'cowshed', 'sty',
               'greenhouse', 'silo') or 'barn' in name:
    return 'barn'
  if btype in ('shed', 'garage', 'garages', 'outbuilding', 'service', 'toilets',
               'roof', 'carport', 'shelter', 'storage_tank', 'container',
               'boathouse') or amenity in ('toilets', 'shelter'):
    return 'outbuilding'
  return 'generic'


def importance(tags, cls):
  name = tags.get('name')
  if not name:
    return 3
  low = name.lower()
  if (cls in ('lodge', 'barn') or tags.get('historic')
      or (tags.get('tourism') or '') in ('information', 'museum', 'attraction')
      or any(w in low for w in LANDMARK_WORDS)
      or any(w in low for w in LANDMARK_NAMES)):
    return 1
  return 2


def jitter_factor(cx, cz):
  """Deterministic +-15% factor from the centroid (hash, not random)."""
  key = ('%.1f,%.1f' % (cx, cz)).encode()
  h = zlib.crc32(key) & 0xffffffff
  return 1.0 + ((h % 2001) - 1000) / 1000.0 * 0.15


def make_building(ring_ll, tags, oddities):
  """lat/lon ring (unclosed) + tags -> building dict in world coords, or None."""
  world = [to_world(lat, lon) for lat, lon in ring_ll]
  cx, cz = centroid(world)
  if not (-X_MAX <= cx <= X_MAX and -Z_MAX <= cz <= Z_MAX):
    return None
  ring = simplify_ring(world, SIMPLIFY_TOL)
  if len(ring) < 3:
    oddities['degenerate_after_simplify'] += 1
    return None
  a = area(ring)
  if a < MIN_AREA:
    oddities['too_small'] += 1
    return None
  if signed_area(ring) < 0:  # normalize winding (CCW in x,z)
    ring.reverse()
  cls = classify(tags)
  h = parse_height(tags)
  if h is None:
    h = CLASS_HEIGHT[cls] * jitter_factor(cx, cz)
  b = {
    'pts': [[round(x, 1), round(z, 1)] for x, z in ring],
    'h': round(h, 1),
    'cls': cls,
    'imp': importance(tags, cls),
    '_c': (cx, cz),
  }
  name = tags.get('name')
  if name:
    b['name'] = name
  return b


def load_osm(oddities):
  with open(OSM_PATH) as f:
    data = json.load(f)
  out = []
  for el in data['elements']:
    tags = el.get('tags', {})
    if tags.get('building:part') and not tags.get('building'):
      oddities['building_part_skipped'] += 1
      continue
    if el['type'] == 'way':
      geom = el.get('geometry')
      if not geom or len(geom) < 4:
        oddities['osm_way_short_or_no_geom'] += 1
        continue
      ring = [(g['lat'], g['lon']) for g in geom]
      if ring[0] == ring[-1]:
        ring = ring[:-1]
      else:
        oddities['osm_unclosed_way'] += 1
      b = make_building(ring, tags, oddities)
      if b:
        out.append(b)
    elif el['type'] == 'relation':
      rings = stitch_outer_rings(el.get('members', []))
      if not rings:
        oddities['relation_no_outer_ring'] += 1
      for ring in rings:
        b = make_building(ring, tags, oddities)
        if b:
          out.append(b)
  return out


# ---------------------------------------------------------------- MS parsing

def load_ms(osm_buildings, oddities):
  # spatial hash of OSM centroids for the ~15 m dedupe
  grid = {}
  cell = DEDUPE_R
  for b in osm_buildings:
    cx, cz = b['_c']
    grid.setdefault((int(cx // cell), int(cz // cell)), []).append((cx, cz))

  def near_osm(cx, cz):
    gi, gj = int(cx // cell), int(cz // cell)
    r2 = DEDUPE_R * DEDUPE_R
    for di in (-1, 0, 1):
      for dj in (-1, 0, 1):
        for ox, oz in grid.get((gi + di, gj + dj), ()):
          if (ox - cx) ** 2 + (oz - cz) ** 2 <= r2:
            return True
    return False

  out = []
  n_seen = 0
  n_box = 0
  n_dup = 0
  with zipfile.ZipFile(MS_ZIP) as zf:
    with zf.open('Wyoming.geojson') as raw:
      for line in io.TextIOWrapper(raw, encoding='utf-8'):
        line = line.strip().rstrip(',')
        if not line.startswith('{"type":"Feature"'):
          continue
        n_seen += 1
        # cheap prefilter before json parse
        i = line.find('[[[')
        if i < 0:
          oddities['ms_no_coords'] += 1
          continue
        j = line.find(']', i)
        try:
          lon0, lat0 = (float(v) for v in line[i + 3:j].split(','))
        except ValueError:
          oddities['ms_bad_first_coord'] += 1
          continue
        if not (LAT_MIN <= lat0 <= LAT_MAX and LON_MIN <= lon0 <= LON_MAX):
          continue
        n_box += 1
        feat = json.loads(line)
        geom = feat.get('geometry') or {}
        if geom.get('type') != 'Polygon':
          oddities['ms_non_polygon'] += 1
          continue
        ring = [(lat, lon) for lon, lat in geom['coordinates'][0]]
        if len(ring) >= 2 and ring[0] == ring[-1]:
          ring = ring[:-1]
        if len(ring) < 3:
          oddities['ms_degenerate_ring'] += 1
          continue
        b = make_building(ring, {}, oddities)
        if b is None:
          continue
        cx, cz = b['_c']
        if near_osm(cx, cz):
          n_dup += 1
          continue
        out.append(b)
  print('MS features scanned: %d, in lat/lon prefilter box: %d, '
        'deduped vs OSM: %d, kept: %d' % (n_seen, n_box, n_dup, len(out)))
  return out


# ---------------------------------------------------------------- cull

def cull_far_from_roads(buildings, limit):
  """If over limit, drop imp:3 buildings furthest from any road vertex."""
  if len(buildings) <= limit:
    return buildings
  with open(ROADS_PATH) as f:
    roads = json.load(f)
  cell = 250.0
  rgrid = {}
  for seg in roads:
    for x, z in seg['pts']:
      rgrid.setdefault((int(x // cell), int(z // cell)), []).append((x, z))

  def road_dist2(cx, cz):
    gi, gj = int(cx // cell), int(cz // cell)
    for radius in range(1, 40):
      best = None
      for di in range(-radius, radius + 1):
        for dj in range(-radius, radius + 1):
          if max(abs(di), abs(dj)) != radius and radius > 1:
            continue
          for rx, rz in rgrid.get((gi + di, gj + dj), ()):
            d2 = (rx - cx) ** 2 + (rz - cz) ** 2
            if best is None or d2 < best:
              best = d2
      if best is not None:
        return best
    return float('inf')

  imp3 = [(road_dist2(*b['_c']), i) for i, b in enumerate(buildings) if b['imp'] == 3]
  imp3.sort(reverse=True)
  n_drop = len(buildings) - limit
  drop = set(i for _, i in imp3[:n_drop])
  kept = [b for i, b in enumerate(buildings) if i not in drop]
  print('Over %d: dropped %d imp:3 buildings furthest from roads' % (limit, len(drop)))
  return kept


# ---------------------------------------------------------------- main

def main():
  oddities = Counter()
  osm = load_osm(oddities)
  print('OSM buildings kept in extent: %d' % len(osm))
  ms = load_ms(osm, oddities)
  buildings = osm + ms
  buildings = cull_far_from_roads(buildings, MAX_BUILDINGS)

  landmarks = [(b['name'], b) for b in buildings if b.get('imp') == 1]
  centres = {b.get('name'): b['_c'] for b in buildings if b.get('name')}
  for b in buildings:
    del b['_c']

  out = {
    'attribution': ('© OpenStreetMap contributors (ODbL); '
                    'Microsoft Building Footprints (ODbL)'),
    'buildings': buildings,
  }
  txt = json.dumps(out, separators=(',', ':'), ensure_ascii=False)
  with open(OUT_PATH, 'w') as f:
    f.write(txt)

  # ------------------------------------------------ sanity checks
  print('\n=== sanity ===')
  print('total buildings: %d' % len(buildings))
  for cls, n in sorted(Counter(b['cls'] for b in buildings).items()):
    print('  %-12s %d' % (cls, n))
  for imp, n in sorted(Counter(b['imp'] for b in buildings).items()):
    print('  imp:%d  %d' % (imp, n))
  print('output: %s (%.2f MB)' % (OUT_PATH, len(txt.encode()) / 1e6))
  if oddities:
    print('oddities: %s' % dict(oddities))

  spot_names = ['Jackson Lake Lodge', 'Colter Bay Visitor Center',
                'Chapel of the Transfiguration', 'Signal Mountain Lodge',
                'T.A. Moulton Barn', 'Jenny Lake Visitor Center',
                'Craig Thomas Discovery and Visitor Center',
                'John Moulton Barn', 'Dornans', 'Triangle X Ranch']
  print('\nlandmark spot checks (name, x, z, h):')
  shown = 0
  for want in spot_names:
    if shown >= 5:
      break
    for name, b in landmarks:
      if name and want.lower() in name.lower():
        cx, cz = centres[name]
        inside = -X_MAX <= cx <= X_MAX and -Z_MAX <= cz <= Z_MAX
        print('  %-45s x=%8.1f z=%9.1f h=%.1f  in-extent=%s'
              % (name, cx, cz, b['h'], inside))
        shown += 1
        break

  # cross-check against labels.json where names match
  try:
    with open(LABELS_PATH) as f:
      labels = json.load(f)['labels']
    print('\nlabel cross-checks:')
    for lab in labels:
      ln = lab['name'].lower()
      for name, (cx, cz) in centres.items():
        first = ln.split()[0]
        if len(first) > 4 and first in name.lower():
          d = math.hypot(cx - lab['x'], cz - lab['z'])
          if d < 3000:
            print('  building "%s" is %.0f m from label "%s" (%.0f, %.0f)'
                  % (name, d, lab['name'], lab['x'], lab['z']))
          break
  except (OSError, KeyError):
    pass


if __name__ == '__main__':
  main()
