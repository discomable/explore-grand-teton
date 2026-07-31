#!/usr/bin/env python3
"""Build measured GLB LODs for one named building from its roof.json.

    python3 heroblock.py --roof terrain/pipeline/work/hero/<slug>/roof.json

Stage 2 of the hero-building pipeline. The roof sits on the planes stage 1
measured; the walls are extruded from the roof down to the ground because
aerial LiDAR does not see them. Everything below the roofline is a plain
surface here on purpose -- logs, doors and windows arrive as projected imagery
in stages 3-6, so adding invented detail now would only fight it.

Geometry is emitted straight to glTF; Blender is not involved at this stage.

Local frame, matching what LandmarkManager expects when it places the model at
record.position on the sampled ground:

    X = world x - footprint centroid x
    Y = elevation - ground elevation      (glTF is Y-up)
    Z = world z - footprint centroid z
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
from shapely.geometry import MultiPoint, Point, Polygon, box
from shapely.ops import triangulate, unary_union

REPO = Path(__file__).resolve().parents[4]
BUILDINGS = REPO / "terrain/public/buildings.json"

TUNING = {
    # Roof outline. The drip edge under-reads by 15-25% because roof-edge
    # returns thin out, so the wall line comes from the mapped footprint and
    # the overhang is applied outward from it.
    "overhang_m": 0.35,
    # Ownership raster. Cells are assigned to the plane with the nearest
    # measured return, then vectorised.
    "wall_skirt_m": 0.60,           # walls run below ground so slopes cannot gap
    "min_wall_step_m": 0.05,        # merge coincident wall cuts; avoids sliver spikes
    "max_wall_top_slope": 3.7,      # tan(75 deg); above this a wall top is a needle, not a gable
    "min_region_area_m2": 1.5,      # drop slivers left by the raster
    # Nearest-plane assignment fills the whole outline, so a cell far from any
    # of a plane's returns still gets one. Unchecked, a 41-degree gable runs
    # metres past its own measurement and the ridge ends up too tall. Regions
    # are held near their measured extent and cut at every ridge they touch.
    # Elevation is bounded by the band below, which holds the ridge to +0.10 m
    # whether this is 1.25 m or 4 m, so this only limits lateral spread.
    "max_extrapolation_m": 3.00,
    "above_ridge_m": 0.10,          # a measured apex is the top; allow only tolerance
    "below_eave_m": 0.55,           # real roof continues past the last return: overhang
    "report_registration_m": 1.00,  # say so when the roof has to move this far
    # Regions are dilated by a fraction of a cell before lifting, so adjacent
    # planes interpenetrate slightly at a crease instead of cracking apart.
    "region_overlap_cells": 0.75,
    # A hole in the roof is see-through, so coverage is a hard gate. Coarser
    # LODs simplify their own edges away, and at 260 m a small gap is invisible.
    "lods": [
        {"name": "LOD0", "cell_m": 0.20, "simplify_m": 0.12, "wall_step_m": 0.60,
         "max_triangles": 5000, "min_coverage": 0.94},
        {"name": "LOD1", "cell_m": 0.40, "simplify_m": 0.55, "wall_step_m": 1.80,
         "max_triangles": 1000, "min_coverage": 0.90},
        # A measured shell is planar, so these budgets are nowhere near binding
        # -- LOD2 lands near 50 triangles of 250. Simplifying harder than the
        # budget requires only erodes small facets like the chapel's cross
        # gable and opens holes for nothing.
        {"name": "LOD2", "cell_m": 0.70, "simplify_m": 1.00, "wall_step_m": 4.00,
         "max_triangles": 250, "min_coverage": 0.85},
    ],
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def footprint(name: str):
    doc = load(BUILDINGS)
    matches = [b for b in doc["buildings"] if (b.get("name") or "") == name]
    if not matches:
        raise SystemExit(f"No footprint named {name!r}; stage 1 should have caught this.")
    ring = Polygon(matches[0]["pts"])
    return ring if ring.is_valid else ring.buffer(0)


def plane_elevation(plane, x, z):
    """Elevation of a plane at plan position(s). normal.(x,z,h) == offset."""
    nx, nz, nh = plane["normal"]
    return (plane["offset"] - nx * np.asarray(x) - nz * np.asarray(z)) / nh


def owner_grid(planes, outline, cell):
    """Assign each cell of the roof outline to the nearest measured return."""
    samples, owners = [], []
    for index, plane in enumerate(planes):
        for point in plane["samplePoints"]:
            samples.append(point)
            owners.append(index)
    samples = np.asarray(samples, dtype=float)
    owners = np.asarray(owners)
    minx, minz, maxx, maxz = outline.bounds
    xs = np.arange(minx + cell / 2, maxx, cell)
    zs = np.arange(minz + cell / 2, maxz, cell)
    grid_x, grid_z = np.meshgrid(xs, zs)
    centres = np.column_stack((grid_x.ravel(), grid_z.ravel()))
    inside = np.array([outline.contains(p) for p in MultiPoint(centres).geoms])
    centres = centres[inside]
    if not len(centres):
        raise SystemExit("The roof outline enclosed no raster cells; check --roof.")
    # Chunked so a large building cannot blow up the distance matrix.
    nearest = np.empty(len(centres), dtype=int)
    for start in range(0, len(centres), 4096):
        block = centres[start:start + 4096]
        distance = np.linalg.norm(block[:, None, :] - samples[None, :, :], axis=2)
        nearest[start:start + 4096] = owners[np.argmin(distance, axis=1)]
    return centres, nearest


def half_plane(ridge, keep, overhang=0.0):
    """The side of a ridge line containing `keep`, as a very large polygon.

    `overhang` pushes the cut past the ridge so the two planes overlap there
    instead of meeting exactly. Cutting on the line leaves a slit you can see
    sky through once each side is simplified independently; the planes are at
    the same height along a ridge, so a small overlap is invisible.
    """
    start = np.array(ridge["startM"][:2], dtype=float)
    end = np.array(ridge["endM"][:2], dtype=float)
    direction = end - start
    length = float(np.linalg.norm(direction))
    if length < 1e-9:
        return None
    direction = direction / length
    normal = np.array([-direction[1], direction[0]])
    if float(np.dot(np.asarray(keep) - start, normal)) < 0:
        normal = -normal
    start = start - normal * overhang
    reach = 1000.0
    a, b = start - direction * reach, start + direction * reach
    return Polygon([tuple(a), tuple(b), tuple(b + normal * reach), tuple(a + normal * reach)])


def elevation_band(plane, low, high):
    """Plan strip where the plane's elevation stays within [low, high].

    Elevation is linear in plan, so an elevation range is a strip between two
    parallel lines. This is the constraint that actually bounds an
    extrapolated plane: a ridge only helps where two planes meet, and a lone
    facet -- the chapel's cross gable has no opposing partner -- has nothing
    else stopping it from climbing above the apex it was measured at.
    """
    nx, nz, nh = plane["normal"]
    gradient = np.array([nx, nz], dtype=float)
    magnitude = float(np.linalg.norm(gradient))
    if magnitude < 1e-9:
        return None                      # level plane: elevation cannot run away
    unit = gradient / magnitude
    near = (plane["offset"] - high * nh) / magnitude
    far = (plane["offset"] - low * nh) / magnitude
    perpendicular = np.array([-unit[1], unit[0]])
    reach = 1000.0
    return Polygon([tuple(unit * near - perpendicular * reach),
                    tuple(unit * far - perpendicular * reach),
                    tuple(unit * far + perpendicular * reach),
                    tuple(unit * near + perpendicular * reach)])


def regions(planes, outline, cell, simplify_m, ridges):
    """Vectorise the ownership raster into one polygon per plane."""
    centres, nearest = owner_grid(planes, outline, cell)
    half = cell / 2
    grown = cell * TUNING["region_overlap_cells"]
    result = []
    for index in range(len(planes)):
        owned = centres[nearest == index]
        if not len(owned):
            continue
        merged = unary_union([box(x - half, z - half, x + half, z + half)
                              for x, z in owned])
        merged = merged.buffer(grown).buffer(-grown).intersection(outline)
        # Hold the region near where the plane was actually measured. The
        # overhang still needs reaching, so the limit exceeds it.
        points = np.asarray(planes[index]["samplePoints"], dtype=float)
        reach = MultiPoint([tuple(p) for p in points]).convex_hull.buffer(
            TUNING["max_extrapolation_m"])
        merged = merged.intersection(reach)
        # Never carry a plane above the highest elevation it was measured at.
        # Downward there is real roof past the last return -- the overhang --
        # so the low end is allowed a little more room.
        # A plane's high edge is the 98th percentile of its own returns, which
        # can fall below the apex it actually reaches. Where a measured ridge
        # says otherwise, believe the ridge -- otherwise the band stops each
        # side short and the seam opens into a slit you can see sky through.
        apex = planes[index]["highEdgeElevationM"]
        for ridge in ridges:
            if planes[index]["id"] in ridge["planes"]:
                apex = max(apex, ridge["elevationM"])
        band = elevation_band(planes[index],
                              planes[index]["lowEdgeElevationM"] - TUNING["below_eave_m"],
                              apex + TUNING["above_ridge_m"])
        if band is not None:
            merged = merged.intersection(band)
        # A plane stops at every ridge it forms; past that the other one owns
        # the roof. Without this a gable climbs straight over its own ridge.
        centre = points.mean(axis=0)
        # Overlap has to survive simplification, or the seam reopens as a slit.
        pad = simplify_m * 0.9 + cell * 0.5
        cuts = [half_plane(ridge, centre, pad) for ridge in ridges
                if planes[index]["id"] in ridge["planes"]]
        cuts = [c for c in cuts if c is not None]
        for side in cuts:
            merged = merged.intersection(side)
        if merged.is_empty:
            continue
        pieces = merged.geoms if merged.geom_type == "MultiPolygon" else [merged]
        for piece in pieces:
            if piece.geom_type != "Polygon" or piece.area < TUNING["min_region_area_m2"]:
                continue
            simple = piece.simplify(simplify_m, preserve_topology=True)
            # Grow back after simplifying so neighbours interpenetrate rather
            # than pull apart, then re-apply the limits that bound the shape.
            # The elevation band still caps the ridge, so this cannot raise it.
            simple = simple.buffer(pad).intersection(outline).intersection(reach)
            if band is not None:
                simple = simple.intersection(band)
            for side in cuts:
                simple = simple.intersection(side)
            if simple.geom_type == "MultiPolygon":
                simple = max(simple.geoms, key=lambda g: g.area)
            if (simple.geom_type == "Polygon" and simple.is_valid
                    and simple.area > TUNING["min_region_area_m2"]):
                result.append((index, simple))
    if not result:
        raise SystemExit("No roof region survived vectorising; raise min_region_area_m2 "
                         "or lower cell_m.")
    return result


def tessellate(polygon):
    """Triangulate a simple polygon, keeping only triangles inside it."""
    faces = []
    for triangle in triangulate(polygon):
        if polygon.contains(triangle.centroid):
            faces.append(list(triangle.exterior.coords)[:3])
    return faces


def roof_faces(built, planes, ground):
    """Triangles lying on the measured planes, in local coordinates."""
    faces, covered = [], []
    for index, region in built:
        plane = planes[index]
        covered.append(region)
        for triangle in tessellate(region):
            faces.append([(x, float(plane_elevation(plane, x, z)) - ground, z)
                          for x, z in triangle])
    return faces, unary_union(covered)


def clamped_elevation(plane, x, z):
    """Plane elevation, held inside the range the plane was measured over."""
    return float(np.clip(plane_elevation(plane, x, z),
                         plane["lowEdgeElevationM"] - TUNING["below_eave_m"],
                         plane["highEdgeElevationM"] + TUNING["above_ridge_m"]))


def roof_height_at(built, planes, x, z, ground):
    """Elevation of the roof that was actually built, above a wall point.

    Asking the nearest plane alone lets a wall top run up an extrapolated
    gable and burst through the ridge -- the walls, not the roof, were what
    stood 0.7-1.1 m proud of the measured apex. Prefer the region the point
    falls in, and clamp whatever is used to its measured range.
    """
    here = Point(x, z)
    inside = [planes[index] for index, region in built if region.contains(here)]
    if inside:
        return max(clamped_elevation(p, x, z) for p in inside) - ground
    best, best_distance = None, None
    for index, region in built:
        distance = region.distance(here)
        if best_distance is None or distance < best_distance:
            best, best_distance = planes[index], distance
    if best is None:
        best = planes[0]
    return clamped_elevation(best, x, z) - ground


def wall_faces(built, planes, ring, ground, step, ridges):
    """Extrude the mapped footprint up to the roof it meets.

    The wall top follows the roofline, so a gable end picks up its apex. Ridge
    crossings are inserted exactly, otherwise a sampled apex lands wherever the
    step happens to fall and the silhouette loses its point.
    """
    coords = list(ring.exterior.coords)
    base = -TUNING["wall_skirt_m"]
    faces = []
    # Roof height steps across a region boundary, so a corner shared by two
    # walls can be answered twice and differently -- leaving one wall standing
    # metres proud of its neighbour along an edge only centimetres wide. Solve
    # each corner once and let both walls use it.
    corners = {index: roof_height_at(built, planes, x, z, ground)
               for index, (x, z) in enumerate(coords)}
    corners[len(coords) - 1] = corners[0]
    for edge, (start, end) in enumerate(zip(coords[:-1], coords[1:])):
        (x0, z0), (x1, z1) = start, end
        length = float(np.hypot(x1 - x0, z1 - z0))
        if length < 1e-6:
            continue
        cuts = {0.0, 1.0}
        cuts.update(np.arange(step, length, step) / length)
        for ridge in ridges:
            hit = segment_crossing(start, end, ridge)
            if hit is not None:
                cuts.add(hit)
        # Drop cuts that land on top of one another. A ridge crossing falling
        # within a hair of an existing subdivision leaves a zero-width quad,
        # which renders as a one-pixel spike standing above the wall.
        order, previous = [], None
        for t in sorted(cuts):
            if previous is None or (t - previous) * length >= TUNING["min_wall_step_m"]:
                order.append(t)
                previous = t
        if order and (1.0 - order[-1]) * length < TUNING["min_wall_step_m"]:
            order[-1] = 1.0
        profile = []
        for t in order:
            x, z = x0 + (x1 - x0) * t, z0 + (z1 - z0) * t
            if t <= 0.0:
                height = corners[edge]
            elif t >= 1.0:
                height = corners[edge + 1]
            else:
                height = roof_height_at(built, planes, x, z, ground)
            profile.append((x, z, height))
        profile = despike(profile)
        for (ax, az, ah), (bx, bz, bh) in zip(profile[:-1], profile[1:]):
            faces.append([(ax, base, az), (bx, base, bz), (bx, bh, bz)])
            faces.append([(ax, base, az), (bx, bh, bz), (ax, ah, az)])
    return faces


def despike(profile):
    """Remove needles from a wall-top profile.

    Where a wall runs past a step in the roof -- a nave gable rising over a
    lower wing -- sampling can land one point on the high side and leave a
    wall a few centimetres wide standing two metres proud, which reads as a
    spike sticking out of the roofline.

    Judged by slope, not height: a gable apex is also a local maximum, but it
    rises at the roof pitch, whereas a needle is effectively vertical.
    """
    if len(profile) < 3:
        return profile
    limit = TUNING["max_wall_top_slope"]
    fixed = [list(point) for point in profile]
    for index in range(len(fixed)):
        before = fixed[index - 1] if index > 0 else None
        after = fixed[index + 1] if index < len(fixed) - 1 else None
        neighbours = [p for p in (before, after) if p is not None]
        tallest = max(p[2] for p in neighbours)
        if fixed[index][2] <= tallest:
            continue
        run = min(float(np.hypot(fixed[index][0] - p[0], fixed[index][1] - p[1]))
                  for p in neighbours)
        if run > 1e-9 and (fixed[index][2] - tallest) / run > limit:
            fixed[index][2] = tallest
    return [tuple(point) for point in fixed]


def segment_crossing(start, end, ridge):
    """Parameter along a wall edge where a ridge line crosses it, or None."""
    (x0, z0), (x1, z1) = start, end
    rx, rz = ridge["startM"][0], ridge["startM"][1]
    dx, dz = ridge["endM"][0] - rx, ridge["endM"][1] - rz
    ex, ez = x1 - x0, z1 - z0
    denominator = ex * dz - ez * dx
    if abs(denominator) < 1e-9:
        return None
    t = ((rx - x0) * dz - (rz - z0) * dx) / denominator
    return t if 1e-6 < t < 1 - 1e-6 else None


def normal_of(face):
    a, b, c = (np.asarray(v, dtype=float) for v in face)
    n = np.cross(b - a, c - a)
    length = float(np.linalg.norm(n))
    return (n / length) if length > 1e-12 else np.array([0.0, 1.0, 0.0])


def upward(faces):
    """Roof triangles must face up; the raster gives no consistent winding."""
    fixed = []
    for face in faces:
        fixed.append(face if normal_of(face)[1] >= 0 else [face[0], face[2], face[1]])
    return fixed


def outward(faces, ring, centroid):
    """Wall triangles must face away from the building centre."""
    fixed = []
    for face in faces:
        centre = np.mean(np.asarray(face, dtype=float), axis=0)
        radial = np.array([centre[0] - centroid[0], centre[2] - centroid[1]])
        n = normal_of(face)
        fixed.append(face if (n[0] * radial[0] + n[2] * radial[1]) >= 0
                     else [face[0], face[2], face[1]])
    return fixed


def primitive(faces):
    """Flat-shaded triangle soup -> (positions, normals, indices)."""
    positions, normals = [], []
    for face in faces:
        n = normal_of(face)
        for vertex in face:
            positions.append(vertex)
            normals.append(n)
    return (np.asarray(positions, dtype=np.float32),
            np.asarray(normals, dtype=np.float32),
            np.arange(len(positions), dtype=np.uint32))


def write_glb(path: Path, parts):
    """Minimal glTF 2.0 binary: one mesh, one primitive per material."""
    buffer, views, accessors, primitives, materials = bytearray(), [], [], [], []
    for name, colour, (positions, normals, indices) in parts:
        entries = []
        for data, kind, component, count in (
                (positions, "VEC3", 5126, len(positions)),
                (normals, "VEC3", 5126, len(normals)),
                (indices, "SCALAR", 5125, len(indices))):
            raw = data.tobytes()
            while len(buffer) % 4:
                buffer.append(0)
            views.append({"buffer": 0, "byteOffset": len(buffer), "byteLength": len(raw)})
            buffer.extend(raw)
            accessor = {"bufferView": len(views) - 1, "componentType": component,
                        "count": int(count), "type": kind}
            if kind == "VEC3":
                accessor["min"] = [float(v) for v in data.min(axis=0)]
                accessor["max"] = [float(v) for v in data.max(axis=0)]
            accessors.append(accessor)
            entries.append(len(accessors) - 1)
        primitives.append({"attributes": {"POSITION": entries[0], "NORMAL": entries[1]},
                           "indices": entries[2], "material": len(materials)})
        materials.append({"name": name, "doubleSided": False,
                          "pbrMetallicRoughness": {"baseColorFactor": list(colour),
                                                   "metallicFactor": 0.0,
                                                   "roughnessFactor": 0.95}})
    gltf = {
        "asset": {"version": "2.0", "generator": "heroblock.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": primitives}], "materials": materials,
        "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(buffer)}],
    }
    body = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    body += b" " * (-len(body) % 4)
    buffer.extend(b"\0" * (-len(buffer) % 4))
    total = 12 + 8 + len(body) + 8 + len(buffer)
    with path.open("wb") as out:
        out.write(struct.pack("<III", 0x46546C67, 2, total))
        out.write(struct.pack("<II", len(body), 0x4E4F534A))
        out.write(body)
        out.write(struct.pack("<II", len(buffer), 0x004E4942))
        out.write(bytes(buffer))
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--roof", type=Path, required=True, help="roof.json from stage 1")
    parser.add_argument("--output", type=Path, help="directory for the GLBs "
                                                    "(default: alongside roof.json)")
    parser.add_argument("--name", help="output basename (default: from the building name)")
    opt = parser.parse_args()

    roof = load(opt.roof)
    if not roof.get("planes"):
        raise SystemExit(f"{opt.roof} holds no planes; stage 1 did not succeed.")
    if any(not p.get("samplePoints") for p in roof["planes"]):
        raise SystemExit(f"{opt.roof} predates samplePoints. Re-run hero_lidar.py.")
    failed = [c["id"] for c in roof.get("checks", []) if not c["passed"]]
    if failed:
        raise SystemExit(f"{opt.roof} has failing stage 1 checks: {', '.join(failed)}.\n"
                         "Fix stage 1 before building geometry on top of it.")

    ring = footprint(roof["building"])
    centroid = (ring.centroid.x, ring.centroid.y)

    # The measured roof and the mapped footprint do not always sit on top of
    # each other -- the T. A. Moulton Barn's disagree by 2.4 m, the chapel's by
    # 0.14 m. Left alone the roof hangs off one end and the far side of the
    # building has no roof at all. LiDAR owns the shape; the footprint owns
    # placement and collision, so the roof is registered onto the footprint.
    measured = MultiPoint([tuple(p) for plane in roof["planes"]
                           for p in plane["samplePoints"]]).convex_hull
    shift = (measured.centroid.x - centroid[0], measured.centroid.y - centroid[1])
    origin = (centroid[0] + shift[0], centroid[1] + shift[1])

    local_ring = Polygon([(x - centroid[0], z - centroid[1])
                          for x, z in ring.exterior.coords])
    planes = [dict(p, samplePoints=[[x - origin[0], z - origin[1]]
                                    for x, z in p["samplePoints"]],
                   offset=p["offset"] - p["normal"][0] * origin[0]
                          - p["normal"][1] * origin[1])
              for p in roof["planes"]]
    ridges = [dict(r, startM=[r["startM"][0] - origin[0], r["startM"][1] - origin[1]],
                   endM=[r["endM"][0] - origin[0], r["endM"][1] - origin[1]])
              for r in roof.get("ridges", [])]
    drift = float(np.hypot(*shift))
    if drift > TUNING["report_registration_m"]:
        print(f"  registered roof onto footprint: moved {drift:.2f} m "
              f"(dx {-shift[0]:+.2f}, dz {-shift[1]:+.2f}). Large for a measured roof -- "
              f"check the footprint against an orthophoto.")
    ground = roof["groundElevationM"]
    outline = local_ring.buffer(TUNING["overhang_m"])

    output = opt.output or opt.roof.parent
    output.mkdir(parents=True, exist_ok=True)
    stem = opt.name or opt.roof.parent.name
    report, over_budget, holed = [], [], []
    for lod in TUNING["lods"]:
        built = regions(planes, outline, lod["cell_m"], lod["simplify_m"], ridges)
        faces, covered = roof_faces(built, planes, ground)
        roof_tris = upward(faces)
        coverage = covered.intersection(local_ring).area / local_ring.area
        wall_tris = outward(wall_faces(built, planes, local_ring, ground,
                                       lod["wall_step_m"], ridges),
                            local_ring, (0.0, 0.0))
        path = output / f"{stem}-{lod['name'].lower()}.glb"
        size = write_glb(path, [
            ("roof", (0.32, 0.30, 0.28, 1.0), primitive(roof_tris)),
            ("wall", (0.55, 0.47, 0.38, 1.0), primitive(wall_tris)),
        ])
        total = len(roof_tris) + len(wall_tris)
        report.append({"lod": lod["name"], "file": path.name, "triangles": total,
                       "roofTriangles": len(roof_tris), "wallTriangles": len(wall_tris),
                       "materialPrimitives": 2, "bytes": size,
                       "maxTriangles": lod["max_triangles"],
                       "roofCoverage": round(coverage, 4),
                       "minCoverage": lod["min_coverage"],
                       "withinBudget": total <= lod["max_triangles"]})
        if total > lod["max_triangles"]:
            over_budget.append(lod["name"])
        if coverage < lod["min_coverage"]:
            holed.append((lod["name"], coverage, lod["min_coverage"]))
        print(f"  {lod['name']}: {total:5d} tris ({len(roof_tris)} roof + "
              f"{len(wall_tris)} wall), roof covers {coverage:.0%} of the footprint, "
              f"{size / 1024:.0f} KB -> {path.name}")

    summary = output / f"{stem}-geometry.json"
    summary.write_text(json.dumps({
        "building": roof["building"], "roof": str(opt.roof),
        "localOriginWorld": [round(centroid[0], 3), round(centroid[1], 3)],
        "groundElevationM": ground, "planes": len(planes),
        "eaveAglM": roof["eaveAglM"], "ridgeAglM": roof["ridgeAglM"],
        "tuning": TUNING, "lods": report,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"  wrote {summary.name}")
    if over_budget:
        print(f"\nFAIL {', '.join(over_budget)} over the triangle budget.\n"
              "     Raise that LOD's cell_m and simplify_m in TUNING and re-run.",
              file=sys.stderr)
    for name, value, limit in holed:
        print(f"\nFAIL {name} roof covers only {value:.0%} of the footprint, needs {limit:.0%}.\n"
              "     Holes mean the measured planes do not reach the walls. Check the\n"
              "     stage 1 planes against the footprint before raising\n"
              "     max_extrapolation_m -- a real gap is usually a missing plane.",
              file=sys.stderr)
    if over_budget or holed:
        return 1
    print(f"\nPlace at world [{centroid[0]:.1f}, {centroid[1]:.1f}] in landmarks.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
