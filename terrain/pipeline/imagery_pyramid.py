#!/usr/bin/env python3
"""
Cut the NAIP imagery pyramid: {z}/{x}/{y}.webp (lossy q85) + imagery.json.

Same dyadic grid family as the height tiles (same extent, tileSize 512). Reads windows straight
from the mosaic VRT with average-resampling decimation, so no zoom level is ever fully resident.
Color CAN be resampled freely (unlike packed terrain-RGB heights).

Usage: imagery_pyramid.py naip_mosaic.vrt ../public/imagery [--tilesize 512] [--quality 85]
"""
import argparse, json, math, os
import numpy as np
import rasterio
from rasterio.windows import Window
from rasterio.enums import Resampling
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("out")
ap.add_argument("--tilesize", type=int, default=512)
ap.add_argument("--quality", type=int, default=85)
a = ap.parse_args()
T = a.tilesize

src = rasterio.open(a.src)
W, H = src.width, src.height
res = src.transform.a
maxz = max(0, math.ceil(math.log2(max(W, H) / T)))
print(f"imagery {W}x{H} @ {res} m -> zooms 0..{maxz}")

total = 0
for z in range(maxz + 1):
    cov = T * (1 << (maxz - z))                  # source px per tile
    nx, ny = math.ceil(W / cov), math.ceil(H / cov)
    for tx in range(nx):
        os.makedirs(os.path.join(a.out, str(z), str(tx)), exist_ok=True)
        for ty in range(ny):
            cw = min(cov, W - tx * cov)
            ch = min(cov, H - ty * cov)
            ow = max(1, round(cw / cov * T))
            oh = max(1, round(ch / cov * T))
            data = src.read([1, 2, 3], window=Window(tx * cov, ty * cov, cw, ch),
                            out_shape=(3, oh, ow), resampling=Resampling.average)
            canvas = np.full((T, T, 3), 118, dtype=np.uint8)   # neutral gray padding
            canvas[:oh, :ow] = np.moveaxis(data, 0, -1)
            Image.fromarray(canvas, "RGB").save(
                os.path.join(a.out, str(z), str(tx), f"{ty}.webp"),
                "WEBP", quality=a.quality, method=4)
            total += 1
    print(f"  z{z}: {nx}x{ny}")

meta = {"url": "imagery/{z}/{x}/{y}.webp", "tileSize": T, "minZoom": 0, "maxZoom": maxz,
        "nativePixelSize": res, "width": W, "height": H}
json.dump(meta, open(os.path.join(os.path.dirname(a.out.rstrip("/")), "imagery.json"), "w"), indent=1)
print(f"Wrote {total} tiles + imagery.json")
