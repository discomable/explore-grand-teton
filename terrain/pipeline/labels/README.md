# Place-name labels pipeline

Builds `terrain/public/labels.json` — curated place-name labels in Grand Teton
**world coordinates** — from the already-downloaded USGS GNIS Domestic Names
data for Wyoming.

## Run

```bash
python3 build_labels.py
```

Stdlib only. `osgeo` (GDAL) is used *opportunistically* to sample real
elevations from the baked DEM; if GDAL or the DEM is missing the script still
runs and writes `ele: null`.

## Inputs

- **GNIS names:** `../data/gnis/DomesticNames_WY_Text/Text/DomesticNames_WY.txt`
  (pipe-delimited; see `../SOURCES.md`). Note: this modern GNIS text export
  has **no elevation column**, so elevations come from the DEM (below), not GNIS.
- **World frame:** `../../public/tiles.json` → `world.centerEasting/centerNorthing`,
  EPSG:32612 (UTM 12N), plus `geoTransform`/`width`/`height` for the extent.
- **DEM (optional):** `../work/dem_filled.tif` (EPSG:32612) for summit elevations.

## World transform

```
UTM 12N (E, N) = ll_to_utm12n(lat, lon)   # hand-rolled Snyder/USGS series
world x = E - centerEasting
world z = centerNorthing - N               # north => negative z
world y = ASL_meters - world.datum         # datum-relative; NOT written here
```

The hand-rolled UTM forward transform is validated against the DEM: sampling
`dem_filled.tif` at the computed UTM of Grand Teton returns ~4192 m, matching
`tiles.json` `elevation.max` (4198 m) — i.e. the coordinate lands on the summit.

## What is kept

Feature classes filtered to the terrain extent, tagged into `cls`:

| GNIS class            | output `cls`         | notes |
|-----------------------|----------------------|-------|
| Summit                | `summit`             | |
| Lake, Reservoir       | `lake`               | Jackson Lake is a Reservoir in GNIS |
| Glacier               | `glacier`            | |
| Valley (name has "Canyon") | `canyon`        | GNIS files Teton canyons as *Valley* |
| Falls                 | `falls`              | |
| Gap                   | `pass`               | mountain passes / divides |
| Populated Place       | `place`              | Moose, Kelly, Moran, ... |
| Stream (shortlist)    | `stream`             | only major named runs (Snake River, Cottonwood/Pacific/Buffalo/Gros Ventre, ...) |
| famous locales        | `locale`             | Oxbow Bend, Jackson Lake Dam, Mormon Row, Schwabacher Landing (matched by name) |

Generic Valleys (no "Canyon" in the name) and minor streams are dropped — the
output `cls` enum has no `valley`, and un-major streams add noise.

## Importance (`imp` 1–3)

- **1** — icons: a curated name set (Grand Teton, the Tetons, big lakes, Cascade/
  Death/Paintbrush canyons, Signal Mountain, Snake River), **any summit ≥ 3400 m**,
  and every Populated Place.
- **2** — notable: named canyons, glaciers, passes, mid summits (≥ 3000 m), lakes,
  falls, locales, secondary streams.
- **3** — everything else.

Output is de-duplicated (identical names within 500 m collapse), capped at **150**
entries preferring higher importance, and sorted by `imp` then `name`.

## Output

`terrain/public/labels.json`:

```json
{"labels":[{"name":"Grand Teton","x":-6276.0,"z":-633.5,"cls":"summit","ele":4192.3,"imp":1}, ...]}
```

## Notes / oddities

- **No elevation in GNIS.** The WY text export omits elevation; all `ele` values
  are DEM-sampled (or `null` if GDAL/DEM unavailable).
- **Snake River primary point is unusable.** GNIS records a stream's primary point
  at its *mouth* — "Snake River" resolves to 46.19N, -119.03W in Washington, far
  outside the park. It is therefore anchored via `CURATED_LATLON` to a
  representative in-park location (the Snake near the Moose crossing, ~1970 m).
  This is the only curated coordinate; every other label is straight from GNIS.
- **Teton canyons are GNIS class "Valley."** Cascade/Death/Paintbrush Canyon etc.
  are recovered by matching "Canyon" in the name.
