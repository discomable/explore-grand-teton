# buildings pipeline

Builds `terrain/public/buildings.json`: building footprints in world
coordinates for runtime extrusion in the Grand Teton 3D world.

## Run

```sh
python3 terrain/pipeline/buildings/build_buildings.py
```

Stdlib only, plus the validated hand-rolled UTM-12N converter reused from
`terrain/pipeline/roads/utm.py`. Runs in ~1 s.

## Inputs

- `terrain/pipeline/data/osm/buildings.osm.json` — Overpass out-geom dump
  (~7.1k ways + 4 multipolygon relations). © OpenStreetMap contributors, ODbL.
- `terrain/pipeline/data/ms_buildings/Wyoming.geojson.zip` — Microsoft
  Building Footprints, statewide (386k polygons), ODbL. **Streamed directly
  from the zip** (one feature per line); nothing is extracted to disk.
- `terrain/public/tiles.json` — world frame: EPSG:32612,
  `x = easting − centerEasting`, `z = centerNorthing − northing`.
- `terrain/public/roads.json` — only used to cull far-from-road `imp:3`
  buildings if the total exceeds 6000 (not triggered at current counts).
- `terrain/public/labels.json` — sanity cross-checks only.

## Processing

1. OSM: outer rings of building ways + stitched outer rings of multipolygon
   relations → world coords. Tags kept: name, building type, height /
   building:levels (levels × 3.2 m + 1 m roof), tourism, amenity, historic.
2. MS footprints: cheap lat/lon prefilter, exact clip in world coords, then
   deduped — an MS polygon is dropped when its centroid lies within 15 m of
   an OSM building centroid (OSM wins; it carries names/tags).
3. Clip: building centroid must lie within x ±14160, z ±20590 (vertices may
   spill a few metres past the edge).
4. Simplify: Douglas-Peucker, 0.75 m tolerance. Drop area < 12 m² or
   degenerate rings. Rings normalized counter-clockwise in (x, z).
5. Classify: `lodge | commercial | residential | barn | outbuilding | generic`
   from tags + name keywords. Height: explicit OSM height/levels when present,
   else per class (lodge 9, commercial 6.5, residential 5.5, barn 7,
   outbuilding 3.5, generic 5 m) with a deterministic ±15% jitter from a
   CRC32 of the rounded centroid (not random — stable across runs).
6. Importance: `imp:1` named landmarks (lodge/visitor/chapel/historic
   character, plus an explicit list: Dornans, Colter Bay, homesteads…),
   `imp:2` other named, `imp:3` unnamed.

## Output format

```json
{
  "attribution": "© OpenStreetMap contributors (ODbL); Microsoft Building Footprints (ODbL)",
  "buildings": [
    {"pts": [[x, z], ...], "h": 7.7, "cls": "lodge", "name": "…", "imp": 1}
  ]
}
```

- `pts`: footprint ring, unclosed, coords rounded to 0.1 m, CCW in (x, z).
- `h`: extrusion height in metres. `name` present only when OSM has one.

## Current results (2026-07-11)

3398 buildings (3145 OSM + 253 MS), 0.67 MB. Classes: generic 2711,
residential 538, outbuilding 78, lodge 26, commercial 23, barn 22.
Landmark spot checks land where labels.json says they should (e.g. Colter Bay
Visitor Center 288 m from the "Colter Bay Village" label). Note: Jackson Lake
Lodge is at x≈11768, z≈−15837 — on the lake's SE shore, east of the lake's
center label at (4008, −18374). Triangle X Ranch has no building polygons in
the OSM extract.

## Multi-agent hero-building drafts

`hero-batch.json` defines the six-candidate, two-wave reconstruction batch. The
`hero-building-batch` Codex skill coordinates building-specific workers while
`hero_batch.py` owns deterministic state, quarantine status, preview assembly
and the local review gallery. A candidate cannot be marked `draft_passed`
unless its `validation-report.json` satisfies the machine gates described by
`validation-report.schema.json` and the central budgets/view IDs in
`hero-batch.json`, and a verifier other than the candidate owner records a
passing review. State includes transition history and SHA-256 snapshots; a
final quarantine is legal only after the configured targeted retry.

```sh
python3 terrain/pipeline/buildings/hero_batch.py validate-packages
python3 terrain/pipeline/buildings/hero_batch.py init --run-id six-landmarks-2026-07-28
python3 terrain/pipeline/buildings/hero_batch.py audit --run-id six-landmarks-2026-07-28
python3 terrain/pipeline/buildings/hero_batch.py summary --run-id six-landmarks-2026-07-28
```

Run products stay under ignored
`terrain/pipeline/work/landmark-batches/<run-id>/`. Passing drafts can be loaded
locally with `?landmarkDraftRun=<run-id>`; deployed hosts always retain
`terrain/public/landmarks.json`.
