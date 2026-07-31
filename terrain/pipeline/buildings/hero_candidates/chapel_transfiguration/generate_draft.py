#!/usr/bin/env python3
"""Generate deterministic exterior-only Chapel of the Transfiguration draft LODs."""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy


HERE = Path(__file__).resolve().parent
DEFAULT_MEASUREMENTS = HERE / "documentary-measurements.json"


def parse_args():
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", type=Path, default=DEFAULT_MEASUREMENTS)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(values)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.curves):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def make_material(name, color, roughness=0.9):
    value = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return value


def cube(name, location, dimensions, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    return obj


def mesh_object(name, vertices, faces, material):
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def cylinder(name, location, radius, depth, rotation, material, vertices=8):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    return obj


def join_by_material():
    groups = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj.data.materials:
            groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = name


def gable_prism(name, center_y, width, wall_height, ridge_height, thickness, material):
    half_width = width / 2
    y0, y1 = center_y - thickness / 2, center_y + thickness / 2
    vertices = [
        (-half_width, y0, wall_height),
        (half_width, y0, wall_height),
        (0, y0, ridge_height),
        (-half_width, y1, wall_height),
        (half_width, y1, wall_height),
        (0, y1, ridge_height),
    ]
    faces = [
        (0, 1, 2),
        (3, 5, 4),
        (0, 3, 4, 1),
        (1, 4, 5, 2),
        (2, 5, 3, 0),
    ]
    return mesh_object(name, vertices, faces, material)


def roof_planes(name, width, length, eave_height, ridge_height, center, material, overhang=0.28):
    cx, cy = center
    half_width = width / 2 + overhang
    half_length = length / 2 + overhang
    thickness = 0.08
    vertices = [
        (cx - half_width, cy - half_length, eave_height),
        (cx - half_width, cy + half_length, eave_height),
        (cx, cy + half_length, ridge_height),
        (cx, cy - half_length, ridge_height),
        (cx, cy - half_length, ridge_height + thickness),
        (cx, cy + half_length, ridge_height + thickness),
        (cx + half_width, cy + half_length, eave_height),
        (cx + half_width, cy - half_length, eave_height),
    ]
    return mesh_object(name, vertices, [(0, 1, 2, 3), (4, 5, 6, 7)], material)


def log_walls(width, length, wall_height, diameter, center, material, prefix):
    cx, cy = center
    radius = diameter / 2
    courses = max(1, int(wall_height / diameter))
    for course in range(courses):
        z = radius + course * diameter
        for side in (-1, 1):
            cylinder(
                f"{prefix}_Long_{course}_{side}",
                (cx + side * width / 2, cy, z),
                radius,
                length + 0.32,
                (math.pi / 2, 0, 0),
                material,
            )
            cylinder(
                f"{prefix}_End_{course}_{side}",
                (cx, cy + side * length / 2, z),
                radius,
                width + 0.32,
                (0, math.pi / 2, 0),
                material,
            )


def surface_panel(name, location, dimensions, material):
    return cube(name, location, dimensions, material)


def add_cross(name, x, y, base_z, material):
    surface_panel(name + "Vertical", (x, y, base_z + 0.48), (0.10, 0.10, 0.95), material)
    surface_panel(name + "Horizontal", (x, y, base_z + 0.60), (0.55, 0.10, 0.09), material)


def build_chapel_lod0(m, materials):
    width = m["primaryWidth"]["value"]
    length = m["primaryLength"]["value"]
    wall = m["wallHeight"]["value"]
    ridge = m["ridgeHeight"]["value"]
    diameter = m["logCourseDiameter"]["value"]

    log_walls(width, length, wall, diameter, (0, 0), materials["Logs"], "Chapel")
    gable_prism("ChapelFrontGable", -length / 2, width, wall, ridge, 0.12, materials["Logs"])
    gable_prism("ChapelRearGable", length / 2, width, wall, ridge, 0.12, materials["Logs"])
    roof_planes("ChapelShakeRoof", width, length, wall, ridge, (0, 0), materials["Roof"])

    entry_width = m["entryProjectionWidth"]["value"]
    entry_length = m["entryProjectionLength"]["value"]
    entry_wall = m["entryEaveHeight"]["value"]
    entry_ridge = m["entryRidgeHeight"]["value"]
    entry_y = -length / 2 - entry_length / 2 + 0.08
    log_walls(entry_width, entry_length, entry_wall, diameter, (0, entry_y), materials["Logs"], "Entry")
    gable_prism(
        "EntryFrontGable",
        entry_y - entry_length / 2,
        entry_width,
        entry_wall,
        entry_ridge,
        0.12,
        materials["Logs"],
    )
    roof_planes(
        "EntryShakeRoof",
        entry_width,
        entry_length,
        entry_wall,
        entry_ridge,
        (0, entry_y),
        materials["Roof"],
        0.22,
    )

    sacristy_width = m["sacristyWidth"]["value"]
    sacristy_length = m["sacristyLength"]["value"]
    sacristy_x = width / 2 + sacristy_width / 2 - 0.15
    sacristy_y = length / 2 - sacristy_length / 2 - 0.9
    sacristy_wall = 2.65
    sacristy_ridge = 4.05
    log_walls(
        sacristy_width,
        sacristy_length,
        sacristy_wall,
        diameter,
        (sacristy_x, sacristy_y),
        materials["Logs"],
        "Sacristy",
    )
    roof_planes(
        "SacristyShakeRoof",
        sacristy_width,
        sacristy_length,
        sacristy_wall,
        sacristy_ridge,
        (sacristy_x, sacristy_y),
        materials["Roof"],
        0.22,
    )

    front_y = entry_y - entry_length / 2 - 0.07
    surface_panel("EntryDoor", (0, front_y, 1.03), (1.05, 0.08, 2.06), materials["Trim"])
    for hinge_z in (0.45, 1.55):
        surface_panel("DoorHinge", (0.25, front_y - 0.05, hinge_z), (0.52, 0.035, 0.055), materials["Trim"])
    add_cross("RoofCross", 0, front_y, entry_ridge + 0.05, materials["Trim"])

    for index, y in enumerate((-4.6, -1.6, 1.4, 4.4)):
        for side in (-1, 1):
            x = side * (width / 2 + 0.065)
            surface_panel(
                f"NaveWindow_{index}_{side}",
                (x, y, 1.75),
                (0.055, 1.12, 1.10),
                materials["Glass"],
            )
            surface_panel(
                f"NaveWindowBarV_{index}_{side}",
                (x + side * 0.035, y, 1.75),
                (0.06, 0.055, 1.16),
                materials["Trim"],
            )
            surface_panel(
                f"NaveWindowBarH_{index}_{side}",
                (x + side * 0.035, y, 1.75),
                (0.06, 1.16, 0.055),
                materials["Trim"],
            )

    rear_y = length / 2 + 0.07
    surface_panel("AltarWindow", (0, rear_y, 2.30), (2.35, 0.055, 2.35), materials["Glass"])
    for offset in (-0.59, 0, 0.59):
        surface_panel("AltarWindowVertical", (offset, rear_y + 0.035, 2.30), (0.055, 0.05, 2.42), materials["Trim"])
    for offset in (-0.59, 0, 0.59):
        surface_panel("AltarWindowHorizontal", (0, rear_y + 0.035, 2.30 + offset), (2.42, 0.05, 0.055), materials["Trim"])


def build_brides_room_lod0(m, materials):
    width = m["footprintWidth"]["value"]
    length = m["footprintLength"]["value"]
    wall = m["wallHeight"]["value"]
    ridge = m["ridgeHeight"]["value"]
    cx, cy = m["relativeCenter"]["value"]
    cube("BridesRoomWalls", (cx, cy, wall / 2), (width, length, wall), materials["Logs"])
    gable_prism("BridesRoomFrontGable", cy - length / 2, width, wall, ridge, 0.12, materials["Logs"]).location.x = cx
    gable_prism("BridesRoomRearGable", cy + length / 2, width, wall, ridge, 0.12, materials["Logs"]).location.x = cx
    roof_planes("BridesRoomRoof", width, length, wall, ridge, (cx, cy), materials["Roof"])


def build_simple(chapel, brides, materials, lod):
    width = chapel["primaryWidth"]["value"]
    length = chapel["primaryLength"]["value"]
    wall = chapel["wallHeight"]["value"]
    ridge = chapel["ridgeHeight"]["value"]
    cube("ChapelWalls", (0, 0, wall / 2), (width, length, wall), materials["Logs"])
    gable_prism("ChapelFrontGable", -length / 2, width, wall, ridge, 0.10, materials["Logs"])
    gable_prism("ChapelRearGable", length / 2, width, wall, ridge, 0.10, materials["Logs"])
    roof_planes("ChapelRoof", width, length, wall, ridge, (0, 0), materials["Roof"])

    entry_width = chapel["entryProjectionWidth"]["value"]
    entry_length = chapel["entryProjectionLength"]["value"]
    entry_wall = chapel["entryEaveHeight"]["value"]
    entry_ridge = chapel["entryRidgeHeight"]["value"]
    entry_y = -length / 2 - entry_length / 2 + 0.08
    cube("EntryWalls", (0, entry_y, entry_wall / 2), (entry_width, entry_length, entry_wall), materials["Logs"])
    roof_planes("EntryRoof", entry_width, entry_length, entry_wall, entry_ridge, (0, entry_y), materials["Roof"])

    cx, cy = brides["relativeCenter"]["value"]
    bw, bl = brides["footprintWidth"]["value"], brides["footprintLength"]["value"]
    bh, br = brides["wallHeight"]["value"], brides["ridgeHeight"]["value"]
    cube("BridesRoomWalls", (cx, cy, bh / 2), (bw, bl, bh), materials["Logs"])
    roof_planes("BridesRoomRoof", bw, bl, bh, br, (cx, cy), materials["Roof"])
    if lod == 1:
        surface_panel("EntryDoor", (0, entry_y - entry_length / 2 - 0.06, 1.03), (1.05, 0.06, 2.06), materials["Trim"])
        surface_panel("AltarWindow", (0, length / 2 + 0.06, 2.30), (2.35, 0.06, 2.35), materials["Trim"])


def triangle_count():
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.data.calc_loop_triangles()
            total += len(obj.data.loop_triangles)
    return total


def export_lod(output, lod):
    join_by_material()
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj["candidateId"] = "chapel_transfiguration"
            obj["lod"] = lod
            obj["exteriorOnly"] = True
    triangles = triangle_count()
    primitives = sum(1 for obj in bpy.context.scene.objects if obj.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    return {
        "path": output.as_posix(),
        "triangles": triangles,
        "materialPrimitives": primitives,
        "bytes": output.stat().st_size,
    }


def main():
    options = parse_args()
    options.output_dir.mkdir(parents=True, exist_ok=True)
    document = json.loads(options.measurements.read_text(encoding="utf-8"))
    chapel = document["measurements"]["chapel"]
    brides = document["measurements"]["bridesRoom"]
    results = {}
    for lod in (0, 1, 2):
        clear_scene()
        materials = {
            "Logs": make_material("Logs", (0.24, 0.14, 0.075)),
            "Roof": make_material("Roof", (0.19, 0.16, 0.125)),
            "Trim": make_material("Trim", (0.15, 0.085, 0.04)),
            "Glass": make_material("Glass", (0.12, 0.17, 0.17), 0.55),
        }
        if lod == 0:
            build_chapel_lod0(chapel, materials)
            build_brides_room_lod0(brides, materials)
        else:
            build_simple(chapel, brides, materials, lod)
        output = options.output_dir / f"chapel-transfiguration-lod{lod}.glb"
        results[f"LOD{lod}"] = export_lod(output, lod)

    report = {
        "schemaVersion": 1,
        "candidateId": "chapel_transfiguration",
        "generator": Path(__file__).name,
        "measurements": options.measurements.as_posix(),
        "exteriorOnly": True,
        "lods": results,
    }
    report_path = options.output_dir / "geometry-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
