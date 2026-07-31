#!/usr/bin/env python3
"""Render orthographic clay targets for one building's projected surfacing.

    python3 render_elevations.py --model terrain/pipeline/work/hero/<slug>/<slug>-lod0.glb

Stage 3 of the hero-building pipeline. Produces five untextured renders -- four
walls around the building plus one looking down at the roof -- and the exact
camera each was taken with, so stage 6 can project the edited images back on
without guessing.

The renders are the immutable edit targets. An image tool may repaint their
surfaces but must not move an edge, because every pixel is registered to a
measured face.

Why five and not four: a shallow roof seen from the side is crushed. The barn's
15-degree sheds stretch 3.8x under a wall camera and 1.04x from above, and the
roof is half its visible skin.

Why the cameras are built from the walls: the frame has to follow the building.
The chapel sits 41 degrees off the world axes, and the barn's roof planes all
face north or south, so taking the frame from roof planes would hand its two
16.8 m walls a camera nearly edge-on to them.

All five share one pixels-per-metre scale so features line up where the images
meet at a corner.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

REPO = Path(__file__).resolve().parents[4]
BUILDINGS = REPO / "terrain/public/buildings.json"

TUNING = {
    "tile_px": 1024,                # each view renders into this square
    "gen_px": 1024,                 # <view>-gen.png: subject filling the frame
    "margin_px": 24,                # keeps the silhouette off the edge
    "max_stretch": 1.60,            # texel stretch a face may suffer
    # Cross-material occlusion paints a wall with roof, so it is a hard stop.
    # Same-material occlusion only duplicates detail between two parallel walls
    # -- the chapel's cross plan does this over 18% of one elevation -- which
    # reads fine at the distance these buildings are judged from.
    "max_cross_material_occlusion": 0.02,
    "warn_same_material_occlusion": 0.05,
    "max_enclosed_gap_m2": 0.40,    # sky visible through the surface

    "min_face_dot": 0.30,           # a face this edge-on to every camera is unusable
    # Flat clay shading. Deliberately even and shadowless: baked lighting would
    # be carried into the texture and fight the game's own sun.
    "light": (0.35, 0.86, 0.37),
    "ambient": 0.42,
    "wall_tone": (0.78, 0.74, 0.68),
    "roof_tone": (0.62, 0.60, 0.58),
    "background": (0.09, 0.10, 0.11),
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_glb(path: Path):
    """Return [(material name, positions, normals, indices)] from a .glb."""
    raw = path.read_bytes()
    magic, version, total = struct.unpack("<III", raw[:12])
    if magic != 0x46546C67 or version != 2 or total != len(raw):
        raise SystemExit(f"{path} is not a valid binary glTF 2.0 file.")
    offset, meta, buffer = 12, None, None
    while offset < len(raw):
        length, kind = struct.unpack("<II", raw[offset:offset + 8])
        offset += 8
        chunk = raw[offset:offset + length]
        offset += length
        if kind == 0x4E4F534A:
            meta = json.loads(chunk)
        else:
            buffer = chunk

    def accessor(index):
        spec = meta["accessors"][index]
        view = meta["bufferViews"][spec["bufferView"]]
        dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16}[spec["componentType"]]
        width = {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[spec["type"]]
        flat = np.frombuffer(buffer, dtype=dtype, count=spec["count"] * width,
                             offset=view["byteOffset"])
        return flat.reshape(-1, width) if width > 1 else flat

    parts = []
    for primitive in meta["meshes"][0]["primitives"]:
        parts.append((meta["materials"][primitive["material"]]["name"],
                      accessor(primitive["attributes"]["POSITION"]).astype(np.float64),
                      accessor(primitive["attributes"]["NORMAL"]).astype(np.float64),
                      accessor(primitive["indices"]).astype(np.int64)))
    return parts


def building_frame(ring: Polygon):
    """Four horizontal camera bearings aligned to the walls.

    Length-weighted circular mean of the wall bearings taken modulo 90 degrees,
    which is the symmetry a rectangular building actually has. Long walls
    dominate, so a few short jogs cannot rotate the frame.
    """
    coords = list(ring.exterior.coords)
    angles, weights = [], []
    for (x0, z0), (x1, z1) in zip(coords[:-1], coords[1:]):
        ex, ez = x1 - x0, z1 - z0
        length = float(np.hypot(ex, ez))
        if length < 0.15:
            continue
        bearing = float(np.degrees(np.arctan2(ez / length, ex / length))) % 360
        angles.append(np.radians(bearing * 4))
        weights.append(length)
    if not angles:
        raise SystemExit("Footprint has no usable wall edges.")
    angles, weights = np.asarray(angles), np.asarray(weights)
    base = (np.degrees(np.arctan2((weights * np.sin(angles)).sum(),
                                  (weights * np.cos(angles)).sum())) / 4) % 90
    return [(base + 90 * k) % 360 for k in range(4)]


def view_basis(bearing):
    """Camera looking horizontally along `bearing`, in local model axes."""
    radians = np.radians(bearing)
    forward = np.array([-np.sin(radians), 0.0, np.cos(radians)])   # toward the building
    right = np.array([np.cos(radians), 0.0, np.sin(radians)])
    up = np.array([0.0, 1.0, 0.0])
    return forward, right, up


def build_views(frame, vertices):
    """Five cameras sharing one pixels-per-metre scale."""
    specs = []
    for index, bearing in enumerate(frame):
        forward, right, up = view_basis(bearing)
        specs.append({"id": f"wall{index}", "kind": "wall", "bearingDeg": round(bearing, 2),
                      "forward": forward, "right": right, "up": up})
    specs.append({"id": "roof", "kind": "roof", "bearingDeg": None,
                  "forward": np.array([0.0, -1.0, 0.0]),
                  "right": np.array([1.0, 0.0, 0.0]),
                  "up": np.array([0.0, 0.0, -1.0])})
    span = 0.0
    for spec in specs:
        u = vertices @ spec["right"]
        v = vertices @ spec["up"]
        spec["uRange"] = (float(u.min()), float(u.max()))
        spec["vRange"] = (float(v.min()), float(v.max()))
        span = max(span, u.max() - u.min(), v.max() - v.min())
    usable = TUNING["tile_px"] - 2 * TUNING["margin_px"]
    scale = usable / span                       # one scale for every view
    for spec in specs:
        spec["pxPerM"] = scale
        # Centre each view in its tile; letterboxing keeps the scale shared.
        mid_u = sum(spec["uRange"]) / 2
        mid_v = sum(spec["vRange"]) / 2
        spec["originU"] = mid_u - TUNING["tile_px"] / (2 * scale)
        spec["originV"] = mid_v - TUNING["tile_px"] / (2 * scale)
    return specs


def assign(normals, specs):
    """Give each face the camera it faces most squarely."""
    directions = np.array([-spec["forward"] for spec in specs])    # outward normals
    alignment = normals @ directions.T
    return np.argmax(alignment, axis=1), alignment


def project(points, spec):
    """Local 3D -> (pixel x, pixel y, depth). Depth grows away from the camera."""
    u = (points @ spec["right"] - spec["originU"]) * spec["pxPerM"]
    v = (points @ spec["up"] - spec["originV"]) * spec["pxPerM"]
    depth = points @ spec["forward"]
    return u, TUNING["tile_px"] - v, depth       # image y runs downward


def face_pixels(spec, tri, size):
    """Pixel indices a projected triangle covers, as (rows, columns)."""
    x, y, _ = project(tri, spec)
    lo_x, hi_x = max(int(np.floor(x.min())), 0), min(int(np.ceil(x.max())), size - 1)
    lo_y, hi_y = max(int(np.floor(y.min())), 0), min(int(np.ceil(y.max())), size - 1)
    if lo_x > hi_x or lo_y > hi_y:
        return np.empty(0, dtype=int), np.empty(0, dtype=int)
    grid_x, grid_y = np.meshgrid(np.arange(lo_x, hi_x + 1) + 0.5,
                                 np.arange(lo_y, hi_y + 1) + 0.5)
    x0, y0, x1, y1, x2, y2 = x[0], y[0], x[1], y[1], x[2], y[2]
    area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if abs(area) < 1e-9:
        return np.empty(0, dtype=int), np.empty(0, dtype=int)
    w0 = ((x1 - grid_x) * (y2 - grid_y) - (x2 - grid_x) * (y1 - grid_y)) / area
    w1 = ((x2 - grid_x) * (y0 - grid_y) - (x0 - grid_x) * (y2 - grid_y)) / area
    inside = (w0 >= 0) & (w1 >= 0) & ((1 - w0 - w1) >= 0)
    rows, columns = np.nonzero(inside)
    return rows + lo_y, columns + lo_x


def occlusion(spec, faces, kinds, mine, owner, size):
    """Area-weighted share of each view's own surface that loses the depth test.

    Split by material, because the consequence differs. A wall hidden behind
    another wall samples wall texels -- duplicated detail, but the right kind
    of surface. A wall hidden behind the roof samples roof texels, which is
    simply the wrong material painted onto it.
    """
    same_area = other_area = total = 0.0
    for face_id in mine:
        tri, _, _ = faces[face_id]
        rows, columns = face_pixels(spec, tri, size)
        if not len(rows):
            continue
        area = 0.5 * float(np.linalg.norm(np.cross(tri[1] - tri[0], tri[2] - tri[0])))
        winners = owner[rows, columns]
        lost = winners != face_id
        if not lost.any():
            total += area
            continue
        held = winners[lost]
        cross = np.array([kinds[w] != kinds[face_id] if w >= 0 else False for w in held])
        share = lost.sum() / len(rows)
        other_area += area * share * (cross.mean() if len(cross) else 0.0)
        same_area += area * share * (1 - (cross.mean() if len(cross) else 0.0))
        total += area
    if total <= 0:
        return 0.0, 0.0
    return same_area / total, other_area / total


def enclosed_gaps(spec, faces, drawn):
    """Area of holes enclosed by the surface -- places you see sky through.

    Every numeric gate passed while the barn's roof still had a slit along its
    ridge, because a thin seam is a negligible share of total area.

    Measured as the interior rings of the union of the projected faces. A
    re-entrant outline is a notch in the exterior ring, not an interior one,
    so the chapel's cross plan does not register as a hole the way a
    surrounded-on-all-sides pixel test would.
    """
    shapes = []
    for face_id in drawn:
        tri, _, _ = faces[face_id]
        x, y, _ = project(tri, spec)
        polygon = Polygon(list(zip(x, y)))
        if polygon.is_valid and polygon.area > 0:
            shapes.append(polygon)
    if not shapes:
        return 0.0
    merged = unary_union(shapes)
    pieces = merged.geoms if merged.geom_type == "MultiPolygon" else [merged]
    holes = sum(Polygon(ring).area for piece in pieces
                for ring in getattr(piece, "interiors", []))
    return float(holes) / (spec["pxPerM"] ** 2)


def rasterize(spec, faces, size, subset=None):
    """Z-buffered flat-shaded render. Returns image, depth and face-id buffers.

    `subset` restricts what is drawn. Wall cameras draw only walls and the roof
    camera only the roof: an overhanging eave otherwise hides the strip of wall
    beneath it, and that wall would then sample roof texels. Excluding the
    other material makes wrong-material projection impossible rather than
    merely rare. Wall geometry already carries the gable peaks, so the
    silhouette an image tool needs survives.
    """
    image = np.zeros((size, size, 3), dtype=np.float64)
    image[:] = TUNING["background"]
    depth_buffer = np.full((size, size), np.inf)
    owner = np.full((size, size), -1, dtype=np.int64)
    light = np.asarray(TUNING["light"], dtype=float)
    light = light / np.linalg.norm(light)
    allowed = None if subset is None else set(int(v) for v in subset)
    for face_id, (tri, normal, tone) in enumerate(faces):
        if allowed is not None and face_id not in allowed:
            continue
        x, y, depth = project(tri, spec)
        lo_x, hi_x = int(np.floor(x.min())), int(np.ceil(x.max()))
        lo_y, hi_y = int(np.floor(y.min())), int(np.ceil(y.max()))
        lo_x, hi_x = max(lo_x, 0), min(hi_x, size - 1)
        lo_y, hi_y = max(lo_y, 0), min(hi_y, size - 1)
        if lo_x > hi_x or lo_y > hi_y:
            continue
        grid_x, grid_y = np.meshgrid(np.arange(lo_x, hi_x + 1) + 0.5,
                                     np.arange(lo_y, hi_y + 1) + 0.5)
        x0, y0, x1, y1, x2, y2 = x[0], y[0], x[1], y[1], x[2], y[2]
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9:
            continue
        w0 = ((x1 - grid_x) * (y2 - grid_y) - (x2 - grid_x) * (y1 - grid_y)) / area
        w1 = ((x2 - grid_x) * (y0 - grid_y) - (x0 - grid_x) * (y2 - grid_y)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        pixel_depth = w0 * depth[0] + w1 * depth[1] + w2 * depth[2]
        window = depth_buffer[lo_y:hi_y + 1, lo_x:hi_x + 1]
        nearer = inside & (pixel_depth < window)
        if not nearer.any():
            continue
        shade = TUNING["ambient"] + (1 - TUNING["ambient"]) * max(0.0, float(normal @ light))
        window[nearer] = pixel_depth[nearer]
        image[lo_y:hi_y + 1, lo_x:hi_x + 1][nearer] = np.asarray(tone) * shade
        owner[lo_y:hi_y + 1, lo_x:hi_x + 1][nearer] = face_id
    return image, depth_buffer, owner


def generation_crop(image, owner, size):
    """Crop to the subject and enlarge it to fill the frame.

    Image models normalise a subject to fill the image. Handed the letterboxed
    target, where the chapel's entry elevation covers 52% of the width and 33%
    of the height, one returned it 1.60x wider and 1.95x taller -- which is
    exactly those fractions pushed up to 83% and 64%. No wording prevents it,
    since the tool offers no mask, denoise strength or structural conditioning.

    Removing the margins removes the motive: from a filled frame the same
    model returns 1.00x, and silhouette agreement goes from 73% to 98%. The
    registration step maps the crop back, so the shared pixels-per-metre scale
    of the letterboxed target is unaffected.
    """
    covered = owner >= 0
    rows = np.flatnonzero(covered.any(axis=1))
    columns = np.flatnonzero(covered.any(axis=0))
    if not len(rows) or not len(columns):
        return None
    pad = 8
    top, bottom = max(int(rows[0]) - pad, 0), min(int(rows[-1]) + 1 + pad, image.shape[0])
    left, right = max(int(columns[0]) - pad, 0), min(int(columns[-1]) + 1 + pad, image.shape[1])
    crop = image[top:bottom, left:right]
    scale = size / max(crop.shape[0], crop.shape[1])
    height = max(1, int(round(crop.shape[0] * scale)))
    width = max(1, int(round(crop.shape[1] * scale)))
    sample_y = np.clip((np.arange(height) / scale).astype(int), 0, crop.shape[0] - 1)
    sample_x = np.clip((np.arange(width) / scale).astype(int), 0, crop.shape[1] - 1)
    return crop[sample_y][:, sample_x]


def write_png(path: Path, image):
    data = np.clip(image, 0, 1)
    pixels = (data * 255 + 0.5).astype(np.uint8)
    height, width, _ = pixels.shape
    raw = b"".join(b"\x00" + pixels[row].tobytes() for row in range(height))

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6))
                     + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, required=True, help="LOD0 .glb from stage 2")
    parser.add_argument("--geometry", type=Path, help="<slug>-geometry.json (default: alongside)")
    parser.add_argument("--output", type=Path, help="directory for the targets")
    opt = parser.parse_args()

    geometry_path = opt.geometry or Path(str(opt.model).rsplit("-lod", 1)[0] + "-geometry.json")
    if not geometry_path.is_file():
        raise SystemExit(f"Missing {geometry_path}. Run heroblock.py (stage 2) first.")
    geometry = load(geometry_path)
    doc = load(BUILDINGS)
    matches = [b for b in doc["buildings"] if (b.get("name") or "") == geometry["building"]]
    ring = Polygon(matches[0]["pts"])
    origin = geometry["localOriginWorld"]
    local_ring = Polygon([(x - origin[0], z - origin[1]) for x, z in ring.exterior.coords])

    parts = read_glb(opt.model)
    vertices = np.vstack([positions for _, positions, _, _ in parts])
    frame = building_frame(local_ring)
    specs = build_views(frame, vertices)

    faces, face_normals, face_area, face_kind = [], [], [], []
    for name, positions, normals, indices in parts:
        tone = TUNING["roof_tone"] if name == "roof" else TUNING["wall_tone"]
        for corner in indices.reshape(-1, 3):
            tri = positions[corner]
            normal = normals[corner[0]]
            faces.append((tri, normal, tone))
            face_normals.append(normal)
            face_area.append(0.5 * float(np.linalg.norm(
                np.cross(tri[1] - tri[0], tri[2] - tri[0]))))
            face_kind.append(name)
    face_normals = np.asarray(face_normals)
    face_area = np.asarray(face_area)
    face_kind = np.asarray(face_kind)
    owner_view, alignment = assign(face_normals, specs)

    output = opt.output or opt.model.parent / "elevations"
    output.mkdir(parents=True, exist_ok=True)

    # Render every view against the whole model so occlusion is real, then ask
    # how much of each view's own faces actually survived the depth test.
    reports, failures = [], []
    for index, spec in enumerate(specs):
        material = "roof" if spec["kind"] == "roof" else "wall"
        drawn = np.flatnonzero(face_kind == material)
        image, _, owner = rasterize(spec, faces, TUNING["tile_px"], drawn)
        write_png(output / f"{spec['id']}-clay.png", image)
        crop = generation_crop(image, owner, TUNING["gen_px"])
        if crop is not None:
            write_png(output / f"{spec['id']}-gen.png", crop)
        mine = np.flatnonzero(owner_view == index)
        mine_area = float(face_area[mine].sum()) if len(mine) else 0.0
        same, cross = occlusion(spec, faces, face_kind, mine, owner, TUNING["tile_px"])
        gaps = enclosed_gaps(spec, faces, drawn)
        dot = alignment[mine, index] if len(mine) else np.array([1.0])
        worst = float(1.0 / max(dot.min(), 1e-6)) if len(mine) else 1.0
        reports.append({
            "id": spec["id"], "kind": spec["kind"], "bearingDeg": spec["bearingDeg"],
            "faces": int(len(mine)), "areaM2": round(mine_area, 2),
            "worstStretch": round(worst, 3),
            "occludedBySameMaterial": round(same, 4),
            "occludedByOtherMaterial": round(cross, 4),
            "enclosedGapM2": round(gaps, 3),
            "pxPerM": round(spec["pxPerM"], 2),
        })
        if worst > TUNING["max_stretch"]:
            failures.append(f"{spec['id']} stretches a face {worst:.2f}x "
                            f"(limit {TUNING['max_stretch']})")
        if gaps > TUNING["max_enclosed_gap_m2"]:
            failures.append(f"{spec['id']} shows {gaps:.2f} m2 of enclosed gaps -- holes "
                            f"in the surface (limit {TUNING['max_enclosed_gap_m2']} m2)")
        if cross > TUNING["max_cross_material_occlusion"]:
            failures.append(
                f"{spec['id']} has {cross:.1%} of its surface hidden behind a different "
                f"material (limit {TUNING['max_cross_material_occlusion']:.0%}); those "
                "faces would be painted with the wrong material")
        note = ""
        if same > TUNING["warn_same_material_occlusion"]:
            note = f"  <- {same:.0%} shares texels with a parallel face of the same material"
        print(f"  {spec['id']:6} {spec['kind']:4} {len(mine):4d} faces  "
              f"{mine_area:7.1f} m2  stretch {worst:.2f}x  "
              f"hidden {same:.1%} same / {cross:.1%} other  gaps {gaps:.2f} m2{note}")

    orphan = float(face_area[alignment.max(axis=1) < TUNING["min_face_dot"]].sum())
    if orphan > 0:
        failures.append(f"{orphan:.1f} m2 of surface is edge-on to every camera")

    manifest = {
        "building": geometry["building"],
        "model": str(opt.model),
        "localOriginWorld": origin,
        "frameBearingsDeg": [round(b, 2) for b in frame],
        "tilePx": TUNING["tile_px"],
        "pxPerM": round(specs[0]["pxPerM"], 4),
        "tuning": {k: v for k, v in TUNING.items() if k != "lods"},
        "views": [{**report,
                   "right": list(spec["right"]), "up": list(spec["up"]),
                   "forward": list(spec["forward"]),
                   "originU": spec["originU"], "originV": spec["originV"]}
                  for report, spec in zip(reports, specs)],
        "faceAssignment": [specs[i]["id"] for i in owner_view],
    }
    (output / "elevations.json").write_text(json.dumps(manifest, indent=2) + "\n",
                                            encoding="utf-8")
    print(f"  {len(specs)} targets at {specs[0]['pxPerM']:.1f} px/m -> "
          f"{output.relative_to(REPO) if output.is_relative_to(REPO) else output}")
    if failures:
        print("\nFAIL " + "\n     ".join(failures)
              + "\n     A stretched or hidden face cannot take a registered projection.\n"
                "     Check the building frame in elevations.json against the footprint.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
