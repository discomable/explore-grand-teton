#!/usr/bin/env python3
"""
Write tiles.json: the geotransform, elevation range, and tile-scheme metadata the runtime needs to
map world XZ <-> pixel <-> tile. Reads the UTM DEM (for transform + true min/max elevation) and
counts the gdal2tiles zoom levels that were produced.
"""
import argparse, json, os, glob
import rasterio
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem", required=True, help="UTM, filled DEM (dem_filled.tif)")
    ap.add_argument("--tiles", required=True, help="tiles/ dir produced by gdal2tiles")
    ap.add_argument("--tilesize", type=int, default=512)
    ap.add_argument("--dataset", default="USGS1m")
    ap.add_argument("--res", type=float, default=1.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    ds = rasterio.open(args.dem)
    t = ds.transform                     # affine; GDAL order = (c, a, b, f, d, e)
    gt = (t.c, t.a, t.b, t.f, t.d, t.e)
    w, h = ds.width, ds.height

    arr = ds.read(1, masked=True)
    emin, emax = float(arr.min()), float(arr.max())

    zooms = sorted(int(os.path.basename(d)) for d in glob.glob(os.path.join(args.tiles, "*"))
                   if os.path.basename(d).isdigit())

    manifest = {
        "crs": "EPSG:32612",
        "dataset": args.dataset,
        "geoTransform": [gt[0], gt[1], gt[2], gt[3], gt[4], gt[5]],
        "width": w, "height": h,
        "nativePixelSize": abs(gt[1]),
        "tileSize": args.tilesize,
        "minZoom": min(zooms), "maxZoom": max(zooms),
        "encoding": {"scheme": "mapbox", "baseval": -10000.0, "interval": 0.1},
        "elevation": {"min": emin, "max": emax},
        "url": "tiles/{z}/{x}/{y}.webp",
        "geometricError": {
            "url": "terrain-error.bin",
            "format": "grand-teton-terrain-error/v1",
            "quantizationMeters": 0.1,
        },
        # suggested world placement: center the park, datum at valley floor
        "world": {
            "centerEasting": gt[0] + w * gt[1] / 2.0,
            "centerNorthing": gt[3] + h * gt[5] / 2.0,
            "datum": round(emin, 1),
        },
    }
    with open(args.out, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote {args.out}: {w}x{h}px, z{min(zooms)}-{max(zooms)}, elev {emin:.0f}-{emax:.0f} m")


if __name__ == "__main__":
    main()
