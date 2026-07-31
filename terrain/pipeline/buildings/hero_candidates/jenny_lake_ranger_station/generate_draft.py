#!/usr/bin/env python3
"""Generate deterministic Jenny Lake Ranger Station draft LODs with Blender.

Geometry is based on HABS WY-108. This generator deliberately omits the nearby
Crandall Studio visitor center and the separate James/Jimmy Manges Cabin.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import mathutils


def arguments():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for value in list(collection):
            if value.users == 0:
                collection.remove(value)


def material(name, color, roughness=0.9, metallic=0.0):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return value


def assign(obj, value):
    obj.data.materials.append(value)
    return obj


def box(name, size, location, value, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign(obj, value)


def beam_between(name, start, end, thickness, value):
    sx, sy, sz = start
    ex, ey, ez = end
    dx, dy, dz = ex - sx, ey - sy, ez - sz
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    midpoint = ((sx + ex) / 2, (sy + ey) / 2, (sz + ez) / 2)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=midpoint)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (length, thickness, thickness)
    obj.rotation_euler[1] = -math.atan2(dz, math.sqrt(dx * dx + dy * dy))
    obj.rotation_euler[2] = math.atan2(dy, dx)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign(obj, value)


def gable_end(name, x, length_sign, width, wall_height, ridge_height, thickness, value):
    half = width / 2
    inner_x = x - length_sign * thickness
    verts = [
        (x, -half, wall_height),
        (x, half, wall_height),
        (x, 0.0, ridge_height),
        (inner_x, -half, wall_height),
        (inner_x, half, wall_height),
        (inner_x, 0.0, ridge_height),
    ]
    faces = [
        (0, 1, 2),
        (5, 4, 3),
        (0, 3, 4, 1),
        (1, 4, 5, 2),
        (2, 5, 3, 0),
    ]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return assign(obj, value)


def panel_x(name, x, y, z, width, height, value):
    return box(name, (0.045, width, height), (x, y, z), value)


def panel_y(name, x, y, z, width, height, value):
    return box(name, (width, 0.045, height), (x, y, z), value)


def add_primary_shell(parts, dims, mats, lod):
    length = dims["length"]
    width = dims["width"]
    wall_height = dims["wall_height"]
    ridge_height = dims["ridge_height"]
    wall = mats["wall"]
    roof = mats["roof"]

    if lod == 0:
        courses = 14
        course_height = wall_height / courses
        for index in range(courses):
            z = course_height * (index + 0.5)
            parts["wall"].append(box(
                f"north_log_{index:02d}",
                (length + 0.28, 0.19, course_height * 0.88),
                (0.0, width / 2, z),
                wall,
            ))
            parts["wall"].append(box(
                f"south_log_{index:02d}",
                (length + 0.28, 0.19, course_height * 0.88),
                (0.0, -width / 2, z),
                wall,
            ))
            parts["wall"].append(box(
                f"east_log_{index:02d}",
                (0.19, width + 0.28, course_height * 0.88),
                (length / 2, 0.0, z),
                wall,
            ))
            parts["wall"].append(box(
                f"west_log_{index:02d}",
                (0.19, width + 0.28, course_height * 0.88),
                (-length / 2, 0.0, z),
                wall,
            ))
    else:
        parts["wall"].append(box(
            "wall_mass",
            (length, width, wall_height),
            (0.0, 0.0, wall_height / 2),
            wall,
        ))

    parts["wall"].append(gable_end(
        "west_gable", -length / 2, -1, width, wall_height, ridge_height, 0.18, wall))
    parts["wall"].append(gable_end(
        "east_gable", length / 2, 1, width, wall_height, ridge_height, 0.18, wall))

    run = width / 2 + dims["roof_overhang"]
    rise = ridge_height - wall_height + dims["roof_overhang"]
    pitch = math.atan2(rise, run)
    slope_length = math.sqrt(run * run + rise * rise)
    roof_length = length + 2 * dims["roof_overhang"]
    thickness = 0.12 if lod == 0 else 0.16
    parts["roof"].append(box(
        "north_roof",
        (roof_length, slope_length, thickness),
        (0.0, run / 2, wall_height + rise / 2),
        roof,
        rotation=(-pitch, 0.0, 0.0),
    ))
    parts["roof"].append(box(
        "south_roof",
        (roof_length, slope_length, thickness),
        (0.0, -run / 2, wall_height + rise / 2),
        roof,
        rotation=(pitch, 0.0, 0.0),
    ))


def add_porch(parts, dims, mats, lod):
    length = dims["length"]
    porch_depth = dims["porch_depth"]
    porch_width = dims["porch_width"]
    wall_height = dims["wall_height"]
    wall = mats["wall"]
    roof = mats["roof"]
    x_outer = -length / 2 - porch_depth
    x_center = -length / 2 - porch_depth / 2

    parts["wall"].append(box(
        "porch_deck", (porch_depth, porch_width, 0.16),
        (x_center, 0.0, 0.22), wall))
    parts["wall"].append(box(
        "porch_step", (0.48, 1.3, 0.14),
        (x_outer - 0.24, 0.0, 0.07), wall))

    outer_height = 2.18
    inner_height = wall_height + 0.16
    if lod < 2:
        for y in (-porch_width / 2 + 0.18, porch_width / 2 - 0.18):
            parts["wall"].append(box(
                f"porch_post_{y:+.2f}", (0.16, 0.16, outer_height),
                (x_outer + 0.12, y, outer_height / 2), wall))
        canopy_length = math.sqrt(
            porch_depth * porch_depth + (inner_height - outer_height) ** 2)
        angle = math.atan2(inner_height - outer_height, porch_depth)
        parts["roof"].append(box(
            "porch_canopy",
            (canopy_length + 0.28, porch_width + 0.35, 0.11),
            (x_center, 0.0, (inner_height + outer_height) / 2),
            roof,
            rotation=(0.0, -angle, 0.0),
        ))
    else:
        parts["roof"].append(box(
            "porch_canopy_lod2",
            (porch_depth + 0.2, porch_width + 0.25, 0.15),
            (x_center, 0.0, 2.35),
            roof,
            rotation=(0.0, -0.15, 0.0),
        ))


def add_openings(parts, dims, mats, lod):
    if lod == 2:
        return
    length = dims["length"]
    width = dims["width"]
    wall_height = dims["wall_height"]
    detail = mats["detail"]
    x_west = -length / 2 - 0.102
    x_east = length / 2 + 0.102
    y_north = width / 2 + 0.102
    y_south = -width / 2 - 0.102

    window_width = 1.05 if lod == 0 else 0.92
    window_height = 0.92 if lod == 0 else 0.82
    window_z = 1.38
    door_width = 0.92
    door_height = 1.93
    panel_x("west_window", x_west, -1.3, window_z, window_width, window_height, detail)
    panel_x("west_door", x_west, 1.05, door_height / 2 + 0.12,
            door_width, door_height, detail)
    panel_x("east_window", x_east, -1.12, window_z, window_width, window_height, detail)
    panel_x("east_door", x_east, 1.12, door_height / 2 + 0.08,
            door_width, door_height, detail)
    if lod == 0:
        panel_x("east_gable_window", x_east, 0.0, wall_height + 0.78,
                0.62, 0.52, detail)
    for index, x in enumerate((-3.55, -0.25, 3.2)):
        panel_y(f"north_window_{index}", x, y_north, window_z,
                window_width, window_height, detail)
    for index, x in enumerate((-2.55, 2.35)):
        panel_y(f"south_window_{index}", x, y_south, window_z,
                window_width, window_height, detail)
    parts["detail"].extend([
        obj for obj in bpy.context.collection.objects
        if obj.name.startswith(("west_", "east_", "north_window", "south_window"))
        and obj not in parts["detail"]
        and obj not in parts["wall"]
        and obj not in parts["roof"]
    ])


def add_close_details(parts, dims, mats):
    length = dims["length"]
    width = dims["width"]
    wall_height = dims["wall_height"]
    detail = mats["detail"]
    stone = mats["stone"]
    x_west = -length / 2 - 0.13

    parts["detail"].append(beam_between(
        "west_gable_left_brace",
        (x_west, -2.0, wall_height + 0.12),
        (x_west, 0.0, wall_height + 1.65),
        0.11,
        detail,
    ))
    parts["detail"].append(beam_between(
        "west_gable_right_brace",
        (x_west, 2.0, wall_height + 0.12),
        (x_west, 0.0, wall_height + 1.65),
        0.11,
        detail,
    ))
    parts["detail"].append(box(
        "west_gable_king_post", (0.11, 0.11, 1.55),
        (x_west, 0.0, wall_height + 0.9), detail))

    stone_positions = (
        (-4.8, -width / 2), (-2.8, -width / 2), (0.2, -width / 2),
        (3.8, -width / 2), (4.9, width / 2), (1.9, width / 2),
        (-1.4, width / 2), (-4.3, width / 2),
    )
    for index, (x, y) in enumerate(stone_positions):
        parts["stone"].append(box(
            f"foundation_stone_{index:02d}",
            (0.62 + (index % 3) * 0.08, 0.34, 0.24 + (index % 2) * 0.05),
            (x, y, 0.02),
            stone,
            rotation=(0.0, 0.0, (index % 4 - 1.5) * 0.08),
        ))


def join_group(objects, name):
    objects = [obj for obj in objects if obj and obj.name in bpy.context.view_layer.objects]
    if not objects:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    return joined


def metrics(objects):
    triangles = 0
    for obj in objects:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    return {
        "triangles": triangles,
        "material_primitives": len(objects),
        "mesh_objects": len(objects),
    }


def render_geometry_review(output_dir):
    review_dir = output_dir.parent / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    ground_material = material("review_ground", (0.16, 0.19, 0.14))
    box("review_ground", (28.0, 28.0, 0.12), (0.0, 0.0, -0.16), ground_material)

    bpy.ops.object.camera_add(location=(-15.5, -13.5, 8.8))
    camera = bpy.context.object
    camera.name = "review_camera"
    direction = mathutils.Vector((0.0, 0.0, 2.0)) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 53
    bpy.context.scene.camera = camera

    bpy.ops.object.light_add(type="SUN", location=(-8.0, -6.0, 12.0))
    sun = bpy.context.object
    sun.rotation_euler = (math.radians(32), 0.0, math.radians(-35))
    sun.data.energy = 2.0
    bpy.ops.object.light_add(type="AREA", location=(-7.0, -8.0, 10.0))
    area = bpy.context.object
    area.data.energy = 750
    area.data.shape = "DISK"
    area.data.size = 8.0
    area.rotation_euler = (
        math.radians(24), 0.0, math.radians(-38))

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(review_dir / "geometry-lod0.png")
    scene.world.color = (0.34, 0.4, 0.47)
    bpy.ops.render.render(write_still=True)


def build_lod(lod, measurements, output_dir):
    clear_scene()
    documented = measurements["documented"]
    dims = {
        "length": documented["wall_envelope"]["length"],
        "width": documented["wall_envelope"]["width"],
        "wall_height": documented["vertical"]["ceiling_line_above_floor"],
        "ridge_height": documented["vertical"]["ridge_above_floor"],
        "roof_overhang": documented["roof"]["overhang"],
        "porch_depth": documented["porch"]["depth_estimate"],
        "porch_width": documented["porch"]["width_estimate"],
    }

    mats = {
        "wall": material("weathered_saddle_log", (0.27, 0.18, 0.105)),
        "roof": material("weathered_wood_shingle", (0.115, 0.105, 0.09)),
    }
    if lod < 2:
        mats["detail"] = material("openings_and_dark_timber", (0.075, 0.085, 0.08))
    if lod == 0:
        mats["stone"] = material("buried_foundation_stone", (0.105, 0.095, 0.08))

    parts = {"wall": [], "roof": [], "detail": [], "stone": []}
    add_primary_shell(parts, dims, mats, lod)
    add_porch(parts, dims, mats, lod)
    if lod < 2:
        add_openings(parts, dims, mats, lod)
    if lod == 0:
        add_close_details(parts, dims, mats)
    elif lod == 1:
        parts["wall"].append(box(
            "foundation_mass", (dims["length"] + 0.15, dims["width"] + 0.12, 0.18),
            (0.0, 0.0, 0.03), mats["wall"]))

    joined = []
    for group in ("wall", "roof", "detail", "stone"):
        obj = join_group(parts[group], f"ranger_station_lod{lod}_{group}")
        if obj:
            joined.append(obj)
    for obj in joined:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = joined[0]

    output = output_dir / f"jenny-lake-ranger-station-lod{lod}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
    )
    value = metrics(joined)
    value["path"] = output.as_posix()
    value["bytes"] = output.stat().st_size
    if lod == 0:
        render_geometry_review(output_dir)
    return value


def main():
    args = arguments()
    measurements = json.loads(args.measurements.read_text(encoding="utf-8"))
    if measurements["candidate_id"] != "jenny_lake_ranger_station":
        raise ValueError("measurements belong to a different candidate")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    results = {
        "schemaVersion": 1,
        "candidateId": "jenny_lake_ranger_station",
        "generator": Path(__file__).as_posix(),
        "blenderVersion": ".".join(str(value) for value in bpy.app.version),
        "lods": {
            f"LOD{lod}": build_lod(lod, measurements, args.output_dir)
            for lod in (0, 1, 2)
        },
    }
    metrics_path = args.output_dir.parent / "geometry-metrics.json"
    metrics_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
