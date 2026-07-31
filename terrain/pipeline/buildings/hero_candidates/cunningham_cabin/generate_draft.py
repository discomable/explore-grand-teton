#!/usr/bin/env python3
"""Deterministically generate documentary Cunningham Cabin draft LODs in Blender."""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy


HERE = Path(__file__).resolve().parent
DEFAULT_MEASUREMENTS = HERE / "documentary-measurements.json"


def args():
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", type=Path, default=DEFAULT_MEASUREMENTS)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(values)


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        if datablocks is bpy.data.materials:
            continue
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def material(name, color, roughness=0.9):
    value = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return value


def cube(name, location, scale, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def prism(name, vertices, faces, mat):
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def cylinder(name, center, radius, length, axis, mat, vertices=8):
    rotation = (0, math.pi / 2, 0) if axis == "x" else (math.pi / 2, 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=length, location=center, rotation=rotation
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def join_by_material():
    groups = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH" or not obj.data.materials:
            continue
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = name


def wall_with_window(x0, x1, y, outward, height, window, backing):
    thickness = 0.08
    wx0, wx1, wz0, wz1 = window
    pieces = [
        ((x0 + wx0) / 2, wx0 - x0, height / 2, height),
        ((wx1 + x1) / 2, x1 - wx1, height / 2, height),
        ((wx0 + wx1) / 2, wx1 - wx0, wz0 / 2, wz0),
        ((wx0 + wx1) / 2, wx1 - wx0, (wz1 + height) / 2, height - wz1),
    ]
    for index, (x, width, z, piece_height) in enumerate(pieces):
        if width > 0.01 and piece_height > 0.01:
            cube(
                f"Wall_{outward}_{index}",
                (x, y, z),
                (width, thickness, piece_height),
                backing,
            )


def inner_wall_with_door(x, y0, y1, height, backing):
    thickness = 0.08
    door_width = 0.82
    door_height = 1.6256
    door_center = -0.18
    dy0, dy1 = door_center - door_width / 2, door_center + door_width / 2
    pieces = [
        ((y0 + dy0) / 2, dy0 - y0, height / 2, height),
        ((dy1 + y1) / 2, y1 - dy1, height / 2, height),
        ((dy0 + dy1) / 2, dy1 - dy0, (door_height + height) / 2, height - door_height),
    ]
    for index, (y, depth, z, piece_height) in enumerate(pieces):
        if depth > 0.01 and piece_height > 0.01:
            cube(f"InnerWall_{index}", (x, y, z), (thickness, depth, piece_height), backing)


def log_wall_x(x0, x1, y, window, height, wood, prefix):
    radius = 0.105
    for course, z in enumerate([0.12 + 0.205 * value for value in range(8)]):
        segments = [(x0, x1)]
        wx0, wx1, wz0, wz1 = window
        if wz0 - radius < z < wz1 + radius:
            segments = [(x0, wx0), (wx1, x1)]
        for segment, (start, end) in enumerate(segments):
            if end - start > 0.12:
                cylinder(
                    f"{prefix}_{course}_{segment}",
                    ((start + end) / 2, y, z),
                    radius,
                    end - start + 0.08,
                    "x",
                    wood,
                )


def log_wall_y(x, y0, y1, height, wood, prefix, door=False):
    radius = 0.105
    door_width = 0.82
    door_center = -0.18
    for course, z in enumerate([0.12 + 0.205 * value for value in range(8)]):
        segments = [(y0, y1)]
        if door and z < 1.6256 + radius:
            segments = [(y0, door_center - door_width / 2), (door_center + door_width / 2, y1)]
        for segment, (start, end) in enumerate(segments):
            if end - start > 0.12:
                cylinder(
                    f"{prefix}_{course}_{segment}",
                    (x, (start + end) / 2, z),
                    radius,
                    end - start + 0.08,
                    "y",
                    wood,
                )


def gable_logs(x, depth, wall_height, ridge_height, wood, prefix):
    half = depth / 2
    for index, z in enumerate([wall_height + 0.17, wall_height + 0.38, wall_height + 0.57]):
        fraction = max(0.1, 1 - (z - wall_height) / (ridge_height - wall_height))
        length = depth * fraction
        cylinder(f"{prefix}_{index}", (x, 0, z), 0.105, length, "y", wood)


def roof_planes(total_length, half_depth, wall_height, ridge_height, wood, sod):
    x0 = -total_length / 2 - 0.254
    x1 = total_length / 2 + 0.254
    west = -half_depth - 0.762
    east = half_depth + 0.5334
    board_faces = [(0, 1, 2, 3), (4, 5, 6, 7)]
    vertices = [
        (x0, west, wall_height), (x1, west, wall_height),
        (x1, 0, ridge_height), (x0, 0, ridge_height),
        (x0, 0, ridge_height), (x1, 0, ridge_height),
        (x1, east, wall_height), (x0, east, wall_height),
    ]
    prism("RoofBoards", vertices, board_faces, wood)
    sod_vertices = [(x, y, z + 0.11) for x, y, z in vertices]
    prism("SodRoof", sod_vertices, board_faces, sod)


def build_lod0(m, mats):
    length = m["overallWallLength"]["value"]
    south = m["southPenLength"]["value"]
    breeze = m["breezewayClearWidth"]["value"]
    north = m["northPenLength"]["value"]
    south_depth = m["southPenDepth"]["value"]
    north_depth = m["northPenDepth"]["value"]
    height = m["wallHeight"]["value"]
    ridge = m["ridgeHeight"]["value"]
    x0 = -length / 2
    x1 = x0 + south
    x2 = x1 + breeze
    x3 = x2 + north
    backing, wood, sod = mats["Chinking"], mats["Logs"], mats["Sod"]
    windows = {
        "south_east": (x0 + 1.7526, x0 + 2.4638, 0.62, 1.17),
        "south_west": (x0 + 2.1844, x0 + 2.8702, 0.62, 1.17),
        "north_east": (x2 + 2.0066, x2 + 2.6924, 0.62, 1.17),
        "north_west": (x2 + 1.9558, x2 + 3.302, 0.62, 1.17),
    }
    for pen, xa, xb, depth in (
        ("South", x0, x1, south_depth),
        ("North", x2, x3, north_depth),
    ):
        for face, y, key in (
            ("East", depth / 2, f"{pen.lower()}_east"),
            ("West", -depth / 2, f"{pen.lower()}_west"),
        ):
            wall_with_window(xa, xb, y, face, height, windows[key], backing)
            log_wall_x(xa, xb, y + (0.055 if y > 0 else -0.055), windows[key], height, wood, pen + face)
    for x, depth, name in ((x0, south_depth, "SouthGable"), (x3, north_depth, "NorthGable")):
        cube(name + "Backing", (x, 0, height / 2), (0.08, depth, height), backing)
        log_wall_y(x + (-0.055 if x < 0 else 0.055), -depth / 2, depth / 2, height, wood, name)
        gable_logs(x, depth, height, ridge, wood, name + "Upper")
    inner_wall_with_door(x1, -south_depth / 2, south_depth / 2, height, backing)
    inner_wall_with_door(x2, -north_depth / 2, north_depth / 2, height, backing)
    log_wall_y(x1 + 0.055, -south_depth / 2, south_depth / 2, height, wood, "SouthInner", True)
    log_wall_y(x2 - 0.055, -north_depth / 2, north_depth / 2, height, wood, "NorthInner", True)
    roof_planes(length, max(south_depth, north_depth) / 2, height, ridge, mats["RoofBoards"], sod)


def roof_for_simple(length, depth, height, ridge, wood, sod, include_boards):
    roof_planes(length, depth / 2, height, ridge, wood if include_boards else sod, sod)


def build_simple(m, mats, lod):
    length = m["overallWallLength"]["value"]
    south = m["southPenLength"]["value"]
    breeze = m["breezewayClearWidth"]["value"]
    north = m["northPenLength"]["value"]
    depth = (m["southPenDepth"]["value"] + m["northPenDepth"]["value"]) / 2
    height = m["wallHeight"]["value"]
    ridge = m["ridgeHeight"]["value"]
    x0 = -length / 2
    x1 = x0 + south
    x2 = x1 + breeze
    x3 = x2 + north
    cube("SouthPen", ((x0 + x1) / 2, 0, height / 2), (south, depth, height), mats["Logs"])
    cube("NorthPen", ((x2 + x3) / 2, 0, height / 2), (north, depth, height), mats["Logs"])
    if lod == 1:
        roof_for_simple(length, depth, height, ridge, mats["RoofBoards"], mats["Sod"], True)
    else:
        roof_for_simple(length, depth, height, ridge, mats["Sod"], mats["Sod"], False)


def triangle_count():
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        obj.data.calc_loop_triangles()
        total += len(obj.data.loop_triangles)
    return total


def export_lod(output, lod):
    join_by_material()
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj["candidateId"] = "cunningham_cabin"
            obj["lod"] = lod
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    return {
        "path": output.as_posix(),
        "triangles": triangle_count(),
        "materialPrimitives": sum(
            1 for obj in bpy.context.scene.objects if obj.type == "MESH"
        ),
        "bytes": output.stat().st_size,
    }


def main():
    opt = args()
    opt.output_dir.mkdir(parents=True, exist_ok=True)
    document = json.loads(opt.measurements.read_text())
    measured = document["measurements"]
    results = {}
    for lod in (0, 1, 2):
        clear()
        mats = {
            "Logs": material("Logs", (0.29, 0.20, 0.12)),
            "Chinking": material("Chinking", (0.34, 0.29, 0.22)),
            "RoofBoards": material("RoofBoards", (0.20, 0.15, 0.10)),
            "Sod": material("Sod", (0.25, 0.28, 0.12)),
        }
        if lod == 0:
            build_lod0(measured, mats)
        else:
            build_simple(measured, mats, lod)
        output = opt.output_dir / f"cunningham-cabin-lod{lod}.glb"
        results[f"LOD{lod}"] = export_lod(output, lod)
    report = {
        "schemaVersion": 1,
        "candidateId": "cunningham_cabin",
        "generator": Path(__file__).name,
        "measurements": opt.measurements.as_posix(),
        "lods": results,
    }
    (opt.output_dir / "geometry-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
