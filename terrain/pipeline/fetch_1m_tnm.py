#!/usr/bin/env python3
"""
Fetch USGS 3DEP 1-meter DEM tiles from The National Map staged products (no API key).

OpenTopography restricts its USGS1m endpoint to academic keys, so we go to the source: TNM Access
lists staged GeoTIFFs on S3. Products overlap across lidar projects/vintages — we dedupe by the
10-km cell id in the title (x##y###), preferring the park-dedicated WY_GrandTetonNP project, then
the newest publication date.

Usage: fetch_1m_tnm.py --west -110.90 --south 43.55 --east -110.55 --north 43.92 \
           --tmp tnm_tiles --out raw_dem_1m.vrt
"""
import argparse, os, re, subprocess, sys, time
import requests

API = "https://tnmaccess.nationalmap.gov/api/v1/products"
DATASET = "Digital Elevation Model (DEM) 1 meter"


def list_products(bbox):
    items, offset = [], 0
    while True:
        r = requests.get(API, params={
            "datasets": DATASET, "bbox": ",".join(map(str, bbox)),
            "outputFormat": "JSON", "max": 100, "offset": offset}, timeout=120)
        r.raise_for_status()
        j = r.json()
        items.extend(j.get("items", []))
        offset += 100
        if offset >= j.get("total", 0):
            return items


def pick_per_cell(items, prefer="GrandTetonNP"):
    cells = {}
    for it in items:
        mcell = re.search(r"x(\d+)y(\d+)", it.get("title", ""))
        if not mcell:
            continue
        key = mcell.group(0)
        cur = cells.get(key)
        score = (prefer in it.get("title", ""), it.get("publicationDate", ""))
        if cur is None or score > cur[0]:
            cells[key] = (score, it)
    return {k: v[1] for k, v in cells.items()}


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1 << 20:
        return True
    for attempt in range(3):
        try:
            with requests.get(url, stream=True, timeout=1800) as r:
                r.raise_for_status()
                tmp = path + ".part"
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                os.replace(tmp, path)
                return True
        except Exception as ex:
            print(f"  retry {os.path.basename(path)}: {ex}", file=sys.stderr)
            time.sleep(8 * (attempt + 1))
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--west", type=float, required=True)
    ap.add_argument("--south", type=float, required=True)
    ap.add_argument("--east", type=float, required=True)
    ap.add_argument("--north", type=float, required=True)
    ap.add_argument("--tmp", default="tnm_tiles")
    ap.add_argument("--out", default="raw_dem_1m.vrt")
    a = ap.parse_args()

    items = list_products((a.west, a.south, a.east, a.north))
    cells = pick_per_cell(items)
    total_mb = sum(i.get("sizeInBytes", 0) for i in cells.values()) / 1e6
    print(f"{len(items)} products -> {len(cells)} unique cells, ~{total_mb:.0f} MB")

    os.makedirs(a.tmp, exist_ok=True)
    got = []
    for k, it in sorted(cells.items()):
        url = it["downloadURL"]
        path = os.path.join(a.tmp, k + ".tif")
        print(f"[1m] {k}  {it['title'][:60]}")
        if download(url, path):
            got.append(path)

    if not got:
        sys.exit("No 1 m tiles downloaded.")
    if len(got) < len(cells):
        print(f"WARNING: {len(cells)-len(got)} cells failed (10 m fills the gaps)", file=sys.stderr)
    subprocess.check_call(["gdalbuildvrt", a.out, *got])
    print(f"VRT: {a.out} ({len(got)} tiles)")


if __name__ == "__main__":
    main()
