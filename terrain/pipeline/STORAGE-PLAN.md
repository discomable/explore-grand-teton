# Storage plan (2026-07-11)

Working constraint: limited disk. Keep only (a) live runtime assets in `terrain/public/`,
(b) source *vector* data that is slow/annoying to refetch, (c) pipeline scripts. Everything
raster-intermediate is deleted after its bake lands — regeneration paths below.

## Deleted (regenerable)
| What | Size | Why safe | Regenerate |
|---|---|---|---|
| `pipeline/work1m/` (merged DEMs + 8 TNM 1 m source tiles) | 7.5 GB | 1 m bake is LIVE: `tiles.json` maxZoom 7, 2,925 z7 height tiles in `public/tiles/7/` | `python3 pipeline/fetch_1m_tnm.py` (tile URLs in `data/dem_3dep/tile_list_full_extent.json`), then the tile_pyramid/encode steps in `pipeline/` |
| `data/nhdplus/NHDPLUS_H_1704_HU4_GDB.zip` | 288 MB | extracted GDB retained (752 MB) | URL in `SOURCES.md` |
| `data/dem_3dep/USGS_1M_12_x51y484_*.tif` (sample tile) | 241 MB | duplicate of a work1m source; bake complete | URL in `tile_list_full_extent.json` |
| superseded review shots in `shots/` | ~200 MB | all shots regenerate via `python3 snap.py` (views files kept) | `snap.py` + the relevant `views-*.json` |

## Kept deliberately
- `data/nhdplus/extracted/` (752 MB) — creek centerlines for a future water/ribbon pass; re-download is 288 MB + slow.
- `data/osm`, `ms_buildings`, `gnis`, `landfire`, `tiger_roads` (~55 MB total) — active roadmap inputs.
- `shots/baseline-premodular/` standard 7 views only — visual-regression reference.

## Deferred on storage grounds (decision, not omission)
- **NAIP 0.6 m re-bake**: ~45 GB source for a near-field sharpness gain — not worth it on this disk; the 1.25 m imagery + shader detail noise carries it.
- **Full LiDAR point cloud pulls**: use windowed EPT queries (PDAL) or the 4.8 MB LANDFIRE EVH/EVC rasters for vegetation height instead.
- Full-extent 1 m DEM refetch (97 tiles / 14.6 GB): already baked; only refetch per-tile if a future re-bake needs it.

Runtime memory notes: TerrainStreamer caches ≈ 300 height + 250 imagery tiles (~0.5 GB peak);
Landcover mask fully resident (~46 MB); vegetation photo-atlas candidates (~52 MB) decoded at
boot for the runtime bake — pre-baking that atlas to one file is queued as a boot-memory win.
