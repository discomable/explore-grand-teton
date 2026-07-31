# Grand Teton — 1 m terrain pipeline & streamer

Goal: replace the procedural `terrainHeight()` with **real USGS 3DEP elevation**, streamed as
a quadtree of tiles so we never hold more than ~100 MB live regardless of how much 1 m data exists.

Two halves:

1. **Offline pipeline** (`pipeline/`) — run once. Fetches the DEM, reprojects to a local metric
   grid, encodes elevation into terrain-RGB, and cuts a `{z}/{x}/{y}` tile pyramid + `tiles.json`.
2. **Runtime streamer** (`src/`) — a Three.js quadtree that loads only the tiles the camera can
   see, at the LOD it needs, with an LRU cache, request cancellation, and a Service-Worker tile
   cache for instant revisits / offline.

## Strategy (why this shape)

At 1 m, ~1,000 km² is ~1 billion samples ≈ 4 GB as Float32 — impossible to hold or draw, and it
blows past the 16384² GPU texture limit. So:

- **Hybrid coverage.** A **10 m baked base** (whole park, ~40 MB, always resident) gives instant
  load, full-world silhouette, and collision everywhere. **1 m tiles stream only for the near
  field** (~1–2 km around the camera), which is the only place 1 m is visible through haze.
- **Never global, always working-set.** Live memory = visible tiles + a capped LRU cache, ~100 MB.
- **CPU-decode terrain-RGB → float texture.** terrain-RGB packs height into RGB bytes; you *cannot*
  GPU-bilinear-filter the packed bytes (interpolating across byte carries is garbage). We decode
  each tile to a `Float32` `DataTexture` once at load, then GPU linear filtering is correct — and
  the decoded array doubles as the near-field collision source.

## Coordinate system

- Reproject to **UTM Zone 12N (EPSG:32612)** — meters, minimal distortion over the Tetons.
- World mapping (matches the existing app: x+ = east, z− = north, y = meters up):
  - `worldX = easting  - centerEasting`
  - `worldZ = centerNorthing - northing`
  - `worldY = elevation - datum`  (datum ≈ valley floor so the valley sits near y=0)
- 1 world unit = 1 meter. This changes the old arbitrary scale — real relief is ~2,000 m
  (valley ~2000 m → Grand Teton 4,199 m), so movement speeds and fog are rescaled in the streamer
  config (see `src/TerrainStreamer.js` `DEFAULTS`).

## Tile scheme

- **UTM raster quadtree** via `gdal2tiles --profile=raster --xyz`. Zoom 0 = whole area in one
  512×512 tile (coarsest); max zoom = native 1 m. ~8 levels for a ~28×41 km area.
- Tile = **512×512 px**, **terrain-RGB** (Mapbox encoding: `h = -10000 + (R*65536 + G*256 + B)*0.1`,
  0.1 m precision), stored as **lossless WebP** (~80 KB/tile).
- Whole pyramid for ~1,000 km² ≈ 5,000–6,000 tiles ≈ ~450 MB on disk. Hosted; never downloaded whole.
- `tiles.json` carries the geotransform, elevation range, tile size, zoom range, and URL template
  so the runtime maps world XZ ↔ pixel ↔ tile exactly. See `tiles.json.example`.

## Runtime memory budget

| Item | Budget |
|---|---|
| Visible working set (~50–150 tiles) | ~50–100 MB |
| LRU cache (capped, tunable) | ≤ 512 MB |
| Shared grid geometries (few densities) | negligible |
| 10 m base (Float32, whole park) | ~40 MB, always resident |

Controls that keep it bounded (all in `TerrainStreamer`):
- **LRU eviction** by tile count; evicted tiles `.dispose()` their texture (shared geometry is not disposed).
- **AbortController** per in-flight fetch; aborted when a node is pruned or leaves the frustum.
- **Upload budget** — cap decoded-tile → GPU uploads per frame (default 3) to avoid hitches; the rest queue.
- **Prefetch** — the next-coarser parent (for LOD morph) + a ring of neighbors in the velocity direction (matters most in fly mode).

## How to run the pipeline

Prereqs: `gdal` (≥3.4, with python bindings), `rio-rgbify` (`pip install rio-rgbify`), `cwebp`,
and a free **OpenTopography API key** (https://portal.opentopography.org).

```bash
cd terrain/pipeline
pip install -r requirements.txt
export OT_API_KEY=xxxxxxxx
# edit BBOX in fetch_and_tile.sh, then:
DATASET=USGS10m RES=10 ./fetch_and_tile.sh   # → ../public/tiles/{z}/{x}/{y}.webp + tiles.json

# landcover mask (trees + water) — needs work/dem_filled.tif from the step above:
python3 make_landcover.py --manifest ../public/tiles.json --dem work/dem_filled.tif \
    --res 10 --out ../public                 # → ../public/landcover.png + landcover.json
```

Then wire `src/TerrainStreamer.js` into `grand-teton-3d.html` (integration steps at the bottom of
that file). The streamer replaces `buildTerrain()` + the `collGrid`/`sampleGround` path; everything
else (sky, water, forest, labels) keeps deriving from the streamer's `heightAt(x,z)`.

## Build phases

1. **Base first (de-risk).** Bake the **10 m** pyramid (`DATASET=USGS10m RES=10`). Wire the
   streamer in base-only mode. Huge fidelity jump, keeps instant load. ← *start here*
2. **Landcover mask.** `make_landcover.py` → real lakes/river (`WaterBuilder`, NHD polygons at
   hydro-flattened DEM elevations) + streamed forests (`ScatterManager`, NLCD classes, scatter
   cells around the camera). Both consume the always-resident mask — no extra streaming.
3. **1 m near-field streaming.** Generate the 1 m pyramid, enable streaming layered on the base.
4. **Service-Worker cache** (`src/sw-tiles.js`) for offline + instant revisit.
5. **Polish** — LOD morphing, near-field collision refinement, real place-name labels from GNIS,
   optional 1 m "hero region" only around the Cathedral Group to shrink the pyramid.
