#!/usr/bin/env python3
"""Recover a roof solid for one named building from high-density LiDAR.

Crops the point cloud to the named footprint in terrain/public/buildings.json,
segments the roof into planes, and writes roof.json in runtime world
coordinates. Stage 1 of the hero-building pipeline.

    python3 hero_lidar.py --building "T. A. Moulton Barn" --laz <file-or-dir>

Every threshold lives in TUNING. Every result carries a checks[] array; a
failed check states what to do next. Exit status is non-zero when any check
fails, but roof.json is still written so the failure can be inspected.

Runtime world frame (terrain/public/tiles.json):
    x = easting - centerEasting        z = centerNorthing - northing
Heights stay in metres above the NAVD88 surface the tiles were baked from.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import laspy
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import MultiPoint, Polygon
from shapely.ops import unary_union

REPO = Path(__file__).resolve().parents[4]
BUILDINGS = REPO / "terrain/public/buildings.json"
TILES = REPO / "terrain/public/tiles.json"
RUNTIME_CRS = "EPSG:32612"

TUNING = {
    # Cropping.
    "footprint_margin_m": 2.5,      # roof overhang beyond the mapped wall line
    "ground_ring_m": 12.0,          # ground sampled in this collar outside the footprint
    # Structure isolation.
    "min_structure_agl_m": 1.2,     # below this a return is ground clutter, not building
    "max_structure_agl_m": 22.0,    # above this it is canopy or a bird
    "noise_classes": (7, 18),
    "single_return_only": True,     # multi-return paths are vegetation, not roof
    "min_structure_points": 200,
    "min_structure_density": 6.0,   # points per m2 of footprint
    # Plane segmentation.
    # Inlier band. At 0.12 the chapel's cross-gable partner never reaches a
    # quorum and a fifth of that roof goes missing; 0.15 recovers it and still
    # separates the barn's shed from its gable. Costs ~1 cm of plane RMS.
    "plane_tolerance_m": 0.15,
    "min_plane_points": 90,
    "min_plane_fraction": 0.04,     # or this share of structure points, whichever is larger
    "max_planes": 8,
    "ransac_iterations": 600,
    "min_plane_normal_up": 0.20,    # reject near-vertical fits (walls, noise columns)
    "min_plane_density_ratio": 0.40,  # vs structure density; below this it is scatter
    "max_sparse_skips": 3,          # scatter sheets to step over before giving up
    "min_plane_coverage": 0.75,     # share of structure points a plane must claim
    "seed": 20260729,
    "sample_points": 400,           # per plane, carried to stage 2 for ownership
    # Ridge pairing.
    "ridge_max_gap_m": 1.5,
    "ridge_min_opposition_deg": 110.0,
    "ridge_adjacency_m": 1.0,       # returns from both planes must sit this close to the line
    "ridge_sample_step_m": 0.25,
    "min_ridge_length_m": 2.0,
    "min_ridge_side_purity": 0.6,   # each plane must sit decisively on its own side
    # Agreement with the mapped footprint.
    "max_centroid_offset_m": 3.0,
    "max_area_ratio": 1.9,          # LiDAR outline includes overhang, so it runs larger
    "min_area_ratio": 0.7,
    "min_ridge_agl_m": 2.0,
    "max_ridge_agl_m": 20.0,
}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def world_frame():
    world = load_json(TILES)["world"]
    return float(world["centerEasting"]), float(world["centerNorthing"])


def footprint(name: str):
    """Return the named building ring as a shapely polygon in world (x, z)."""
    doc = load_json(BUILDINGS)
    matches = [b for b in doc["buildings"] if (b.get("name") or "") == name]
    if not matches:
        available = sorted({b["name"] for b in doc["buildings"] if b.get("name")})
        near = [n for n in available if name.split()[-1].lower() in n.lower()]
        raise SystemExit(
            f"No building named {name!r} in {BUILDINGS.relative_to(REPO)}.\n"
            + (f"Did you mean: {', '.join(near[:5])}\n" if near else "")
            + f"{len(available)} named footprints exist; pass --list to print them.")
    if len(matches) > 1:
        raise SystemExit(
            f"{len(matches)} footprints are named {name!r}. Disambiguate the source data "
            "or add --index; this script refuses to guess which one is the landmark.")
    ring = Polygon(matches[0]["pts"])
    if not ring.is_valid:
        ring = ring.buffer(0)
    return ring, matches[0]


def laz_files(path: Path):
    if path.is_file():
        return [path]
    found = sorted(f for pattern in ("*.las", "*.laz", "*.LAS", "*.LAZ")
                   for f in path.glob(pattern))
    if not found:
        raise SystemExit(f"No LAS/LAZ files under {path}. Download the 3DEP tile covering "
                         "the footprint first, then re-run.")
    return found


def read_points(files, ring, east0, north0):
    """Load every return near the footprint, in world (x, z, elevation)."""
    margin = TUNING["footprint_margin_m"] + TUNING["ground_ring_m"]
    minx, minz, maxx, maxz = ring.buffer(margin).bounds
    to_runtime, used = None, []
    xs, zs, hs, cls, single = [], [], [], [], []
    for path in files:
        las = laspy.read(path)
        crs = CRS.from_user_input(las.header.parse_crs())
        to_runtime = Transformer.from_crs(crs, RUNTIME_CRS, always_xy=True)
        east, north = to_runtime.transform(np.asarray(las.x), np.asarray(las.y))
        x, z = east - east0, north0 - north
        keep = (x >= minx) & (x <= maxx) & (z >= minz) & (z <= maxz)
        if not np.any(keep):
            continue
        used.append(path.name)
        xs.append(x[keep])
        zs.append(z[keep])
        hs.append(np.asarray(las.z)[keep])
        cls.append(np.asarray(las.classification)[keep])
        single.append(np.asarray(las.number_of_returns)[keep] == 1)
    if not used:
        raise SystemExit(
            "No returns fall inside the footprint bounds. The tile does not cover this "
            "building — check the download against the footprint centroid and re-run.")
    return (np.concatenate(xs), np.concatenate(zs), np.concatenate(hs),
            np.concatenate(cls), np.concatenate(single), used)


def inside(ring, x, z):
    minx, minz, maxx, maxz = ring.bounds
    box = (x >= minx) & (x <= maxx) & (z >= minz) & (z <= maxz)
    result = np.zeros(len(x), dtype=bool)
    if not np.any(box):
        return result
    index = np.flatnonzero(box)
    prepared = ring.contains
    from shapely.geometry import Point
    result[index] = [prepared(Point(px, pz)) for px, pz in zip(x[index], z[index])]
    return result


def ground_elevation(ring, x, z, h, cls):
    """Median ground return in a collar around the building, never under it."""
    collar = ring.buffer(TUNING["ground_ring_m"]).difference(
        ring.buffer(TUNING["footprint_margin_m"]))
    near = inside(collar, x, z)
    on_ground = near & (cls == 2)
    if np.count_nonzero(on_ground) >= 50:
        return float(np.median(h[on_ground])), "lidar_class_2_collar_median"
    if np.count_nonzero(near) >= 50:
        low = h[near]
        return float(np.median(low[low <= np.percentile(low, 15)])), "lowest_15_percent_collar"
    raise SystemExit(
        "Too few returns around the building to establish ground level. Widen "
        "ground_ring_m or confirm the tile covers the surroundings, then re-run.")


def structure_mask(ring, x, z, h, cls, single, ground):
    """Isolate building returns without trusting the vendor classification."""
    agl = h - ground
    footprint_zone = inside(ring.buffer(TUNING["footprint_margin_m"]), x, z)
    keep = (footprint_zone
            & (agl >= TUNING["min_structure_agl_m"])
            & (agl <= TUNING["max_structure_agl_m"])
            & ~np.isin(cls, TUNING["noise_classes"]))
    if TUNING["single_return_only"]:
        keep &= single
    classified = keep & (cls == 6)
    if np.count_nonzero(classified) >= TUNING["min_structure_points"]:
        return classified, "class_6_within_footprint"
    return keep, "self_classified_above_ground_single_return"


def fit_plane(points):
    """Least-squares plane through points; returns (unit normal, offset)."""
    centre = points.mean(axis=0)
    _, _, vh = np.linalg.svd(points - centre, full_matrices=False)
    normal = vh[2]
    if normal[2] < 0:
        normal = -normal
    return normal, float(normal @ centre)


def hull_density(subset):
    """Inliers per m2 of their own outline. A real roof facet is densely filled."""
    hull = MultiPoint([(float(p[0]), float(p[1])) for p in subset]).convex_hull
    if hull.geom_type != "Polygon" or hull.area <= 0:
        return 0.0
    return len(subset) / hull.area


def segment_planes(points, rng, reference_density):
    """Greedy RANSAC: strongest plane first, its inliers removed, repeat.

    Stops at the first plane too sparse to be a real surface. Once the genuine
    facets have taken their inliers, the residue is scatter that still fits a
    plane -- typically one near-parallel to a real roof and smeared across the
    whole building, which would otherwise invent ridges under the real one.
    Planes come out strongest-first, so the first sparse one ends the run.
    """
    remaining = np.arange(len(points))
    floor = max(TUNING["min_plane_points"],
                int(TUNING["min_plane_fraction"] * len(points)))
    density_floor = TUNING["min_plane_density_ratio"] * reference_density
    planes, rejected = [], []
    while len(planes) < TUNING["max_planes"] and len(remaining) >= floor:
        subset = points[remaining]
        best_inliers, best = None, 0
        for _ in range(TUNING["ransac_iterations"]):
            pick = rng.choice(len(subset), 3, replace=False)
            a, b, c = subset[pick]
            normal = np.cross(b - a, c - a)
            length = np.linalg.norm(normal)
            if length < 1e-6:
                continue
            normal = normal / length
            if normal[2] < 0:
                normal = -normal
            if abs(normal[2]) < TUNING["min_plane_normal_up"]:
                continue
            distance = np.abs(subset @ normal - normal @ a)
            hits = distance <= TUNING["plane_tolerance_m"]
            count = int(np.count_nonzero(hits))
            if count > best:
                best, best_inliers = count, hits
        if best_inliers is None or best < floor:
            break
        # Refit on the consensus set, then re-collect inliers around the better fit.
        normal, offset = fit_plane(subset[best_inliers])
        if abs(normal[2]) < TUNING["min_plane_normal_up"]:
            break
        refined = np.abs(subset @ normal - offset) <= TUNING["plane_tolerance_m"]
        if int(np.count_nonzero(refined)) < floor:
            break
        density = hull_density(subset[refined])
        if density < density_floor:
            # Discard the scatter and keep looking rather than stopping. Greedy
            # RANSAC orders by inlier count, not by quality, so a broad sparse
            # sheet can outrank a small real facet sitting behind it -- on the
            # chapel a 165-point scatter hid the cross gable's 118-point
            # opposing plane, and stopping here lost a fifth of the roof.
            rejected.append((int(np.count_nonzero(refined)), density))
            remaining = remaining[~refined]
            if len(rejected) > TUNING["max_sparse_skips"]:
                break
            continue
        planes.append((normal, offset, remaining[refined]))
        remaining = remaining[~refined]
    return planes, remaining, rejected


def describe_plane(index, normal, offset, points):
    """Turn a fitted plane into the numbers the massing stage consumes."""
    pitch = math.degrees(math.acos(min(1.0, abs(float(normal[2])))))
    # Steepest descent direction, projected to the ground plane, as a compass
    # bearing in the runtime frame (+x east, +z south). An upward normal leans
    # downhill, so its horizontal part already points down the slope -- negating
    # it aims every elevation at the opposite face of the building.
    down = np.array([normal[0], normal[1]])
    azimuth = (math.degrees(math.atan2(float(down[0]), -float(down[1]))) % 360.0
               if np.linalg.norm(down) > 1e-6 else 0.0)
    hull = MultiPoint([(float(p[0]), float(p[1])) for p in points]).convex_hull
    outline = (hull.buffer(0.35).buffer(-0.35) if hull.geom_type == "Polygon" else hull)
    heights = points[:, 2]
    return {
        "id": f"plane{index}",
        "points": int(len(points)),
        "normal": [round(float(v), 6) for v in normal],
        "offset": round(float(offset), 4),
        "pitchDeg": round(pitch, 2),
        "downslopeAzimuthDeg": round(azimuth, 2),
        "planarRmsM": round(float(np.sqrt(np.mean((points @ normal - offset) ** 2))), 4),
        "lowEdgeElevationM": round(float(np.percentile(heights, 2)), 3),
        "highEdgeElevationM": round(float(np.percentile(heights, 98)), 3),
        "areaM2": round(float(outline.area) if outline.geom_type == "Polygon" else 0.0, 2),
        "hull": [[round(px, 3), round(pz, 3)]
                 for px, pz in (outline.exterior.coords[:-1]
                                if outline.geom_type == "Polygon" else [])],
        # Plan positions of a deterministic subset of the inliers. Hulls overlap
        # too much to say which plane owns a patch of roof -- on the barn the
        # shed and gable hulls overlap by 3.3 m -- so stage 2 decides ownership
        # by nearest measured return instead. Sampled to keep roof.json small.
        "samplePoints": [[round(float(p[0]), 2), round(float(p[1]), 2)]
                         for p in points[::max(1, len(points) // TUNING["sample_points"])]],
    }


def find_ridges(planes, described, points):
    """Ridge segments where two opposed planes physically meet.

    Opposition and matching edge height are necessary but not sufficient: the
    two sheds on opposite sides of a barn satisfy both and never touch. The
    deciding test is adjacency — walk the intersection line and keep only the
    stretch where returns from both planes lie close to it.
    """
    anchor = points.mean(axis=0)
    step = TUNING["ridge_sample_step_m"]
    reach = TUNING["ridge_adjacency_m"]
    ridges = []
    for i in range(len(planes)):
        for j in range(i + 1, len(planes)):
            a, b = described[i], described[j]
            opposition = abs((a["downslopeAzimuthDeg"] - b["downslopeAzimuthDeg"] + 180) % 360 - 180)
            if opposition < TUNING["ridge_min_opposition_deg"]:
                continue
            if abs(a["highEdgeElevationM"] - b["highEdgeElevationM"]) > TUNING["ridge_max_gap_m"]:
                continue
            na, oa = np.asarray(planes[i][0]), planes[i][1]
            nb, ob = np.asarray(planes[j][0]), planes[j][1]
            direction = np.cross(na, nb)
            if np.linalg.norm(direction) < 1e-6:
                continue
            direction = direction / np.linalg.norm(direction)
            # Anchor on the intersection line nearest the building centre, not the
            # world origin: the runtime frame's origin is kilometres away and any
            # elevation read off a far-away point on a sloping line is meaningless.
            matrix = np.vstack([na, nb, direction])
            base = np.linalg.solve(matrix, np.array([oa, ob, float(direction @ anchor)]))
            xy_a = points[planes[i][2]][:, :2]
            xy_b = points[planes[j][2]][:, :2]
            span = float(np.linalg.norm(np.ptp(points[:, :2], axis=0))) + 2 * reach
            offsets = np.arange(-span / 2, span / 2 + step, step)
            samples = base[:2] + np.outer(offsets, direction[:2])
            near_a = np.min(np.linalg.norm(xy_a[None, :, :] - samples[:, None, :], axis=2), axis=1)
            near_b = np.min(np.linalg.norm(xy_b[None, :, :] - samples[:, None, :], axis=2), axis=1)
            touching = (near_a <= reach) & (near_b <= reach)
            if not np.any(touching):
                continue
            # A real ridge has one plane on each side of it. Planes whose inliers
            # bleed into each other near the apex are adjacent everywhere and
            # would otherwise register a phantom crease across the roof.
            flat = direction[:2] / np.linalg.norm(direction[:2])
            perp = np.array([-flat[1], flat[0]])
            side_a = float(np.mean(np.sign((xy_a - base[:2]) @ perp)))
            side_b = float(np.mean(np.sign((xy_b - base[:2]) @ perp)))
            purity = TUNING["min_ridge_side_purity"]
            if side_a * side_b >= 0 or min(abs(side_a), abs(side_b)) < purity:
                continue
            # Longest contiguous run of adjacency is the ridge; short scattered
            # hits are two planes clipping past each other at a corner.
            best_start, best_length, run_start = None, 0, None
            for index, value in enumerate(touching):
                if value and run_start is None:
                    run_start = index
                elif not value and run_start is not None:
                    if index - run_start > best_length:
                        best_start, best_length = run_start, index - run_start
                    run_start = None
            if run_start is not None and len(touching) - run_start > best_length:
                best_start, best_length = run_start, len(touching) - run_start
            if best_start is None or best_length * step < TUNING["min_ridge_length_m"]:
                continue
            start = base + offsets[best_start] * direction
            end = base + offsets[best_start + best_length - 1] * direction
            ridges.append({
                "planes": [a["id"], b["id"]],
                "startM": [round(float(v), 3) for v in start],
                "endM": [round(float(v), 3) for v in end],
                "lengthM": round(float(np.linalg.norm(end - start)), 3),
                "elevationM": round(float((start[2] + end[2]) / 2), 3),
                "oppositionDeg": round(opposition, 1),
            })
    return sorted(ridges, key=lambda r: -r["elevationM"])


def drip_edge(described):
    """Union of the plane outlines: the roof edge as seen from above."""
    shapes = [Polygon(p["hull"]) for p in described if len(p["hull"]) >= 3]
    if not shapes:
        return None
    merged = unary_union([s.buffer(0.25) for s in shapes]).buffer(-0.25)
    if merged.geom_type == "MultiPolygon":
        merged = max(merged.geoms, key=lambda g: g.area)
    if merged.geom_type != "Polygon" or merged.is_empty:
        return None
    return merged.simplify(0.20, preserve_topology=True)


def check(results, name, passed, value, threshold, action):
    results.append({
        "id": name,
        "passed": bool(passed),
        "value": value,
        "threshold": threshold,
        **({} if passed else {"nextAction": action}),
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--building", help="exact name in terrain/public/buildings.json")
    parser.add_argument("--laz", type=Path, help="LAS/LAZ file or directory of tiles")
    parser.add_argument("--output", type=Path, help="roof.json path (default: alongside --laz)")
    parser.add_argument("--list", action="store_true", help="print named footprints and exit")
    opt = parser.parse_args()

    if opt.list:
        names = sorted({b["name"] for b in load_json(BUILDINGS)["buildings"] if b.get("name")})
        print("\n".join(names))
        return 0
    if not opt.building or not opt.laz:
        parser.error("--building and --laz are required (or pass --list)")

    ring, record = footprint(opt.building)
    east0, north0 = world_frame()
    x, z, h, cls, single, used = read_points(laz_files(opt.laz), ring, east0, north0)
    ground, ground_method = ground_elevation(ring, x, z, h, cls)
    keep, structure_method = structure_mask(ring, x, z, h, cls, single, ground)

    points = np.column_stack((x[keep], z[keep], h[keep]))
    density = len(points) / ring.area if ring.area else 0.0
    rng = np.random.default_rng(TUNING["seed"])
    planes, leftover, rejected = ([], np.arange(len(points)), [])
    described, ridges, edge = [], [], None
    if len(points) >= TUNING["min_structure_points"]:
        planes, leftover, rejected = segment_planes(points, rng, density)
        described = [describe_plane(i, n, o, points[idx])
                     for i, (n, o, idx) in enumerate(planes)]
        ridges = find_ridges(planes, described, points)
        edge = drip_edge(described)
    coverage = 1.0 - (len(leftover) / len(points)) if len(points) else 0.0
    ridge_agl = (max(p["highEdgeElevationM"] for p in described) - ground) if described else 0.0
    eave_agl = (min(p["lowEdgeElevationM"] for p in described) - ground) if described else 0.0

    checks = []
    check(checks, "structure_points", len(points) >= TUNING["min_structure_points"],
          int(len(points)), TUNING["min_structure_points"],
          "Too few building returns. Confirm the tile covers the footprint and that "
          "min_structure_agl_m is not cutting off a low building.")
    check(checks, "structure_density", density >= TUNING["min_structure_density"],
          round(density, 2), TUNING["min_structure_density"],
          "Point density is too low for plane segmentation. Source a denser tile (QL1 or "
          "better) before continuing; this building cannot get an exact silhouette.")
    check(checks, "planes_found", len(described) >= 1, len(described), 1,
          "No roof plane survived RANSAC. Raise plane_tolerance_m toward 0.20 or lower "
          "min_plane_points, then re-run and inspect planarRmsM.")
    check(checks, "plane_coverage", coverage >= TUNING["min_plane_coverage"],
          round(coverage, 3), TUNING["min_plane_coverage"],
          "Too many returns are unexplained by the fitted planes. Usually overhanging "
          "canopy: shrink footprint_margin_m, or raise max_planes if the roof is complex.")
    check(checks, "ridge_height", TUNING["min_ridge_agl_m"] <= ridge_agl <= TUNING["max_ridge_agl_m"],
          round(ridge_agl, 2), [TUNING["min_ridge_agl_m"], TUNING["max_ridge_agl_m"]],
          "Ridge height above ground is implausible. Check the ground method: a collar "
          "crossing a slope biases it.")

    offset, area_ratio = None, None
    if edge is not None:
        offset = math.dist((edge.centroid.x, edge.centroid.y), (ring.centroid.x, ring.centroid.y))
        area_ratio = edge.area / ring.area if ring.area else 0.0
        check(checks, "footprint_agreement", offset <= TUNING["max_centroid_offset_m"],
              round(offset, 2), TUNING["max_centroid_offset_m"],
              "The LiDAR roof outline and the mapped footprint disagree on position. The "
              "tile, the footprint, or the CRS is wrong — resolve before building geometry.")
        check(checks, "footprint_scale",
              TUNING["min_area_ratio"] <= area_ratio <= TUNING["max_area_ratio"],
              round(area_ratio, 3), [TUNING["min_area_ratio"], TUNING["max_area_ratio"]],
              "Roof outline area is far from the mapped footprint. Likely a neighbouring "
              "structure inside the crop: tighten footprint_margin_m.")

    output = opt.output or (opt.laz if opt.laz.is_dir() else opt.laz.parent) / "roof.json"
    roof = {
        "schemaVersion": 1,
        "building": opt.building,
        "crs": RUNTIME_CRS,
        "frame": "runtime world: x east of centre, z south of centre, elevation in metres",
        "groundElevationM": round(ground, 3),
        "groundMethod": ground_method,
        "structureMethod": structure_method,
        "structurePoints": int(len(points)),
        "structureDensityPerM2": round(density, 2),
        "eaveAglM": round(eave_agl, 3),
        "ridgeAglM": round(ridge_agl, 3),
        "mappedFootprint": {
            "areaM2": round(ring.area, 2),
            "centroid": [round(ring.centroid.x, 2), round(ring.centroid.y, 2)],
            "heightHintM": record.get("h"),
        },
        "dripEdge": ([[round(px, 3), round(pz, 3)] for px, pz in edge.exterior.coords[:-1]]
                     if edge is not None else []),
        "dripEdgeAreaM2": round(edge.area, 2) if edge is not None else None,
        "dripEdgeCentroidOffsetM": round(offset, 3) if offset is not None else None,
        "planes": described,
        "rejectedSparsePlanes": [{"points": n, "densityPerM2": round(v, 2)}
                                 for n, v in rejected],
        "ridges": ridges,
        "sourceFiles": used,
        "tuning": TUNING,
        "checks": checks,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(roof, indent=2) + "\n", encoding="utf-8")

    failed = [c for c in checks if not c["passed"]]
    print(f"{output.relative_to(REPO) if output.is_relative_to(REPO) else output}: "
          f"{len(described)} planes, {len(points)} points at {density:.1f}/m2, "
          f"ridge {ridge_agl:.2f} m AGL, coverage {coverage:.0%}")
    for plane in described:
        print(f"  {plane['id']}: {plane['points']:5d} pts  pitch {plane['pitchDeg']:5.1f} deg  "
              f"faces {plane['downslopeAzimuthDeg']:6.1f} deg  rms {plane['planarRmsM']:.3f} m  "
              f"{plane['areaM2']:6.1f} m2")
    for ridge in ridges:
        print(f"  ridge {'+'.join(ridge['planes'])}: {ridge['lengthM']:5.2f} m long at "
              f"{ridge['elevationM'] - ground:.2f} m AGL")
    for count, value in rejected:
        print(f"  stopped: next plane held {count} points at {value:.1f}/m2, below "
              f"{TUNING['min_plane_density_ratio']:.0%} of the structure's {density:.1f}/m2 "
              f"-- scatter, not a surface")
    for item in failed:
        print(f"  FAIL {item['id']}: {item['value']} vs {item['threshold']}\n"
              f"       {item['nextAction']}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
