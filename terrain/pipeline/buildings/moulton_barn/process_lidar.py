#!/usr/bin/env python3
"""Crop LAS/LAZ data and derive a provenance-labelled first-pass envelope."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import laspy
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import MultiPoint, Polygon

ROOT = Path(__file__).resolve().parent


def files_at(path):
    return [path] if path.is_file() else sorted(
        file for pattern in ("*.las", "*.laz", "*.LAS", "*.LAZ")
        for file in path.glob(pattern))


def source_crs(las, fallback):
    try:
        value = las.header.parse_crs()
        if value:
            return CRS.from_user_input(value), False
    except Exception:
        pass
    return fallback, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--building", type=Path, default=ROOT / "building.json")
    parser.add_argument("--input", type=Path, default=ROOT.parents[1] / "data/moulton-barn")
    parser.add_argument("--output", type=Path, default=ROOT.parents[1] / "work/moulton-barn")
    opt = parser.parse_args()
    config = json.loads(opt.building.read_text(encoding="utf-8"))
    inputs = files_at(opt.input)
    if not inputs:
        parser.error(f"no LAS/LAZ files found at {opt.input}")
    opt.output.mkdir(parents=True, exist_ok=True)

    processing_crs = CRS.from_user_input(config["crs"]["processing"])
    locate = Transformer.from_crs(config["crs"]["input"], processing_crs, always_xy=True)
    cx, cy = locate.transform(config["location"]["longitude"], config["location"]["latitude"])
    radius = float(config["location"]["search_radius_m"])
    chunks, selected, assumed_crs = [], [], False
    for path in inputs:
        las = laspy.read(path)
        crs, assumed = source_crs(las, processing_crs)
        assumed_crs |= assumed
        transformer = Transformer.from_crs(crs, processing_crs, always_xy=True)
        x, y = transformer.transform(np.asarray(las.x), np.asarray(las.y))
        mask = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
        if np.any(mask):
            chunks.append((las, mask, np.asarray(x), np.asarray(y)))
            selected.append(str(path))
    if not chunks:
        raise SystemExit("No points intersect the search circle; verify the seed and CRS.")

    xs = np.concatenate([x[mask] for _, mask, x, _ in chunks])
    ys = np.concatenate([y[mask] for _, mask, _, y in chunks])
    zs = np.concatenate([np.asarray(las.z)[mask] for las, mask, _, _ in chunks])
    classes = np.concatenate(
        [np.asarray(las.classification)[mask] for las, mask, _, _ in chunks])
    near = (xs - cx) ** 2 + (ys - cy) ** 2 <= min(radius, 35) ** 2
    ground = (classes == 2) & near
    if np.count_nonzero(ground) >= 20:
        ground_z, ground_method = float(np.median(zs[ground])), "lidar_class_2_median"
    else:
        near_z = zs[near]
        ground_z = float(np.median(near_z[near_z <= np.percentile(near_z, 20)]))
        ground_method = "estimated_lowest_20_percent_near_seed"

    structure = (classes == 6) & near
    structure_method = "lidar_class_6"
    seed = config["dimensions"]
    values = {key: float(value["value"]) for key, value in seed.items()}
    if np.count_nonzero(structure) < 40:
        max_radius = .75 * math.hypot(values["length_m"], values["width_m"])
        structure = (near & ((xs-cx)**2 + (ys-cy)**2 <= max_radius**2) &
                     (zs > ground_z + 1.5) & (zs < ground_z + 18))
        structure_method = "estimated_above_ground_geometric_fallback"
    bx, by, bz = xs[structure], ys[structure], zs[structure]

    footprint_measured = False
    if len(bx) >= 12:
        hull = MultiPoint(np.column_stack((bx, by))).convex_hull
        if isinstance(hull, Polygon):
            corners = np.asarray(hull.minimum_rotated_rectangle.exterior.coords)[:4]
            edges = np.roll(corners, -1, axis=0) - corners
            lengths = np.linalg.norm(edges, axis=1)
            long_index = int(np.argmax(lengths))
            length, width = float(lengths[long_index]), float(np.min(lengths))
            if 4 <= width <= length <= 45 and width <= 30:
                vector = edges[long_index]
                values.update(
                    length_m=length, width_m=width,
                    orientation_deg_true_north=math.degrees(
                        math.atan2(vector[0], vector[1])) % 180)
                footprint_measured = True
    height_measured = False
    if len(bz) >= 12:
        agl = bz - ground_z
        eave, ridge = float(np.percentile(agl, 45)), float(np.percentile(agl, 98))
        if 2 <= eave < ridge <= 18:
            values.update(eave_height_m=eave, ridge_height_m=ridge)
            values["roof_pitch_deg"] = math.degrees(math.atan2(
                ridge - eave, max(values["width_m"] * .25, .1)))
            height_measured = True

    provenance = {}
    for key in values:
        measured = (key in ("length_m", "width_m", "orientation_deg_true_north")
                    and footprint_measured) or (
                    key in ("eave_height_m", "ridge_height_m", "roof_pitch_deg")
                    and height_measured)
        provenance[key] = structure_method if measured else f"configuration_{seed[key]['status']}"
    measurement = {
        "schema_version": 1, "building": config["name"],
        "origin": {"easting_m": cx, "northing_m": cy, "ground_elevation_m": ground_z},
        "measurements": values, "provenance": provenance,
        "methods": {"ground": ground_method, "building": structure_method},
        "point_counts": {
            "cropped": int(len(xs)), "ground_class_2": int(np.count_nonzero(classes == 2)),
            "building_class_6": int(np.count_nonzero(classes == 6)),
            "building_used": int(len(bx))},
        "input_files": selected,
        "uncertainty": [
            "Inspect the oriented rectangle and percentile heights against photography before production.",
            *(["LAS CRS missing; configured processing CRS was assumed."] if assumed_crs else []),
        ],
    }
    path = opt.output / "measurements.json"
    path.write_text(json.dumps(measurement, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(measurement, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

