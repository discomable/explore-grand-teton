#!/usr/bin/env python3
"""
Bake horizon-angle maps for terrain-cast shadows (golden-hour drama at zero runtime cost).

For 8 azimuths (every 45°, from +x/east rotating toward +z/south — matching the runtime's world
axes AND pixel axes, since pixel row+ = south), compute per texel the maximum elevation angle of
the terrain silhouette in that direction. At runtime the shader compares sun elevation against
the interpolated horizon angle: below → in shadow. The mountains genuinely cast their 20 km
evening shadows across Jackson Hole, and they move with the sun.

Output: horizon_a.png (bins 0-3 in RGBA), horizon_b.png (bins 4-7), horizon.json.
Angles encoded 0..MAX_DEG over 0..255. Works at ~40 m — cast shadows don't need 1 m detail.

Usage: bake_horizon.py --dem work/dem_filled.tif --out ../public [--res-factor 4]
"""
import argparse, json, math, os
import numpy as np
import rasterio
from scipy import ndimage
from PIL import Image

MAX_DEG = 60.0

ap = argparse.ArgumentParser()
ap.add_argument("--dem", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--res-factor", type=int, default=4, help="decimation vs the DEM (4 → 40 m at 10 m)")
ap.add_argument("--max-km", type=float, default=26.0)
a = ap.parse_args()

with rasterio.open(a.dem) as src:
    dem = src.read(1).astype(np.float32)
    px = src.transform.a
H0, W0 = dem.shape
f = a.res_factor
Hc, Wc = H0 // f, W0 // f
dem = dem[:Hc * f, :Wc * f].reshape(Hc, f, Wc, f).mean(axis=(1, 3))
res = px * f
print(f"horizon grid {Wc}x{Hc} @ {res:.0f} m")

# geometric distance ladder (px): dense near, sparse far
dists, d = [], 1.2
while d * res < a.max_km * 1000:
    dists.append(d); d *= 1.22
dists = np.array(dists)
print(f"{len(dists)} distance steps to {dists[-1]*res/1000:.1f} km")

rows, cols = np.mgrid[0:Hc, 0:Wc].astype(np.float32)
layers = []
for k in range(8):
    phi = k * math.pi / 4          # 0=east(+x/+col) … 2=south(+z/+row) … CCW in (col,row)
    dc, dr = math.cos(phi), math.sin(phi)
    best = np.full((Hc, Wc), -1e9, dtype=np.float32)
    for dpx in dists:
        sr = rows + dr * dpx
        sc = cols + dc * dpx
        hs = ndimage.map_coordinates(dem, [sr, sc], order=1, mode="nearest")
        np.maximum(best, (hs - dem) / (dpx * res), out=best)
    ang = np.degrees(np.arctan(np.maximum(best, 0.0)))
    layers.append(np.clip(ang / MAX_DEG * 255.0, 0, 255).astype(np.uint8))
    print(f"  azimuth {k*45}° done (max {ang.max():.1f}°)")

os.makedirs(a.out, exist_ok=True)
Image.fromarray(np.stack(layers[0:4], axis=-1), "RGBA").save(os.path.join(a.out, "horizon_a.png"))
Image.fromarray(np.stack(layers[4:8], axis=-1), "RGBA").save(os.path.join(a.out, "horizon_b.png"))
json.dump({"urlA": "horizon_a.png", "urlB": "horizon_b.png",
           "maxAngleDeg": MAX_DEG, "width": Wc, "height": Hc, "res": res},
          open(os.path.join(a.out, "horizon.json"), "w"), indent=1)
print(f"Wrote horizon maps -> {a.out}")
