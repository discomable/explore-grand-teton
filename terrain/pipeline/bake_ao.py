#!/usr/bin/env python3
"""
Bake a park-wide ambient-occlusion / sky-visibility map from the DEM.

Companion to bake_horizon.py (which bakes 8-azimuth horizon ANGLES for sun cast shadows).
This bakes the scalar that horizon maps can't give cheaply at runtime: total SKY VISIBILITY.
For N azimuths (default 16, twice the horizon maps' angular resolution) compute the terrain
horizon angle h(phi) per texel, then integrate cosine-weighted sky irradiance for a horizontal
receiver: V = mean_phi cos^2(h) (the classic horizon-based AO integral — each azimuth wedge of
open sky above the horizon contributes cos^2(h)/2 out of 1/2). Valley floors ~0.9, deep
couloirs/gullies ~0.5-0.65, open ridges ~1.0.

Runtime multiplies the AMBIENT term only — direct sun shadowing stays with the horizon maps,
so there is no double-counting of the sun.

Output: ao.png (single-channel L, V in 0..1 over 0..255) + ao.json, same park-extent uv
mapping as horizon.json (uWorldMin/uWorldInv in the terrain shader).

Usage: bake_ao.py --dem work/dem_filled.tif --out ../public [--res-factor 2] [--azimuths 16]
"""
import argparse, json, math, os
import numpy as np
import rasterio
from scipy import ndimage
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--dem", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--res-factor", type=int, default=2, help="decimation vs the DEM (2 -> 20 m at 10 m)")
ap.add_argument("--azimuths", type=int, default=16)
ap.add_argument("--max-km", type=float, default=20.0)
a = ap.parse_args()

with rasterio.open(a.dem) as src:
    dem = src.read(1).astype(np.float32)
    px = src.transform.a
H0, W0 = dem.shape
f = a.res_factor
Hc, Wc = H0 // f, W0 // f
dem = dem[:Hc * f, :Wc * f].reshape(Hc, f, Wc, f).mean(axis=(1, 3))
res = px * f
print(f"AO grid {Wc}x{Hc} @ {res:.0f} m, {a.azimuths} azimuths")

# geometric distance ladder (px): dense near (local gullies), sparse far (valley walls)
dists, d = [], 1.0
while d * res < a.max_km * 1000:
    dists.append(d); d *= 1.22
dists = np.array(dists)
print(f"{len(dists)} distance steps to {dists[-1]*res/1000:.1f} km")

rows, cols = np.mgrid[0:Hc, 0:Wc].astype(np.float32)
vis = np.zeros((Hc, Wc), dtype=np.float32)
for k in range(a.azimuths):
    phi = k * 2.0 * math.pi / a.azimuths
    dc, dr = math.cos(phi), math.sin(phi)
    best = np.zeros((Hc, Wc), dtype=np.float32)          # max tan(horizon), floored at 0
    for dpx in dists:
        sr = rows + dr * dpx
        sc = cols + dc * dpx
        hs = ndimage.map_coordinates(dem, [sr, sc], order=1, mode="nearest")
        np.maximum(best, (hs - dem) / (dpx * res), out=best)
    # cos^2(atan(t)) = 1 / (1 + t^2): fraction of cosine-weighted sky left in this wedge
    vis += 1.0 / (1.0 + best * best)
    print(f"  azimuth {k*360//a.azimuths}° done")
vis /= a.azimuths
print(f"sky visibility: min {vis.min():.3f}  mean {vis.mean():.3f}  max {vis.max():.3f}")

os.makedirs(a.out, exist_ok=True)
Image.fromarray(np.clip(vis * 255.0 + 0.5, 0, 255).astype(np.uint8), "L") \
     .save(os.path.join(a.out, "ao.png"), optimize=True)
json.dump({"url": "ao.png", "width": Wc, "height": Hc, "res": res,
           "azimuths": a.azimuths, "encoding": "skyVisibility 0..1 over 0..255"},
          open(os.path.join(a.out, "ao.json"), "w"), indent=1)
print(f"Wrote AO map -> {a.out} ({os.path.getsize(os.path.join(a.out,'ao.png'))/1e6:.2f} MB)")
