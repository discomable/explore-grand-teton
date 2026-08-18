import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import benchmark


class RouteCertificationTests(unittest.TestCase):
    def test_endurance_manifest_covers_and_materializes_all_pathologies(self):
        manifest = benchmark.load_endurance_routes()
        self.assertEqual(manifest["repetitions"], 2)
        self.assertEqual(manifest["telemetryHz"], 4)
        self.assertEqual({route["kind"] for route in manifest["routes"]},
                         benchmark.ENDURANCE_KINDS)
        self.assertEqual(len(manifest["routes"]), 7)
        boundary = next(route for route in manifest["routes"]
                        if route["kind"] == "tile-boundary")["boundary"]
        self.assertEqual(boundary["zoom"], 7)
        self.assertAlmostEqual(boundary["coordinate"], -80.0)
        self.assertAlmostEqual(boundary["tileSpan"], 640.0)
        by_kind = {route["kind"]: route for route in manifest["routes"]}
        self.assertEqual(by_kind["linear"]["speedMps"], 350)
        self.assertEqual(by_kind["turns"]["speedMps"], 300)
        self.assertEqual(by_kind["altitude-cycle"]["maximumAglMeters"], 3000)
        self.assertEqual(by_kind["rotation"]["origin"][1], 1500)
        self.assertEqual(by_kind["target"]["speedMps"], 220)

    def test_tile_boundary_derivation_rejects_outer_or_invalid_edges(self):
        tiles = json.loads((benchmark.ROOT / "terrain/public/tiles.json").read_text())
        with self.assertRaisesRegex(ValueError, "interior edge"):
            benchmark.derive_tile_boundary(tiles, 7, "x", 0)
        with self.assertRaisesRegex(ValueError, "x/z"):
            benchmark.derive_tile_boundary(tiles, 7, "y", 2)

    def test_manifest_covers_every_required_transport_scenario(self):
        routes = benchmark.load_routes()
        covered = set().union(*(route["certificationTargets"] for route in routes.values()))
        self.assertEqual(covered, benchmark.CERTIFICATION_TARGETS)
        self.assertGreaterEqual(len(routes), 6)

    def test_routes_materialize_to_existing_views(self):
        routes = list(benchmark.load_routes().values())
        views = json.loads((benchmark.ROOT / "views.json").read_text())
        known = {view["name"] for view in views}
        for route in routes:
            self.assertLessEqual(set(benchmark.waypoint_names(route)), known)
        captures = benchmark.materialize_routes(routes, views, "night", "first-person")
        self.assertEqual(len(captures), len(routes))
        self.assertTrue(all(len(capture["waypoints"]) >= 2 for capture in captures))
        self.assertTrue(all(capture["certificationTargets"] for capture in captures))
        self.assertTrue(all(capture["time"] == 0.05 for capture in captures))
        self.assertTrue(all(capture["cameraMode"] == 2 for capture in captures))
        self.assertTrue(all(capture["name"].endswith("-night-first-person")
                            for capture in captures))
        self.assertEqual([capture["routeId"] for capture in captures],
                         [route["id"] for route in routes])

    def test_cycle_suffixes_keep_repeated_route_evidence_unique(self):
        route = next(iter(benchmark.load_routes().values()))
        views = json.loads((benchmark.ROOT / "views.json").read_text())
        repeated = [dict(route, _captureCycle=cycle) for cycle in (1, 2)]
        captures = benchmark.materialize_routes(repeated, views, "day", "near-chase")
        self.assertEqual([capture["name"] for capture in captures], [
            f"{route['id']}-day-near-chase-cycle-01",
            f"{route['id']}-day-near-chase-cycle-02",
        ])

    def test_duration_scale_extends_routes_and_names_the_evidence(self):
        route = next(iter(benchmark.load_routes().values()))
        views = json.loads((benchmark.ROOT / "views.json").read_text())
        capture = benchmark.materialize_routes(
            [dict(route, _durationScale=5)], views, "day", "far-chase")[0]
        self.assertEqual(capture["durationSeconds"], route["durationSeconds"] * 5)
        self.assertEqual(capture["name"], f"{route['id']}-day-far-chase-duration-5x")
        decimal = benchmark.materialize_routes(
            [dict(route, _durationScale=1.1)], views, "day", "far-chase")[0]
        self.assertTrue(decimal["name"].endswith("-duration-1p1x"))

    def test_schema_rejects_incomplete_certification_coverage(self):
        document = {
            "schemaVersion": 2,
            "routes": [{
                "id": "partial", "mode": "drive", "durationSeconds": 8,
                "certificationTargets": ["highway"],
                "waypoints": [{"view": "sage-ground"}, {"view": "sage-ground"}],
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "routes.json"
            path.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "coverage is incomplete"):
                benchmark.load_routes(path)

    def test_performance_gate_reports_high_and_accessible_failures(self):
        passing = {
            "averageFps": 48, "onePercentLowFps": 34, "maxFrameMs": 180,
            "coldStartInteractiveMs": 3900, "consoleErrors": [], "failedRequests": [],
            "visibleTerrainCoverage": {"complete": True},
        }
        self.assertTrue(benchmark.evaluate_route_gate(passing, "high")["passed"])
        failing = dict(passing, averageFps=29, maxFrameMs=360)
        gate = benchmark.evaluate_route_gate(failing, "low")
        self.assertFalse(gate["passed"])
        self.assertEqual(gate["tier"], "accessible")
        self.assertFalse(gate["checks"]["averageFps"])
        self.assertFalse(gate["checks"]["maxFrameMs"])

        incomplete = dict(passing, visibleTerrainCoverage={"complete": False})
        gate = benchmark.evaluate_route_gate(incomplete, "high")
        self.assertFalse(gate["passed"])
        self.assertFalse(gate["checks"]["visibleTerrainCoverage"])

    def test_summary_counts_incomplete_terrain_views(self):
        summary = benchmark.summarize([
            {"meanFrameMs": 16, "visibleTerrainCoverage": {"complete": True}},
            {"meanFrameMs": 17, "visibleTerrainCoverage": {"complete": False}},
        ])
        self.assertEqual(summary["incompleteTerrainViews"], 1)


if __name__ == "__main__":
    unittest.main()
