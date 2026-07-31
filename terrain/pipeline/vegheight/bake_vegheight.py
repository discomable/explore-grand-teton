#!/usr/bin/env python3
"""
Bake terrain/public/vegheight.png from a LANDFIRE LF2025 EVH+EVC clip.

Input: a 2-band GeoTIFF (band 1 = LF2025_EVH_CONUS, band 2 = LF2025_EVC_CONUS), 30 m,
EPSG:5070-style Albers (the clip that shipped in ../data/landfire/extracted/).

LANDFIRE EVH/EVC use the *detailed* coded VALUE encoding (not raw metres/percent):
  Trees   VALUE 101-199 : height_m = VALUE - 100        cover% = VALUE - 100
  Shrubs  VALUE 201-299 : height_m = (VALUE-200)*0.1     cover% = VALUE - 200
  Herb    VALUE 301-399 : height_m = (VALUE-300)*0.1     cover% = VALUE - 300
  Non-veg VALUE  11- 99 : height 0, cover 0  (water/snow/developed/barren)
(EVH herb/shrub codes carry heights in 0.1 m steps; trees in whole metres. EVC codes carry
percent directly for trees, and life-form percent for shrub/herb.)

Output onto the SAME world grid style as landcover.png (UTM EPSG:32612, same origin), coarser
res to stay small:
  vegheight.png  R = veg height   metres 0..50  -> 0..250   (clamped)
                 G = canopy cover  percent 0..100 -> 0..200
                 B = 0
  vegheight.json origin/res/mapping mirrored from landcover.json (world center/datum identical)

Run:
  python3 bake_vegheight.py \
      --evhevc ../data/landfire/extracted/jef8aeb32850d410bbc2903214959ddf7.tif \
      --landcover ../../public/landcover.json --res 20 --out ../../public
Temporaries are written to a TemporaryDirectory and deleted on exit (storage!).
"""
import argparse, json, math, os, subprocess, sys, tempfile
import numpy as np
from osgeo import gdal

gdal.UseExceptions()

UTM = "EPSG:32612"


def run(*cmd):
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.check_call([str(c) for c in cmd])


def decode_height_m(v):
    """LANDFIRE EVH coded VALUE -> vegetation height in metres (0 for non-veg)."""
    h = np.zeros(v.shape, dtype=np.float32)
    tree = (v >= 101) & (v <= 199)
    shrub = (v >= 201) & (v <= 299)
    herb = (v >= 301) & (v <= 399)
    h[tree] = (v[tree] - 100).astype(np.float32)
    h[shrub] = (v[shrub] - 200).astype(np.float32) * 0.1
    h[herb] = (v[herb] - 300).astype(np.float32) * 0.1
    return h


def decode_cover_pct(v):
    """LANDFIRE EVC coded VALUE -> canopy/veg cover percent (0 for non-veg)."""
    c = np.zeros(v.shape, dtype=np.float32)
    tree = (v >= 101) & (v <= 199)
    shrub = (v >= 201) & (v <= 299)
    herb = (v >= 301) & (v <= 399)
    c[tree] = (v[tree] - 100).astype(np.float32)
    c[shrub] = (v[shrub] - 200).astype(np.float32)
    c[herb] = (v[herb] - 300).astype(np.float32)
    return np.clip(c, 0, 100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evhevc", required=True, help="2-band LANDFIRE EVH+EVC GeoTIFF")
    ap.add_argument("--landcover", required=True, help="../../public/landcover.json (grid template)")
    ap.add_argument("--res", type=float, default=20.0, help="output metres/px (10-30)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    lc = json.load(open(args.landcover))
    # landcover grid extent (UTM 32612), from its origin + res + size
    xmin = lc["originE"]
    ymax = lc["originN"]
    xmax = xmin + lc["width"] * lc["res"]
    ymin = ymax - lc["height"] * lc["res"]
    W = math.ceil((xmax - xmin) / args.res)
    H = math.ceil((ymax - ymin) / args.res)
    # snap extent to the chosen res so origin stays exact
    xmax2 = xmin + W * args.res
    ymin2 = ymax - H * args.res
    te = ["-te", xmin, ymin2, xmax2, ymax, "-tr", args.res, args.res]
    print(f"Grid: {W}x{H} @ {args.res} m  ({xmin:.0f},{ymin2:.0f})..({xmax2:.0f},{ymax:.0f}) {UTM}")

    with tempfile.TemporaryDirectory() as wd:
        # nearest resample: EVH/EVC are coded categorical VALUEs — never average them
        warped = os.path.join(wd, "evhevc_utm.tif")
        run("gdalwarp", "-t_srs", UTM, *te, "-r", "near", "-overwrite",
            "-srcnodata", "-9999", "-dstnodata", "0", args.evhevc, warped)
        ds = gdal.Open(warped)
        evh = ds.GetRasterBand(1).ReadAsArray().astype(np.int32)
        evc = ds.GetRasterBand(2).ReadAsArray().astype(np.int32)
        ds = None

        height_m = decode_height_m(evh)
        cover_pct = decode_cover_pct(evc)

        rgb = np.zeros((H, W, 3), dtype=np.uint8)
        rgb[..., 0] = np.clip(height_m / 50.0 * 250.0, 0, 255).astype(np.uint8)   # metres 0..50 -> 0..250
        rgb[..., 1] = np.clip(cover_pct / 100.0 * 200.0, 0, 255).astype(np.uint8)  # pct 0..100 -> 0..200
        os.makedirs(args.out, exist_ok=True)
        png = os.path.join(args.out, "vegheight.png")
        # write RGB via GDAL MEM -> PNG (no PIL); PNG driver needs CreateCopy from a dataset
        mem = gdal.GetDriverByName("MEM").Create("", W, H, 3, gdal.GDT_Byte)
        for b in range(3):
            mem.GetRasterBand(b + 1).WriteArray(rgb[..., b])
        gdal.GetDriverByName("PNG").CreateCopy(png, mem, options=["ZLEVEL=9"])
        mem = None
        # gdal writes a .png.aux.xml sidecar — remove it (storage / not needed by the client)
        for junk in (png + ".aux.xml",):
            if os.path.exists(junk):
                os.remove(junk)

    meta = {
        "crs": UTM, "res": args.res, "width": W, "height": H,
        "originE": xmin, "originN": ymax,
        "url": "vegheight.png",
        "world": lc["world"],                # identical center/datum mapping as landcover
        "encode": {                          # decode hints for the client
            "heightR": {"maxM": 50.0, "scale": 250.0},
            "coverG": {"maxPct": 100.0, "scale": 200.0},
        },
        "source": "LANDFIRE LF2025 EVH+EVC (detailed coded VALUE decode)",
    }
    json.dump(meta, open(os.path.join(args.out, "vegheight.json"), "w"), indent=1)

    sz = os.path.getsize(png)
    treed = (height_m >= 3).mean() * 100
    print(f"Wrote {png} ({W}x{H}, {sz/1e6:.2f} MB) + vegheight.json")
    print(f"  height  m: min {height_m.min():.1f} max {height_m.max():.1f} mean {height_m.mean():.1f}")
    print(f"  cover pct: min {cover_pct.min():.0f} max {cover_pct.max():.0f} mean {cover_pct.mean():.0f}")
    print(f"  pixels with height >= 3 m (tree-capable): {treed:.1f}%")


if __name__ == "__main__":
    main()
