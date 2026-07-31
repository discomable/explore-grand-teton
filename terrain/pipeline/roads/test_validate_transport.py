import copy
import unittest

try:
    from .validate_transport import validate_transport
except ImportError:
    from validate_transport import validate_transport


def dataset(features):
    return {
        "version": 1,
        "coordinateSystem": "local metres",
        "chunkSize": 2048,
        "features": features,
        "chunks": {"0,0": sorted(feature["id"] for feature in features)},
    }


def feature(feature_id="osm-way-1", osm_id=1, kind="track", points=None, **extra):
    value = {
        "id": feature_id,
        "osmId": osm_id,
        "class": kind,
        "pts": points or [[0, 0], [10, 0]],
        "tags": {},
    }
    value.update(extra)
    return value


class ValidateTransportTests(unittest.TestCase):
    def codes(self, value):
        return [issue.code for issue in validate_transport(value)]

    def test_valid_network_has_no_findings(self):
        value = dataset([
            feature(points=[[0, 0], [10, 0]]),
            feature("osm-way-2", 2, points=[[10, 0], [30, 0]]),
        ])
        self.assertEqual(validate_transport(value), [])

    def test_schema_and_stable_ids(self):
        value = dataset([feature("temporary-1", 7)])
        self.assertIn("id.unstable", self.codes(value))
        del value["version"]
        self.assertIn("schema.missing", self.codes(value))

    def test_zero_length_and_reversed_duplicate(self):
        value = dataset([
            feature(points=[[0, 0], [0, 0], [10, 0]]),
            feature("osm-way-2", 2, points=[[10, 0], [0, 0], [0, 0]]),
        ])
        codes = self.codes(value)
        self.assertIn("geometry.zero_length", codes)
        self.assertIn("geometry.duplicate", codes)

    def test_self_intersection(self):
        value = dataset([feature(points=[[0, 0], [10, 10], [0, 10], [10, 0]])])
        self.assertIn("geometry.self_intersection", self.codes(value))

    def test_width_and_pedestrian_vehicle_access(self):
        value = dataset([feature(
            kind="boardwalk", width=20, vehicleAllowed=True,
            points=[[0, 0], [30, 0]],
        )])
        codes = self.codes(value)
        self.assertIn("width.implausible", codes)
        self.assertIn("access.pedestrian_vehicle", codes)

    def test_short_disconnected_fragment_is_warning(self):
        value = dataset([feature(points=[[0, 0], [5, 0]])])
        issues = validate_transport(value)
        self.assertTrue(any(
            issue.code == "topology.short_orphan" and issue.severity == "warning"
            for issue in issues
        ))

    def test_short_t_junction_is_not_an_orphan(self):
        value = dataset([
            feature(points=[[0, 0], [5, 0]]),
            feature("osm-way-2", 2, points=[[5, -10], [5, 10]]),
        ])
        orphan_ids = [
            issue.feature_id for issue in validate_transport(value)
            if issue.code == "topology.short_orphan"
        ]
        self.assertNotIn("osm-way-1", orphan_ids)

    def test_nearby_short_fragment_remains_an_orphan(self):
        value = dataset([
            feature(points=[[0, 0], [5, 0]]),
            feature("osm-way-2", 2, points=[[7, -10], [7, 10]]),
        ])
        issues = [
            issue for issue in validate_transport(value)
            if issue.code == "topology.short_orphan"
            and issue.feature_id == "osm-way-1"
        ]
        self.assertEqual([issue.feature_id for issue in issues], ["osm-way-1"])

    def test_chunk_manifest_integrity(self):
        value = dataset([feature()])
        value["chunks"] = {"bad": ["osm-way-999", "osm-way-999"]}
        codes = self.codes(value)
        self.assertIn("chunk.key", codes)
        self.assertIn("chunk.order", codes)
        self.assertIn("chunk.unknown_feature", codes)
        self.assertIn("chunk.missing_feature", codes)

    def test_chunk_manifest_covers_segment_crossings(self):
        value = dataset([feature(points=[[100, 100], [2200, 100]])])
        value["chunks"] = {"0,0": ["osm-way-1"], "1,0": []}
        codes = [issue.code for issue in validate_transport(value)]
        self.assertIn("chunk.spatial_gap", codes)

    def test_findings_are_deterministic(self):
        value = dataset([feature(points=[[0, 0], [0, 0]])])
        self.assertEqual(validate_transport(copy.deepcopy(value)),
                         validate_transport(copy.deepcopy(value)))


if __name__ == "__main__":
    unittest.main()
