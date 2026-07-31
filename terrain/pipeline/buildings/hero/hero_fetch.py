#!/usr/bin/env python3
"""Download the USGS 3DEP tiles covering one named building.

    python3 hero_fetch.py --building "Chapel of the Transfiguration"
    python3 hero_fetch.py --building "Menor's Homestead" --list

Derives the search area from the named footprint in terrain/public/buildings.json,
so there are no coordinates to type. Downloads every tile of the chosen project
that overlaps the footprint — buildings near a tile seam need two — into
terrain/pipeline/data/hero/<slug>/, ready to hand to hero_lidar.py.

Prints which project it chose and why. Density is the thing that decides whether
a building can get an exact silhouette, so the choice is never silent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Polygon

REPO = Path(__file__).resolve().parents[4]
BUILDINGS = REPO / "terrain/public/buildings.json"
TILES = REPO / "terrain/public/tiles.json"
API = "https://tnmaccess.nationalmap.gov/api/v1/products"

# Highest-density first. WY_GrandTetonNP_D22 measures ~27 points/m2 over the
# park; the 2015 collection is materially sparser. An unlisted project is used
# only when nothing here covers the building, and is reported when it happens.
PREFERRED_PROJECTS = ("WY_GrandTetonNP_D22",)
SEARCH_MARGIN_M = 30.0
STALL_TIMEOUT_S = 60          # socket timeout; only catches a fully dead connection
CHUNK_BYTES = 64 * 1024       # small enough that a throttled trickle is still visible
STALL_WINDOW_S = 20.0         # throughput is judged over this window
MIN_THROUGHPUT_BPS = 40_000   # below this, reconnecting beats waiting
DOWNLOAD_ATTEMPTS = 40        # each attempt resumes, so these are cheap
TITLE = re.compile(r"USGS Lidar Point Cloud (?P<project>\S+) (?P<tile>\S+)")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def slug(name: str):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def footprint_bbox(name: str):
    """Footprint bounds in WGS84, buffered, plus the world-frame ring."""
    doc = load(BUILDINGS)
    matches = [b for b in doc["buildings"] if (b.get("name") or "") == name]
    if not matches:
        available = sorted({b["name"] for b in doc["buildings"] if b.get("name")})
        near = [n for n in available if name.split()[-1].lower() in n.lower()]
        raise SystemExit(
            f"No building named {name!r} in {BUILDINGS.relative_to(REPO)}.\n"
            + (f"Did you mean: {', '.join(near[:5])}\n" if near else "")
            + "Run hero_lidar.py --list to print every named footprint.")
    if len(matches) > 1:
        raise SystemExit(f"{len(matches)} footprints are named {name!r}; disambiguate first.")
    ring = Polygon(matches[0]["pts"])
    world = load(TILES)["world"]
    minx, minz, maxx, maxz = ring.buffer(SEARCH_MARGIN_M).bounds
    to_wgs = Transformer.from_crs("EPSG:32612", "EPSG:4326", always_xy=True)
    corners = [to_wgs.transform(x + world["centerEasting"], world["centerNorthing"] - z)
               for x in (minx, maxx) for z in (minz, maxz)]
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    return (min(lons), min(lats), max(lons), max(lats)), ring


def query(bbox):
    params = urllib.parse.urlencode({
        "bbox": ",".join(f"{v:.7f}" for v in bbox),
        "datasets": "Lidar Point Cloud (LPC)",
        "prodFormats": "LAZ,LAS", "max": 100, "outputFormat": "JSON",
    })
    url = f"{API}?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": "grand-teton-hero/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            items = json.load(response).get("items", [])
    except Exception as error:  # noqa: BLE001 - the operator needs the reason, not a trace
        raise SystemExit(
            f"Could not reach the USGS product API ({type(error).__name__}: {error}).\n"
            "Check connectivity, or download the tile by hand and pass the directory "
            "straight to hero_lidar.py --laz.")
    products = []
    for item in items:
        match = TITLE.match(str(item.get("title", "")))
        if not match or not item.get("downloadURL"):
            continue
        products.append({
            "project": match.group("project"), "tile": match.group("tile"),
            "url": item["downloadURL"], "published": item.get("publicationDate", ""),
            "sizeBytes": item.get("sizeInBytes"),
        })
    return products, url


def choose_project(products, requested):
    projects = sorted({p["project"] for p in products})
    if requested:
        if requested not in projects:
            raise SystemExit(f"Project {requested!r} does not cover this building. "
                             f"Available: {', '.join(projects) or 'none'}")
        return requested, "requested on the command line"
    for preferred in PREFERRED_PROJECTS:
        if preferred in projects:
            return preferred, "highest-density project known to cover the park"
    newest = max(products, key=lambda p: p["published"])
    return newest["project"], ("no preferred project covers this building; fell back to the "
                               f"most recent of {', '.join(projects)} — verify density in "
                               "hero_lidar.py's structure_density check")


class Stalled(Exception):
    """The connection is alive but delivering almost nothing."""


def fetch_to(url: str, temporary: Path, expected):
    """Resume a partial download. Returns True when the file is complete.

    These tiles are ~100 MB from a server that throttles hard: it keeps the
    connection open and trickles bytes, so a socket timeout never fires. Read
    in small chunks and watch throughput instead — a stalled transfer becomes a
    reconnect, and Range resumes from the bytes already on disk. Reconnecting
    is what actually recovers throughput.
    """
    have = temporary.stat().st_size if temporary.is_file() else 0
    headers = {"User-Agent": "grand-teton-hero/1.0"}
    if have:
        headers["Range"] = f"bytes={have}-"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=STALL_TIMEOUT_S) as response:
        if have and response.status != 206:
            have, mode = 0, "wb"               # server ignored Range; start over
        else:
            mode = "ab" if have else "wb"
        window_start, window_bytes = time.monotonic(), 0
        with temporary.open(mode) as out:
            while block := response.read(CHUNK_BYTES):
                out.write(block)
                have += len(block)
                window_bytes += len(block)
                elapsed = time.monotonic() - window_start
                if elapsed >= STALL_WINDOW_S:
                    rate = window_bytes / elapsed
                    print(f"\r  {temporary.name[:44]:44} {have / 1e6:6.1f} MB"
                          + (f" / {expected / 1e6:.0f} MB" if expected else "")
                          + f"  {rate / 1e3:6.1f} kB/s", end="", flush=True)
                    if rate < MIN_THROUGHPUT_BPS:
                        raise Stalled(f"{rate / 1e3:.1f} kB/s over {elapsed:.0f}s")
                    window_start, window_bytes = time.monotonic(), 0
    return expected is None or have >= expected


def download(product, destination: Path):
    path = destination / Path(urllib.parse.urlparse(product["url"]).path).name
    if path.is_file():
        print(f"  have {path.name}")
    else:
        temporary = path.with_suffix(path.suffix + ".part")
        expected = product.get("sizeBytes")
        for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
            try:
                if fetch_to(product["url"], temporary, expected):
                    break
                print(f"\n  short read, resuming (attempt {attempt})", flush=True)
            except Exception as error:  # noqa: BLE001 - retry, then report plainly
                label = "stalled" if isinstance(error, Stalled) else type(error).__name__
                print(f"\n  {label}: {error} — reconnecting "
                      f"({attempt}/{DOWNLOAD_ATTEMPTS})", flush=True)
                time.sleep(min(2 ** min(attempt, 4), 15))
                if attempt == DOWNLOAD_ATTEMPTS:
                    raise SystemExit(
                        f"\nGave up after {DOWNLOAD_ATTEMPTS} attempts with "
                        f"{temporary.stat().st_size / 1e6:.0f} MB of "
                        f"{(expected or 0) / 1e6:.0f} MB downloaded.\n"
                        f"The partial file is kept at {temporary.relative_to(REPO)}; "
                        "re-run this command to resume from there.\n"
                        f"Or download {product['url']} by hand into "
                        f"{destination.relative_to(REPO)}/ and re-run.")
        print()
        temporary.replace(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return {**product, "localPath": str(path.relative_to(REPO)),
            "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--building", required=True)
    parser.add_argument("--project", help=f"override the default ({PREFERRED_PROJECTS[0]})")
    parser.add_argument("--output", type=Path, help="default: terrain/pipeline/data/hero/<slug>")
    parser.add_argument("--list", action="store_true", help="show covering tiles, download nothing")
    opt = parser.parse_args()

    bbox, _ = footprint_bbox(opt.building)
    products, url = query(bbox)
    if not products:
        raise SystemExit(f"No LiDAR products cover {opt.building!r}.\nQuery: {url}")

    if opt.list:
        for product in sorted(products, key=lambda p: (p["project"], p["tile"])):
            size = f"{product['sizeBytes'] / 1e6:.0f} MB" if product.get("sizeBytes") else "?"
            print(f"{product['project']:42} {product['tile']:14} {product['published']:12} {size}")
        return 0

    project, why = choose_project(products, opt.project)
    chosen = sorted((p for p in products if p["project"] == project), key=lambda p: p["tile"])
    destination = opt.output or REPO / "terrain/pipeline/data/hero" / slug(opt.building)
    destination.mkdir(parents=True, exist_ok=True)
    print(f"{opt.building}: {project} ({why})")
    print(f"  {len(chosen)} tile(s) overlap the footprint: {', '.join(p['tile'] for p in chosen)}")
    records = [download(product, destination) for product in chosen]

    manifest = destination / "download_manifest.json"
    manifest.write_text(json.dumps({
        "building": opt.building, "project": project, "projectChosenBecause": why,
        "queryUrl": url, "searchBboxWgs84": list(bbox), "tiles": records,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"  wrote {manifest.relative_to(REPO)}")
    print(f"\nNext:\n  terrain/pipeline/.venv/bin/python "
          f"terrain/pipeline/buildings/hero/hero_lidar.py \\\n"
          f"    --building {opt.building!r} \\\n"
          f"    --laz {destination.relative_to(REPO)} \\\n"
          f"    --output terrain/pipeline/work/hero/{slug(opt.building)}/roof.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
