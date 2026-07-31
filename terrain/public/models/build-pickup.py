#!/usr/bin/env python3
"""build-pickup.py — bake Quaternius "Pickup Truck" (CC0, poly.pizza/m/qn4grQgHm8)
into the game-ready terrain/public/models/pickup.glb. Deterministic, no RNG.

Input : pickup-src.glb (raw download, see ASSETS.md; re-download from
        https://static.poly.pizza/4e925a01-dbb8-4aab-848b-221306b835ea.glb)
Output: pickup.glb next to this script.

What it does (offline, so the runtime stays dumb):
  1. Bakes every node transform (rot -90deg X, scale 100) into the vertices,
     then scales to real dims (SC=0.82 -> 1.90 m wide, 4.25 m long) and yaws
     180deg so forward = -Z (the game's car convention). Origin at ground.
  2. Splits the window glass out of the Atlas body primitive by palette colour
     (68,68,68 above the beltline) into its own node "Glass", and the cab
     greenhouse (roof/pillars/rear wall above the beltline) into "CabTop";
     first person hides both (glass is opaque; pillars would z-clip on
     look-back with the 0.5 near plane).
  3. Re-pivots the wheels: vertices stored about each wheel centre, node
     translation = centre, so the runtime can spin/steer them directly.
  Nodes out: Body, Glass, CabTop, WheelFL, WheelFR, WheelB (back pair, one node).
"""
import struct, json, zlib, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "pickup-src.glb")
OUT = os.path.join(HERE, "pickup.glb")
SC = 0.82                      # 2.31 m raw width -> 1.90 m
GLASS = (68, 68, 68)           # window pane colour in the palette atlas
GLASS_MIN_Y = 0.98             # …but only glasshouse faces (same colour reappears low on the grille)

d = open(SRC, "rb").read()
jlen = struct.unpack_from("<I", d, 12)[0]
g = json.loads(d[20:20 + jlen])
binoff = 20 + jlen + 8

def acc(ai, ncomp, dtype):
    a = g["accessors"][ai]; bv = g["bufferViews"][a["bufferView"]]
    off = binoff + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    return np.frombuffer(d, dtype=dtype, count=a["count"] * ncomp, offset=off).reshape(a["count"], ncomp)

def prim_arrays(p):
    pos = acc(p["attributes"]["POSITION"], 3, np.float32)
    nrm = acc(p["attributes"]["NORMAL"], 3, np.float32)
    uv = acc(p["attributes"]["TEXCOORD_0"], 2, np.float32)
    ia = g["accessors"][p["indices"]]
    dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}[ia["componentType"]]
    idx = acc(p["indices"], 1, dt).ravel().astype(np.uint32)
    return pos, nrm, uv, idx

# node bake: raw -> (x, z, -y)*100  [rot -90 X, scale 100]; then flip yaw pi
# (-x, y, -z) and scale SC. Normals: rotations only (uniform scale drops out).
def bake_pos(pos):
    w = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], axis=1) * 100.0
    return np.stack([-w[:, 0], w[:, 1], -w[:, 2]], axis=1) * SC
def bake_nrm(nrm):
    w = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], axis=1)
    return np.stack([-w[:, 0], w[:, 1], -w[:, 2]], axis=1)

# decode the 512x512 RGBA palette PNG (to classify faces by colour)
def decode_png(png):
    pos = 8; idat = b""; w = h = None
    while pos < len(png):
        l = struct.unpack(">I", png[pos:pos + 4])[0]; typ = png[pos + 4:pos + 8]
        if typ == b"IHDR": w, h = struct.unpack(">II", png[pos + 8:pos + 16])
        if typ == b"IDAT": idat += png[pos + 8:pos + 8 + l]
        pos += 12 + l
    raw = zlib.decompress(idat); stride = w * 4
    out = np.zeros((h, w, 4), np.uint8); prev = np.zeros(stride, np.int64); p = 0
    for y in range(h):
        f = raw[p]; row = np.frombuffer(raw, np.uint8, stride, p + 1).astype(np.int64); p += 1 + stride
        if f == 1:
            for i in range(4, stride): row[i] = (row[i] + row[i - 4]) & 255
        elif f == 2: row = (row + prev) & 255
        elif f == 3:
            for i in range(stride): row[i] = (row[i] + ((row[i - 4] if i >= 4 else 0) + prev[i]) // 2) & 255
        elif f == 4:
            for i in range(stride):
                a = row[i - 4] if i >= 4 else 0; b = prev[i]; c = prev[i - 4] if i >= 4 else 0
                pp = a + b - c; pa = abs(pp - a); pb = abs(pp - b); pc = abs(pp - c)
                row[i] = (row[i] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))) & 255
        out[y] = row.astype(np.uint8).reshape(w, 4); prev = row
    return out

img_bv = g["bufferViews"][g["images"][0]["bufferView"]]
png = d[binoff + img_bv.get("byteOffset", 0): binoff + img_bv.get("byteOffset", 0) + img_bv["byteLength"]]
atlas = decode_png(png)

meshes = {m["name"]: m for m in g["meshes"]}

def subset(pos, nrm, uv, idx, tri_mask):
    """keep triangles where tri_mask, reindex compactly"""
    keep = idx.reshape(-1, 3)[tri_mask].ravel()
    uniq, inv = np.unique(keep, return_inverse=True)
    return pos[uniq], nrm[uniq], uv[uniq], inv.astype(np.uint32)

out_prims = []   # (node_name, material_idx, pos, nrm, uv, idx, translation)

# --- body: split Atlas prim into paint vs glass; carry lights prims as-is ---
MAT_ATLAS, MAT_GLASS, MAT_HEAD, MAT_BRAKE = 0, 1, 2, 3
for p in meshes["Pickup"]["primitives"]:
    pos, nrm, uv, idx = prim_arrays(p)
    pos = bake_pos(pos); nrm = bake_nrm(nrm)
    mname = g["materials"][p["material"]]["name"]
    if mname == "Atlas":
        uvt = uv[idx].reshape(-1, 3, 2).mean(1)
        px = (uvt[:, 0] * (atlas.shape[1] - 1)).astype(int) % atlas.shape[1]
        py = (uvt[:, 1] * (atlas.shape[0] - 1)).astype(int) % atlas.shape[0]
        cols = atlas[py, px][:, :3]
        tctr = pos[idx].reshape(-1, 3, 3).mean(1)
        is_glass = ((cols[:, 0] == GLASS[0]) & (cols[:, 1] == GLASS[1]) & (cols[:, 2] == GLASS[2])
                    & (tctr[:, 1] > GLASS_MIN_Y))
        # cab greenhouse above the beltline (roof, pillars, rear cab wall, mirrors)
        is_top = (~is_glass) & (tctr[:, 1] > 1.10) & (tctr[:, 2] > -1.02) & (tctr[:, 2] < 0.12)
        is_body = ~(is_glass | is_top)
        out_prims.append(("Body", MAT_ATLAS) + subset(pos, nrm, uv, idx, is_body) + (None,))
        out_prims.append(("Glass", MAT_GLASS) + subset(pos, nrm, uv, idx, is_glass) + (None,))
        out_prims.append(("CabTop", MAT_ATLAS) + subset(pos, nrm, uv, idx, is_top) + (None,))
        print(f"body {is_body.sum()} tris, glass {is_glass.sum()} tris, cabtop {is_top.sum()} tris")
        gz = pos[idx].reshape(-1, 3, 3)[is_glass]
        front = gz[gz[:, :, 2].mean(1) < -0.3]
        if len(front): print("windshield z", front[:, :, 2].min(), front[:, :, 2].max(),
                             "y", front[:, :, 1].min(), front[:, :, 1].max())
    else:
        mi = MAT_HEAD if mname == "Headlights" else MAT_BRAKE
        out_prims.append(("Body", mi, pos, nrm, uv, idx.astype(np.uint32), None))

# --- wheels: recentre about their bbox centre, node translation = centre ---
for src, name in [("FrontWheel_L", None), ("FrontWheel_R", None), ("BackWheels", "WheelB")]:
    p = meshes[src]["primitives"][0]
    pos, nrm, uv, idx = prim_arrays(p)
    pos = bake_pos(pos); nrm = bake_nrm(nrm)
    ctr = (pos.min(0) + pos.max(0)) / 2
    if name is None:  # L/R raw names refer to pre-flip; resolve by final x
        name = "WheelFL" if ctr[0] < 0 else "WheelFR"
    out_prims.append((name, MAT_ATLAS, pos - ctr, nrm, uv, idx.astype(np.uint32), ctr))
    print(name, "centre", np.round(ctr, 3), "radius", round(float(pos[:, 1].max() - pos[:, 1].min()) / 2, 3))

# --- materials (tweaked for the ACES scene; Glass gets its own, hideable) ---
materials = [
    {"name": "Atlas", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0},
     "metallicFactor": 0.25, "roughnessFactor": 0.55}},
    {"name": "Glass", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0},
     "metallicFactor": 0.6, "roughnessFactor": 0.15}},
    {"name": "Headlights", "pbrMetallicRoughness": {"baseColorFactor": [0.799, 0.605, 0.173, 1.0],
     "metallicFactor": 0.4, "roughnessFactor": 0.27}},
    {"name": "BrakeLight", "pbrMetallicRoughness": {"baseColorFactor": [0.55, 0.06, 0.05, 1.0],
     "metallicFactor": 0.4, "roughnessFactor": 0.27}},
]

# --- assemble glb ---
def pad(b, n=4, c=b"\x00"): return b + c * (-len(b) % n)
bufviews, accessors, bin_parts, off = [], [], [], 0
def add_bv(data, target=None):
    global off
    b = pad(data)
    bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
    if target: bv["target"] = target
    bufviews.append(bv); bin_parts.append(b); off += len(b)
    return len(bufviews) - 1
def add_acc(arr, comptype, typ, target, minmax=False):
    bvi = add_bv(arr.tobytes(), target)
    a = {"bufferView": bvi, "componentType": comptype, "count": len(arr), "type": typ}
    if minmax:
        a["min"] = [float(x) for x in arr.min(0)]; a["max"] = [float(x) for x in arr.max(0)]
    accessors.append(a)
    return len(accessors) - 1

nodes, meshes_out = {}, []
for name, mat, pos, nrm, uv, idx, tr in out_prims:
    prim = {"attributes": {
        "POSITION": add_acc(pos.astype(np.float32), 5126, "VEC3", 34962, True),
        "NORMAL": add_acc(nrm.astype(np.float32), 5126, "VEC3", 34962),
        "TEXCOORD_0": add_acc(uv.astype(np.float32), 5126, "VEC2", 34962)},
        "indices": add_acc(idx.astype(np.uint16).reshape(-1, 1), 5123, "SCALAR", 34963),
        "material": mat}
    if name in nodes:
        meshes_out[nodes[name]["mesh"]]["primitives"].append(prim)
    else:
        meshes_out.append({"name": name, "primitives": [prim]})
        nodes[name] = {"name": name, "mesh": len(meshes_out) - 1}
        if tr is not None: nodes[name]["translation"] = [float(x) for x in tr]
img_bvi = add_bv(png)

node_list = list(nodes.values())
gltf = {"asset": {"version": "2.0", "generator": "build-pickup.py",
                  "copyright": "Model: 'Pickup Truck' by Quaternius, CC0 1.0 (poly.pizza/m/qn4grQgHm8)"},
        "scene": 0, "scenes": [{"nodes": list(range(len(node_list)))}],
        "nodes": node_list, "meshes": meshes_out, "materials": materials,
        "textures": [{"sampler": 0, "source": 0}],
        "images": [{"bufferView": img_bvi, "mimeType": "image/png"}],
        "samplers": [{"magFilter": 9728, "minFilter": 9986, "wrapS": 10497, "wrapT": 10497}],
        "bufferViews": bufviews, "buffers": [{"byteLength": off}],
        "accessors": accessors}

js = pad(json.dumps(gltf, separators=(",", ":")).encode(), 4, b" ")
bb = b"".join(bin_parts)
total = 12 + 8 + len(js) + 8 + len(bb)
with open(OUT, "wb") as f:
    f.write(struct.pack("<III", 0x46546C67, 2, total))
    f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
    f.write(struct.pack("<II", len(bb), 0x004E4942) + bb)
print("wrote", OUT, total, "bytes")
