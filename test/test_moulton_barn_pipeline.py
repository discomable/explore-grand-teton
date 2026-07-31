import importlib.util
import json
import math
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read_json(relative):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class MoultonBarnPipelineTests(unittest.TestCase):
    def test_runtime_placement_tracks_named_footprint_not_approximate_seed(self):
        buildings = read_json("terrain/public/buildings.json")["buildings"]
        footprint = next(item for item in buildings if item.get("name") == "T. A. Moulton Barn")
        centre = [
            sum(point[axis] for point in footprint["pts"]) / len(footprint["pts"])
            for axis in (0, 1)
        ]
        landmark = read_json("terrain/public/landmarks.json")["landmarks"][0]
        self.assertLess(math.dist(centre, landmark["position"]), 0.15)

        spec = importlib.util.spec_from_file_location(
            "utm", ROOT / "terrain/pipeline/roads/utm.py")
        utm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(utm)
        config = read_json("terrain/pipeline/buildings/moulton_barn/building.json")
        easting, northing = utm.wgs84_to_utm12(
            config["location"]["latitude"], config["location"]["longitude"])
        seed_world = [easting - 522180.8068557632, 4842506.167973563 - northing]
        self.assertGreater(math.dist(seed_world, landmark["position"]), 25)
        self.assertLess(math.dist(seed_world, landmark["position"]), 40)

    def test_generated_lods_stay_inside_runtime_budgets(self):
        report = read_json("terrain/public/models/ta-moulton-barn-validation.json")
        self.assertEqual(report["status"], "measured_pending_photographic_qa")
        limits = {"LOD0": 5000, "LOD1": 1000, "LOD2": 250}
        draw_limits = {"LOD0": 4, "LOD1": 3, "LOD2": 3}
        for lod, limit in limits.items():
            self.assertLessEqual(report["triangle_counts"][lod], limit)
            self.assertLessEqual(report["material_primitives_per_lod"][lod], draw_limits[lod])
        for index in range(3):
            path = ROOT / f"terrain/public/models/ta-moulton-barn-lod{index}.glb"
            self.assertTrue(path.is_file())
            # LODs embed a compact WebP atlas for standalone validity. Runtime reuses the first
            # decoded texture across all three, so this guards transfer without assuming three
            # resident copies.
            # Hero includes the registered facade plus small silhouette geometry; the decoded
            # texture remains shared and the two streaming LODs stay below 192 KiB.
            size_limit = 448 * 1024 if index == 0 else 192 * 1024
            self.assertLess(path.stat().st_size, size_limit)

    def test_estimates_remain_explicit(self):
        measurements = read_json(
            "terrain/pipeline/buildings/moulton_barn/measurements.estimated.json")
        self.assertTrue(measurements["uncertainty"])
        for value, provenance in measurements["provenance"].items():
            self.assertIn("estimate", provenance, value)

    def test_lidar_measurements_retain_source_and_review_status(self):
        measurements = read_json(
            "terrain/pipeline/buildings/moulton_barn/measurements.lidar-2022.json")
        self.assertEqual(measurements["status"], "measured_pending_photographic_qa")
        self.assertGreater(measurements["point_counts"]["building_used"], 1000)
        self.assertEqual(len(measurements["source"]["sha256"]), 64)
        self.assertTrue(all("lidar" in value.lower()
                            for value in measurements["provenance"].values()))

        references = read_json(
            "terrain/pipeline/buildings/moulton_barn/reference-sources.json")
        self.assertGreaterEqual(len(references["references"]), 6)
        self.assertTrue(all(len(item["sha256"]) == 64
                            for item in references["references"]))


if __name__ == "__main__":
    unittest.main()
