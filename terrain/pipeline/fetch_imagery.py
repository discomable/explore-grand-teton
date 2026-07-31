#!/usr/bin/env python3
"""
Fetch NAIP aerial imagery for the park from the USGS National Map ImageServer, as GeoTIFF chunks
already projected onto our UTM grid, then mosaic.

The grid is the same dyadic family as the terrain tiles: extent from tiles.json, 1.25 m/px
(= 10 m / 8, so imagery tile indices align exactly with height tile indices). Chunks are
4096 px (5120 m) — precisely one z4 height tile each.

Usage:
    fetch_imagery.py --manifest ../public/tiles.json --out naip_mosaic.vrt [--res 1.25]
"""
import argparse, json, math, os, subprocess, sys, time
import requests

SERVICES = [  # tried in order
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer",
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer",
]
JPEG_MAGIC = b"\xff\xd8"
PRJ_32612 = ('PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",'
             'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],'
             'UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
             'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-111],'
             'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],'
             'PARAMETER["false_northing",0],UNIT["metre",1]]')


def fetch_chunk(service, bbox, size_px, res, path):
    """JPEG export (the service 500s on large TIFFs) + sidecar world/prj files for georef."""
    if os.path.exists(path) and os.path.getsize(path) > 4096:
        return True
    params = {
        "bbox": ",".join(f"{v:.3f}" for v in bbox),
        "bboxSR": "32612", "imageSR": "32612",
        "size": f"{size_px},{size_px}",
        "format": "jpg", "f": "image",
    }
    for attempt in range(4):
        try:
            r = requests.get(f"{service}/exportImage", params=params, timeout=600)
            if r.status_code == 200 and r.content[:2] == JPEG_MAGIC:
                open(path, "wb").write(r.content)
                # world file: pixel size, top-left pixel CENTER
                with open(path[:-4] + ".jgw", "w") as w:
                    w.write(f"{res}\n0\n0\n-{res}\n{bbox[0]+res/2}\n{bbox[3]-res/2}\n")
                open(path[:-4] + ".prj", "w").write(PRJ_32612)
                return True
            msg = r.text[:160]
        except requests.RequestException as ex:
            msg = str(ex)
        wait = 6 * (attempt + 1)
        print(f"  {os.path.basename(path)}: retry in {wait}s ({msg})", file=sys.stderr)
        time.sleep(wait)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--res", type=float, default=1.25)
    ap.add_argument("--chunk-px", type=int, default=4096)
    ap.add_argument("--tmp", default="naip_chunks")
    ap.add_argument("--out", default="naip_mosaic.vrt")
    a = ap.parse_args()

    m = json.load(open(a.manifest))
    gt = m["geoTransform"]
    xmin, ymax = gt[0], gt[3]
    xmax = xmin + m["width"] * gt[1]
    ymin = ymax + m["height"] * gt[5]
    span = a.chunk_px * a.res
    nx = math.ceil((xmax - xmin) / span)
    ny = math.ceil((ymax - ymin) / span)
    print(f"NAIP @ {a.res} m: {nx}x{ny} chunks of {a.chunk_px}px ({span:.0f} m)")

    os.makedirs(a.tmp, exist_ok=True)
    got, service_ok = [], None
    for j in range(ny):
        for i in range(nx):
            # chunk bbox clamped to the grid extent (edge chunks stay full-size requests;
            # the mosaic -te crop below trims any overhang)
            bx0, by1 = xmin + i * span, ymax - j * span
            bbox = (bx0, by1 - span, bx0 + span, by1)
            path = os.path.join(a.tmp, f"n_{j:02d}_{i:02d}.jpg")
            print(f"[naip] chunk {j},{i}")
            ok = False
            for svc in ([service_ok] if service_ok else SERVICES):
                if fetch_chunk(svc, bbox, a.chunk_px, a.res, path):
                    ok, service_ok = True, svc
                    break
            if ok:
                got.append(path)
            time.sleep(0.5)

    if len(got) < nx * ny:
        print(f"WARNING: {nx*ny - len(got)} chunks missing (holes will be gray)", file=sys.stderr)
    if not got:
        sys.exit("No NAIP chunks fetched.")
    subprocess.check_call(["gdalbuildvrt", "-te", str(xmin), str(ymin), str(xmax), str(ymax),
                           "-tr", str(a.res), str(a.res), a.out, *got])
    print(f"Mosaic VRT: {a.out} ({len(got)} chunks)")


if __name__ == "__main__":
    main()
