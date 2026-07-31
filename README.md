# Grand Teton — Real-Terrain 3D World

An explorable, first-person 3D rendering of Grand Teton National Park and Jackson Hole,
built on **real USGS terrain, NAIP aerial imagery, and public geodata**, running entirely in
the browser on pinned **three.js r184**. Walk, fly, or drive the valley; the Snake River, Jenny and
Jackson Lakes, the Cathedral Group, the park roads, buildings, and place names are all in
their real geographic positions.

Vite provides the ES-module entry point and production build. The established world modules still
load as ordered classic scripts while they are migrated manager-by-manager; terrain tiles stream
from `terrain/public/` locally and Cloudflare R2 in deployed builds.

> This is an unofficial, independent project and is not affiliated with, endorsed by, or
> sponsored by the National Park Service.

---

## Quick start

```bash
npm install                      # first run only
npm run dev -- --port 8130      # app on http://localhost:8130
```

That works from a fresh clone with no further setup: the bulk terrain tiles are not in git, so
if no local pyramid is present the app streams them from a public bucket instead.

For faster, offline development, fetch a local pyramid once:

```bash
npm run dev:setup                # ~44 MB (z0–z5), whole park at coarser ground detail
npm run dev:setup -- --max-zoom 7   # 483 MB, full production detail
```

`dev:setup` also lowers `maxZoom` in `tiles.json`/`imagery.json` to match what it fetched, so the
streamer never requests a level you don't have. Those are **tracked files** — don't commit the
change; undo it with `npm run dev:setup -- --restore`. See `terrain/pipeline/SOURCES.md` and
`DEPLOY.md` for regenerating the pyramid from the original USGS/NAIP sources instead.

Add `python3 serve.py` (screenshot receiver on `http://localhost:8123`) if you want `P` to save
review screenshots or intend to run `snap.py`. Vite proxies uploads to it; ordinary code edits
hot-reload. Restart the relevant process after editing `serve.py`, `snap.py`, or `vite.config.js`.

> The world needs **`http://`**. Opening the HTML from `file://` falls back to a small procedural
> world (the `10-worldgen.js` / `50–60` path), because tile streaming needs real requests.

---

## Controls

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `W A S D` | move | | `L` | cycle labels (compass → legacy pills → off) |
| Mouse | look | | `M` | cycle minimap (off → overview → follow) |
| `F` | walk / fly | | `Esc` | pause menu + **fast travel** to landmarks |
| `G` | drive / park the car | | `R` | return to trailhead |
| `Space` / `C` | jump·ascend / descend·(camera in drive) | | `T` | play/pause the sun |
| `Shift` | sprint / fly fast | | `[` `]` | scrub time of day |
| `P` | save a review screenshot | | | |

HUD (bottom-right) shows **fps · ms · draw-calls**, altitude, clock, and speed while driving.

---

## Architecture

### Runtime (browser)

`terrain/src/main.js` is the ES-module entry point. It imports `three`, `GLTFLoader`,
`AppContext`, and the worker services, then loads the remaining world modules as ordered classic
scripts. Those classic scripts share the page's global lexical scope; see the load-order manifest
at the top of `terrain/src/app/00-core.js`.

CPU-heavy terrain decode and deterministic vegetation/ground-cover preparation use bounded module
workers. A worker-owned spatial index batches terrain, ecology, water, road, and building queries.
Use `?noWorkers=1` only as the synchronous benchmark/control path. The experimental
`?renderWorker=1` path validates the OffscreenCanvas boundary but is not the production renderer.
See `docs/R184-WORKER-ARCHITECTURE.md`.

**Engine modules — `terrain/src/`** (window-global IIFEs):

| Module | Responsibility |
|---|---|
| `TerrainStreamer.js` | Quadtree streaming of height + imagery tiles; crack-free 2:1-balanced LOD with edge stitching; `heightAt()` for collision/placement |
| `terrain-shaders.js` | Terrain vertex/fragment shaders: geomorph, macro-normals, NAIP drape, baked AO + horizon shadows, cast-shadow + headlight sampling, detail noise, cloud shadows |
| `Landcover.js` | NLCD class + water-mask point queries from `landcover.png` |
| `WaterBuilder.js` | Authoritative-elevation lakes/rivers, derived shorelines, chop/flow, half-res planar lake reflections |
| `ScatterManager.js` | Photo-impostor vegetation, imagery + LANDFIRE-driven density, amortized cell streaming, frustum culling, far-forest band |
| `GroundCover.js` | Near-field grass/sage card ring |
| `RoadRibbon.js` | Spline road ribbons from `roads.json`, class hierarchy, grading/shoulders, materials, terrain re-drape |
| `BuildingManager.js` | Extruded footprints, roofs by class, textures, foundation skirts, collision (`window.buildingBlocked`) |
| `PropScatter.js` | Boulders / deadfall / fences for scale |

**App modules — `terrain/src/app/`** (the former inline script, split by concern):

`00-core` (noise/math/error hook) · `10-worldgen` (procedural fallback height) · `20-scene`
(renderer, ACES tone pipeline, cast-shadow rig) · `30-sun-sky` (day/night arc, moon, weather,
sky+clouds) · `40-terrain` (collision, road index, `roadQuery`) · `50-water`/`60-forest`
(procedural fallback) · `70-labels` · `80-controls` · `82-drive` (car + first-person cam) ·
`84-input` · `85-fasttravel` · `86-capture` (screenshot POST) · `88-minimap` · `90-auto`
(headless view driver) · `92-boot` (world build + animate loop).

### Data pipeline — `terrain/pipeline/`

Offline Python scripts fetch public data and bake the runtime assets in `terrain/public/`:

| Asset | Baked by | From |
|---|---|---|
| `tiles/` height pyramid (z0–z7, 1 m) + `tiles.json` | `fetch_1m_tnm.py`, `tile_pyramid.py`, `encode_rgb.py`, `make_manifest.py` | USGS 3DEP 1 m DEM |
| `imagery/` NAIP pyramid + `imagery.json` | `fetch_imagery.py`, `imagery_pyramid.py` | USDA NAIP 1.25 m |
| `landcover.png` / `.json` | `make_landcover.py` | NLCD + NHD water |
| `horizon_a/b.png`, `ao.png` | `bake_horizon.py`, `bake_ao.py` | DEM (8-azimuth horizon shadows, sky-visibility AO) |
| `roads.json` + SDF, `labels.json`, `buildings.json` | `build_roads.py`, `build_labels.py`, `build_buildings.py` | OSM, TIGER, GNIS, MS Footprints |
| `vegheight.png`, `forestmask.png` | `bake_vegheight.py` | LANDFIRE EVH/EVC, NAIP darkness |
| `water-surface.png` / `water-kind.png` / `water-mask-hi.png` / `water-meta.json` | `bake_water.py` | NHD + DEM (authoritative elevation, river/lake classification, and 2.5 m vector shoreline gate) |
| `veg-atlas.png` | runtime bake (`?bakeatlas=1`) | CC0 tree cutouts — see `terrain/pipeline/VEG-ATLAS-SOURCES.md` |

`terrain/pipeline/data/` holds the downloaded sources; see `terrain/pipeline/SOURCES.md` for URLs +
licenses and `terrain/pipeline/STORAGE-PLAN.md` for what's kept vs regenerable. A shared UTM zone-12N
converter (`pipeline/roads/utm.py`) maps WGS84 → the app's world frame (metres, origin at the
park centre; `x−` = west/range, `z−` = north).

The measured-silhouette, image-assisted hero-building workflow proven on the T. A. Moulton Barn is
documented in [`docs/HERO-BUILDING-RECONSTRUCTION.md`](docs/HERO-BUILDING-RECONSTRUCTION.md).

---

## Headless capture & review (`snap.py`)

The project is developed with a **screenshot-driven verification loop** — changes are proven by
rendering fixed viewpoints headlessly and inspecting the images, not by tests alone.

```bash
python3 snap.py                       # render the full suite → shots/auto-<name>.png
python3 snap.py --suite smoke         # fast terrain, lighting, UI, and loading-health sampling
python3 snap.py --suite full          # every canonical review state (same as the default)
python3 snap.py --list-suites         # list suite names and their member views
python3 snap.py views-<feature>.json  # a specific feature's views
python3 snap.py --views sage-ground,treeline   # a subset
```

`snap.py` drives headless Chrome against Vite; the page's **auto mode**
(`?auto=views.json`) flies to each viewpoint, waits for terrain streams to settle, and POSTs the
frame through the `/shot` proxy to `serve.py`, which writes `shots/auto-<name>.png` + a `.json`
sidecar containing camera pose, commit and dirty-worktree provenance, `errors` (page/shader
failures), `calls`/`tris`, and `renderMs`. Named shots overwrite in
place so a viewpoint is directly comparable across edits.

A view is `{"name", "pos":[x,y,z], "yaw", "pitch", "suites"?, "time"?, "weather"?, "phase"?, "ground"?, "drive"?}`.
`suites` is a list of named suites; views without it remain part of `full` for compatibility.
The checked-in **smoke** suite is intentionally short but includes a ground-level terrain shot, a
golden-hour lighting shot, a UI/HUD state, and a no-settle loading-transition probe. **full** adds
forest, shoreline, high-alpine, night/overcast, minimap, and error-health coverage. The
loading probe verifies that a camera move can be rendered while streams are still arriving; every
capture also writes page/shader failures to its sidecar's `errors` field, so an empty field is the
expected error-condition result.

The `views-*.json` files at the repo root are per-feature capture sets accumulated during
development (candidates for cleanup).

### Visual baseline comparison

Approve a capture by copying its PNG into `visual-baselines/` with the same filename (for
example `shots/auto-teton.png` → `visual-baselines/auto-teton.png`). Then compare every capture
to its approved counterpart:

```bash
python3 visual_compare.py
```

The command writes `visual-results/report.html` plus per-view actual, baseline, and brightened
diff PNGs. It exits nonzero for missing images, mismatched dimensions, or a regression. The
defaults ignore channel deltas of 12 or less and permit no changed pixels; tune both limits for
intentional rendering variance:

```bash
python3 visual_compare.py --pixel-threshold 16 --max-diff-pixels 0.25%
```

`visual_compare.py` requires Pillow (`python3 -m pip install Pillow`). Use `--shots-dir`,
`--baselines-dir`, and `--output-dir` to compare alternate directories.

> **Headless can't measure GPU frame time** — `renderMs` is CPU submit time only. True fps is
> read from the in-browser HUD on real hardware.

### Canonical photorealism benchmark

Phase 0 of `PHOTOREALISTIC-EXPLORATION-ROADMAP.md` uses five hero views as the fast, repeatable
quality gate. One command starts a temporary local server when needed, captures those views, and
writes `benchmark-results/report.json`:

```bash
python3 benchmark.py
python3 benchmark.py --quality high
python3 benchmark.py --route highway-junction-drive --route pedestrian-structures-hike
python3 benchmark.py --route snake-bridge-drive --time-of-day night --camera first-person
python3 benchmark.py --list-routes
```

The report includes average and 1%-low frame rate samples, stream-settle time, draw calls,
triangles, renderer memory counts, tile-cache residency, CPU submit time, and true GPU time when
Chrome exposes `EXT_disjoint_timer_query_webgl2` (otherwise the backend is explicitly labelled
`cpu-fallback`). Screenshots and individual JSON sidecars remain in `shots/`.

`benchmark` is deliberately a five-view gate intended to finish quickly. Use
`python3 snap.py --suite full` for the broader visual review suite.

The versioned route manifest covers highway and paved junctions, gravel and two-track, road and
pedestrian structures, maintained and primitive trails, and the off-road/water/barrier recovery
cases. Route captures are continuous diagnostic traversals, not teleports. They
measure frame spikes, visible tile arrivals, streaming-busy frames, cold-start readiness, and peak
rendering counts while moving. Each route report includes its certification targets and a
machine-readable High or Accessible performance-gate result. Repeat driving routes with
`--time-of-day day|golden-hour|night` and
`--camera far-chase|near-chase|first-person` for the visual matrix. Longer visible-browser
certification runs use the same versioned paths and the budgets in `docs/PHASE-0-BASELINE.md`.

The 15-scene photographic target and its NPS/USGS provenance live in
`docs/PHOTOGRAPHIC-REFERENCE-REGISTER.md`. Capture its versioned poses with:

```bash
python3 snap.py --suite reference
```

### Rendering paths

The default rendering path draws directly through Three.js r184's ACES film response and sRGB
output. Side-by-side visual review found this more neutral and natural than the experimental HDR
post stack, which introduced unwanted green/sepia grading.

- `?postfx` enables the experimental half-float linear HDR and bloom stack.
- `?post8` enables that stack with its forced RGBA8 compatibility target.
- `?nopost` remains a backwards-compatible no-op: direct rendering is already the default.

The migration decision, compatibility inventory, validation matrix, and explicit deferrals are in
`docs/PHASE-1-RENDERING-NOTES.md`.

---

## Data sources & licensing

Code is MIT-licensed (`LICENSE`). Public-domain federal data: USGS 3DEP/DEM, USDA NAIP, NLCD,
NHD, Census TIGER, USGS GNIS, LANDFIRE. **ODbL (attribution required): OpenStreetMap
contributors, Microsoft Building Footprints** — attribution strings are embedded in the
generated `roads.json` / `buildings.json` and shown in the app's credit HUD. Project-generated
assets (AI-image-generated textures, baked rasters, measured building reconstructions) are
dedicated CC0-1.0; vendored third-party models keep their own upstream terms (CC0-1.0 or
CC-BY-4.0). Full asset-by-asset provenance is in `LICENSE-ASSETS.md` and
`terrain/public/assets-manifest.json`.

---

## Status

The delivery source of truth is `PHOTOREALISTIC-EXPLORATION-ROADMAP.md`. `ROADMAP.md` records the
completed foundation work that preceded it; it is historical context rather than the active plan.

Known residuals honestly tracked in `ROADMAP.md`: the distant Grand still reads slightly
foothill-like (a distant-LOD silhouette limit — the core-range sprint targets it).

### Docs reading order

| Read | For |
|---|---|
| `AGENTS.md` | Commands, gotchas, and what an agent will otherwise get wrong |
| `WORKFLOW.md` | The human/agent development loop and review gates |
| `PHOTOREALISTIC-EXPLORATION-ROADMAP.md` | Active delivery plan and current priorities |
| `ROADMAP.md` | Historical record of the completed M1–M4 foundation |
| `DEPLOY.md` | Build and Cloudflare Pages deploy |
| `docs/` | Per-topic deep dives (rendering migration, worker architecture, hero-building pipeline, phase baselines, photographic reference register, and more) |

---

## Conventions & gotchas

- **Load order matters** — app modules share one global lexical scope; keep each binding
  declared in exactly one file, in dependency order.
- **GLSL:** never name a variable `patch`, `filter`, or `sample` — ANGLE rejects these and the
  terrain shader silently fails (all terrain vanishes). The ACES tone curve is applied once to
  every material via the prototype hook in `20-scene.js`; don't double-apply in a new shader.
- **Determinism:** all placement is seeded (`mulberry32`); avoid `Math.random`/`Date.now` in
  per-frame or cell-fill paths so the world is identical every visit.
- **World Y is datum-relative:** true elevation ASL = `y + datum` (~1897 m). Valley floor
  ≈ `y 168`; summits ≈ `y 2000–2300`.
- **Restart `serve.py` after editing it** (Python isn't hot-reloaded; the page is).
