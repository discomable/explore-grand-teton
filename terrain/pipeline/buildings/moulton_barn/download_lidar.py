#!/usr/bin/env python3
"""Discover or register public USGS 3DEP LiDAR for the configured barn."""
from __future__ import annotations

import argparse
import json
import math
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = "https://tnmaccess.nationalmap.gov/api/v1/products"


def discover(config):
    loc = config["location"]
    lat, lon, radius = float(loc["latitude"]), float(loc["longitude"]), float(loc["search_radius_m"])
    dlat = radius / 110_900
    dlon = radius / (110_900 * abs(math.cos(math.radians(lat))))
    bbox = f"{lon-dlon:.7f},{lat-dlat:.7f},{lon+dlon:.7f},{lat+dlat:.7f}"
    query = urllib.parse.urlencode({
        "bbox": bbox, "datasets": "Lidar Point Cloud (LPC)",
        "prodFormats": "LAZ,LAS", "max": 100, "outputFormat": "JSON",
    })
    url = f"{API}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "grand-teton-reconstruction/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        items = json.load(response).get("items", [])
    tokens = ("grand teton", "elk refuge", "2014")
    items.sort(key=lambda item: (
        -sum(token in " ".join(str(item.get(k, "")) for k in
            ("title", "publicationDate", "sourceId")).lower() for token in tokens),
        str(item.get("title", "")),
    ))
    return items, url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--building", type=Path, default=ROOT / "building.json")
    parser.add_argument("--output", type=Path,
                        default=ROOT.parents[1] / "data/moulton-barn")
    parser.add_argument("--tile", type=Path, help="register a supplied LAS/LAZ")
    parser.add_argument("--url", help="download a known LAS/LAZ URL")
    parser.add_argument("--list", action="store_true")
    opt = parser.parse_args()
    opt.output.mkdir(parents=True, exist_ok=True)
    manifest = {"building": str(opt.building), "products_api": None,
                "selected": None, "candidates": []}

    if opt.tile:
        if not opt.tile.is_file():
            parser.error(f"tile does not exist: {opt.tile}")
        destination = opt.output / opt.tile.name
        if opt.tile.resolve() != destination.resolve():
            shutil.copy2(opt.tile, destination)
        manifest["selected"] = {
            "downloadURL": opt.tile.resolve().as_uri(), "local_path": str(destination)}
    else:
        selected_url = opt.url
        if not selected_url:
            config = json.loads(opt.building.read_text(encoding="utf-8"))
            products, query_url = discover(config)
            manifest.update(products_api=query_url, candidates=products)
            if opt.list:
                for index, product in enumerate(products):
                    print(f"[{index}] {product.get('title')}\n    {product.get('downloadURL')}")
                selected_url = None
            else:
                selected = next((item for item in products if item.get("downloadURL")), None)
                if not selected:
                    raise SystemExit("No downloadable LPC product found; use --tile or --url.")
                selected_url = selected["downloadURL"]
                manifest["selected"] = selected
        if selected_url:
            filename = Path(urllib.parse.urlparse(selected_url).path).name or "usgs_lidar.laz"
            destination = opt.output / filename
            request = urllib.request.Request(
                selected_url, headers={"User-Agent": "grand-teton-reconstruction/1.0"})
            with urllib.request.urlopen(request, timeout=300) as response, destination.open("wb") as stream:
                while block := response.read(1024 * 1024):
                    stream.write(block)
            manifest["selected"] = {
                **(manifest["selected"] or {}), "downloadURL": selected_url,
                "local_path": str(destination)}

    path = opt.output / "download_manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

