import json
import struct
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TerrainErrorAssetTests(unittest.TestCase):
    def test_error_asset_matches_manifest_quadtree(self):
        manifest = json.loads((ROOT / "terrain/public/tiles.json").read_text())
        path = ROOT / "terrain/public" / manifest["geometricError"]["url"]
        data = path.read_bytes()
        magic, version, levels, grids, reserved, quantization = struct.unpack_from(
            "<4sHHHHf", data, 0)
        self.assertEqual(magic, b"GTE1")
        self.assertEqual(version, 1)
        self.assertEqual(levels, manifest["maxZoom"] + 1)
        self.assertEqual(grids, 6)
        self.assertEqual(reserved, 0)
        self.assertAlmostEqual(quantization, 0.1)
        cursor = 16 + grids * 2
        payload_values = 0
        for z in range(levels):
            nx, ny, offset = struct.unpack_from("<HHI", data, cursor)
            cursor += 8
            coverage = manifest["tileSize"] * (1 << (manifest["maxZoom"] - z))
            self.assertEqual(nx, -(-manifest["width"] // coverage))
            self.assertEqual(ny, -(-manifest["height"] // coverage))
            self.assertEqual(offset, payload_values)
            payload_values += nx * ny * grids
        self.assertEqual(len(data), cursor + payload_values * 2)


if __name__ == "__main__":
    unittest.main()
