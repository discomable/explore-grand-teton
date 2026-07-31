#!/usr/bin/env python3
"""Place a generated mesh on a named footprint, with no LiDAR stage.

    python3 place_mesh.py --mesh model.glb --building "John Moulton Barn"

Option B of the mesh route. Where import_mesh.py rides on the measured
pipeline -- roof.json, the elevation cameras, the geometry origin -- this needs
only the named footprint in buildings.json. The mesh supplies the shape; the
footprint supplies position, orientation and horizontal size; the camera frame
is derived from the footprint the same way stage 3 derives it.

Use this when a building has no measured stages, or when its roof is a form the
plane segmenter was not built for -- a gambrel barn being the case in hand. The
mesh already is the gambrel, so there is nothing for LiDAR to add.

Fit is uniform by default: one scale factor from the long axis, so the mesh
keeps its proportions and its height falls out of them. --fit footprint scales
each axis independently to fill the plot and hit --ridge-m, at the cost of
stretching the shape.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import Polygon

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import import_mesh as IM            # noqa: E402
import render_elevations as RE      # noqa: E402
import apply_textures as AT         # noqa: E402

TUNING_RIDGE_BAND = 0.15   # top fraction of height used to find the ridge axis
REPO = Path(__file__).resolve().parents[4]
BUILDINGS = REPO / "terrain/public/buildings.json"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def footprint(name: str):
    doc = load(BUILDINGS)
    matches = [b for b in doc["buildings"] if (b.get("name") or "") == name]
    if not matches:
        raise SystemExit(f"No footprint named {name!r} in buildings.json. Name it first.")
    ring = Polygon(matches[0]["pts"])
    return ring if ring.is_valid else ring.buffer(0)


def oriented_extents(local_ring, bearing):
    """Long and short footprint extent in the building's own frame."""
    rotation = np.array([[np.cos(bearing), -np.sin(bearing)],
                         [np.sin(bearing), np.cos(bearing)]])
    pts = np.array(local_ring.exterior.coords[:-1]) @ rotation
    extents = np.ptp(pts, axis=0)
    return float(extents.max()), float(extents.min())


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mesh", type=Path, required=True)
    parser.add_argument("--building", required=True, help="exact name in buildings.json")
    parser.add_argument("--output", type=Path, help="default: work/hero/<slug>/placed")
    parser.add_argument("--fit", choices=["uniform", "footprint"], default="footprint")
    parser.add_argument("--ridge-m", type=float, default=0.0,
                        help="ridge height AGL; 0 = proportionate to the horizontal fit")
    parser.add_argument("--slug", help="output basename (default: from the name)")
    opt = parser.parse_args()

    slug = opt.slug or opt.building.lower().replace(" ", "-").replace(".", "")
    ring = footprint(opt.building)
    origin = (ring.centroid.x, ring.centroid.y)
    local_ring = Polygon([(x - origin[0], z - origin[1]) for x, z in ring.exterior.coords])
    bearing = np.radians(RE.building_frame(local_ring)[0])
    target_long, target_short = oriented_extents(local_ring, bearing)

    positions, uv, faces, texture = IM.read_mesh(opt.mesh)
    keep, dropped = IM.largest_part(positions, uv, faces)
    faces = faces[keep]
    if dropped:
        print(f"  dropped {len(dropped)} detached part(s), "
              f"{sum(n for n, _ in dropped)} tris")

    # Choose which mesh axis maps to the footprint's long axis by whichever
    # assignment fits most uniformly. Guessing the ridge direction and forcing
    # it onto the long axis was the mistake that deformed the barn: for a mesh
    # ~1.9 wide by ~0.95 deep it demanded a x19.8 stretch on one axis, when the
    # other assignment scales x9.95 by x13.0 -- nearly uniform, no deformation.
    span = {0: float(np.ptp(positions[:, 0])), 2: float(np.ptp(positions[:, 2]))}
    base_local = float(positions[:, 1].min())
    mesh_height = float(np.ptp(positions[:, 1]))

    def anisotropy(long_ax, short_ax):
        s = (target_long / span[long_ax], target_short / span[short_ax])
        return max(s) / min(s), s

    (aniso_a, _), (aniso_b, _) = anisotropy(0, 2), anisotropy(2, 0)
    long_axis, short_axis = (0, 2) if aniso_a <= aniso_b else (2, 0)
    _, (scale_long_fp, scale_short_fp) = anisotropy(long_axis, short_axis)

    if opt.fit == "uniform":
        scale_long = scale_short = scale_y = min(scale_long_fp, scale_short_fp)
        ridge = mesh_height * scale_y
        print(f"  uniform fit x{scale_y:.3f} (ridge {ridge:.2f} m); "
              f"fills {span[long_axis] * scale_y:.1f}/{target_long:.1f} m long, "
              f"{span[short_axis] * scale_y:.1f}/{target_short:.1f} m short")
    else:
        scale_long, scale_short = scale_long_fp, scale_short_fp
        # Height by the geometric mean of the horizontal scales, so the barn is
        # neither stretched tall nor squashed. --ridge-m overrides.
        scale_y = (opt.ridge_m / mesh_height if opt.ridge_m
                   else float(np.sqrt(scale_long * scale_short)))
        ridge = mesh_height * scale_y
        print(f"  footprint fit: long x{scale_long:.3f}, short x{scale_short:.3f} "
              f"({min(scale_long, scale_short) / max(scale_long, scale_short):.2f}:1), "
              f"ridge {ridge:.2f} m")

    # Lay the ridge on world +Z, the gable width on world X, then rotate so the
    # ridge points along the footprint's actual long-axis direction. Rotating by
    # a wall bearing instead double-counts the axis assignment and lands the barn
    # 90 degrees out on an axis-aligned footprint.
    placed = np.zeros_like(positions)
    placed[:, 0] = (positions[:, short_axis] - positions[:, short_axis].mean()) * scale_short
    placed[:, 2] = (positions[:, long_axis] - positions[:, long_axis].mean()) * scale_long
    placed[:, 1] = (positions[:, 1] - base_local) * scale_y
    coords = np.array(local_ring.exterior.coords[:-1])
    edges = np.roll(coords, -1, axis=0) - coords
    longest = edges[int(np.argmax(np.hypot(edges[:, 0], edges[:, 1])))]
    theta_long = np.arctan2(longest[1], longest[0])       # long-edge direction in (x, z)
    rot = theta_long - np.pi / 2                            # ridge sits on +Z (pi/2) now
    back = np.array([[np.cos(rot), -np.sin(rot)], [np.sin(rot), np.cos(rot)]])
    plan = placed[:, [0, 2]] @ back
    placed[:, 0], placed[:, 2] = plan[:, 0], plan[:, 1]
    placed[placed[:, 1] < IM.TUNING["base_grip_m"], 1] = -IM.TUNING["wall_skirt_m"]

    # Cameras from the footprint, exactly as stage 3 builds them, but sized to
    # this mesh's placed extent rather than a measured GLB's.
    specs = RE.build_views(RE.building_frame(local_ring), placed)
    size = RE.TUNING["tile_px"]
    for spec in specs:
        spec["tile"] = size

    dense_texture = np.asarray(texture.resize((2048, 2048), Image.LANCZOS),
                               dtype=np.float64) / 255.0
    up = np.cross(placed[faces[:, 1]] - placed[faces[:, 0]],
                  placed[faces[:, 2]] - placed[faces[:, 0]])
    length = np.linalg.norm(up, axis=1)
    length[length == 0] = 1
    face_up = np.abs(up[:, 1] / length)

    tiles = {}
    for spec in specs:
        selected = (faces[face_up > IM.TUNING["roof_normal_up"]] if spec["kind"] == "roof"
                    else faces[face_up <= IM.TUNING["roof_normal_up"]])
        baked = IM.bake_view(placed, uv, selected, dense_texture, spec, size)
        tiles[spec["id"]] = AT.calibrate(
            Image.fromarray((np.clip(baked, 0, 1) * 255 + 0.5).astype(np.uint8)))
    print(f"  baked {len(tiles)} views from the mesh through the footprint cameras")

    output = opt.output or REPO / "terrain/pipeline/work/hero" / slug / "placed"
    output.mkdir(parents=True, exist_ok=True)
    atlas = Image.new("RGB", (size * 2, size * 2))
    for view in AT.TUNING["wall_order"]:
        column, row = AT.TUNING["quadrants"][view]
        atlas.paste(tiles[view], (column * size, row * size))
    # The re-baked atlas only serves LOD1/LOD2, seen past 90 m, so it is shipped
    # at half resolution -- the sharp close view comes from the base texture
    # below. UVs are normalised, so downscaling the image changes nothing else.
    wall_name, roof_name = f"{slug}-wall.jpg", f"{slug}-roof.jpg"
    wall_blob, roof_blob = io.BytesIO(), io.BytesIO()
    atlas.resize((size, size), Image.LANCZOS).save(
        wall_blob, "JPEG", quality=IM.TUNING["jpeg_quality"], optimize=True)
    tiles["roof"].resize((size // 2, size // 2), Image.LANCZOS).save(
        roof_blob, "JPEG", quality=IM.TUNING["jpeg_quality"], optimize=True)
    (output / wall_name).write_bytes(wall_blob.getvalue())
    (output / roof_name).write_bytes(roof_blob.getvalue())
    # A LOD that is not decimated keeps the mesh's own UVs, so it can use the
    # original texture directly. The re-bake exists only because decimation
    # destroys UVs; running it on an undecimated LOD would halve the per-wall
    # resolution and add projection seams for nothing. Albedo-normalise the
    # original -- keep its hue and its UVs -- for the close view.
    base_arr = np.asarray(texture, dtype=np.float64) / 255.0
    base_mask = base_arr.max(axis=2) > 0.15
    base_arr = np.where(base_mask[..., None], AT.as_albedo(base_arr, base_mask), base_arr)
    base_name = f"{slug}-base.jpg"
    base_blob = io.BytesIO()
    Image.fromarray((np.clip(base_arr, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
        base_blob, "JPEG", quality=IM.TUNING["jpeg_quality"], optimize=True)
    (output / base_name).write_bytes(base_blob.getvalue())
    texture_bytes = len(wall_blob.getvalue()) + len(roof_blob.getvalue()) + len(base_blob.getvalue())
    print(f"  textures {texture_bytes / 1024:.0f} KB of "
          f"{IM.TUNING['max_texture_bytes'] / 1024:.0f} KB budget "
          f"(base {len(base_blob.getvalue()) // 1024} + atlas {len(wall_blob.getvalue()) // 1024} "
          f"+ roof {len(roof_blob.getvalue()) // 1024})")

    failures, report = [], []
    for lod in IM.TUNING["lods"]:
        path = output / f"{slug}-{lod['name']}.glb"
        if len(faces) <= lod["max_triangles"]:
            # Undecimated: original UVs and texture, one sharp material. A
            # distinct material name keeps the runtime from sharing this texture
            # with the decimated LODs' atlas.
            normals = IM.vertex_normals(placed, faces)
            parts = [("mesh_full", placed.astype(np.float32), normals.astype(np.float32),
                      uv.astype(np.float32), faces.astype(np.uint32).ravel(), 0)]
            size_bytes = AT.write_glb(path, parts, [base_name])
            total = len(faces)
        else:
            p_, f_ = IM.decimate(placed, uv, faces, lod["max_triangles"])
            n_ = IM.vertex_normals(p_, f_)
            edge = np.cross(p_[f_[:, 1]] - p_[f_[:, 0]], p_[f_[:, 2]] - p_[f_[:, 0]])
            norm = np.linalg.norm(edge, axis=1)
            norm[norm == 0] = 1
            is_roof = edge[:, 1] / norm > IM.TUNING["roof_normal_up"]
            parts = []
            for name, selected, image_index in (("wall", ~is_roof, 0), ("roof", is_roof, 1)):
                chosen = f_[selected]
                if not len(chosen):
                    continue
                used, remap = np.unique(chosen, return_inverse=True)
                sub_uv = AT.uvs_for(p_[used], n_[used], remap.reshape(-1, 3), name, specs, size)
                parts.append((name, p_[used].astype(np.float32), n_[used].astype(np.float32),
                              sub_uv, remap.reshape(-1, 3).astype(np.uint32).ravel(), image_index))
            size_bytes = AT.write_glb(path, parts, [wall_name, roof_name])
            total = sum(len(part[4]) for part in parts) // 3
        report.append({"lod": lod["name"], "triangles": total, "bytes": size_bytes})
        print(f"  {lod['name'].upper()}: {total:5d} tris "
              f"({'original UVs' if len(faces) <= lod['max_triangles'] else 're-baked'}), "
              f"{size_bytes / 1024:.0f} KB")
        if total > lod["max_triangles"]:
            failures.append(lod["name"])
    if texture_bytes > IM.TUNING["max_texture_bytes"]:
        failures.append("texture budget")

    (output / "place.json").write_text(json.dumps({
        "building": opt.building, "source": str(opt.mesh), "fit": opt.fit,
        "localOriginWorld": [round(origin[0], 3), round(origin[1], 3)],
        "ridgeM": round(ridge, 3), "textureBytes": texture_bytes, "lods": report,
    }, indent=2) + "\n", encoding="utf-8")
    if failures:
        print(f"\nFAIL over budget: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\nPlace at world [{origin[0]:.1f}, {origin[1]:.1f}] in landmarks.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
