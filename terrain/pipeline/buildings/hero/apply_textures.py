#!/usr/bin/env python3
"""Pack the registered elevations and project them onto the GLB LODs.

    python3 apply_textures.py --building terrain/pipeline/work/hero/<slug>

Stages 5 and 6. Packs the four registered wall elevations into one atlas and
the roof into its own texture, then gives every triangle UVs by projecting it
through the camera stage 3 recorded. The result is one self-contained GLB per
LOD with both images embedded.

Two materials, not five. Four separate wall textures would put LOD0 at seven
material primitives against a budget of four; one four-quadrant atlas keeps
walls to a single primitive.

Cameras come from elevations.json rather than being recomputed, so every LOD
projects through the identical camera and their textures line up. Recomputing
would derive the scale from each LOD's own vertex bounds and drift between them.
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

REPO = Path(__file__).resolve().parents[4]

TUNING = {
    "jpeg_quality": 88,             # photographic content; JPEG is core glTF
    # Target linear luma for base colour, measured off the barn atlas already
    # shipping in this world. Generated images run ~4x brighter than this.
    "albedo_linear_luma": 0.048,
    # Mean wall hue measured off a photograph of the chapel: the real logs
    # run red/blue 1.48 at 0.32 saturation, the generation 1.31 at 0.24.
    "wall_chroma_rgb": [0.340, 0.272, 0.230],
    "bleed_px": 16,                 # margin so edge samples never hit background
    "max_texture_bytes": 1572864,   # 1.5 MB budget for a whole building
    "wall_order": ["wall0", "wall1", "wall2", "wall3"],
    "quadrants": {"wall0": (0, 0), "wall1": (1, 0), "wall2": (0, 1), "wall3": (1, 1)},
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_glb(path: Path):
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
        dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16}[spec["componentType"]]
        width = {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[spec["type"]]
        flat = np.frombuffer(buffer, dtype=dtype, count=spec["count"] * width,
                             offset=view["byteOffset"])
        return flat.reshape(-1, width) if width > 1 else flat

    return [(meta["materials"][p["material"]]["name"],
             accessor(p["attributes"]["POSITION"]).astype(np.float64),
             accessor(p["attributes"]["NORMAL"]).astype(np.float64),
             accessor(p["indices"]).astype(np.int64))
            for p in meta["meshes"][0]["primitives"]]


def specs_from(manifest):
    """Rebuild the stage 3 cameras exactly as they were recorded."""
    specs = []
    for view in manifest["views"]:
        specs.append({
            "id": view["id"], "kind": view["kind"],
            "right": np.asarray(view["right"], dtype=float),
            "up": np.asarray(view["up"], dtype=float),
            "forward": np.asarray(view["forward"], dtype=float),
            "originU": float(view["originU"]), "originV": float(view["originV"]),
            "pxPerM": float(view["pxPerM"]), "tile": int(manifest["tilePx"]),
        })
    return specs


def project(points, spec):
    u = (points @ spec["right"] - spec["originU"]) * spec["pxPerM"]
    v = (points @ spec["up"] - spec["originV"]) * spec["pxPerM"]
    return u, spec["tile"] - v


def to_linear(value):
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def to_srgb(value):
    return np.where(value <= 0.0031308, value * 12.92,
                    1.055 * np.clip(value, 0, None) ** (1 / 2.4) - 0.055)


def as_albedo(image, mask):
    """Bring a generated photograph down to the albedo the renderer expects.

    A generated image already contains its own lighting, so it sits around
    mid-grey; a base colour map has to be darker and let the engine supply the
    light. Shipped straight through, the chapel's walls came out near-white in
    daylight -- mean luma 0.456 against 0.238 for the barn atlas already in the
    world, roughly 1.9x too bright.

    Matched in linear space against that existing landmark, which is the only
    calibration reference this project actually has. Scaling linear rather than
    sRGB keeps the relative shading of the logs intact instead of crushing it.
    """
    linear = to_linear(image)
    weights = np.array([0.2126, 0.7152, 0.0722])
    current = float((linear[mask] @ weights).mean())
    if current <= 1e-6:
        return image
    gain = TUNING["albedo_linear_luma"] / current
    return to_srgb(linear * gain)


def match_chroma(image, mask):
    """Pull the generated colour toward the building's real hue.

    Asked for "warm grey-brown" the model leans grey. Measured against a
    photograph of the chapel, the generated walls came back at a red/blue ratio
    of 1.31 and 0.235 saturation where the real logs are 1.48 and 0.322 -- brown,
    but washed toward grey. Corrected by per-channel gain so the mean hue
    matches; luma is re-normalised afterwards so this only moves colour.
    """
    target = np.asarray(TUNING["wall_chroma_rgb"], dtype=float)
    current = image[mask].mean(axis=0)
    if (current <= 1e-6).any():
        return image
    gain = (target / target.mean()) / (current / current.mean())
    return image * gain


def bleed(image, mask, pixels):
    """Grow painted content outward so edge samples never land on background.

    A face whose projection falls a pixel or two outside the painted silhouette
    samples empty background and renders as a flat unpainted patch -- 10 of the
    chapel's 184 wall faces did exactly that. Registration is 97-99% accurate,
    not perfect, so the margin has to absorb the remainder.
    """
    filled = image.copy()
    grown = mask.copy()
    for _ in range(pixels):
        for shift, axis in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
            rolled_mask = np.roll(grown, shift, axis=axis)
            rolled_image = np.roll(filled, shift, axis=axis)
            take = rolled_mask & ~grown
            filled[take] = rolled_image[take]
            grown = grown | take
    return filled, grown


def calibrate(tile):
    """Bring one painted elevation to albedo, correct its hue, and bleed edges."""
    image = np.asarray(tile, dtype=np.float64) / 255.0
    mask = image.max(axis=2) > 0.15
    if not mask.any():
        return tile
    adjusted = match_chroma(image, mask)
    adjusted = as_albedo(adjusted, mask)
    adjusted, _ = bleed(np.where(mask[..., None], adjusted, image), mask,
                        TUNING["bleed_px"])
    return Image.fromarray((np.clip(adjusted, 0, 1) * 255 + 0.5).astype(np.uint8))


def pack(elevations: Path, output: Path, wall_name: str, roof_name: str):
    """Four wall elevations into one atlas; the roof into its own texture."""
    tiles = {}
    for view in TUNING["wall_order"] + ["roof"]:
        path = elevations / f"{view}-painted.png"
        if not path.is_file():
            raise SystemExit(f"Missing {path}. Register every view (stage 5) first.")
        tiles[view] = calibrate(Image.open(path).convert("RGB"))
    size = tiles["wall0"].size[0]
    atlas = Image.new("RGB", (size * 2, size * 2))
    for view in TUNING["wall_order"]:
        column, row = TUNING["quadrants"][view]
        atlas.paste(tiles[view].resize((size, size), Image.LANCZOS), (column * size, row * size))
    output.mkdir(parents=True, exist_ok=True)
    wall_bytes = io.BytesIO()
    atlas.save(wall_bytes, "JPEG", quality=TUNING["jpeg_quality"], optimize=True)
    roof_bytes = io.BytesIO()
    tiles["roof"].save(roof_bytes, "JPEG", quality=TUNING["jpeg_quality"], optimize=True)
    (output / wall_name).write_bytes(wall_bytes.getvalue())
    (output / roof_name).write_bytes(roof_bytes.getvalue())
    return wall_bytes.getvalue(), roof_bytes.getvalue(), size


def uvs_for(positions, normals, indices, material, specs, tile):
    """Project each triangle through the camera stage 3 assigned it.

    A primitive only ever samples its own material's image: roof geometry uses
    the roof camera, wall geometry the wall camera it faces most squarely.
    Choosing across all five would let a steeply pitched wall pick the roof
    camera and sample shingles.
    """
    if material == "roof":
        roof = next(s for s in specs if s["kind"] == "roof")
        x, y = project(positions, roof)
        return np.clip(np.column_stack((x / tile, y / tile)), 0.0, 1.0).astype(np.float32)

    walls = [s for s in specs if s["kind"] != "roof"]
    directions = np.array([-s["forward"] for s in walls])
    owner = np.argmax(normals @ directions.T, axis=1)
    uv = np.zeros((len(positions), 2), dtype=np.float32)
    for corner in indices.reshape(-1, 3):
        spec = walls[int(owner[corner[0]])]
        column, row = TUNING["quadrants"][spec["id"]]
        x, y = project(positions[corner], spec)
        uv[corner, 0] = (column * tile + x) / (2 * tile)
        uv[corner, 1] = (row * tile + y) / (2 * tile)
    return np.clip(uv, 0.0, 1.0)


def write_glb(path: Path, parts, image_uris):
    """One GLB per LOD, with the textures referenced rather than embedded.

    Three LODs sharing two images would otherwise carry three copies each and
    triple the transfer for nothing -- only one LOD is ever visible, and the
    browser caches the images once across all three.
    """
    buffer, views, accessors, primitives, materials = bytearray(), [], [], [], []
    for name, positions, normals, uv, indices, image_index in parts:
        entries = []
        for data, kind, component in ((positions, "VEC3", 5126), (normals, "VEC3", 5126),
                                      (uv, "VEC2", 5126), (indices, "SCALAR", 5125)):
            raw = np.ascontiguousarray(data).tobytes()
            while len(buffer) % 4:
                buffer.append(0)
            views.append({"buffer": 0, "byteOffset": len(buffer), "byteLength": len(raw)})
            buffer.extend(raw)
            accessor = {"bufferView": len(views) - 1, "componentType": component,
                        "count": int(len(data)), "type": kind}
            if kind in ("VEC3", "VEC2"):
                accessor["min"] = [float(v) for v in np.asarray(data).min(axis=0)]
                accessor["max"] = [float(v) for v in np.asarray(data).max(axis=0)]
            accessors.append(accessor)
            entries.append(len(accessors) - 1)
        primitives.append({"attributes": {"POSITION": entries[0], "NORMAL": entries[1],
                                          "TEXCOORD_0": entries[2]},
                           "indices": entries[3], "material": len(materials)})
        materials.append({"name": name, "doubleSided": False,
                          "pbrMetallicRoughness": {
                              "baseColorTexture": {"index": image_index},
                              "metallicFactor": 0.0, "roughnessFactor": 0.95}})
    gltf = {
        "asset": {"version": "2.0", "generator": "apply_textures.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": primitives}], "materials": materials,
        "textures": [{"source": i, "sampler": 0} for i in range(len(image_uris))],
        "images": [{"uri": uri} for uri in image_uris],
        "samplers": [{"magFilter": 9729, "minFilter": 9987,
                      "wrapS": 33071, "wrapT": 33071}],
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


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--building", type=Path, required=True,
                        help="the work directory holding elevations/ and the GLBs")
    parser.add_argument("--output", type=Path, help="default: <building>/textured")
    opt = parser.parse_args()

    elevations = opt.building / "elevations"
    manifest = load(elevations / "elevations.json")
    specs = specs_from(manifest)
    tile = int(manifest["tilePx"])
    output = opt.output or opt.building / "textured"
    slug_early = opt.building.name
    wall_name, roof_name = f"{slug_early}-wall-atlas.jpg", f"{slug_early}-roof.jpg"
    wall_jpeg, roof_jpeg, _ = pack(elevations, output, wall_name, roof_name)
    texture_bytes = len(wall_jpeg) + len(roof_jpeg)
    print(f"  wall atlas {len(wall_jpeg) / 1024:.0f} KB + roof {len(roof_jpeg) / 1024:.0f} KB "
          f"= {texture_bytes / 1024:.0f} KB of {TUNING['max_texture_bytes'] / 1024:.0f} KB budget")

    slug = opt.building.name
    report = []
    for lod in ("lod0", "lod1", "lod2"):
        source = opt.building / f"{slug}-{lod}.glb"
        if not source.is_file():
            raise SystemExit(f"Missing {source}. Run heroblock.py (stage 2) first.")
        parts = []
        for material, positions, normals, indices in read_glb(source):
            uv = uvs_for(positions, normals, indices, material, specs, tile)
            parts.append((material, positions.astype(np.float32), normals.astype(np.float32),
                          uv, indices.astype(np.uint32), 0 if material != "roof" else 1))
        destination = output / f"{slug}-{lod}.glb"
        size = write_glb(destination, parts, [wall_name, roof_name])
        triangles = sum(len(p[4]) for p in parts) // 3
        report.append({"lod": lod.upper(), "file": destination.name,
                       "triangles": triangles, "bytes": size,
                       "materialPrimitives": len(parts)})
        print(f"  {lod.upper()}: {triangles:5d} tris, {len(parts)} primitives, "
              f"{size / 1024:.0f} KB -> {destination.name}")

    (output / "textures.json").write_text(json.dumps({
        "building": manifest["building"], "textureBytes": texture_bytes,
        "wallAtlas": wall_name, "roof": roof_name,
        "quadrants": TUNING["quadrants"], "lods": report,
    }, indent=2) + "\n", encoding="utf-8")

    if texture_bytes > TUNING["max_texture_bytes"]:
        print(f"\nFAIL textures are {texture_bytes / 1024:.0f} KB, over the "
              f"{TUNING['max_texture_bytes'] / 1024:.0f} KB budget. Lower jpeg_quality "
              "or halve the roof texture.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
