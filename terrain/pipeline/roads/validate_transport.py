"""Validate the versioned baked transport network.

The checks in this module deliberately operate on the checked-in JSON rather
than source OSM data.  This makes them suitable as a deterministic release
gate for every producer of transport.json.

Run from any directory:
  python3 terrain/pipeline/roads/validate_transport.py
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from dataclasses import dataclass, asdict
from typing import Any, Iterable


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_PATH = os.path.join(ROOT, "public", "transport.json")
ID_RE = re.compile(r"^osm-way-(\d+)(?::(\d+))?$")
PEDESTRIAN_CLASSES = {"trail", "primitive_trail", "steps", "boardwalk", "footbridge"}
KNOWN_CLASSES = {
    "highway", "park_paved", "gravel", "track",
    "trail", "primitive_trail", "steps", "boardwalk", "footbridge",
}
WIDTH_RANGES = {
    "highway": (4.0, 30.0),
    "park_paved": (2.5, 20.0),
    "gravel": (2.0, 15.0),
    "track": (1.5, 10.0),
    "trail": (0.35, 5.0),
    "primitive_trail": (0.25, 3.0),
    "steps": (0.4, 6.0),
    "boardwalk": (0.4, 6.0),
    "footbridge": (0.4, 6.0),
}


@dataclass(frozen=True, order=True)
class Issue:
    severity: str
    code: str
    feature_id: str
    message: str


def _issue(severity: str, code: str, feature_id: str, message: str) -> Issue:
    return Issue(severity, code, feature_id, message)


def _finite_point(point: Any) -> bool:
    return (
        isinstance(point, list) and len(point) == 2
        and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v) for v in point)
    )


def _distance(a: list[float], b: list[float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _point_segment_distance(point: list[float], a: list[float],
                            b: list[float]) -> float:
    dx, dz = b[0] - a[0], b[1] - a[1]
    length_squared = dx * dx + dz * dz
    if length_squared <= 1e-12:
        return _distance(point, a)
    t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length_squared
    t = max(0.0, min(1.0, t))
    closest = [a[0] + t * dx, a[1] + t * dz]
    return _distance(point, closest)


def _parse_width(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if math.isfinite(value) else None
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    # OSM commonly contains "3.5", "3.5 m", and imperial values.
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(m|meter|metres|meters)?", text)
    if match:
        return float(match.group(1))
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(ft|feet|')", text)
    if match:
        return float(match.group(1)) * 0.3048
    return None


def _orientation(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _proper_intersection(a: list[float], b: list[float],
                         c: list[float], d: list[float]) -> bool:
    """True for a crossing, excluding shared/collinear endpoints."""
    o1, o2 = _orientation(a, b, c), _orientation(a, b, d)
    o3, o4 = _orientation(c, d, a), _orientation(c, d, b)
    eps = 1e-9
    return o1 * o2 < -eps and o3 * o4 < -eps


def _canonical_geometry(points: list[list[float]]) -> tuple[tuple[float, float], ...]:
    forward = tuple((float(x), float(z)) for x, z in points)
    reverse = tuple(reversed(forward))
    return min(forward, reverse)


def validate_transport(data: Any, endpoint_tolerance: float = 1.0,
                       orphan_max_length: float = 25.0) -> list[Issue]:
    issues: list[Issue] = []
    if not isinstance(data, dict):
        return [_issue("error", "schema.root", "", "root must be an object")]

    for key in ("version", "coordinateSystem", "chunkSize", "features", "chunks"):
        if key not in data:
            issues.append(_issue("error", "schema.missing", "", f"missing root field {key}"))
    if data.get("version") != 1:
        issues.append(_issue("error", "schema.version", "", "version must be 1"))
    if not isinstance(data.get("chunkSize"), (int, float)) or data.get("chunkSize", 0) <= 0:
        issues.append(_issue("error", "schema.chunk_size", "", "chunkSize must be positive"))
    features = data.get("features")
    if not isinstance(features, list):
        issues.append(_issue("error", "schema.features", "", "features must be an array"))
        return sorted(issues)

    ids: set[str] = set()
    geometry_owners: dict[tuple[tuple[float, float], ...], str] = {}
    valid: list[dict[str, Any]] = []
    for index, feature in enumerate(features):
        fallback_id = f"features[{index}]"
        if not isinstance(feature, dict):
            issues.append(_issue("error", "schema.feature", fallback_id, "feature must be an object"))
            continue
        feature_id = feature.get("id")
        if not isinstance(feature_id, str) or not feature_id:
            issues.append(_issue("error", "schema.id", fallback_id, "id must be a non-empty string"))
            continue
        if feature_id in ids:
            issues.append(_issue("error", "id.duplicate", feature_id, "feature id is not unique"))
        ids.add(feature_id)
        match = ID_RE.fullmatch(feature_id)
        if not match:
            issues.append(_issue("error", "id.unstable", feature_id,
                                 "id must be osm-way-<osmId> with optional clip suffix"))
        elif feature.get("osmId") != int(match.group(1)):
            issues.append(_issue("error", "id.osm_mismatch", feature_id,
                                 "osmId does not match stable feature id"))

        kind = feature.get("class")
        if kind not in KNOWN_CLASSES:
            issues.append(_issue("error", "schema.class", feature_id,
                                 f"unknown transport class {kind!r}"))
        points = feature.get("pts")
        if not isinstance(points, list) or len(points) < 2:
            issues.append(_issue("error", "geometry.too_short", feature_id,
                                 "geometry must contain at least two points"))
            continue
        if not all(_finite_point(point) for point in points):
            issues.append(_issue("error", "geometry.non_finite", feature_id,
                                 "points must be finite [x,z] numbers"))
            continue
        valid.append(feature)

        for segment_index, (a, b) in enumerate(zip(points, points[1:])):
            if _distance(a, b) <= 1e-6:
                issues.append(_issue("error", "geometry.zero_length", feature_id,
                                     f"segment {segment_index} has zero length"))
        canonical = _canonical_geometry(points)
        if canonical in geometry_owners:
            issues.append(_issue("error", "geometry.duplicate", feature_id,
                                 f"duplicates {geometry_owners[canonical]}"))
        else:
            geometry_owners[canonical] = feature_id

        for i in range(len(points) - 1):
            for j in range(i + 2, len(points) - 1):
                if _proper_intersection(points[i], points[i + 1],
                                        points[j], points[j + 1]):
                    issues.append(_issue("error", "geometry.self_intersection", feature_id,
                                         f"segments {i} and {j} cross"))
                    break
            else:
                continue
            break

        raw_width = feature.get("width", feature.get("tags", {}).get("width")
                                if isinstance(feature.get("tags"), dict) else None)
        if raw_width is not None:
            width = _parse_width(raw_width)
            if width is None:
                issues.append(_issue("warning", "width.unparseable", feature_id,
                                     f"cannot parse width {raw_width!r}"))
            elif kind in WIDTH_RANGES:
                low, high = WIDTH_RANGES[kind]
                if not low <= width <= high:
                    issues.append(_issue("warning", "width.implausible", feature_id,
                                         f"{width:.2f} m is outside {low:g}-{high:g} m"))

        tags = feature.get("tags") if isinstance(feature.get("tags"), dict) else {}
        explicitly_vehicle = (
            feature.get("vehicleAllowed") is True
            or tags.get("motor_vehicle") in {"yes", "designated", "permissive"}
            or tags.get("motorcar") in {"yes", "designated", "permissive"}
        )
        if kind in PEDESTRIAN_CLASSES and explicitly_vehicle:
            issues.append(_issue("error", "access.pedestrian_vehicle", feature_id,
                                 f"{kind} must not permit vehicles"))

    # Validate the chunk index as an exact, duplicate-free reference index.
    chunks = data.get("chunks")
    indexed: set[str] = set()
    if not isinstance(chunks, dict):
        issues.append(_issue("error", "schema.chunks", "", "chunks must be an object"))
    else:
        feature_chunks: dict[str, set[str]] = {}
        for key in sorted(chunks):
            refs = chunks[key]
            if not re.fullmatch(r"-?\d+,-?\d+", key):
                issues.append(_issue("error", "chunk.key", key, "invalid chunk coordinate"))
            if not isinstance(refs, list):
                issues.append(_issue("error", "chunk.refs", key, "chunk references must be an array"))
                continue
            if refs != sorted(set(refs)):
                issues.append(_issue("error", "chunk.order", key,
                                     "chunk references must be sorted and unique"))
            for ref in refs:
                if ref not in ids:
                    issues.append(_issue("error", "chunk.unknown_feature", str(ref),
                                         f"referenced by chunk {key}"))
                indexed.add(ref)
                feature_chunks.setdefault(ref, set()).add(key)
        for missing in sorted(ids - indexed):
            issues.append(_issue("error", "chunk.missing_feature", missing,
                                 "feature is absent from chunk manifest"))
        chunk_size = data.get("chunkSize")
        if isinstance(chunk_size, (int, float)) and chunk_size > 0:
            for feature in valid:
                expected: set[str] = set()
                for a, b in zip(feature["pts"], feature["pts"][1:]):
                    min_x, max_x = math.floor(min(a[0], b[0]) / chunk_size), math.floor(max(a[0], b[0]) / chunk_size)
                    min_z, max_z = math.floor(min(a[1], b[1]) / chunk_size), math.floor(max(a[1], b[1]) / chunk_size)
                    expected.update(f"{x},{z}" for x in range(min_x, max_x + 1)
                                    for z in range(min_z, max_z + 1))
                absent = expected - feature_chunks.get(feature["id"], set())
                if absent:
                    issues.append(_issue("error", "chunk.spatial_gap", feature["id"],
                                         f"missing segment cells {','.join(sorted(absent))}"))

    # Flag tiny, fully isolated fragments. Large isolated ways and world-edge
    # clips can be legitimate and are not useful validator findings.
    segments: dict[tuple[int, int],
                   list[tuple[str, list[float], list[float]]]] = {}
    # A tolerance-sized grid makes long source segments occupy thousands of
    # cells. The orphan threshold is a compact, deterministic index size while
    # exact point-to-segment distance remains the final connectivity test.
    segment_cell_size = max(orphan_max_length, endpoint_tolerance)
    scale = 1.0 / segment_cell_size
    for feature in valid:
        for a, b in zip(feature["pts"], feature["pts"][1:]):
            min_x = math.floor((min(a[0], b[0]) - endpoint_tolerance) * scale)
            max_x = math.floor((max(a[0], b[0]) + endpoint_tolerance) * scale)
            min_z = math.floor((min(a[1], b[1]) - endpoint_tolerance) * scale)
            max_z = math.floor((max(a[1], b[1]) + endpoint_tolerance) * scale)
            segment = (feature["id"], a, b)
            for cell_x in range(min_x, max_x + 1):
                for cell_z in range(min_z, max_z + 1):
                    segments.setdefault((cell_x, cell_z), []).append(segment)

    def connected(feature_id: str, point: list[float]) -> bool:
        cx, cz = math.floor(point[0] * scale), math.floor(point[1] * scale)
        for other_id, a, b in segments.get((cx, cz), ()):
            if (other_id != feature_id
                    and _point_segment_distance(point, a, b) <= endpoint_tolerance):
                return True
        return False

    for feature in valid:
        points = feature["pts"]
        length = sum(_distance(a, b) for a, b in zip(points, points[1:]))
        if (length < orphan_max_length
                and not connected(feature["id"], points[0])
                and not connected(feature["id"], points[-1])):
            issues.append(_issue("warning", "topology.short_orphan", feature["id"],
                                 f"isolated {length:.1f} m fragment"))

    return sorted(issues)


def summarize(issues: Iterable[Issue]) -> dict[str, int]:
    result = {"errors": 0, "warnings": 0}
    for issue in issues:
        result["errors" if issue.severity == "error" else "warnings"] += 1
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default=DEFAULT_PATH)
    parser.add_argument("--json", action="store_true", help="emit machine-readable findings")
    parser.add_argument("--warnings-as-errors", action="store_true")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as source:
        issues = validate_transport(json.load(source))
    counts = summarize(issues)
    if args.json:
        print(json.dumps({
            "path": os.path.abspath(args.path),
            **counts,
            "issues": [asdict(issue) for issue in issues],
        }, separators=(",", ":"), sort_keys=True))
    else:
        for issue in issues:
            owner = f" [{issue.feature_id}]" if issue.feature_id else ""
            print(f"{issue.severity.upper()} {issue.code}{owner}: {issue.message}")
        print(f"transport validation: {counts['errors']} errors, "
              f"{counts['warnings']} warnings, {len(issues)} findings")
    return 1 if counts["errors"] or (args.warnings_as_errors and counts["warnings"]) else 0


if __name__ == "__main__":
    sys.exit(main())
