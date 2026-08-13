#!/usr/bin/env python3
"""Bake conservative quadtree geometric error from the shipped terrain-RGB pyramid.

The bake is intentionally based on the encoded tiles consumed by TerrainStreamer rather than a
pipeline-only DEM. That makes it reproducible for local/R2 tile sets and includes terrain-RGB
quantization. Each node stores the maximum deviation of the actual grid surface from the finest
descendant texture surface. Errors are accumulated bottom-up with the triangle inequality, so the
0.1 m upward quantization never understates relief even when maxima occur at different positions.
"""
import argparse
import json
import math
import os
import struct

import numpy as np
from PIL import Image

MAGIC = b"GTE1"
VERSION = 1
QUANTIZATION = 0.1
GRIDS = (16, 32, 48, 64, 96, 160)


def decode_tile(path, manifest, z, x, y):
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint32)
    encoded = rgb[:, :, 0] * 65536 + rgb[:, :, 1] * 256 + rgb[:, :, 2]
    height = (manifest["encoding"]["baseval"] +
              encoded.astype(np.float32) * manifest["encoding"]["interval"])
    # Match TerrainStreamer._decodeHeight: edge tiles replicate their last real texel.
    size = manifest["tileSize"]
    scale = 1 << (manifest["maxZoom"] - z)
    level_w = math.ceil(manifest["width"] / scale)
    level_h = math.ceil(manifest["height"] / scale)
    valid_x = max(1, min(size, level_w - x * size))
    valid_y = max(1, min(size, level_h - y * size))
    if valid_x < size:
        height[:, valid_x:] = height[:, valid_x - 1:valid_x]
    if valid_y < size:
        height[valid_y:, :] = height[valid_y - 1:valid_y, :]
    return height


def bilinear(field, u, v):
    """Sample a square field at normalized meshgrid coordinates u/v."""
    size = field.shape[0]
    px = np.clip(u * (size - 1), 0, size - 1)
    py = np.clip(v * (size - 1), 0, size - 1)
    x0 = np.floor(px).astype(np.int32); y0 = np.floor(py).astype(np.int32)
    x1 = np.minimum(x0 + 1, size - 1); y1 = np.minimum(y0 + 1, size - 1)
    fx = px - x0; fy = py - y0
    return ((field[y0, x0] * (1 - fx) + field[y0, x1] * fx) * (1 - fy) +
            (field[y1, x0] * (1 - fx) + field[y1, x1] * fx) * fy)


def grid_surface(tile, grid, sample_step=1):
    """Reproduce makeGrid's b-c diagonal surface at terrain texel sample positions."""
    size = tile.shape[0]
    lattice = np.linspace(0, 1, grid + 1, dtype=np.float32)
    lu, lv = np.meshgrid(lattice, lattice)
    vertices = bilinear(tile, lu, lv)
    coords = np.arange(0, size, sample_step, dtype=np.float32) / (size - 1)
    u, v = np.meshgrid(coords, coords)
    gx = np.minimum(np.floor(u * grid).astype(np.int32), grid - 1)
    gy = np.minimum(np.floor(v * grid).astype(np.int32), grid - 1)
    fx = u * grid - gx; fy = v * grid - gy
    a = vertices[gy, gx]; b = vertices[gy, gx + 1]
    c = vertices[gy + 1, gx]; d = vertices[gy + 1, gx + 1]
    lower = a + (b - a) * fx + (c - a) * fy
    upper = d + (c - d) * (1 - fx) + (b - d) * (1 - fy)
    return np.where(fx + fy <= 1, lower, upper)


def grids_for_zoom(z, max_zoom):
    depth = max_zoom - z
    if depth == 0:
        return (48, 64, 96, 160)
    if depth <= 2:
        return (48, 64)
    if depth == 3:
        return (32,)
    return (16,)


def tile_counts(manifest, z):
    coverage = manifest["tileSize"] * (1 << (manifest["maxZoom"] - z))
    return math.ceil(manifest["width"] / coverage), math.ceil(manifest["height"] / coverage)


def bake(manifest_path, tiles_dir, output_path, sample_step=1):
    with open(manifest_path, encoding="utf8") as stream:
        manifest = json.load(stream)
    max_zoom = manifest["maxZoom"]
    size = manifest["tileSize"]
    coords = np.arange(0, size, sample_step, dtype=np.float32) / (size - 1)
    su, sv = np.meshgrid(coords, coords)
    inherited = {}
    level_values = [None] * (max_zoom + 1)

    for z in range(max_zoom, -1, -1):
        nx, ny = tile_counts(manifest, z)
        values = np.full((ny, nx, len(GRIDS)), np.nan, dtype=np.float32)
        next_inherited = {}
        active_grids = grids_for_zoom(z, max_zoom)
        print(f"z{z}: {nx}x{ny}, grids {active_grids}", flush=True)
        for y in range(ny):
            for x in range(nx):
                path = os.path.join(tiles_dir, str(z), str(x), f"{y}.webp")
                tile = decode_tile(path, manifest, z, x, y)
                descendant_error = 0.0
                if z < max_zoom:
                    for dy in range(2):
                        for dx in range(2):
                            child_key = (x * 2 + dx, y * 2 + dy)
                            child = inherited.get(child_key)
                            if child is None:
                                continue
                            child_tile, child_error = child
                            pu = (dx + su) * 0.5; pv = (dy + sv) * 0.5
                            parent_on_child = bilinear(tile, pu, pv)
                            child_samples = child_tile[::sample_step, ::sample_step]
                            cross = float(np.max(np.abs(parent_on_child - child_samples)))
                            descendant_error = max(descendant_error, child_error + cross)
                for grid in active_grids:
                    surface = grid_surface(tile, grid, sample_step)
                    local = float(np.max(np.abs(tile[::sample_step, ::sample_step] - surface)))
                    values[y, x, GRIDS.index(grid)] = descendant_error + local
                next_inherited[(x, y)] = (tile, descendant_error)
        inherited = next_inherited
        level_values[z] = values

    header_size = 16 + len(GRIDS) * 2 + len(level_values) * 8
    offsets = []
    count = 0
    for level in level_values:
        offsets.append(count)
        count += level.shape[0] * level.shape[1] * len(GRIDS)
    payload = np.full(count, 0xffff, dtype="<u2")
    cursor = 0
    for level in level_values:
        flat = level.reshape(-1)
        present = np.isfinite(flat)
        quantized = np.minimum(0xfffe, np.ceil(flat[present] / QUANTIZATION)).astype("<u2")
        payload[cursor:cursor + len(flat)][present] = quantized
        cursor += len(flat)
    with open(output_path, "wb") as stream:
        stream.write(struct.pack("<4sHHHHf", MAGIC, VERSION, len(level_values), len(GRIDS), 0,
                                 QUANTIZATION))
        stream.write(struct.pack("<" + "H" * len(GRIDS), *GRIDS))
        for z, level in enumerate(level_values):
            ny, nx, _ = level.shape
            stream.write(struct.pack("<HHI", nx, ny, offsets[z]))
        stream.write(payload.tobytes())
    print(f"wrote {output_path}: {os.path.getsize(output_path):,} bytes", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="terrain/public/tiles.json")
    parser.add_argument("--tiles", default="terrain/public/tiles")
    parser.add_argument("--out", default="terrain/public/terrain-error.bin")
    parser.add_argument("--sample-step", type=int, default=1,
                        help="diagnostic acceleration only; production must use 1")
    args = parser.parse_args()
    bake(args.manifest, args.tiles, args.out, max(1, args.sample_step))


if __name__ == "__main__":
    main()
