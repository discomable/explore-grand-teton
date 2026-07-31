#!/usr/bin/env python3
"""Make a generated 3D mesh shippable as a landmark.

    python3 import_mesh.py --mesh model.glb --building terrain/pipeline/work/hero/<slug>

An image-to-3D service returns a dense unit-scale mesh with baked props and no
normals. This fits it to the measured footprint, strips the loose props,
decimates it to the LOD budgets, corrects the roof colour and writes the same
three GLBs the rest of the pipeline produces.

The measurement still rules. Placement, orientation and size come from the
LiDAR-derived footprint, not from the mesh -- what the mesh contributes is the
detail LiDAR cannot see, which for the chapel is the ridge cross, the chimney
and the entry porch.

Scale is close to honest here: in the building's own frame the chapel's
footprint is 16.06 x 9.74 m, an aspect of 0.606, against the mesh's 0.629. The
axis-aligned bounding box makes that disagreement look like 20% because the
building sits 41 degrees off the world axes.
"""
from __future__ import annotations

import argparse
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import Polygon

REPO = Path(__file__).resolve().parents[4]
BUILDINGS = REPO / "terrain/public/buildings.json"

TUNING = {
    "min_component_area_share": 0.01,   # (unused) legacy size filter
    "prop_gap_m": 0.02,                 # a part this far off the mass in plan is a prop
    "uv_cluster": 0.004,                # keep UV seams apart when collapsing vertices
    "ridge_area_percentile": 97.0,      # roof top, ignoring cross and chimney spikes
    "roof_normal_up": 0.45,             # a face this upward-facing is roof
    "background": (0.09, 0.10, 0.11),
    "wall_skirt_m": 0.60,               # sink the base ring so slopes cannot gap
    "base_grip_m": 0.18,                # vertices this close to the base are ground ring
    "texture_px": 1024,
    "jpeg_quality": 88,
    "max_texture_bytes": 1572864,
    "lods": [
        {"name": "lod0", "max_triangles": 5000},
        {"name": "lod1", "max_triangles": 1000},
        {"name": "lod2", "max_triangles": 250},
    ],
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_mesh(path: Path):
    raw = path.read_bytes()
    magic, version, total = struct.unpack("<III", raw[:12])
    if magic != 0x46546C67 or version != 2 or total != len(raw):
        raise SystemExit(f"{path} is not valid binary glTF 2.0.")
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
        dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16,
                 5121: np.uint8}[spec["componentType"]]
        width = {"VEC4": 4, "VEC3": 3, "VEC2": 2, "SCALAR": 1}[spec["type"]]
        start = view.get("byteOffset", 0) + spec.get("byteOffset", 0)
        flat = np.frombuffer(buffer, dtype=dtype, count=spec["count"] * width, offset=start)
        return flat.reshape(-1, width) if width > 1 else flat

    primitive = meta["meshes"][0]["primitives"][0]
    positions = accessor(primitive["attributes"]["POSITION"]).astype(np.float64)
    uv = accessor(primitive["attributes"]["TEXCOORD_0"]).astype(np.float64)
    faces = accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)

    # Follow the material to the base colour, do not assume image[0]. Meshy
    # orders the four maps differently per export -- this barn put emissive at
    # index 0 and the albedo at index 2, so the old assumption baked a black
    # night-emissive map onto the walls.
    image_index = 0
    if "material" in primitive:
        material = meta["materials"][primitive["material"]]
        texture_ref = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if texture_ref is not None:
            image_index = meta["textures"][texture_ref["index"]]["source"]
    image = meta["images"][image_index]
    view = meta["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset", 0)
    blob = buffer[start:start + view["byteLength"]]
    return positions, uv, faces, Image.open(io.BytesIO(blob)).convert("RGB")


def areas(positions, faces):
    a, b, c = positions[faces[:, 0]], positions[faces[:, 1]], positions[faces[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def largest_part(positions, uv, faces):
    """Keep the building; drop the props welded onto it.

    These meshes arrive with scenery attached -- the chapel came with a bench
    and a signboard floating clear of the walls. They are separate connected
    components, so area share separates them from the building cleanly.
    """
    # Weld by position before looking for parts. UV seams duplicate vertices, so
    # index connectivity alone reported 1180 "loose parts" on a mesh that is one
    # building -- the seams, not the props.
    _, welded = np.unique(np.round(positions, 4), axis=0, return_inverse=True)
    parent = np.arange(welded.max() + 1)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for face in welded[faces]:
        roots = [find(int(v)) for v in face]
        for other in roots[1:]:
            if other != roots[0]:
                parent[other] = roots[0]
    labels = np.array([find(int(v)) for v in range(parent.size)])
    face_label = labels[welded[faces[:, 0]]]
    face_area = areas(positions, faces)
    total = face_area.sum()

    # A prop is spatially detached, not merely small. A retopologised mesh
    # splits the building into many separate panels -- this chapel came in 128
    # components, the largest only 15% -- so dropping by area share throws out
    # real walls. Instead, grow outward from the largest component and keep any
    # component whose plan footprint overlaps what is already kept; a bench or
    # sign clear of the walls never joins and is dropped.
    def plan_box(mask):
        pts = positions[np.unique(faces[mask])][:, [0, 2]]
        return pts.min(axis=0), pts.max(axis=0)

    labels_by_area = sorted(np.unique(face_label),
                            key=lambda l: -face_area[face_label == l].sum())
    kept_labels = {labels_by_area[0]}
    lo, hi = plan_box(face_label == labels_by_area[0])
    margin = TUNING["prop_gap_m"]
    changed = True
    while changed:
        changed = False
        for label in labels_by_area:
            if label in kept_labels:
                continue
            plo, phi = plan_box(face_label == label)
            if (plo[0] <= hi[0] + margin and phi[0] >= lo[0] - margin
                    and plo[1] <= hi[1] + margin and phi[1] >= lo[1] - margin):
                kept_labels.add(label)
                lo, hi = np.minimum(lo, plo), np.maximum(hi, phi)
                changed = True
    keep = np.isin(face_label, list(kept_labels))
    dropped = [(int((face_label == l).sum()), float(face_area[face_label == l].sum() / total))
               for l in labels_by_area if l not in kept_labels]
    return keep, dropped


def cluster(positions, uv, faces, cell, uv_cell=None):
    """Collapse vertices sharing a position cell and a UV cell.

    Position alone would weld the two sides of a UV seam together and smear the
    texture across it, so the key carries both.
    """
    grid = np.floor(positions / cell).astype(np.int64)
    uv_grid = np.floor(uv / (uv_cell or TUNING["uv_cluster"])).astype(np.int64)
    key = np.concatenate([grid, uv_grid], axis=1)
    _, inverse = np.unique(key, axis=0, return_inverse=True)
    count = inverse.max() + 1
    sums = np.zeros((count, 3))
    uv_sums = np.zeros((count, 2))
    weights = np.zeros(count)
    np.add.at(sums, inverse, positions)
    np.add.at(uv_sums, inverse, uv)
    np.add.at(weights, inverse, 1.0)
    new_positions = sums / weights[:, None]
    new_uv = uv_sums / weights[:, None]
    new_faces = inverse[faces]
    good = ((new_faces[:, 0] != new_faces[:, 1])
            & (new_faces[:, 1] != new_faces[:, 2])
            & (new_faces[:, 0] != new_faces[:, 2]))
    return new_positions, new_faces[good]


def bake_view(positions, uv, faces, texture, spec, size):
    """Rasterise the dense mesh through one orthographic camera, with its texture.

    The dense mesh's UVs cannot survive decimation -- at 94% reduction a
    surviving vertex stands in for about sixteen originals scattered across a
    chaotic generated atlas, so no single UV is right for the triangles using
    it. Both a nearest-vertex transfer and the decimator's own collapse mapping
    produced the same scrambled walls.

    So the texture is re-baked instead: render the dense mesh through the same
    cameras the rest of the pipeline uses, and give the decimated mesh clean
    planar UVs into the result.
    """
    image = np.zeros((size, size, 3))
    image[:] = np.asarray(TUNING["background"])
    depth = np.full((size, size), np.inf)
    th, tw, _ = texture.shape
    for face in faces:
        tri = positions[face]
        x = (tri @ spec["right"] - spec["originU"]) * spec["pxPerM"]
        y = size - (tri @ spec["up"] - spec["originV"]) * spec["pxPerM"]
        d = tri @ spec["forward"]
        lo_x, hi_x = max(int(x.min()), 0), min(int(x.max()) + 1, size - 1)
        lo_y, hi_y = max(int(y.min()), 0), min(int(y.max()) + 1, size - 1)
        if lo_x >= hi_x or lo_y >= hi_y:
            continue
        gx, gy = np.meshgrid(np.arange(lo_x, hi_x + 1) + .5, np.arange(lo_y, hi_y + 1) + .5)
        area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0])
        if abs(area) < 1e-12:
            continue
        w0 = ((x[1] - gx) * (y[2] - gy) - (x[2] - gx) * (y[1] - gy)) / area
        w1 = ((x[2] - gx) * (y[0] - gy) - (x[0] - gx) * (y[2] - gy)) / area
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        pixel_depth = w0 * d[0] + w1 * d[1] + w2 * d[2]
        window = depth[lo_y:hi_y + 1, lo_x:hi_x + 1]
        nearer = inside & (pixel_depth < window)
        if not nearer.any():
            continue
        u = w0 * uv[face[0], 0] + w1 * uv[face[1], 0] + w2 * uv[face[2], 0]
        v = w0 * uv[face[0], 1] + w1 * uv[face[1], 1] + w2 * uv[face[2], 1]
        px = np.clip((u * tw).astype(int), 0, tw - 1)
        py = np.clip((v * th).astype(int), 0, th - 1)
        window[nearer] = pixel_depth[nearer]
        image[lo_y:hi_y + 1, lo_x:hi_x + 1][nearer] = texture[py, px][nearer]
    return image


def decimate(positions, uv, faces, target):
    """Quadric-error decimation down to the triangle budget.

    Vertex clustering was tried first and is not usable at this ratio: taking
    80,000 triangles to 5,000 tore holes in the roof, turned the log courses to
    mush and smeared the bench's green across the walls, because collapsing a
    cell averages UVs that belong to different parts of the sheet.

    Quadric collapse keeps the silhouette, and UVs are carried across from the
    nearest surviving original vertex rather than averaged.
    """
    if len(faces) <= target:
        return positions, faces
    import fast_simplification
    welded, inverse = np.unique(np.round(positions, 5), axis=0, return_inverse=True)
    welded_faces = inverse[faces]
    good = ((welded_faces[:, 0] != welded_faces[:, 1])
            & (welded_faces[:, 1] != welded_faces[:, 2])
            & (welded_faces[:, 0] != welded_faces[:, 2]))
    welded_faces = welded_faces[good].astype(np.int32)
    reduction = max(0.0, min(0.999, 1.0 - target / len(welded_faces)))
    new_positions, new_faces = fast_simplification.simplify(
        welded.astype(np.float32), welded_faces, reduction)
    new_positions = np.asarray(new_positions, dtype=np.float64)
    new_faces = np.asarray(new_faces, dtype=np.int64)

    return new_positions, new_faces


def roof_mask(positions, uv, faces, eave_y, texture_size):
    """Texels used by upward-facing geometry above the eave."""
    a, b, c = positions[faces[:, 0]], positions[faces[:, 1]], positions[faces[:, 2]]
    normals = np.cross(b - a, c - a)
    lengths = np.linalg.norm(normals, axis=1)
    lengths[lengths == 0] = 1
    normals = normals / lengths[:, None]
    height = positions[faces].mean(axis=1)[:, 1]
    selected = (np.abs(normals[:, 1]) > TUNING["roof_normal_up"]) & (height > eave_y)
    mask = np.zeros((texture_size, texture_size), dtype=bool)
    for face in faces[selected]:
        pixels = np.clip((uv[face] * texture_size).astype(int), 0, texture_size - 1)
        lo_x, hi_x = pixels[:, 0].min(), pixels[:, 0].max() + 1
        lo_y, hi_y = pixels[:, 1].min(), pixels[:, 1].max() + 1
        if (hi_x - lo_x) * (hi_y - lo_y) > texture_size * texture_size // 4:
            continue                       # a wrapped triangle; skip rather than fill
        mask[lo_y:hi_y, lo_x:hi_x] = True
    return mask, selected


def write_glb(path: Path, positions, normals, uv, faces, image_uri, name):
    buffer, views, accessors = bytearray(), [], []
    entries = []
    for data, kind, component in ((positions.astype(np.float32), "VEC3", 5126),
                                  (normals.astype(np.float32), "VEC3", 5126),
                                  (uv.astype(np.float32), "VEC2", 5126),
                                  (faces.astype(np.uint32).ravel(), "SCALAR", 5125)):
        raw = np.ascontiguousarray(data).tobytes()
        while len(buffer) % 4:
            buffer.append(0)
        views.append({"buffer": 0, "byteOffset": len(buffer), "byteLength": len(raw)})
        buffer.extend(raw)
        accessor = {"bufferView": len(views) - 1, "componentType": component,
                    "count": int(len(data)), "type": kind}
        if kind in ("VEC3", "VEC2"):
            accessor["min"] = [float(v) for v in data.min(axis=0)]
            accessor["max"] = [float(v) for v in data.max(axis=0)]
        accessors.append(accessor)
        entries.append(len(accessors) - 1)
    gltf = {
        "asset": {"version": "2.0", "generator": "import_mesh.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": entries[0], "NORMAL": entries[1],
                           "TEXCOORD_0": entries[2]},
            "indices": entries[3], "material": 0}]}],
        "materials": [{"name": name, "doubleSided": False,
                       "pbrMetallicRoughness": {"baseColorTexture": {"index": 0},
                                                "metallicFactor": 0.0,
                                                "roughnessFactor": 0.92}}],
        "textures": [{"source": 0, "sampler": 0}],
        "images": [{"uri": image_uri}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
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


def vertex_normals(positions, faces):
    a, b, c = positions[faces[:, 0]], positions[faces[:, 1]], positions[faces[:, 2]]
    face_normals = np.cross(b - a, c - a)
    normals = np.zeros_like(positions)
    for column in range(3):
        np.add.at(normals, faces[:, column], face_normals)
    lengths = np.linalg.norm(normals, axis=1)
    # A vertex whose faces cancel out leaves a zero normal, which is undefined
    # shading rather than a guarded divide. Point it up instead.
    degenerate = lengths < 1e-9
    normals[degenerate] = np.array([0.0, 1.0, 0.0])
    lengths[degenerate] = 1.0
    return normals / lengths[:, None]


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mesh", type=Path, required=True)
    parser.add_argument("--building", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    opt = parser.parse_args()

    slug = opt.building.name
    roof_doc = load(opt.building / "roof.json")
    manifest = load(opt.building / "elevations" / "elevations.json")
    geometry = load(opt.building / f"{slug}-geometry.json")
    reference = load(opt.building / "textured" / f"{slug}-roof.jpg.json") \
        if (opt.building / "textured" / f"{slug}-roof.jpg.json").is_file() else None

    doc = load(BUILDINGS)
    ring = Polygon([b for b in doc["buildings"]
                    if b.get("name") == roof_doc["building"]][0]["pts"])
    origin = geometry["localOriginWorld"]
    bearing = np.radians(manifest["frameBearingsDeg"][0])
    local = np.array([[x - origin[0], z - origin[1]] for x, z in ring.exterior.coords[:-1]])
    rotation = np.array([[np.cos(bearing), -np.sin(bearing)],
                         [np.sin(bearing), np.cos(bearing)]])
    oriented = local @ rotation
    extents = np.ptp(oriented, axis=0)
    target_long, target_short = float(extents.max()), float(extents.min())

    positions, uv, faces, texture = read_mesh(opt.mesh)
    keep, dropped = largest_part(positions, uv, faces)
    faces = faces[keep]
    if dropped:
        print(f"  dropped {len(dropped)} loose part(s), "
              f"{sum(n for n, _ in dropped)} tris, "
              f"{sum(s for _, s in dropped):.1%} of surface area")

    # Fit: the mesh's own long horizontal axis onto the measured long axis.
    span_x, span_z = float(np.ptp(positions[:, 0])), float(np.ptp(positions[:, 2]))
    if span_z >= span_x:
        long_axis, short_axis = 2, 0
        long_span, short_span = span_z, span_x
    else:
        long_axis, short_axis = 0, 2
        long_span, short_span = span_x, span_z
    scale_long = target_long / long_span
    scale_short = target_short / short_span
    face_area = areas(positions, faces)
    order = np.argsort(positions[faces].mean(axis=1)[:, 1])
    cumulative = np.cumsum(face_area[order]) / face_area.sum()
    ridge_local = float(positions[faces].mean(axis=1)[:, 1][
        order[np.searchsorted(cumulative, TUNING["ridge_area_percentile"] / 100)]])
    base_local = float(positions[:, 1].min())
    scale_y = roof_doc["ridgeAglM"] / max(ridge_local - base_local, 1e-6)
    print(f"  fit: long {long_span:.3f}->{target_long:.2f} m ({scale_long:.3f}), "
          f"short {short_span:.3f}->{target_short:.2f} m ({scale_short:.3f}), "
          f"height x{scale_y:.3f} to a {roof_doc['ridgeAglM']:.2f} m ridge")

    placed = np.zeros_like(positions)
    placed[:, 0] = (positions[:, short_axis] - positions[:, short_axis].mean()) * scale_short
    placed[:, 2] = (positions[:, long_axis] - positions[:, long_axis].mean()) * scale_long
    placed[:, 1] = (positions[:, 1] - base_local) * scale_y
    # Drop the ground ring below the terrain. The generated mesh stops dead at
    # its base, so on a slope it would stand clear of the ground on the low
    # side; the measured geometry carries the same skirt for that reason.
    placed[placed[:, 1] < TUNING["base_grip_m"], 1] = -TUNING["wall_skirt_m"]
    # Rotate from the building frame back into world-aligned local coordinates.
    back = np.array([[np.cos(-bearing), -np.sin(-bearing)],
                     [np.sin(-bearing), np.cos(-bearing)]])
    plan = placed[:, [0, 2]] @ back
    placed[:, 0], placed[:, 2] = plan[:, 0], plan[:, 1]

    size = TUNING["texture_px"]
    dense_texture = np.asarray(texture.resize((2048, 2048), Image.LANCZOS),
                               dtype=np.float64) / 255.0

    sys.path.insert(0, str(Path(__file__).parent))
    import apply_textures as AT
    specs = AT.specs_from(manifest)
    for spec in specs:
        spec["tile"] = size

    # Recolour the roof in the dense texture before baking, while its faces
    # still carry usable UVs. The generator gave the shakes a sky-blue cast.
    eave_local = base_local + (roof_doc["eaveAglM"] / max(scale_y, 1e-6))
    mask, _ = roof_mask(positions, uv, faces, eave_local, 2048)
    if mask.any():
        target_rgb = np.array([0.30, 0.285, 0.26])
        current = dense_texture[mask].mean(axis=0)
        gain = (target_rgb / target_rgb.mean()) / np.maximum(current / current.mean(), 1e-6)
        dense_texture[mask] = np.clip(dense_texture[mask] * gain, 0, 1)
        print(f"  roof recoloured: {mask.mean():.0%} of the sheet, "
              f"RGB {current.round(3)} -> {dense_texture[mask].mean(axis=0).round(3)}")

    up = np.cross(placed[faces[:, 1]] - placed[faces[:, 0]],
                  placed[faces[:, 2]] - placed[faces[:, 0]])
    lengths = np.linalg.norm(up, axis=1)
    lengths[lengths == 0] = 1
    face_up = np.abs(up[:, 1] / lengths)

    tiles = {}
    for spec in specs:
        selected = faces[face_up > TUNING["roof_normal_up"]] if spec["kind"] == "roof" \
            else faces[face_up <= TUNING["roof_normal_up"]]
        baked = bake_view(placed, uv, selected, dense_texture, spec, size)
        tiles[spec["id"]] = AT.calibrate(
            Image.fromarray((np.clip(baked, 0, 1) * 255 + 0.5).astype(np.uint8)))
    print(f"  baked {len(tiles)} views from the dense mesh through the stage 3 cameras")

    output = opt.output or opt.building / "imported"
    output.mkdir(parents=True, exist_ok=True)
    atlas = Image.new("RGB", (size * 2, size * 2))
    for view in AT.TUNING["wall_order"]:
        column, row = AT.TUNING["quadrants"][view]
        atlas.paste(tiles[view], (column * size, row * size))
    wall_name, roof_name = f"{slug}-mesh-wall.jpg", f"{slug}-mesh-roof.jpg"
    wall_blob, roof_blob = io.BytesIO(), io.BytesIO()
    atlas.save(wall_blob, "JPEG", quality=TUNING["jpeg_quality"], optimize=True)
    tiles["roof"].save(roof_blob, "JPEG", quality=TUNING["jpeg_quality"], optimize=True)
    (output / wall_name).write_bytes(wall_blob.getvalue())
    (output / roof_name).write_bytes(roof_blob.getvalue())
    texture_bytes = len(wall_blob.getvalue()) + len(roof_blob.getvalue())
    print(f"  textures {texture_bytes / 1024:.0f} KB of "
          f"{TUNING['max_texture_bytes'] / 1024:.0f} KB budget")

    failures = []
    report = []
    for lod in TUNING["lods"]:
        p_, f_ = decimate(placed, uv, faces, lod["max_triangles"])
        n_ = vertex_normals(p_, f_)
        up_ = np.abs(np.cross(p_[f_[:, 1]] - p_[f_[:, 0]], p_[f_[:, 2]] - p_[f_[:, 0]]))
        norm = np.linalg.norm(np.cross(p_[f_[:, 1]] - p_[f_[:, 0]],
                                       p_[f_[:, 2]] - p_[f_[:, 0]]), axis=1)
        norm[norm == 0] = 1
        is_roof = up_[:, 1] / norm > TUNING["roof_normal_up"]
        parts = []
        for name, selected, image_index in (("wall", ~is_roof, 0), ("roof", is_roof, 1)):
            chosen = f_[selected]
            if not len(chosen):
                continue
            used, remap = np.unique(chosen, return_inverse=True)
            sub_pos, sub_norm = p_[used], n_[used]
            sub_faces = remap.reshape(-1, 3)
            sub_uv = AT.uvs_for(sub_pos, sub_norm, sub_faces, name, specs, size)
            parts.append((name, sub_pos.astype(np.float32), sub_norm.astype(np.float32),
                          sub_uv, sub_faces.astype(np.uint32).ravel(), image_index))
        path = output / f"{slug}-{lod['name']}.glb"
        size_bytes = AT.write_glb(path, parts, [wall_name, roof_name])
        total = sum(len(part[4]) for part in parts) // 3
        report.append({"lod": lod["name"], "triangles": total, "bytes": size_bytes})
        print(f"  {lod['name'].upper()}: {total:5d} tris (budget {lod['max_triangles']}), "
              f"{len(parts)} primitives, {size_bytes / 1024:.0f} KB")
        if total > lod["max_triangles"]:
            failures.append(lod["name"])
    if texture_bytes > TUNING["max_texture_bytes"]:
        failures.append("texture budget")
    (output / "import.json").write_text(json.dumps({
        "building": roof_doc["building"], "source": str(opt.mesh),
        "fit": {"longM": target_long, "shortM": target_short,
                "ridgeAglM": roof_doc["ridgeAglM"]},
        "textureBytes": texture_bytes, "lods": report}, indent=2) + "\n", encoding="utf-8")
    if failures:
        print(f"\nFAIL over budget: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\nPlace at world {origin} in landmarks.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
