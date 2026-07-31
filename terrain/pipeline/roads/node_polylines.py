"""Deterministically node self-crossing transport polylines.

Only polylines with a proper self-intersection are split.  Affected geometry is
emitted as atomic, noded segments so no alignment edge is discarded and every
result is simple.  Keeping unaffected polylines intact avoids needless feature
fragmentation in the baked network.
"""

from __future__ import annotations

from collections import defaultdict
from math import hypot


EPSILON = 1e-9


def _cross(ax, az, bx, bz):
  return ax * bz - az * bx


def _intersection(a, b, c, d):
  """Return (t, u, point) for a proper AB/CD intersection, else None."""
  rx, rz = b[0] - a[0], b[1] - a[1]
  sx, sz = d[0] - c[0], d[1] - c[1]
  denominator = _cross(rx, rz, sx, sz)
  if abs(denominator) <= EPSILON:
    return None
  qx, qz = c[0] - a[0], c[1] - a[1]
  t = _cross(qx, qz, sx, sz) / denominator
  u = _cross(qx, qz, rx, rz) / denominator
  # Endpoint contacts already form valid nodes and are not self-intersections
  # according to the transport validator.
  if not EPSILON < t < 1.0 - EPSILON or not EPSILON < u < 1.0 - EPSILON:
    return None
  return t, u, (a[0] + t * rx, a[1] + t * rz)


def node_self_intersections(points):
  """Return simple pieces preserving every edge of *points*.

  With no proper crossing the original polyline is returned as one piece.
  Otherwise every source edge is split at its sorted intersections and emitted
  in original traversal order.  Coincident crossing coordinates are calculated
  once per segment pair, making shared nodes bit-identical.
  """
  pts = [tuple(point) for point in points]
  if len(pts) < 2:
    return []

  cuts = defaultdict(list)
  for i in range(len(pts) - 1):
    for j in range(i + 2, len(pts) - 1):
      hit = _intersection(pts[i], pts[i + 1], pts[j], pts[j + 1])
      if hit is None:
        continue
      t, u, point = hit
      cuts[i].append((t, point))
      cuts[j].append((u, point))

  if not cuts:
    return [pts]

  pieces = []
  for index, (start, end) in enumerate(zip(pts, pts[1:])):
    nodes = [(0.0, start), *cuts.get(index, ()), (1.0, end)]
    nodes.sort(key=lambda item: item[0])
    unique = []
    for _, point in nodes:
      if not unique or hypot(point[0] - unique[-1][0],
                             point[1] - unique[-1][1]) > EPSILON:
        unique.append(point)
    pieces.extend([[a, b] for a, b in zip(unique, unique[1:])])
  return pieces
