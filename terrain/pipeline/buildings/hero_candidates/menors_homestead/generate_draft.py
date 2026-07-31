#!/usr/bin/env python3
"""Generate deterministic, documentary Menor cabin/store draft LODs in Blender.

This generator deliberately excludes the ferry, cableworks, storehouse, smokehouse,
Maud Noble Cabin, and transportation barn. Output is local batch-review material.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
DEFAULT_MEASUREMENTS = HERE / "documentary-measurements.json"
SOURCE_ROOT = REPO / "terrain/pipeline/data/hero-buildings/menors_homestead/habs-wy-24"


def arguments():
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", type=Path, default=DEFAULT_MEASUREMENTS)
    parser.add_argument("--output-directory", type=Path, required=True)
    return parser.parse_args(values)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for value in list(datablocks):
            datablocks.remove(value)


def material(name, color, roughness=0.92):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return value


class MeshBuilder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.material_indices = []

    def face(self, vertices, material_index):
        start = len(self.vertices)
        self.vertices.extend(vertices)
        self.faces.append(tuple(range(start, start + len(vertices))))
        self.material_indices.append(material_index)

    def box(self, center, size, material_index):
        cx, cy, cz = center
        sx, sy, sz = (value * 0.5 for value in size)
        vertices = [
            (cx - sx, cy - sy, cz - sz), (cx + sx, cy - sy, cz - sz),
            (cx + sx, cy + sy, cz - sz), (cx - sx, cy + sy, cz - sz),
            (cx - sx, cy - sy, cz + sz), (cx + sx, cy - sy, cz + sz),
            (cx + sx, cy + sy, cz + sz), (cx - sx, cy + sy, cz + sz),
        ]
        for indices in (
            (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
            (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
        ):
            self.face([vertices[index] for index in indices], material_index)

    def prism_y(self, profile, y0, y1, material_index):
        front = [(x, y0, z) for x, z in profile]
        back = [(x, y1, z) for x, z in profile]
        self.face(list(reversed(front)), material_index)
        self.face(back, material_index)
        for index in range(len(profile)):
            following = (index + 1) % len(profile)
            self.face(
                [front[index], front[following], back[following], back[index]],
                material_index,
            )

    def prism_x(self, profile, x0, x1, material_index):
        left = [(x0, y, z) for y, z in profile]
        right = [(x1, y, z) for y, z in profile]
        self.face(list(reversed(left)), material_index)
        self.face(right, material_index)
        for index in range(len(profile)):
            following = (index + 1) % len(profile)
            self.face(
                [left[index], left[following], right[following], right[index]],
                material_index,
            )

    def roof_quad(self, corners, thickness, material_index):
        bottom = [(x, y, z - thickness) for x, y, z in corners]
        self.face(corners, material_index)
        self.face(list(reversed(bottom)), material_index)
        for index in range(4):
            following = (index + 1) % 4
            self.face(
                [bottom[index], corners[index], corners[following], bottom[following]],
                material_index,
            )

    def object(self, name, materials):
        mesh = bpy.data.meshes.new(name + "Mesh")
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        for value in materials:
            obj.data.materials.append(value)
        for polygon, material_index in zip(mesh.polygons, self.material_indices):
            polygon.material_index = material_index
            polygon.use_smooth = False
        return obj


def measured(document, key):
    return document["measurements"][key]["value"]


def layout(document):
    original_w = measured(document, "original_cabin_width_m")
    central_w = measured(document, "central_addition_width_m")
    store_w = measured(document, "store_width_m")
    total = original_w + central_w + store_w
    x0 = -total * 0.5
    x1 = x0 + original_w
    x2 = x1 + central_w
    x3 = x2 + store_w
    original_depth = measured(document, "original_cabin_depth_m")
    central_depth = measured(document, "central_addition_depth_m")
    store_body = measured(document, "store_body_depth_m")
    porch = measured(document, "store_south_porch_depth_m")
    south = -max(original_depth, central_depth) * 0.5
    return {
        "x0": x0, "x1": x1, "x2": x2, "x3": x3,
        "original_depth": original_depth,
        "central_depth": central_depth,
        "store_body": store_body,
        "porch": porch,
        "south": south,
        "store_south": south + porch,
        "store_north": south + porch + store_body,
    }


def opening_y(builder, x, y, width, height, sill, material_index, outward):
    builder.box(
        (x, y + outward * 0.035, sill + height * 0.5),
        (width, 0.07, height),
        material_index,
    )


def opening_x(builder, x, y, width, height, sill, material_index, outward):
    builder.box(
        (x + outward * 0.035, y, sill + height * 0.5),
        (0.07, width, height),
        material_index,
    )


def build(document, lod, materials):
    values = layout(document)
    b = MeshBuilder()
    whitewash = 0
    board = 1 if lod < 2 else 0
    roof = 2 if lod < 2 else 1
    trim = 3 if lod < 2 else 0
    glass = 4 if lod == 0 else trim
    foundation = 5 if lod == 0 else whitewash
    cabin_eave = measured(document, "cabin_eave_height_m")
    cabin_ridge = measured(document, "cabin_ridge_height_m")
    store_eave = measured(document, "store_eave_height_m")
    store_ridge = measured(document, "store_ridge_height_m")
    x0, x1, x2, x3 = (values[key] for key in ("x0", "x1", "x2", "x3"))
    south = values["south"]
    original_north = south + values["original_depth"]
    central_north = south + values["central_depth"]
    store_south, store_north = values["store_south"], values["store_north"]

    # Documentary phase masses. They overlap by only a few centimetres to avoid
    # daylight seams but retain separate silhouette breaks.
    b.box(((x0 + x1) * 0.5, (south + original_north) * 0.5, cabin_eave * 0.5),
          (x1 - x0, values["original_depth"], cabin_eave), whitewash)
    b.box(((x1 + x2) * 0.5, (south + central_north) * 0.5, cabin_eave * 0.5),
          (x2 - x1 + 0.04, values["central_depth"], cabin_eave), board)
    b.box(((x2 + x3) * 0.5, (store_south + store_north) * 0.5, store_eave * 0.5),
          (x3 - x2 + 0.04, values["store_body"], store_eave), whitewash)
    b.prism_x(
        [(south, cabin_eave), ((south + original_north) * 0.5, cabin_ridge),
         (original_north, cabin_eave)],
        x0, x2 + 0.08, whitewash,
    )
    b.prism_y(
        [(x2 - 0.06, store_eave), ((x2 + x3) * 0.5, store_ridge),
         (x3, store_eave)],
        store_south, store_north, whitewash,
    )

    # Cabin roof ridge runs east-west; store roof is perpendicular and covers its
    # documented south porch.
    overhang = 0.28
    ridge_y = (south + original_north) * 0.5
    # Stop the low cabin roof beneath the store's west overhang. A full rectangular
    # overlap creates an implausible exposed fold where the perpendicular roofs meet.
    cabin_roof_east = x2 - 0.34
    b.roof_quad(
        [(x0 - overhang, south - overhang, cabin_eave),
         (cabin_roof_east, south - overhang, cabin_eave),
         (cabin_roof_east, ridge_y, cabin_ridge),
         (x0 - overhang, ridge_y, cabin_ridge)],
        0.1, roof,
    )
    b.roof_quad(
        [(x0 - overhang, ridge_y, cabin_ridge),
         (cabin_roof_east, ridge_y, cabin_ridge),
         (cabin_roof_east, original_north + overhang, cabin_eave),
         (x0 - overhang, original_north + overhang, cabin_eave)],
        0.1, roof,
    )
    store_mid_x = (x2 + x3) * 0.5
    b.roof_quad(
        [(x2 - overhang, south - overhang, store_eave),
         (store_mid_x, south - overhang, store_ridge),
         (store_mid_x, store_north + overhang, store_ridge),
         (x2 - overhang, store_north + overhang, store_eave)],
        0.1, roof,
    )
    b.roof_quad(
        [(store_mid_x, south - overhang, store_ridge),
         (x3 + overhang, south - overhang, store_eave),
         (x3 + overhang, store_north + overhang, store_eave),
         (store_mid_x, store_north + overhang, store_ridge)],
        0.1, roof,
    )

    if lod < 2:
        door_h = measured(document, "exterior_door_height_m")
        # Pale trim/glazing avoids the black-rectangle failure from earlier drafts.
        opening_y(b, (x0 + x1) * 0.5, south, 1.45, 1.05, 0.78, glass, -1)
        opening_y(b, x1 + (x2 - x1) * 0.38, south, 0.72, 0.95, 1.05, glass, -1)
        opening_y(b, x1 + (x2 - x1) * 0.76, south, 0.86, door_h, 0, trim, -1)
        opening_y(b, store_mid_x, store_south, 0.88, door_h, 0, trim, -1)
        opening_y(b, store_mid_x, store_north, 0.86, 1.12, 0.88, glass, 1)
        opening_y(b, x1 + (x2 - x1) * 0.58, central_north, 0.86, door_h, 0, trim, 1)
        opening_x(b, x0, south + values["original_depth"] * 0.34,
                  0.82, 1.1, 0.83, glass, -1)
        opening_x(b, x3, store_south + values["store_body"] * 0.55,
                  0.82, 1.1, 0.83, glass, 1)

    if lod == 0:
        # Log-course and board-and-batten relief stays shallow and shares materials.
        original_window = ((x0 + x1) * 0.5 - 0.725, (x0 + x1) * 0.5 + 0.725)
        store_window = (store_mid_x - 0.43, store_mid_x + 0.43)
        for index in range(10):
            z = 0.18 + index * (cabin_eave - 0.25) / 10
            original_segments = [(x0, x1)]
            store_segments = [(x2, x3)]
            if 0.74 < z < 1.87:
                original_segments = [(x0, original_window[0]), (original_window[1], x1)]
                store_segments = [(x2, store_window[0]), (store_window[1], x3)]
            for start, end in original_segments:
                b.box(((start + end) * 0.5, south - 0.035, z),
                      (end - start, 0.07, 0.045), whitewash)
            for start, end in store_segments:
                b.box(((start + end) * 0.5, store_north + 0.035, z),
                      (end - start, 0.07, 0.045), whitewash)
        central_window = (x1 + (x2 - x1) * 0.38 - 0.36,
                          x1 + (x2 - x1) * 0.38 + 0.36)
        central_door = (x1 + (x2 - x1) * 0.76 - 0.43,
                        x1 + (x2 - x1) * 0.76 + 0.43)
        for index in range(1, 9):
            x = x1 + index * (x2 - x1) / 9
            if central_window[0] < x < central_window[1] or central_door[0] < x < central_door[1]:
                continue
            b.box((x, south - 0.04, cabin_eave * 0.5),
                  (0.045, 0.08, cabin_eave), board)
        for index, x in enumerate((x0 + 0.35, x1 - 0.35, x2 + 0.35, x3 - 0.35)):
            b.box((x, south + 0.08, 0.12), (0.42, 0.38, 0.24), foundation)
        # Four square porch posts shown on HABS sheet 8.
        for x in (x2 + 0.16, x3 - 0.16):
            b.box((x, south + 0.08, store_eave * 0.5),
                  (0.14, 0.14, store_eave), whitewash)

    obj = b.object(f"MenorsHomestead_LOD{lod}", materials)
    obj["candidateId"] = "menors_homestead"
    obj["lod"] = lod
    obj["ferryExcluded"] = True
    obj["sourceSurvey"] = "HABS WY-24"
    return obj


def triangle_count():
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.data.calc_loop_triangles()
            total += len(obj.data.loop_triangles)
    return total


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_report():
    captions = {
        "174562.jpg": "Menor's Ferry complex from west",
        "174563.jpg": "West end elevation of original Menor Cabin",
        "174564.jpg": "Interior of original cabin looking east",
        "174565.jpg": "Menor Homestead showing cabin and addition; copy of early 1899 NPS photo",
        "174566.jpg": "Southwest corner of Menor Cabin; copy of early NPS photo",
        "174569.jpg": "Southwest corner of storage building; identity exclusion reference",
        "174570.jpg": "South corner of smokehouse; identity exclusion reference",
        "174571.jpg": "South elevation: original cabin, addition, store and storage building before restoration",
    }
    artifacts = []
    for path in sorted(SOURCE_ROOT.glob("sheets/*.jpg")):
        number = int(path.stem.split("-")[-1])
        artifacts.append({
            "path": path.relative_to(REPO).as_posix(),
            "source_url": (
                "https://tile.loc.gov/storage-services/service/pnp/habshaer/"
                f"wy/wy0000/wy0036/sheet/000{number:02d}v.jpg"
            ),
            "role": "measured_drawing",
            "sheet": number,
            "bytes": path.stat().st_size,
            "sha256": file_sha256(path),
        })
    for path in sorted(SOURCE_ROOT.glob("photos/*.jpg")):
        artifacts.append({
            "path": path.relative_to(REPO).as_posix(),
            "source_url": (
                "https://tile.loc.gov/storage-services/service/pnp/habshaer/"
                f"wy/wy0000/wy0036/photos/{path.stem}pv.jpg"
            ),
            "role": "documentary_photo",
            "caption": captions[path.name],
            "bytes": path.stat().st_size,
            "sha256": file_sha256(path),
        })
    return {
        "schema_version": 1,
        "candidate_id": "menors_homestead",
        "retrieved_date": "2026-07-28",
        "record_url": "https://www.loc.gov/item/wy0036/",
        "provider": "Library of Congress, Historic American Buildings Survey",
        "survey_number": "HABS WY-24",
        "call_number": "HABS WYO,20-MOOS,2-",
        "rights": (
            "No known restrictions on images made by the U.S. Government; images "
            "copied from other sources may be restricted. Item-level credit must be "
            "checked before redistribution."
        ),
        "rights_url": "https://www.loc.gov/rr/print/res/114_habs.html",
        "artifacts": artifacts,
    }


def materials_for(lod):
    if lod == 0:
        return [
            material("LimeWhitewashedLogs", (0.62, 0.58, 0.49)),
            material("WhitewashedBoardBatten", (0.69, 0.65, 0.56)),
            material("WeatheredBoardRoof", (0.25, 0.23, 0.19)),
            material("PaintedHistoricTrim", (0.38, 0.35, 0.29)),
            material("PaleWindowGlass", (0.28, 0.34, 0.35), 0.48),
            material("BuriedFieldstone", (0.22, 0.20, 0.17)),
        ]
    if lod == 1:
        return [
            material("LimeWhitewashedLogs", (0.62, 0.58, 0.49)),
            material("WhitewashedBoardBatten", (0.69, 0.65, 0.56)),
            material("WeatheredBoardRoof", (0.25, 0.23, 0.19)),
            material("HistoricOpenings", (0.34, 0.34, 0.31)),
        ]
    return [
        material("WhitewashedBuilding", (0.63, 0.59, 0.50)),
        material("WeatheredBoardRoof", (0.25, 0.23, 0.19)),
    ]


def export_lod(output, lod, document):
    clear_scene()
    materials = materials_for(lod)
    obj = build(document, lod, materials)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )
    return {
        "path": output.as_posix(),
        "bytes": output.stat().st_size,
        "sha256": file_sha256(output),
        "triangles": triangle_count(),
        "material_primitives": len(materials),
    }


def main():
    options = arguments()
    options.output_directory.mkdir(parents=True, exist_ok=True)
    document = json.loads(options.measurements.read_text(encoding="utf-8"))
    results = {}
    for lod in (0, 1, 2):
        output = options.output_directory / f"menors-homestead-lod{lod}.glb"
        results[f"LOD{lod}"] = export_lod(output, lod, document)
    report = {
        "schema_version": 1,
        "candidate_id": "menors_homestead",
        "generator": Path(__file__).name,
        "measurements": options.measurements.as_posix(),
        "ferry_excluded": True,
        "placement": {
            "world_anchor_xz_m": measured(document, "world_anchor_xz_m"),
            "world_rotation_y_deg": measured(document, "world_rotation_y_deg"),
            "status": "documentary_anchor_pending_habs_site_registration",
        },
        "lods": results,
        "budgets": {
            "triangles": {"LOD0": 12000, "LOD1": 3000, "LOD2": 750},
            "material_primitives": {"LOD0": 8, "LOD1": 5, "LOD2": 3},
            "texture_bytes": 1572864,
        },
    }
    report["budget_pass"] = all(
        result["triangles"] <= report["budgets"]["triangles"][lod]
        and result["material_primitives"] <= report["budgets"]["material_primitives"][lod]
        for lod, result in results.items()
    )
    (options.output_directory / "geometry-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    (options.output_directory / "acquired-sources.json").write_text(
        json.dumps(source_report(), indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
