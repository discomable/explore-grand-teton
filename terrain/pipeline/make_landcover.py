#!/usr/bin/env python3
"""
Bake the landcover/water mask for the park: NLCD landcover classes + NHD water polygons,
rasterized onto the same UTM grid as the DEM, plus per-lake surface elevations from the DEM.

Outputs (into --out):
  landcover.png   RGB, R = NLCD class code, G = 255 where water, B = 0. ~10 m/px, whole park.
  landcover.json  georeferencing + world mapping (copied from tiles.json) + lake list
                  [{id, elev (m), type lake|river, minPx, maxPx, areaPx, name?}]

Run AFTER fetch_and_tile.sh (needs work/dem_filled.tif + ../public/tiles.json):
    python3 make_landcover.py --manifest ../public/tiles.json --dem work/dem_filled.tif \
        --res 10 --out ../public

Data sources (both free, no key):
  NLCD 2021 landcover — MRLC WCS (EPSG:5070). If the WCS is down, download the CONUS GeoTIFF from
    mrlc.gov manually and pass it via --nlcd-tif.
  NHD waterbodies/areas — USGS National Map ArcGIS REST (hydro.nationalmap.gov), GeoJSON queries.
"""
import argparse, json, math, os, subprocess, sys, tempfile
import numpy as np
import requests
import rasterio
from rasterio.warp import transform_bounds
from PIL import Image
from scipy import ndimage

UTM = "EPSG:32612"
MRLC_WCS = ("https://www.mrlc.gov/geoserver/mrlc_download/NLCD_2021_Land_Cover_L48/wcs"
            "?service=WCS&version=2.0.1&request=GetCoverage"
            "&coverageid=NLCD_2021_Land_Cover_L48&format=image/tiff"
            "&subset=X({x0},{x1})&subset=Y({y0},{y1})")
NHD_BASE = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer"


def run(*cmd):
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.check_call([str(c) for c in cmd])


def fetch_nlcd(bounds_utm, workdir):
    """GetCoverage from the MRLC WCS in EPSG:5070, padded a little."""
    b5070 = transform_bounds(UTM, "EPSG:5070", *bounds_utm, densify_pts=21)
    pad = 200
    url = MRLC_WCS.format(x0=b5070[0]-pad, x1=b5070[2]+pad, y0=b5070[1]-pad, y1=b5070[3]+pad)
    path = os.path.join(workdir, "nlcd_5070.tif")
    print("  fetching NLCD via WCS…")
    r = requests.get(url, timeout=600)
    if r.status_code != 200 or not r.content[:4] in (b"II*\x00", b"MM\x00*"):
        sys.exit(f"NLCD WCS failed (HTTP {r.status_code}). Download the CONUS GeoTIFF from "
                 f"mrlc.gov and re-run with --nlcd-tif <path>.\n{r.text[:300]}")
    open(path, "wb").write(r.content)
    return path


# NHD ftypes that must NOT render as open water:
#   378 Ice Mass (glaciers — they're snow in the imagery, and they drape as floating blue sheets)
#   466 Swamp/Marsh (vegetated wetland — imagery carries it; a flat water plane looks wrong)
NHD_EXCLUDE_FTYPES = {378, 466}


def fetch_nhd(bbox4326, workdir):
    """Query NHD waterbody + area polygons as GeoJSON (paginated), merge into one FeatureCollection."""
    layers = requests.get(f"{NHD_BASE}?f=json", timeout=120).json().get("layers", [])
    # large-scale layers only — the small-scale twins are coarse duplicates
    ids = [l["id"] for l in layers
           if "large scale" in l["name"].lower()
           and ("waterbody" in l["name"].lower() or l["name"].lower().startswith("area"))]
    if not ids:
        sys.exit("Could not find NHD Waterbody/Area layers — check the MapServer.")
    feats = []
    for lid in ids:
        offset = 0
        while True:
            params = dict(geometry=",".join(map(str, bbox4326)), geometryType="esriGeometryEnvelope",
                          inSR=4326, spatialRel="esriSpatialRelIntersects", where="1=1",
                          outFields="gnis_name,ftype", returnGeometry="true", f="geojson",
                          resultOffset=offset, resultRecordCount=1000)
            j = requests.get(f"{NHD_BASE}/{lid}/query", params=params, timeout=300).json()
            got = j.get("features", [])
            for f in got:
                props = {k.lower(): v for k, v in (f.get("properties") or {}).items()}
                if int(props.get("ftype") or 0) not in NHD_EXCLUDE_FTYPES:
                    feats.append(f)
            if len(got) < 1000:
                break
            offset += 1000
    print(f"  NHD: {len(feats)} water polygons (glaciers/marshes excluded)")
    path = os.path.join(workdir, "water_4326.geojson")
    json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w"))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--dem", required=True, help="UTM filled DEM (work/dem_filled.tif)")
    ap.add_argument("--res", type=float, default=10.0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nlcd-tif", help="pre-downloaded NLCD GeoTIFF (skips the WCS fetch)")
    ap.add_argument("--min-lake-px", type=int, default=20, help="min component size (px)")
    args = ap.parse_args()

    m = json.load(open(args.manifest))
    gt = m["geoTransform"]
    xmin, ymax = gt[0], gt[3]
    xmax = xmin + m["width"] * gt[1]
    ymin = ymax + m["height"] * gt[5]
    W = math.ceil((xmax - xmin) / args.res)
    H = math.ceil((ymax - ymin) / args.res)
    te = ["-te", xmin, ymin, xmax, ymax, "-tr", args.res, args.res]
    print(f"Grid: {W}x{H} @ {args.res} m  ({xmin:.0f},{ymin:.0f})..({xmax:.0f},{ymax:.0f}) {UTM}")

    with tempfile.TemporaryDirectory() as wd:
        # --- NLCD classes -> UTM grid (nearest: these are categorical) ---
        nlcd_src = args.nlcd_tif or fetch_nlcd((xmin, ymin, xmax, ymax), wd)
        nlcd_utm = os.path.join(wd, "nlcd_utm.tif")
        run("gdalwarp", "-t_srs", UTM, *te, "-r", "near", "-overwrite", nlcd_src, nlcd_utm)

        # --- NHD water polygons -> UTM -> rasterized mask ---
        bbox4326 = transform_bounds(UTM, "EPSG:4326", xmin, ymin, xmax, ymax, densify_pts=21)
        gj = fetch_nhd(bbox4326, wd)
        water_utm = os.path.join(wd, "water_utm.gpkg")
        run("ogr2ogr", "-t_srs", UTM, water_utm, gj)
        water_tif = os.path.join(wd, "water.tif")
        run("gdal_rasterize", "-burn", 1, "-init", 0, "-ot", "Byte", *te, water_utm, water_tif)

        # --- DEM on the same grid, for lake surface elevations ---
        dem_lc = os.path.join(wd, "dem_lc.tif")
        run("gdalwarp", "-t_srs", UTM, *te, "-r", "bilinear", "-overwrite", args.dem, dem_lc)

        classes = rasterio.open(nlcd_utm).read(1).astype(np.uint8)
        water = rasterio.open(water_tif).read(1).astype(np.uint8)
        dem = rasterio.open(dem_lc).read(1).astype(np.float32)

    # --- connected water components -> lake/river entries with DEM elevations ---
    labels, n = ndimage.label(water)
    lakes = []
    for i in range(1, n + 1):
        ys, xs = np.nonzero(labels == i)
        if len(xs) < args.min_lake_px:
            continue
        elevs = dem[ys, xs]
        p5, p95 = np.percentile(elevs, [5, 95])
        lakes.append({
            "id": i,
            "elev": round(float(np.median(elevs)), 2),
            # hydro-flattened lakes are near-constant; a spread means flowing water
            "type": "river" if (p95 - p5) > 3.0 else "lake",
            "minPx": [int(xs.min()), int(ys.min())],
            "maxPx": [int(xs.max()), int(ys.max())],
            "areaPx": int(len(xs)),
        })
    lakes.sort(key=lambda L: -L["areaPx"])
    print(f"Water components kept: {len(lakes)} "
          f"({sum(1 for L in lakes if L['type']=='river')} river-like)")

    # --- write outputs ---
    os.makedirs(args.out, exist_ok=True)
    rgb = np.zeros((H, W, 3), dtype=np.uint8)
    rgb[..., 0] = classes
    rgb[..., 1] = water * 255
    Image.fromarray(rgb).save(os.path.join(args.out, "landcover.png"), optimize=True)

    meta = {
        "crs": UTM, "res": args.res, "width": W, "height": H,
        "originE": xmin, "originN": ymax,
        "url": "landcover.png",
        "world": m["world"],           # same center/datum as the terrain manifest
        "lakes": lakes,
        "legend": {"41": "deciduous", "42": "evergreen", "43": "mixed", "52": "shrub",
                   "71": "grassland", "90": "woody wetlands", "95": "herbaceous wetlands"},
    }
    json.dump(meta, open(os.path.join(args.out, "landcover.json"), "w"), indent=1)
    print(f"Wrote {args.out}/landcover.png ({W}x{H}) + landcover.json")


if __name__ == "__main__":
    main()
