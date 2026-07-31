#!/usr/bin/env python3
"""
Cut a terrain-RGB tile pyramid from a float DEM — replaces gdal2tiles for this project.

Why not gdal2tiles: its overview zooms are built by resampling the *packed RGB bytes*, which is
numerically meaningless for terrain-RGB (a ±1 blend in the R channel = ±6553 m spikes). Here every
zoom level is downsampled in *height space* (box mean), then encoded. Tiles are opaque RGB webp
(no alpha channel → no canvas premultiply loss at decode time); padding beyond the raster edge is
filled with the DEM minimum, matching the runtime decoder's floor.

Scheme (consumed by src/TerrainStreamer.js):
  zoom z tile covers tileSize * 2^(maxZoom - z) native pixels, origin at the raster top-left;
  grid = ceil(w / cov) x ceil(h / cov); {z}/{x}/{y}.webp with y=0 at the north edge.

Usage:  tile_pyramid.py dem_filled.tif ../public/tiles [--tilesize 512]
"""
import argparse, math, os
import numpy as np
import rasterio
from PIL import Image

BASEVAL, INTERVAL = -10000.0, 0.1

ap = argparse.ArgumentParser()
ap.add_argument("dem"); ap.add_argument("out")
ap.add_argument("--tilesize", type=int, default=512)
a = ap.parse_args()
T = a.tilesize

with rasterio.open(a.dem) as src:
    dem = src.read(1).astype(np.float32)   # float32: a 1.25 m park grid is ~3 GB, f64 would be 6
H, W = dem.shape
floor = float(np.nanmin(dem))
dem = np.nan_to_num(dem, nan=floor)
maxz = max(0, math.ceil(math.log2(max(W, H) / T)))
print(f"DEM {W}x{H}, floor {floor:.1f} m -> zooms 0..{maxz}")

def encode(h):
    """float heights -> uint8 RGB (Mapbox terrain-RGB)."""
    v = np.rint((h - BASEVAL) / INTERVAL).astype(np.uint32)
    return np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)

total = 0
level = dem
for z in range(maxz, -1, -1):
    lh, lw = level.shape
    nx, ny = math.ceil(lw / T), math.ceil(lh / T)
    # pad to full tiles with the floor value
    pad = np.full((ny * T, nx * T), floor, dtype=np.float32)
    pad[:lh, :lw] = level
    for tx in range(nx):
        os.makedirs(os.path.join(a.out, str(z), str(tx)), exist_ok=True)
        for ty in range(ny):
            tile = pad[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T]
            img = Image.fromarray(encode(tile), "RGB")
            img.save(os.path.join(a.out, str(z), str(tx), f"{ty}.webp"),
                     "WEBP", lossless=True, quality=100)
            total += 1
    print(f"  z{z}: {nx}x{ny} tiles ({lw}x{lh}px)")
    if z:  # halve in HEIGHT space (box mean) for the next-coarser level
        eh, ew = lh + (lh & 1), lw + (lw & 1)          # pad odd dims by edge-replication
        e = np.empty((eh, ew)); e[:lh, :lw] = level
        if eh > lh: e[lh:, :lw] = level[-1:, :]
        if ew > lw: e[:lh, lw:] = level[:, -1:]
        if eh > lh and ew > lw: e[lh:, lw:] = level[-1, -1]
        level = e.reshape(eh // 2, 2, ew // 2, 2).mean(axis=(1, 3))

print(f"Wrote {total} tiles -> {a.out}")
