"""Wave-3 John Moulton cluster draft GLBs — split, oriented, runtime-placeable.

Rebuilds the barn and the pink house as separate GLB LOD sets, each in its own
local frame with the matched OSM/HABS orientation baked in, so each can be
placed at its own runtime world coordinate by preview-landmark.json. The outer
envelopes are reused from the documentary measurement file; the wave-2 omitted
house additions/dormer remain omitted (foundation+capture+performance pass).

Run:
  blender --background --python generate_draft.py -- --output-dir <candidate dir>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy


CANDIDATE_ID = "john_moulton"


def args_after_blender() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--measurements",
        type=Path,
        default=Path(__file__).with_name("measurements.documentary.json"),
    )
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def material(name: str, color: tuple[float, float, float, float]) -> bpy.types.Material:
    result = bpy.data.materials.new(name)
    result.diffuse_color = color
    result.use_nodes = True
    result.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
    result.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.88
    return result


def box(name, dimensions, location, mat, rotation_y=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location,
                                   rotation=(0.0, rotation_y, 0.0))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def profile_prism(name, profile, depth, offset, mat):
    ox, oy = offset
    vertices = [(ox + x, oy - depth / 2.0, z) for x, z in profile]
    vertices += [(ox + x, oy + depth / 2.0, z) for x, z in profile]
    count = len(profile)
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, 2 * count))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def roof_panel(name, start, end, depth, offset, mat):
    x1, z1 = start
    x2, z2 = end
    length = math.hypot(x2 - x1, z2 - z1)
    angle = -math.atan2(z2 - z1, x2 - x1)
    return box(name, (length + 0.08, depth + 0.28, 0.12),
               (offset[0] + (x1 + x2) / 2.0, offset[1], (z1 + z2) / 2.0 + 0.04),
               mat, angle)


def join_by_material():
    groups: dict[str, list] = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        key = obj.data.materials[0].name if obj.data.materials else "none"
        groups.setdefault(key, []).append(obj)
    for objects in groups.values():
        if len(objects) < 2:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()


def triangle_count():
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.data.calc_loop_triangles()
            total += len(obj.data.loop_triangles)
    return total


def value(data, *keys):
    node = data
    for key in keys:
        node = node[key]
    result = node["value"] if isinstance(node, dict) and "value" in node else node
    if not isinstance(result, (int, float)):
        raise ValueError(f"Required measurement {'.'.join(keys)} is unresolved")
    return float(result)


def build_barn(data, lod, mats):
    width = value(data, "structures", "barn", "plan", "overall_x_m")
    depth = value(data, "structures", "barn", "plan", "overall_y_m")
    core = value(data, "structures", "barn", "profile", "core_half_span_m")
    roof_break = value(data, "structures", "barn", "profile", "gambrel_break_half_span_m")
    shed = value(data, "structures", "barn", "profile", "shed_eave_height_m")
    eave = value(data, "structures", "barn", "profile", "core_eave_height_m")
    break_z = value(data, "structures", "barn", "profile", "gambrel_break_height_m")
    ridge = value(data, "structures", "barn", "profile", "ridge_height_m")
    half = width / 2.0
    profile = [
        (-half, 0.0), (-half, shed), (-core, eave), (-roof_break, break_z),
        (0.0, ridge), (roof_break, break_z), (core, eave), (half, shed), (half, 0.0),
    ]
    profile_prism("barn_envelope", profile, depth, (0.0, 0.0), mats["timber"])
    roof_points = [
        ((-half, shed), (-core, eave)),
        ((-core, eave), (-roof_break, break_z)),
        ((-roof_break, break_z), (0.0, ridge)),
        ((0.0, ridge), (roof_break, break_z)),
        ((roof_break, break_z), (core, eave)),
        ((core, eave), (half, shed)),
    ]
    for index, points in enumerate(roof_points):
        roof_panel(f"barn_roof_{index}", points[0], points[1], depth, (0.0, 0.0), mats["roof"])
    if lod == 0:
        box("barn_door", (2.15, 0.08, 2.55), (0.0, -depth / 2.0 - 0.045, 1.275), mats["door"])
        for x in (-5.6, 5.6):
            box("barn_side_door", (1.45, 0.08, 2.0), (x, -depth / 2.0 - 0.045, 1.0), mats["door"])


def build_house(data, lod, mats):
    width = value(data, "structures", "pink_house", "plan", "overall_x_m")
    depth = value(data, "structures", "pink_house", "plan", "overall_y_m")
    eave = value(data, "structures", "pink_house", "profile", "eave_height_m")
    ridge = value(data, "structures", "pink_house", "profile", "ridge_height_m")
    half = width / 2.0
    profile_prism(
        "house_envelope",
        [(-half, 0.0), (-half, eave), (0.0, ridge), (half, eave), (half, 0.0)],
        depth, (0.0, 0.0), mats["stucco"],
    )
    roof_panel("house_roof_left", (-half, eave), (0.0, ridge), depth, (0.0, 0.0), mats["roof"])
    roof_panel("house_roof_right", (0.0, ridge), (half, eave), depth, (0.0, 0.0), mats["roof"])
    if lod == 0:
        face_y = -depth / 2.0 - 0.045
        box("house_door", (1.05, 0.08, 2.15), (0.0, face_y, 1.075), mats["trim"])
        for x in (-2.5, 2.5):
            box("house_window", (1.1, 0.08, 1.25), (x, face_y, 1.55), mats["trim"])
        box("house_upper_window", (0.9, 0.08, 1.05), (0.0, face_y, 4.25), mats["trim"])


def build_and_export(data, structure, lod, bearing_deg, limit, output_dir, stem):
    reset_scene()
    mats = {
        "timber": material("weathered_timber", (0.28, 0.17, 0.08, 1.0)),
        "roof": material("weathered_roof", (0.12, 0.10, 0.075, 1.0)),
        "door": material("weathered_door", (0.19, 0.105, 0.045, 1.0)),
        "stucco": material("muted_pink_stucco", (0.55, 0.31, 0.28, 1.0)),
        "trim": material("historic_green_trim", (0.12, 0.24, 0.13, 1.0)),
    }
    if structure == "barn":
        build_barn(data, lod, mats)
    else:
        build_house(data, lod, mats)
    join_by_material()
    triangles = triangle_count()
    if triangles > limit:
        raise RuntimeError(f"{stem} LOD{lod}: {triangles} triangles > allocation {limit}")
    # Bake orientation: rotate the local frame around Z (Blender up) so the
    # facade faces the documented public approach in the runtime world.
    rotation = math.radians(270.0 - bearing_deg)
    for obj in bpy.context.scene.objects:
        obj.rotation_euler.z = rotation
    output = output_dir / f"{stem}-lod{lod}.glb"
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB",
                              use_selection=False, export_apply=True,
                              export_materials="EXPORT", export_yup=True)
    primitive_count = sum(1 for o in bpy.context.scene.objects if o.type == "MESH")
    return {
        "id": f"lod{lod}",
        "structure": structure,
        "file": output.name,
        "stem": stem,
        "bearing_deg_true_north": bearing_deg,
        "triangles": triangles,
        "triangle_allocation": limit,
        "material_primitives": primitive_count,
        "bytes": output.stat().st_size,
        "sha256": sha256(output),
    }


def main():
    args = args_after_blender()
    measurements = json.loads(args.measurements.read_text(encoding="utf-8"))
    if measurements.get("candidate_id") != CANDIDATE_ID:
        raise ValueError("Measurement file belongs to another candidate")
    if not measurements.get("required_structures_buildable"):
        raise ValueError("Required documentary envelopes are unresolved; refusing generation")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    # Barn orientation from the matched OSM way 306529655 (placement-retry.json).
    # House orientation estimated from the Mormon Row Road alignment (N-S), marked
    # explicit_estimate; within the 5-degree tolerance of the candidate contract.
    barn_bearing = 0.35
    house_bearing = 0.0
    allocations = {"barn": (4200, 1000, 240), "pink_house": (2800, 700, 170)}
    report = {
        "schema_version": 1,
        "candidate_id": CANDIDATE_ID,
        "wave": 3,
        "status": "runtime_placeable_documentary_draft",
        "measurements_sha256": sha256(args.measurements),
        "draft_space_only": False,
        "structures": [
            {
                "id": "barn",
                "stem": "john-moulton-barn",
                "bearing_deg_true_north": barn_bearing,
                "bearing_method": "osm_way_match",
            },
            {
                "id": "pink_house",
                "stem": "john-moulton-house",
                "bearing_deg_true_north": house_bearing,
                "bearing_method": "explicit_estimate",
                "note": "N-S aligned with Mormon Row Road; additions and dormer omitted per wave-2 unresolved blockers.",
            },
        ],
        "omitted": ["house additions and dormer details", "minor building cluster"],
        "lods": [],
    }
    for structure, stem, bearing in (("barn", "john-moulton-barn", barn_bearing),
                                    ("pink_house", "john-moulton-house", house_bearing)):
        for lod in range(3):
            lod_lods = build_and_export(
                measurements, structure, lod, bearing,
                allocations[structure][lod], args.output_dir, stem,
            )
            report["lods"].append(lod_lods)
    (args.output_dir / "generation-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()