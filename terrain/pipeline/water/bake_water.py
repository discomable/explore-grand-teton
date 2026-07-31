#!/usr/bin/env python3
"""
Bake the authoritative water-surface elevation grid for WaterBuilder (Milestone 1 item 2).

Root problem this fixes: landcover.png's 10 m NHD wet mask + per-component elevations were
baked against the OLD 10 m DEM; the world now renders 1.25 m lidar heights. Mask and terrain
disagree, so the Snake reads dry in reaches, climbs banks in others, and breaks into
rectangular shards at cell edges.

Method (authoritative-elevation model):
  * heights come from the CURRENT tile pyramid (z4 = exactly the 10 m mask grid, decoded from
    the same webp tiles the runtime streams) — never from the stale pipeline DEM.
  * the DEM over open water IS (approximately) the water surface — lidar returns / the old
    hydro-flattened fill. So the channel elevation estimate c = mean height over wet pixels
    in a 5x5 window (bank-resistant, noise-averaging), and the final surface gets a small
    LIFT so ~90%+ of genuinely-wet pixels render above the terrain (measured: lift 0.25 →
    96% / 87% visible on the two Snake components, 3-4% clipped as real banks/bars).
  * per connected river component, the surface is a priority-flood over c from the component's
    lowest pixel: s(p) = max(c(p), s(parent)) processed lowest-first. That is exactly a
    monotonic non-increasing-downstream (isotonic) surface and it flattens reservoir pools
    automatically. A masked blur + re-flood smooths steps while preserving monotonicity.
  * lake components get one flat elevation (low percentile of c — robust to mask fringe
    sitting on 1.25 m banks).
  * reservoir-scale river components (Jackson Lake files under the Snake in NHD) additionally
    snap near-pool values onto the modal pool elevation (anchorY, used for planar reflections).
  * the surface is extended ~4 px beyond the wet mask (value of the nearest wet pixel), and a
    per-pixel wet-rule BIAS is baked alongside: +0.25 m inside the mask, declining with
    distance outside it. The runtime derives wet/dry from terrain - S - bias < 0 inside this
    candidate band, which is what clips bank-climb, fills small inter-segment gaps (a real
    channel the mask missed has terrain ≈ S - lift, well under the bias out to ~4 px), and
    puts the shoreline exactly on the heightfield∩surface intersection at every LOD.

Outputs (--out, default ../../public):
  water-surface.png  RGB: R,G = big/little byte of (S - elevMin) * 10 + 1 (0 = no water
                     surface here), B = 128 + bias * 100. Same grid as landcover.png.
  water-meta.json    georef + elevMin + component list [{id, type, elev, anchorY?, minPx,
                     maxPx, areaPx}] (ids match landcover.json's lakes where both kept).

Run:  .venv/bin/python3 water/bake_water.py     (from terrain/pipeline)
"""
import argparse, heapq, json, os
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.normpath(os.path.join(HERE, "..", "..", "public"))

MIN_PX = 20            # keep components >= this (same as make_landcover)
POOL_PX = 200000       # reservoir-scale river component => pool snap + reflection anchor
POOL_SNAP = 1.5        # m above modal pool level snapped flat
POOL_BLEND = 2.5       # m ramp back onto the flood surface above the snap band
DILATE_PX = 4          # candidate band beyond the wet mask (px of 10 m)
LIFT_RIVER = 0.25      # m the river surface sits above the flood estimate (see docstring)
LIFT_LAKE = 0.10       # lakes are hydro-flattened AT pool level — a small tie-break lift
BIAS_CORE = 0.25       # wet rule inside the mask: terrain < S + BIAS_CORE
BIAS_FALL = 0.12       # bias falls this much per px outside the mask (gap-fill vs bank-flood)
RIVER_SPREAD = 3.0     # p95-p5 height spread that separates river from lake


def load_height_grid(pub, W, H):
    """Decode the z-level of the CURRENT tile pyramid whose pixel grid is exactly the 10 m
    mask grid (native 1.25 m halved 3x -> z = maxZoom-3), cropped to WxH."""
    m = json.load(open(os.path.join(pub, "tiles.json")))
    enc = m["encoding"]
    assert enc["scheme"] == "mapbox"
    z = m["maxZoom"] - 3
    T = m["tileSize"]
    lw, lh = -(-m["width"] // 8), -(-m["height"] // 8)   # level dims (ceil)
    assert (lw, lh) == (W, H), f"z{z} level {lw}x{lh} != mask {W}x{H}"
    nx, ny = -(-lw // T), -(-lh // T)
    g = np.full((ny * T, nx * T), np.nan, np.float32)
    for tx in range(nx):
        for ty in range(ny):
            p = os.path.join(pub, "tiles", str(z), str(tx), f"{ty}.webp")
            rgb = np.asarray(Image.open(p).convert("RGB"), np.uint32)
            v = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
            g[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T] = \
                enc["baseval"] + v.astype(np.float32) * enc["interval"]
    print(f"  heights: z{z} tiles {nx}x{ny} -> {lw}x{lh} @ 10 m, "
          f"{np.nanmin(g):.0f}..{np.nanmax(g):.0f} m")
    return g[:H, :W]


def flood_monotone(c, comp_mask, seed):
    """Priority-flood from the seed: s = max(c, s(parent)), lowest surface first.
    Non-increasing downstream by construction. 8-connected."""
    H, W = c.shape
    s = np.full(c.shape, np.inf, np.float32)
    ys, xs = seed
    heap = [(float(c[ys, xs]), int(ys), int(xs))]
    s[ys, xs] = c[ys, xs]
    NB = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    while heap:
        v, y, x = heapq.heappop(heap)
        if v > s[y, x]:
            continue
        for dy, dx in NB:
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and comp_mask[ny, nx]:
                nv = max(v, float(c[ny, nx]))
                if nv < s[ny, nx]:
                    s[ny, nx] = nv
                    heapq.heappush(heap, (nv, ny, nx))
    return s


def masked_blur(a, mask, iters=3):
    """3x3 mean over mask-true pixels only (mask-false neighbours don't contaminate)."""
    out = np.where(mask, a, 0.0).astype(np.float64)
    m = mask.astype(np.float64)
    k = np.ones((3, 3))
    for _ in range(iters):
        num = ndimage.convolve(out, k, mode="nearest")
        den = ndimage.convolve(m, k, mode="nearest")
        out = np.where(mask, num / np.maximum(den, 1e-9), 0.0)
    return out.astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=PUB)
    args = ap.parse_args()

    lc = json.load(open(os.path.join(PUB, "landcover.json")))
    W, H = lc["width"], lc["height"]
    mask_rgb = np.asarray(Image.open(os.path.join(PUB, "landcover.png")).convert("RGB"))
    wet = mask_rgb[..., 1] > 127
    print(f"mask {W}x{H}, wet px {wet.sum()}")

    hgt = load_height_grid(PUB, W, H)

    # channel elevation estimate: mean height over wet pixels within a 5x5 window
    # (the DEM over open water ≈ the water surface; the masked mean averages lidar noise
    # without letting dry-bank neighbours contaminate the estimate)
    k = np.ones((5, 5))
    num = ndimage.convolve(np.where(wet, hgt, 0.0).astype(np.float64), k, mode="nearest")
    den = ndimage.convolve(wet.astype(np.float64), k, mode="nearest")
    c = np.where(wet, num / np.maximum(den, 1e-9), np.inf).astype(np.float32)

    labels, n = ndimage.label(wet)          # 4-connected — same ids as make_landcover
    surf = np.zeros((H, W), np.float32)
    kept = np.zeros((H, W), bool)
    comps = []
    slices = ndimage.find_objects(labels)
    for i in range(1, n + 1):
        sl = slices[i - 1]
        if sl is None:
            continue
        comp = labels[sl] == i
        area = int(comp.sum())
        if area < MIN_PX:
            continue
        hv = hgt[sl][comp]
        cv = c[sl][comp]
        p5, p95 = np.percentile(hv, [5, 95])
        typ = "river" if (p95 - p5) > RIVER_SPREAD else "lake"
        entry = {"id": i, "type": typ, "areaPx": area,
                 "minPx": [int(sl[1].start), int(sl[0].start)],
                 "maxPx": [int(sl[1].stop - 1), int(sl[0].stop - 1)]}
        if typ == "lake":
            flat = float(np.percentile(cv, 25)) + LIFT_LAKE
            s_comp = np.where(comp, flat, 0.0).astype(np.float32)
            entry["elev"] = round(flat, 2)
            entry["anchorY"] = round(flat, 2)
        else:
            cc = c[sl].copy()
            seed = np.unravel_index(np.argmin(np.where(comp, cc, np.inf)), cc.shape)
            s0 = flood_monotone(cc, comp, seed)
            s1 = masked_blur(s0, comp)                    # smooth steps…
            s_comp = flood_monotone(s1, comp, seed)       # …then restore exact monotonicity
            if area >= POOL_PX:
                sv = s_comp[comp]
                hist, edges = np.histogram(sv, bins=np.arange(sv.min(), sv.max() + 0.2, 0.1))
                mode = float(edges[np.argmax(hist)] + 0.05)
                e = s_comp - mode
                # Flatten the reservoir pool onto the modal level, but ONLY around that level.
                # The Jackson Lake component stays 4-connected through the dam outlet to the
                # Snake BELOW the sill (Oxbow Bend / Willow Flats), which the monotonic flood
                # correctly puts ~5 m lower (measured: 6.3k px at 2050.8–2053.8 m vs a 2055.4 m
                # pool). Snapping those DOWNSTREAM pixels UP to pool level was the mega-component
                # defect: it drowned the wetland km-scale (open water over marsh, conifers
                # standing half-submerged, an inland sea at Oxbow). Snap only the near-pool band
                # (|e| ≤ POOL_SNAP → flat; the old upper blend still tapers fringe just above the
                # pool); pixels well below the mode keep their monotonic downstream flood value,
                # so the reach reverts to the river profile and terrain-clips to the calm bend.
                up = np.where(
                    e <= POOL_SNAP, 0.0,
                    np.where(e < POOL_SNAP + POOL_BLEND,
                             (e - POOL_SNAP) * ((POOL_SNAP + POOL_BLEND) / POOL_BLEND), e))
                snapped = mode + np.where(e >= -POOL_SNAP, up, e)
                s_comp = np.where(comp, snapped, s_comp).astype(np.float32)
                entry["anchorY"] = round(mode + LIFT_RIVER, 2)
                entry["elev"] = round(mode + LIFT_RIVER, 2)
            else:
                entry["elev"] = round(float(np.median(s_comp[comp])) + LIFT_RIVER, 2)
            s_comp = s_comp + LIFT_RIVER
        surf[sl] = np.where(comp, s_comp, surf[sl])
        kept[sl] |= comp
        comps.append(entry)
    comps.sort(key=lambda L: -L["areaPx"])
    print(f"components kept: {len(comps)} "
          f"({sum(1 for L in comps if L['type'] == 'river')} river)")

    # candidate band: dilate the kept mask, extend surface by the nearest-wet value; bias
    # is BIAS_CORE inside the mask and falls off with distance outside it
    cand = ndimage.binary_dilation(kept, np.ones((3, 3), bool), iterations=DILATE_PX)
    dist, (iy, ix) = ndimage.distance_transform_edt(~kept, return_indices=True)
    sfull = np.where(kept, surf, np.where(cand, surf[iy, ix], 0.0)).astype(np.float32)
    bias = BIAS_CORE - BIAS_FALL * dist.astype(np.float32)

    # DATA-EXTENT EDGE EXTENSION (M1 fix round): the NHD mask goes ragged where the Snake
    # exits the data extent (east edge at Oxbow, x=+14160): the channel was cut mid-water in
    # 10-30 m stair-steps up to 400 m before the boundary while the DEM continues 1.5-5 m
    # BELOW the local water surface. Terrain clips the extent to a clean straight line; water
    # must reach that same line. Within an EDGE_PX corridor of any grid boundary, grow the
    # candidate band over pixels whose terrain sits clearly below the nearest-band surface,
    # keeping only growth 8-connected to the existing band (no detached puddles). Extended
    # pixels carry the nearest surface and a slightly conservative bias, so the runtime wet
    # rule (terrain < S + bias) still draws the final shoreline against real banks.
    EDGE_PX = 64        # corridor width (px of 10 m) along each grid boundary
    EDGE_DEPTH = 0.5    # m the terrain must sit below the extended surface to qualify
    EDGE_MAXD = 6.0     # …but no more than this: deeper means the nearest band pixel is an
                        # unrelated (often high-altitude) component — extending would perch
                        # water tens/hundreds of m over the valley floor (measured: genuine
                        # channel continuation at Oxbow is 1.5-5 m under S)
    EDGE_NEAR = 48      # px: nearest band pixel must be this close (same reach, S coherent)
    EDGE_BIAS = -0.05   # extended-pixel wet rule: terrain must be just under S
    ey, ex_ = np.mgrid[0:H, 0:W]
    d_edge = np.minimum(np.minimum(ex_, W - 1 - ex_), np.minimum(ey, H - 1 - ey))
    depth = surf[iy, ix] - hgt
    ok = (d_edge < EDGE_PX) & ~cand & (dist < EDGE_NEAR) & \
         (depth > EDGE_DEPTH) & (depth < EDGE_MAXD)
    st8 = np.ones((3, 3), bool)
    lbl_ok, n_ok = ndimage.label(ok, structure=st8)
    if n_ok:
        touch = np.unique(lbl_ok[ndimage.binary_dilation(cand, st8) & ok])
        ext = ok & np.isin(lbl_ok, touch[touch > 0])
        cand |= ext
        sfull = np.where(ext, surf[iy, ix], sfull)
        bias = np.where(ext, EDGE_BIAS, bias).astype(np.float32)
        print(f"  extent-edge extension: {int(ext.sum())} px grown to the data boundary")

    elev_min = float(json.load(open(os.path.join(PUB, "tiles.json")))["elevation"]["min"])
    q = np.zeros((H, W), np.uint32)
    q[cand] = np.clip(np.rint((sfull[cand] - elev_min) * 10.0) + 1, 1, 65535).astype(np.uint32)
    out = np.zeros((H, W, 3), np.uint8)
    out[..., 0] = (q >> 8) & 255
    out[..., 1] = q & 255
    out[..., 2] = np.where(cand, np.clip(np.rint(128 + bias * 100), 0, 255), 128).astype(np.uint8)
    png = os.path.join(args.out, "water-surface.png")
    Image.fromarray(out).save(png, optimize=True)

    meta = {"res": lc["res"], "width": W, "height": H,
            "originE": lc["originE"], "originN": lc["originN"],
            "world": lc["world"], "elevMin": elev_min, "scale": 0.1,
            "biasZero": 128, "biasScale": 0.01,
            "url": "water-surface.png", "comps": comps}
    with open(os.path.join(args.out, "water-meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"wrote {png} ({os.path.getsize(png)/1e6:.2f} MB) + water-meta.json")

    # sanity vs the old landcover elevations (same ids)
    old = {L["id"]: L for L in lc["lakes"]}
    for L in comps[:6]:
        o = old.get(L["id"])
        print(f"  comp {L['id']:4d} {L['type']:5s} area {L['areaPx']:7d} "
              f"elev {L['elev']:8.2f}  (old {o['elev'] if o else '—'})")


if __name__ == "__main__":
    main()
