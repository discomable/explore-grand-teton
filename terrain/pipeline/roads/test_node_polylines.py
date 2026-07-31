import unittest

try:
  from .node_polylines import node_self_intersections
  from .validate_transport import validate_transport
except ImportError:
  from node_polylines import node_self_intersections
  from validate_transport import validate_transport


class NodePolylinesTests(unittest.TestCase):
  def test_unaffected_polyline_stays_whole(self):
    points = [(0, 0), (5, 2), (10, 0)]
    self.assertEqual(node_self_intersections(points), [points])

  def test_bow_tie_is_noded_without_dropping_edges(self):
    points = [(0, 0), (10, 10), (0, 10), (10, 0)]
    pieces = node_self_intersections(points)
    self.assertEqual(pieces, [
      [(0, 0), (5.0, 5.0)],
      [(5.0, 5.0), (10, 10)],
      [(10, 10), (0, 10)],
      [(0, 10), (5.0, 5.0)],
      [(5.0, 5.0), (10, 0)],
    ])
    original_length = sum(
      ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
      for a, b in zip(points, points[1:])
    )
    output_length = sum(
      ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
      for a, b in pieces
    )
    self.assertAlmostEqual(output_length, original_length)

  def test_output_ids_are_accepted_by_transport_validator(self):
    pieces = node_self_intersections([(0, 0), (10, 10), (0, 10), (10, 0)])
    features = [{
      "id": "osm-way-7" if index == 0 else f"osm-way-7:{index}",
      "osmId": 7,
      "class": "track",
      "pts": piece,
      "tags": {},
    } for index, piece in enumerate(pieces)]
    data = {
      "version": 1,
      "coordinateSystem": "local metres",
      "chunkSize": 2048,
      "features": features,
      "chunks": {"0,0": sorted(item["id"] for item in features)},
    }
    codes = [issue.code for issue in validate_transport(data)]
    self.assertNotIn("id.unstable", codes)
    self.assertNotIn("geometry.self_intersection", codes)


if __name__ == "__main__":
  unittest.main()
