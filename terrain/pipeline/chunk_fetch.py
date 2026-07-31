#!/usr/bin/env python3
"""
Chunked fetch of a USGS 3DEP DEM from the OpenTopography REST API, then mosaic to one GeoTIFF.

OpenTopography caps the area per request (tightest for the 1 m dataset), so we tile the bbox into
sub-requests, download each, and build a VRT mosaic. Re-running skips chunks already on disk.

Usage:
    OT_API_KEY=xxxx python3 chunk_fetch.py \
        --dataset USGS1m --west -110.90 --south 43.55 --east -110.55 --north 43.92 \
        --step 0.02 --out raw_dem.tif
"""
import argparse, os, subprocess, sys, time
import requests

API = "https://portal.opentopography.org/API/usgsdem"


def frange(lo, hi, step):
    x = lo
    while x < hi - 1e-9:
        yield x, min(x + step, hi)
        x += step


def fetch_chunk(dataset, w, s, e, n, key, path):
    if os.path.exists(path) and os.path.getsize(path) > 2048:
        return True
    params = dict(datasetName=dataset, south=s, north=n, west=w, east=e,
                  outputFormat="GTiff", API_Key=key)
    for attempt in range(4):
        r = requests.get(API, params=params, timeout=600)
        # content-type varies (octet-stream etc.) — sniff the TIFF magic instead
        if r.status_code == 200 and r.content[:4] in (b"II*\x00", b"MM\x00*"):
            with open(path, "wb") as f:
                f.write(r.content)
            return True
        # 204 = no data in this sub-box (ocean/gap) — skip quietly
        if r.status_code == 204:
            return False
        # 429/5xx — back off and retry
        wait = 5 * (attempt + 1)
        print(f"  chunk {path} HTTP {r.status_code}, retry in {wait}s ({r.text[:120]})",
              file=sys.stderr)
        time.sleep(wait)
    print(f"  giving up on {path}", file=sys.stderr)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="USGS1m", help="USGS1m | USGS10m | USGS30m")
    ap.add_argument("--west", type=float, required=True)
    ap.add_argument("--south", type=float, required=True)
    ap.add_argument("--east", type=float, required=True)
    ap.add_argument("--north", type=float, required=True)
    ap.add_argument("--step", type=float, default=0.02,
                    help="sub-request size in degrees (~2 km at 0.02). Smaller = safer for 1 m.")
    ap.add_argument("--out", default="raw_dem.tif")
    ap.add_argument("--tmp", default="chunks")
    args = ap.parse_args()

    key = os.environ.get("OT_API_KEY")
    if not key:
        sys.exit("Set OT_API_KEY (free key from https://portal.opentopography.org)")

    os.makedirs(args.tmp, exist_ok=True)
    got = []
    for iy, (s, n) in enumerate(frange(args.south, args.north, args.step)):
        for ix, (w, e) in enumerate(frange(args.west, args.east, args.step)):
            path = os.path.join(args.tmp, f"c_{iy:03d}_{ix:03d}.tif")
            print(f"[{args.dataset}] chunk y{iy} x{ix}  {w:.3f},{s:.3f} .. {e:.3f},{n:.3f}")
            if fetch_chunk(args.dataset, w, s, e, n, key, path):
                got.append(path)
            time.sleep(1.0)  # be polite to the API

    if not got:
        sys.exit("No chunks downloaded — check bbox/key/dataset.")

    vrt = "mosaic.vrt"
    subprocess.check_call(["gdalbuildvrt", vrt, *got])
    # BIGTIFF because a 1 m mosaic of a large bbox easily exceeds 4 GB
    subprocess.check_call([
        "gdal_translate", "-co", "BIGTIFF=YES", "-co", "TILED=YES",
        "-co", "COMPRESS=DEFLATE", vrt, args.out])
    print(f"\nMosaic written: {args.out}  ({len(got)} chunks)")


if __name__ == "__main__":
    main()
