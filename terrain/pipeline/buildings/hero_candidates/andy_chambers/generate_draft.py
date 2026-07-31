#!/usr/bin/env python3
"""Generate deterministic documentary clay LODs for the Andy Chambers cluster.

Run through Blender:
  blender --background --python generate_draft.py -- \
    --output-directory /path/to/run/candidates/andy_chambers

The local origin is the HABS ranch-house centre. This is a review draft, not a
georeferenced production asset. The unresolved windmill is intentionally absent.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy


HERE = Path(__file__).resolve().parent
DEFAULT_MEASUREMENTS = HERE / "measurements.documentary.json"


def arguments():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", type=Path, default=DEFAULT_MEASUREMENTS)
    parser.add_argument("--output-directory", type=Path, required=True)
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for value in list(datablocks):
            datablocks.remove(value)


class MeshBuilder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.material_indices = []

    def add_face(self, vertices, material):
        start = len(self.vertices)
        self.vertices.extend(vertices)
        self.faces.append(tuple(range(start, start + len(vertices))))
        self.material_indices.append(material)

    def box(self, center, size, material, rotate_y=0.0):
        cx, cy, cz = center
        sx, sy, sz = (value * 0.5 for value in size)
        cosine, sine = math.cos(rotate_y), math.sin(rotate_y)
        vertices = []
        for x, y, z in (
            (-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
            (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz),
        ):
            vertices.append((
                cx + x * cosine + z * sine,
                cy + y,
                cz - x * sine + z * cosine,
            ))
        for face in (
            (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
            (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
        ):
            self.add_face([vertices[index] for index in face], material)

    def prism_y(self, profile, y0, y1, material):
        front = [(x, y0, z) for x, z in profile]
        back = [(x, y1, z) for x, z in profile]
        self.add_face(list(reversed(front)), material)
        self.add_face(back, material)
        count = len(profile)
        for index in range(count):
            following = (index + 1) % count
            self.add_face(
                [front[index], front[following], back[following], back[index]],
                material,
            )

    def roof_panel(self, p0, p1, y_center, length_y, thickness, material):
        x0, z0 = p0
        x1, z1 = p1
        dx, dz = x1 - x0, z1 - z0
        length = math.hypot(dx, dz)
        angle = math.atan2(-dz, dx)
        self.box(
            ((x0 + x1) * 0.5, y_center, (z0 + z1) * 0.5),
            (length, length_y, thickness),
            material,
            rotate_y=angle,
        )

    def object(self, name, materials):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        for material in materials:
            obj.data.materials.append(material)
        for polygon, material_index in zip(obj.data.polygons, self.material_indices):
            polygon.material_index = material_index
            polygon.use_smooth = False
        return obj


def material(name, color, roughness=0.9, metallic=0.0):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return value


def value(structure, key):
    return structure["dimensions"][key]["value"]


def cabin(builder, data, lod, slots):
    width_y = value(data, "north_south_m")
    total_x = value(data, "east_west_overall_m")
    core_x = value(data, "central_gable_depth_m")
    west_x = value(data, "west_front_porch_depth_m")
    east_x = value(data, "east_rear_porch_depth_m")
    eave = value(data, "wall_eave_height_m")
    ridge = value(data, "ridge_height_m")
    porch_eave = value(data, "porch_eave_height_m")
    log = slots["timber"]
    roof = slots["roof"]
    opening = slots.get("opening", log)

    # Central log block and gable ends.
    builder.box((0, 0, eave * 0.5), (core_x, width_y, eave), log)
    profile = [(-core_x * 0.5, eave), (0, ridge), (core_x * 0.5, eave)]
    builder.prism_y(profile, -width_y * 0.5, width_y * 0.5, log)

    overhang = 0.28
    builder.roof_panel(
        (-core_x * 0.5 - overhang, eave),
        (0, ridge + 0.08),
        0,
        width_y + 0.55,
        0.1,
        roof,
    )
    builder.roof_panel(
        (0, ridge + 0.08),
        (core_x * 0.5 + overhang, eave),
        0,
        width_y + 0.55,
        0.1,
        roof,
    )

    west_center = -(core_x + west_x) * 0.5
    east_center = (core_x + east_x) * 0.5
    quarter_height = 1.02
    builder.box(
        (west_center, 0, quarter_height * 0.5),
        (west_x, width_y, quarter_height),
        log,
    )
    builder.box(
        (east_center, 0, porch_eave * 0.5),
        (east_x, width_y, porch_eave),
        log,
    )
    builder.roof_panel(
        (-total_x * 0.5 - 0.18, porch_eave),
        (-core_x * 0.5 + 0.08, eave - 0.08),
        0,
        width_y + 0.45,
        0.09,
        roof,
    )
    builder.roof_panel(
        (core_x * 0.5 - 0.08, eave - 0.08),
        (total_x * 0.5 + 0.18, porch_eave),
        0,
        width_y + 0.45,
        0.09,
        roof,
    )

    if lod == 0:
        post_x = -total_x * 0.5 + 0.18
        for y in (-width_y * 0.5 + 0.22, -width_y * 0.17,
                  width_y * 0.17, width_y * 0.5 - 0.22):
            builder.box((post_x, y, porch_eave * 0.5), (0.17, 0.17, porch_eave), log)
        # West door and window, kept shallow to avoid black recess artifacts.
        facade_x = -core_x * 0.5 - 0.025
        builder.box((facade_x, width_y * 0.18, 1.05), (0.05, 1.05, 2.1), opening)
        builder.box((facade_x, -width_y * 0.23, 1.45), (0.05, 1.15, 1.25), opening)
    elif lod == 1:
        facade_x = -core_x * 0.5 - 0.025
        builder.box((facade_x, width_y * 0.18, 1.02), (0.05, 1.05, 2.04), opening)


def stable_barn(builder, data, lod, slots):
    tx, ty, _ = data["translation_m"]
    length_y = value(data, "north_south_m")
    overall_x = value(data, "east_west_overall_m")
    central_x = value(data, "central_gambrel_width_m")
    shed_x = value(data, "west_shed_width_m")
    eave = value(data, "eave_height_m")
    shoulder = value(data, "gambrel_shoulder_height_m")
    ridge = value(data, "ridge_height_m")
    log = slots["timber"]
    board = slots.get("board", log)
    roof = slots["metal"]
    opening = slots.get("opening", board)

    east_edge = tx + overall_x * 0.5
    central_west = east_edge - central_x
    central_center = (central_west + east_edge) * 0.5
    west_edge = central_west - shed_x
    builder.box((central_center, ty, eave * 0.5), (central_x, length_y, eave), log)
    profile = [
        (central_west, eave),
        (central_west + central_x * 0.24, shoulder),
        (central_center, ridge),
        (east_edge - central_x * 0.24, shoulder),
        (east_edge, eave),
    ]
    builder.prism_y(profile, ty - length_y * 0.5, ty + length_y * 0.5, board)

    roof_profile = profile
    for start, end in zip(roof_profile, roof_profile[1:]):
        builder.roof_panel(start, end, ty, length_y + 0.5, 0.1, roof)

    shed_eave = 3.35
    builder.box(
        ((west_edge + central_west) * 0.5, ty, shed_eave * 0.5),
        (shed_x, length_y, shed_eave),
        board,
    )
    builder.roof_panel(
        (west_edge - 0.2, shed_eave),
        (central_west + 0.08, eave),
        ty,
        length_y + 0.45,
        0.1,
        roof,
    )

    south = ty - length_y * 0.5 - 0.03
    if lod <= 1:
        builder.box((central_center, south, eave * 0.43), (2.1, 0.06, eave * 0.86), opening)
        builder.box(
            ((west_edge + central_west) * 0.5, south, shed_eave * 0.47),
            (2.5, 0.06, shed_eave * 0.9),
            opening,
        )
    if lod == 0:
        # Simple documentary hay hood over the south gambrel end.
        builder.roof_panel(
            (central_center - 1.05, shoulder + 0.1),
            (central_center + 1.05, shoulder + 0.1),
            south - 0.48,
            1.05,
            0.1,
            roof,
        )
        for offset in (-1.5, 1.5):
            builder.box(
                (central_center + offset, south, 2.65),
                (0.72, 0.06, 0.62),
                opening,
            )


def create_lod(measurements, lod):
    clear_scene()
    if lod == 0:
        materials = [
            material("weathered_timber", (0.30, 0.21, 0.13)),
            material("weathered_board", (0.38, 0.29, 0.19)),
            material("wood_shingle", (0.16, 0.14, 0.12)),
            material("galvanized_metal", (0.30, 0.31, 0.30), metallic=0.35),
            material("opening_detail", (0.13, 0.105, 0.075)),
        ]
        slots = {"timber": 0, "board": 1, "roof": 2, "metal": 3, "opening": 4}
    elif lod == 1:
        materials = [
            material("weathered_timber", (0.30, 0.21, 0.13)),
            material("wood_shingle", (0.16, 0.14, 0.12)),
            material("galvanized_metal", (0.30, 0.31, 0.30), metallic=0.35),
            material("opening_detail", (0.13, 0.105, 0.075)),
        ]
        slots = {"timber": 0, "board": 0, "roof": 1, "metal": 2, "opening": 3}
    else:
        materials = [
            material("weathered_timber", (0.30, 0.21, 0.13)),
            material("roof", (0.22, 0.21, 0.19), metallic=0.1),
        ]
        slots = {"timber": 0, "board": 0, "roof": 1, "metal": 1}

    builder = MeshBuilder()
    structures = measurements["structures"]
    cabin(builder, structures["cabin"], lod, slots)
    stable_barn(builder, structures["stable_barn"], lod, slots)
    obj = builder.object(f"andy_chambers_lod{lod}", materials)
    obj["candidate_id"] = "andy_chambers"
    obj["documentary_draft"] = True
    obj["windmill_omitted"] = True
    obj["local_origin"] = "HABS ranch-house centre"
    return obj, len(materials)


def export_lod(obj, output, lod):
    path = output / f"andy-chambers-draft-lod{lod}.glb"
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )
    triangles = sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)
    bounds = {
        "min": [min(vertex.co[index] for vertex in obj.data.vertices) for index in range(3)],
        "max": [max(vertex.co[index] for vertex in obj.data.vertices) for index in range(3)],
    }
    return {
        "lod": lod,
        "path": path.name,
        "bytes": path.stat().st_size,
        "triangles": triangles,
        "material_primitives": len(obj.data.materials),
        "bounds_m": bounds,
    }


def main():
    options = arguments()
    measurements = json.loads(options.measurements.read_text(encoding="utf-8"))
    output = options.output_directory.resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for lod in range(3):
        obj, _ = create_lod(measurements, lod)
        results.append(export_lod(obj, output, lod))
    validation = {
        "schema_version": 1,
        "candidate_id": "andy_chambers",
        "status": "documentary_draft",
        "local_only": True,
        "windmill_omitted": True,
        "replacement_gate": "Barn vertical dimensions and cluster georeferencing require LiDAR before visual approval.",
        "lods": results,
    }
    (output / "validation.json").write_text(
        json.dumps(validation, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(validation, indent=2))


if __name__ == "__main__":
    main()
