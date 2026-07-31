#!/usr/bin/env python3
"""Encode a float DEM as Mapbox terrain-RGB: h = -10000 + (R*65536 + G*256 + B) * 0.1.
Replaces rio-rgbify (which trips over inherited nodata tags). Matches the decoder in
terrain/src/TerrainStreamer.js and the encoding block in tiles.json.
"""
import argparse
import numpy as np
import rasterio

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--baseval", type=float, default=-10000.0)
ap.add_argument("--interval", type=float, default=0.1)
a = ap.parse_args()

with rasterio.open(a.src) as src:
    dem = src.read(1).astype(np.float64)
    prof = src.profile

v = np.rint((dem - a.baseval) / a.interval).astype(np.uint32)
rgb = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255]).astype(np.uint8)

prof.pop("blockxsize", None); prof.pop("blockysize", None)   # stale strip-layout tags
prof.update(count=3, dtype="uint8", nodata=None, photometric="RGB",
            compress="deflate", tiled=True, blockxsize=256, blockysize=256)
with rasterio.open(a.dst, "w", **prof) as dst:
    dst.write(rgb)
print(f"terrain-RGB written: {a.dst}  ({dem.shape[1]}x{dem.shape[0]}, "
      f"elev {np.nanmin(dem):.0f}..{np.nanmax(dem):.0f} m)")
