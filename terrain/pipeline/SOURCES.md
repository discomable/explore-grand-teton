# Data Sources — Grand Teton / Jackson Hole 3D World

Area of interest (AOI): lat 43.48–44.10, lon -110.95 to -110.45 (WGS84).
World frame: `terrain/public/tiles.json` — EPSG:32612, easting 508,020–536,340 m,
northing 4,821,916–4,863,096 m (center 522180.8 E / 4842506.2 N), confirmed inside the AOI bbox.

All fetched: **2026-07-10**. Total on disk: ~1.3 GB (budget 2 GB — OK).
One subdirectory per source. Downloads verified with `unzip -t` / `gdalinfo` / JSON parse.

---

## 1. Census TIGER/Line Roads — Teton County, WY (`tiger_roads/`)

- **URL:** https://www2.census.gov/geo/tiger/TIGER2024/ROADS/tl_2024_56039_roads.zip
  (2024 is the newest vintage available; 2023 also exists at the analogous path)
- **Files:** `tl_2024_56039_roads.zip` (807 KB, zip OK) + extracted shapefile in `tl_2024_56039_roads/`
- **Features:** 3,433 road linestrings (counted from .shx)
- **License:** US public domain (US Census Bureau)

## 2. OpenStreetMap extracts via Overpass API (`osm/`)

Endpoint: `https://overpass-api.de/api/interpreter`, bbox `(43.48,-110.95,44.10,-110.45)`,
output `[out:json]`, geometry via `out geom;`. Three queries with pauses between them:

| File | Query | Elements | Size |
|---|---|---|---|
| `buildings.osm.json` | `way["building"]` + `relation["building"]` | 7,120 | 6.8 MB |
| `roads.osm.json` | `way["highway"]` | 9,026 | 14.5 MB |
| `trails_pois.osm.json` | `way["highway"~"^(path\|footway)$"]` + `node/way["tourism"]` + `node/way["amenity"]` | 4,761 | 7.2 MB |

- **Problems encountered:** one roads request timed out client-side and the immediate retry got
  HTTP 406 (rate limit / missing UA). Resolved by waiting ~90 s and sending a descriptive
  `User-Agent`. No Geofabrik fallback needed.
- **License:** ODbL 1.0. **Attribution required:** "© OpenStreetMap contributors". Derived
  databases must remain ODbL.

## 3. Microsoft US Building Footprints — Wyoming (`ms_buildings/`)

- **URL:** https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Wyoming.geojson.zip
  (NOTE: the old `usbuildingdata.blob.core.windows.net` host now returns 409 "public access
  not permitted"; current links are in the README of github.com/microsoft/USBuildingFootprints)
- **File:** `Wyoming.geojson.zip` (13 MB, zip OK)
- **Features:** 386,518 polygons (whole state — clip to AOI happens later in the pipeline)
- **License:** ODbL (per Microsoft USBuildingFootprints repo)

## 4. USGS GNIS Domestic Names — Wyoming (`gnis/`)

- **URL:** https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_WY_Text.zip
  (the older `.../Topical/DomesticNames_WY.zip` path 404s)
- **Files:** `DomesticNames_WY_Text.zip` (839 KB, zip OK) + extracted
  `DomesticNames_WY_Text/Text/DomesticNames_WY.txt`
- **Rows:** 19,098 names (19,099 lines incl. header; pipe-delimited)
- **License:** US public domain (USGS)

## 5. NHDPlus HR — Snake Headwaters HU4 1704 (`nhdplus/`)

- **URL:** https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHDPlusHR/VPU/Current/GDB/NHDPLUS_H_1704_HU4_GDB.zip
  (Current VPU snapshot; a Beta copy also exists under `.../Beta/GDB/`, 304 MB)
- **Files:** `NHDPLUS_H_1704_HU4_GDB.zip` (302 MB, zip OK) + extracted GDB in `extracted/`
- **Features:** NHDFlowline = 128,209 (3D measured multilinestring); GDB covers the whole HU4
  (extent -115.35..-109.77, 41.44..44.75) — filter to AOI / HU8 17040101 later
- HU8-only subsets are not individually staged for NHDPlus HR, hence the HU4 pull (well under
  the 800 MB threshold)
- **License:** US public domain (USGS)

## 6. LANDFIRE EVH + EVC clipped to AOI (`landfire/`)

- **API:** LANDFIRE Product Service (LFPS) — fully non-interactive:
  1. `GET https://lfps.usgs.gov/api/job/submit?Layer_List=LF2025_EVH;LF2025_EVC&Area_of_Interest=-110.95 43.48 -110.45 44.10&Email=<email>`
  2. Poll `GET https://lfps.usgs.gov/api/job/status?JobId=<id>` until `Succeeded`
  3. Download `outputFile` zip
- **Gotcha:** legacy short product codes (`240EVH;240EVC`) now fail with "Invalid products".
  Valid layer names come from `GET https://lfps.usgs.gov/api/products` (e.g. `LF2025_EVH`).
- **File:** `LF2025_EVH_EVC_bbox.zip` (4.8 MB) + extracted GeoTIFF in `extracted/`
- **Contents:** single GeoTIFF, 1349×2298 px, 30 m, NAD83 CONUS Albers, Int16, NoData -9999;
  Band 1 = `LF2025_EVH_CONUS`, Band 2 = `LF2025_EVC_CONUS` (LANDFIRE LF 2025 version)
- **License:** US public domain (LANDFIRE is a USGS/USDA product)

---

## 7. USGS 3DEP 1 m DEM — SAMPLE ONLY (`dem_3dep/`)

- **Sample downloaded:** `USGS_1M_12_x51y484_WY_GrandTetonNP_D22.tif` (252 MB; 10,012×10,012 px,
  Float32 LZW). Tile x51y484 = UTM12 easting 510–520 km / northing 4,840–4,850 km, which covers
  the Cathedral Group and the Grand Teton summit (43.741 N, -110.802 E ≈ 515.9 km E / 4,843.7 km N).
- **Discovery:** TNM Access API —
  `https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Digital Elevation Model (DEM) 1 meter&bbox=-110.95,43.48,-110.45,44.10`
- **Full-pull plan:** 97 products intersect the AOI, **14.63 GB total** (projects overlap):
  - `WY_GrandTetonNP_D22` — 27 tiles, 3.47 GB (newest, pub. 2025; preferred where present)
  - `WY_GrandTetonElkRefuge_2014` — 29 tiles, 4.41 GB
  - `WY_North_Converse_2020_D20` — 32 tiles, 5.26 GB
  - `WY_YellowstoneNP_2020_D20` — 9 tiles, 1.49 GB
  Deduplicating to one project per tile brings a full pull to roughly 6–8 GB.
  Complete list with URLs + sizes: `dem_3dep/tile_list_full_extent.json`.
- **License:** US public domain (USGS 3DEP)

## 8. USGS 3DEP lidar point cloud — EPT METADATA ONLY (`lidar_ept/`)

- **Endpoints (Entwine Point Tile, public AWS bucket `usgs-lidar-public`, EPSG:3857):**
  - `https://usgs-lidar-public.s3.amazonaws.com/WY_GrandTetonNP_1_D22/ept.json` — **covers the AOI**;
    37,257,677,080 points, bounds x -12,350,722..-12,292,192 / y 5,394,209..5,485,975, z 1913–4355 m
  - `WY_GrandTetonNP_2_D22` — 114,479,747 points (north, outside AOI)
  - `WY_GrandTetonNP_3_D22` — 71,322,227,279 points (north, outside AOI)
- Fetched `*_ept.json` for all three (in this directory). Full point-cloud pull is NOT planned as
  a bulk download (tens of TB raw); access windowed via PDAL `readers.ept` with an AOI bounds
  filter against the `WY_GrandTetonNP_1_D22` endpoint.
- **License:** US public domain (USGS 3DEP)

## 9. NAIP imagery — ACCESS PATH ONLY (`naip/`)

- **Newest year over the AOI: 2022** (0.6 m GSD). Verified via Microsoft Planetary Computer STAC
  (`collections=["naip"]`, bbox search): years present 2017 / 2019 / 2022, nothing newer as of
  2026-07-10. TNM Access no longer serves NAIP products for this bbox.
- **Coverage:** 99 quarter-quad 4-band (RGBIR) COGs; sampled one at 455 MB → full pull ≈ **~45 GB**.
- **Access paths:**
  - Planetary Computer STAC: `https://planetarycomputer.microsoft.com/api/stac/v1/search`
    → assets at `https://naipeuwest.blob.core.windows.net/naip/v002/wy/2022/wy_060cm_2022/...`
    (requires SAS signing: `https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=<url>`)
  - AWS (requester pays): `s3://naip-analytic/wy/2022/60cm/rgbir_cog/` and
    `s3://naip-visualization/wy/2022/60cm/rgb/`
- Item listing for the AOI saved to `naip/stac_naip_2022_items_bbox.json`.
- **License:** US public domain (USDA)

---

## Attribution summary

| Dataset | License | Attribution |
|---|---|---|
| TIGER/Line, GNIS, 3DEP DEM/lidar, NHDPlus HR, LANDFIRE, NAIP | US public domain | courtesy credit to US Census / USGS / USDA appreciated, not required |
| OSM (Overpass extracts) | ODbL 1.0 | **required:** "© OpenStreetMap contributors" |
| Microsoft US Building Footprints | ODbL 1.0 | **required:** ODbL notice; source: Microsoft USBuildingFootprints |
