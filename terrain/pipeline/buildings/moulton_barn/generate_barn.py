"""Generate performance-bounded T. A. Moulton Barn GLB LODs.

Run:
  blender --background --python generate_barn.py -- \
    --measurements measurements.lidar-2022.json --output ../../../public/models
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

ROOT = Path(__file__).resolve().parent


def options():
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", type=Path, default=ROOT / "measurements.lidar-2022.json")
    parser.add_argument("--output", type=Path, default=ROOT / "../../../public/models")
    parser.add_argument("--atlas", type=Path, default=
                        ROOT / "../../../public/materials/moulton-barn/moulton-barn-atlas.webp")
    parser.add_argument("--front-projection", type=Path, default=
                        ROOT / "../../../public/materials/moulton-barn/front-projection-v2.webp")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def material(name, color, roughness, atlas=None):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    if atlas:
        texture = value.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = atlas
        texture.interpolation = "Linear"
        value.node_tree.links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    return value


def projection_material(name, image):
    value = material(name, (1, 1, 1), .94)
    nodes = value.node_tree.nodes
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    uv_map = nodes.new("ShaderNodeUVMap")
    uv_map.uv_map = "FrontProjection"
    value.node_tree.links.new(uv_map.outputs["UV"], texture.inputs["Vector"])
    value.node_tree.links.new(texture.outputs["Color"],
                              nodes.get("Principled BSDF").inputs["Base Color"])
    return value


def mesh_object(name, verts, faces, mat, collection):
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def cube(name, size, location, mat, collection, rotate_y=0.0):
    x, y, z = (value * 0.5 for value in size)
    ox, oy, oz = location
    cosine, sine = math.cos(rotate_y), math.sin(rotate_y)
    verts = []
    for sx, sy, sz in ((-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),
                       (-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)):
        lx, ly, lz = sx * x, sy * y, sz * z
        verts.append((ox + cosine * lx + sine * lz, oy + ly,
                      oz - sine * lx + cosine * lz))
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    return mesh_object(name, verts, faces, mat, collection)


def prism_y(name, depth, profile, mat, collection):
    """Extrude an X/Z profile along local Y."""
    verts = [(x, -depth / 2, z) for x, z in profile]
    verts += [(x, depth / 2, z) for x, z in profile]
    count = len(profile)
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    faces += [(i, (i + 1) % count, (i + 1) % count + count, i + count)
              for i in range(count)]
    return mesh_object(name, verts, faces, mat, collection)


def roof_panel(name, start, end, depth, mat, collection):
    x0, z0 = start
    x1, z1 = end
    dx, dz = x1 - x0, z1 - z0
    length = math.hypot(dx, dz)
    angle = -math.atan2(dz, dx)
    return cube(name, (length, depth, .12),
                ((x0 + x1) / 2, 0, (z0 + z1) / 2),
                mat, collection, rotate_y=angle)


def roof_panel_sag(name, start, end, depth, mat, collection, segments=7, sag=.075):
    """Thin segmented roof plate with a restrained, symmetric ridge-direction sag."""
    x0, z0 = start
    x1, z1 = end
    thickness = .12
    verts = []
    for index in range(segments + 1):
        t = index / segments
        y = -depth / 2 + depth * t
        offset = -sag * (1 - (2 * t - 1) ** 2)
        verts.extend([
            (x0, y, z0 + offset - thickness / 2),
            (x1, y, z1 + offset - thickness / 2),
            (x0, y, z0 + offset + thickness / 2),
            (x1, y, z1 + offset + thickness / 2),
        ])
    faces = []
    for index in range(segments):
        a, b = index * 4, (index + 1) * 4
        faces.extend([
            (a, b, b + 1, a + 1),
            (a + 2, a + 3, b + 3, b + 2),
            (a, a + 2, b + 2, b),
            (a + 1, b + 1, b + 3, a + 3),
        ])
    last = segments * 4
    faces.extend([(0, 1, 3, 2), (last, last + 2, last + 3, last + 1)])
    return mesh_object(name, verts, faces, mat, collection)


def hex_log_y(name, radius, length, location, mat, collection):
    """Low-poly exposed log end with its axis along Y."""
    ox, oy, oz = location
    verts = []
    for y in (-length / 2, length / 2):
        for index in range(6):
            angle = index / 6 * math.tau
            verts.append((ox + math.cos(angle) * radius, oy + y,
                          oz + math.sin(angle) * radius))
    faces = [tuple(range(5, -1, -1)), tuple(range(6, 12))]
    faces += [(index, (index + 1) % 6, (index + 1) % 6 + 6, index + 6)
              for index in range(6)]
    return mesh_object(name, verts, faces, mat, collection)


def join_by_material(collection):
    """Collapse many detail objects to <=3 material primitives/draw calls."""
    groups = {}
    for obj in list(collection.objects):
        key = obj.data.materials[0].name
        groups.setdefault(key, []).append(obj)
    for key, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = f"{collection.name}_{key.replace(' ', '_')}"


def project_atlas_uvs(collection):
    """Cube-project each material group, then place it in its atlas half."""
    for obj in collection.objects:
        if obj.type != "MESH" or not obj.data.materials:
            continue
        name = obj.data.materials[0].name.lower()
        if "weathered_timber" not in name and "weathered_shake_roof" not in name:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=4.0, correct_aspect=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        u0 = .5 if "roof" in name else 0
        uv = obj.data.uv_layers.active
        for loop in uv.data:
            loop.uv.x = u0 + (loop.uv.x % 1.0) * .5


def project_front_elevation(collection, front_material, scene):
    """Camera-project the registered generated elevation onto front-facing timber polygons."""
    camera_data = bpy.data.cameras.new("FrontProjectionCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 12
    camera = bpy.data.objects.new("FrontProjectionCamera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (32, 0, 3.1)
    camera.rotation_euler = (Vector((0, 0, 3.1)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    old_x, old_y = scene.render.resolution_x, scene.render.resolution_y
    scene.render.resolution_x, scene.render.resolution_y = 1536, 1024
    bpy.context.view_layer.update()
    for obj in collection.objects:
        if obj.type != "MESH" or not obj.data.materials:
            continue
        if "weathered_timber" not in obj.data.materials[0].name.lower():
            continue
        slot = len(obj.data.materials)
        obj.data.materials.append(front_material)
        uv = obj.data.uv_layers.get("FrontProjection") or obj.data.uv_layers.new(
            name="FrontProjection")
        normal_matrix = obj.matrix_world.to_3x3()
        front_x = max((obj.matrix_world @ vertex.co).x for vertex in obj.data.vertices)
        front_cut = front_x - 1.25
        for polygon in obj.data.polygons:
            normal = (normal_matrix @ polygon.normal).normalized()
            centre = obj.matrix_world @ polygon.center
            # The hand-built prism's two end polygons have reversed winding, so normal sign is
            # not a reliable front/back discriminator. Depth plus axis alignment is.
            if centre.x > front_cut and abs(normal.x) > .70:
                polygon.material_index = slot
            for loop_index in polygon.loop_indices:
                vertex = obj.data.vertices[obj.data.loops[loop_index].vertex_index]
                projected = world_to_camera_view(scene, camera, obj.matrix_world @ vertex.co)
                uv.data[loop_index].uv = (projected.x, projected.y)
    scene.render.resolution_x, scene.render.resolution_y = old_x, old_y
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.cameras.remove(camera_data)


def add_details(col, lod, span, core, depth, eave, ridge, shed_eave, timber, recess,
                include_recess=True):
    front = -depth / 2
    door_w, door_h = 1.12, min(2.25, eave * .78)
    # Paired plank doors and the small offset openings visible in HABS/NPS elevations.
    if include_recess:
        cube("Central_door_recess", (door_w * 2.08, .065, door_h),
             (0, front - .08, door_h / 2), recess, col)
    cube("Central_door_divider", (.07, .09, door_h),
         (0, front - .12, door_h / 2), timber, col)
    if include_recess:
        cube("Loft_opening", (.72, .065, .58),
             (core * .18, front - .09, eave + (ridge - eave) * .34), recess, col)
        cube("South_shed_door", (1.05, .065, min(1.95, shed_eave * .86)),
             (-span * .34, front - .08, min(1.95, shed_eave * .86) / 2), recess, col)
        cube("North_shed_door", (.92, .065, min(1.82, shed_eave * .82)),
             (span * .38, front - .08, min(1.82, shed_eave * .82) / 2), recess, col)
    if lod == 0:
        # Horizontal log courses around the lower walls. Geometry supplies stable
        # close-range relief/self-shadowing with no normal-map residency.
        for end in (-1, 1):
            y = end * (depth / 2 + .045)
            for index in range(1, 13):
                z = index * eave / 13
                cube(f"Core_log_{end}_{index}", (core, .08, .065),
                     (0, y, z), timber, col)
            for side in (-1, 1):
                shed_width = (span - core) / 2
                centre = side * (core / 2 + shed_width / 2)
                for index in range(1, 10):
                    z = index * shed_eave / 10
                    cube(f"Shed_log_{end}_{side}_{index}", (shed_width, .08, .06),
                         (centre, y, z), timber, col)
        for side in (-1, 1):
            x = side * (span / 2 + .045)
            for index in range(1, 10):
                z = index * shed_eave / 10
                cube(f"Outer_log_{side}_{index}", (.08, depth, .06),
                     (x, 0, z), timber, col)
        # Board-and-batten gable ends documented by NPS/HABS.
        for end in (-1, 1):
            y = end * (depth / 2 + .052)
            for index in range(-8, 9):
                x = index * core / 18
                top = eave + (ridge - eave) * (1 - min(1, abs(x) / (core / 2)))
                height = max(.08, top - eave)
                cube(f"Gable_batten_{end}_{index}", (.045, .055, height),
                     (x, y, eave + height / 2), timber, col)


def add_finish_details(col, span, core, depth, eave, timber, stone):
    """Sparse silhouette/detail cues for LOD0; deterministic and material-batched."""
    # Exposed round log ends where the central bay meets the later side sheds.
    for end in (-1, 1):
        y = end * (depth / 2 + .11)
        for side in (-1, 1):
            x = side * (core / 2 + .035)
            for course in range(1, 11):
                radius = .075 + .012 * ((course * 7 + side) % 3)
                hex_log_y(f"Log_end_{end}_{side}_{course}", radius, .28,
                          (x, y, course * eave / 11), timber, col)

    # Uneven fieldstone footing: enough parallax to break the ruler-straight ground seam,
    # without turning the documented low foundation into a continuous modern masonry wall.
    count = 18
    for end in (-1, 1):
        y = end * (depth / 2 + .035)
        for index in range(count):
            if (index * 7 + (1 if end > 0 else 0)) % 9 >= 5:
                continue
            t = (index + .5) / count
            x = -span / 2 + span * t
            width = .32 + .14 * ((index * 13) % 5) / 4
            height = .12 + .07 * ((index * 17 + 2) % 7) / 6
            depth_size = .20 + .08 * ((index * 11 + 1) % 4) / 3
            cube(f"Foundation_{end}_{index}", (width, depth_size, height),
                 (x, y, height / 2 - .09), stone, col)


def triangle_count(collection):
    total = 0
    for obj in collection.objects:
        obj.data.calc_loop_triangles()
        total += len(obj.data.loop_triangles)
    return total


def export_lod(collection, path):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(collection.objects), None)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_apply=True, export_materials="EXPORT", export_yup=True,
    )


def main():
    opt = options()
    doc = json.loads(opt.measurements.read_text(encoding="utf-8"))
    values = doc["measurements"]
    span, measured_depth = values["length_m"], values["width_m"]
    eave, ridge = values["eave_height_m"], values["ridge_height_m"]
    bearing = values["orientation_deg_true_north"]
    opt.output.mkdir(parents=True, exist_ok=True)
    if not opt.atlas.is_file():
        raise SystemExit(f"Missing material atlas: {opt.atlas}")
    if not opt.front_projection.is_file():
        raise SystemExit(f"Missing front projection: {opt.front_projection}")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for old in list(bpy.data.collections):
        bpy.data.collections.remove(old)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1

    atlas = bpy.data.images.load(str(opt.atlas.resolve()), check_existing=True)
    front_image = bpy.data.images.load(str(opt.front_projection.resolve()), check_existing=True)
    # The photographic atlas supplies the material colour; these factors only impart a mild
    # warm/cool bias. Dark pre-atlas factors would multiply the texture into a black silhouette.
    timber = material("weathered_timber", (.86, .76, .64), .94, atlas)
    roof = material("weathered_shake_roof", (.76, .76, .74), .98, atlas)
    recess = material("deep_recess", (.012, .014, .013), .82)
    stone = material("foundation_stone", (.12, .105, .09), .99)
    front = projection_material("front_elevation_projection", front_image)
    # HABS plan: 52'-4" total span split into roughly three 17' bays; 28'-6"
    # wall depth. LiDAR owns the outer envelope, while the plan owns massing.
    core = span / 3.02
    depth = measured_depth * .84
    shed_eave = min(eave * .76, 2.25)
    shed_inner = min(eave + .18, ridge - .7)
    central_profile = [(-core/2, 0), (core/2, 0), (core/2, eave),
                       (0, ridge), (-core/2, eave)]

    counts = {}
    for lod in range(3):
        col = bpy.data.collections.new(f"LOD{lod}")
        scene.collection.children.link(col)
        prism_y("Central_gable", depth, central_profile, timber, col)
        # Shed additions follow their roof planes. Flat-topped boxes left a visible triangular
        # daylight gap beside the central gable, unlike the boarded-in HABS elevations.
        prism_y("Shed_-1", depth, [
            (-span / 2, 0), (-core / 2, 0),
            (-core / 2, shed_inner), (-span / 2, shed_eave),
        ], timber, col)
        prism_y("Shed_1", depth, [
            (core / 2, 0), (span / 2, 0),
            (span / 2, shed_eave), (core / 2, shed_inner),
        ], timber, col)
        roof_depth = depth + .55
        panel = roof_panel_sag if lod == 0 else roof_panel
        panel("Gable_roof_left", (-core/2-.22, eave), (0, ridge+.10),
              roof_depth, roof, col)
        panel("Gable_roof_right", (0, ridge+.10), (core/2+.22, eave),
              roof_depth, roof, col)
        panel("Shed_roof_left", (-span/2-.22, shed_eave),
              (-core/2+.08, shed_inner), roof_depth, roof, col)
        panel("Shed_roof_right", (core/2-.08, shed_inner),
              (span/2+.22, shed_eave), roof_depth, roof, col)
        if lod < 2:
            add_details(col, lod, span, core, depth, eave, ridge, shed_eave,
                        timber, recess, include_recess=lod != 0)
        if lod == 0:
            add_finish_details(col, span, core, depth, eave, timber, stone)
        # The OBR bearing is directionless modulo 180°. HABS/NPS elevations
        # resolve the photographed door face toward the canonical approach.
        rotation = math.radians(270 - bearing)
        for obj in col.objects:
            obj.rotation_euler.z = rotation
        join_by_material(col)
        project_atlas_uvs(col)
        if lod == 0:
            project_front_elevation(col, front, scene)
        counts[f"LOD{lod}"] = triangle_count(col)
        export_lod(col, opt.output / f"ta-moulton-barn-lod{lod}.glb")
        for obj in col.objects:
            obj.hide_viewport = obj.hide_render = True

    report = {
        "schema_version": 1,
        "building": doc["building"],
        "status": doc.get("status", "estimated"),
        "source": str(opt.measurements),
        "triangle_counts": counts,
        "material_primitives_per_lod": {"LOD0": 4, "LOD1": 3, "LOD2": 2},
        "measurements": values,
        "provenance": doc["provenance"],
        "uncertainty": doc["uncertainty"],
    }
    (opt.output / "ta-moulton-barn-validation.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
