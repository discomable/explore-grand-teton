#!/usr/bin/env python3
"""Validate or explicitly promote one passed local hero-building draft.

Dry-run is the default. `--write` is intentionally required for production mutation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil


REPO = Path(__file__).resolve().parents[3]
BATCH = Path(__file__).with_name("hero-batch.json")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def inside(path, parent):
    return path == parent or parent in path.parents


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--write", action="store_true")
    opt = parser.parse_args()

    batch = read(BATCH)
    if not next((item for item in batch["candidates"] if item["id"] == opt.candidate), None):
        parser.error("candidate is not configured in hero-batch.json")
    run_root = (REPO / batch["runRoot"] / opt.run_id).resolve()
    candidate_root = (run_root / "candidates" / opt.candidate).resolve()
    state = read(run_root / "state.json")
    if state["candidates"][opt.candidate]["status"] != "draft_passed":
        raise SystemExit("only a draft_passed candidate can be promoted")
    plan_path = candidate_root / "promotion.json"
    plan = read(plan_path)
    if plan.get("schemaVersion") != 1 or plan.get("candidateId") != opt.candidate:
        raise SystemExit("promotion.json has the wrong schema or candidate")
    if not plan.get("files") or not plan.get("landmarks") or not plan.get("assetManifest"):
        raise SystemExit("promotion.json needs files, landmarks, and assetManifest")

    copies = []
    permitted = [
        (REPO / "terrain/public/models").resolve(),
        (REPO / "terrain/public/materials").resolve(),
    ]
    for item in plan["files"]:
        source = (REPO / item["source"]).resolve()
        destination = (REPO / item["destination"]).resolve()
        if not inside(source, candidate_root) or not source.is_file():
            raise SystemExit(f"invalid draft source: {item['source']}")
        if not any(inside(destination, root) for root in permitted):
            raise SystemExit(f"invalid production destination: {item['destination']}")
        if destination.exists() and digest(source) != digest(destination):
            raise SystemExit(f"refusing to overwrite different production asset: {item['destination']}")
        copies.append((source, destination))

    landmarks_path = REPO / "terrain/public/landmarks.json"
    landmarks = read(landmarks_path)
    existing_names = {item["name"] for item in landmarks["landmarks"]}
    new_names = [item.get("name") for item in plan["landmarks"]]
    if not all(new_names) or existing_names.intersection(new_names):
        raise SystemExit("promotion contains a missing or duplicate production landmark name")
    assets_path = REPO / "terrain/public/assets-manifest.json"
    assets = read(assets_path)
    asset_entry = plan["assetManifest"]
    if asset_entry.get("id") in {item["id"] for item in assets["assets"]}:
        raise SystemExit("promotion asset-manifest id already exists")
    destinations = {path.relative_to(REPO).as_posix() for _, path in copies}
    if not destinations.issubset(set(asset_entry.get("files", []))):
        raise SystemExit("assetManifest.files must list every promoted file")

    print(json.dumps({
        "candidate": opt.candidate,
        "mode": "write" if opt.write else "dry-run",
        "files": sorted(destinations),
        "landmarks": new_names,
        "assetManifestId": asset_entry["id"],
    }, indent=2))
    if not opt.write:
        print("dry-run only; pass --write after explicit approval")
        return 0

    for source, destination in copies:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            shutil.copy2(source, destination)
    landmarks["landmarks"].extend(plan["landmarks"])
    assets["assets"].append(asset_entry)
    atomic_json(landmarks_path, landmarks)
    atomic_json(assets_path, assets)
    print("promotion written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
