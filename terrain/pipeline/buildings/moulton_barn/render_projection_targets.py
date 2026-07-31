"""Render fixed-camera targets for image-assisted T. A. Moulton Barn texturing.

Run:
  blender --background --python render_projection_targets.py -- \
    --model ../../../public/models/ta-moulton-barn-lod0.glb \
    --output ../../data/moulton-barn/projection-targets
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent


def options():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path,
                        default=HERE / "../../../public/models/ta-moulton-barn-lod0.glb")
    parser.add_argument("--output", type=Path,
                        default=HERE / "../../data/moulton-barn/projection-targets")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def aim(camera, point):
    camera.rotation_euler = (Vector(point) - camera.location).to_track_quat("-Z", "Y").to_euler()


def main():
    opt = options()
    opt.output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(opt.model.resolve()))

    clay = bpy.data.materials.new("projection_target_clay")
    clay.diffuse_color = (0.48, 0.45, 0.40, 1)
    clay.roughness = 1
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.data.materials.clear()
            obj.data.materials.append(clay)

    camera_data = bpy.data.cameras.new("ProjectionCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 13
    camera = bpy.data.objects.new("ProjectionCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    key_data = bpy.data.lights.new("Large softbox", "AREA")
    key_data.energy = 1100
    key_data.shape = "DISK"
    key_data.size = 12
    key = bpy.data.objects.new("Large softbox", key_data)
    key.location = (-8, -10, 14)
    bpy.context.collection.objects.link(key)

    world = bpy.context.scene.world or bpy.data.worlds.new("ProjectionWorld")
    bpy.context.scene.world = world
    world.color = (0.16, 0.16, 0.16)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1536
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"

    views = {
        # The export's X axis faces the photographed main elevation; Y runs along the ridge.
        "front": ((32, 0, 3.1), (0, 0, 3.1), 12),
        "side": ((0, -32, 3.1), (0, 0, 3.1), 12),
    }
    for name, (location, target, ortho_scale) in views.items():
        camera.location = location
        camera_data.ortho_scale = ortho_scale
        key.location = location
        aim(camera, target)
        aim(key, target)
        scene.render.filepath = str((opt.output / f"{name}-clay.png").resolve())
        bpy.ops.render.render(write_still=True)
        print(f"wrote {scene.render.filepath}")


if __name__ == "__main__":
    main()
