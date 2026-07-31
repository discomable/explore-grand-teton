# AGENTS.md — Grand Teton 3D

A real-terrain, browser-only three.js r184 world. Read `README.md` and `WORKFLOW.md` for the long
version; this file records what an agent will otherwise get wrong.

## Verify

```bash
npm test                      # node --test — 87 unit tests (JS)
npm run test:py               # Python unittest — 17 tests incl. hero-batch + audit
npm run validate:assets       # assets-manifest.json license/provenance check
npm run build                 # Vite production build (also runs in CI)
npm run verify                # test:all + validate:assets + build (the full CI gate)
python3 serve.py & npm run dev -- --port 8130   # local app; two processes, see below
python3 snap.py                                  # headless capture suite (needs both servers)
python3 terrain/pipeline/buildings/hero_batch.py audit --run-id <run-id>
```

`npm run verify` is the exact CI gate in `.github/workflows/test.yml`. Run it before claiming a
change is green. `npm test` is `node --test` (no glob), `test:py` is `unittest discover -s test`.

## Two-server local model

`snap.py` and headless capture need **both** `serve.py` (PNG inbox on `:8123`) and `vite dev`
(`:8130`). Vite proxies `/shot` → `:8123`. Edit `serve.py`/`snap.py`/`vite.config.js` → restart
that process; ordinary JS/HTML hot-reloads. The world is **http-only** — `file://` falls back to a
procedural stub (`10-worldgen.js`).

## Hot high-risk gotchas

- **GLSL reserved words** `patch`, `filter`, `sample` as variable names silently fail ANGLE and
  blank the whole terrain. Check `errors` in the shot `.json` sidecar before trusting any image.
- **App load order matters.** `terrain/src/app/00-…→97-…` are ordered global scripts sharing one
  lexical scope; `main.js` and `AppContext` are ES modules. Each binding declared in exactly one
  file, in dependency order. See the manifest at the top of `app/00-core.js`.
- **Determinism.** Terrain/veg placement is `mulberry32`-seeded. Never `Math.random`/`Date.now` in
  per-frame or cell-fill paths — captures stop being comparable.
- **No default resolution scaling.** The `O` menu is opt-in only; do not turn it on by default.
- **World Y is datum-relative.** True ASL ≈ `y + 1897 m` (valley floor ≈ y 160, summits ≈ y
  2000–2300). Runtime world frame is EPSG:32612 UTM zone-12N metres, origin at `tiles.json`'s
  `world.centerEasting`/`centerNorthing`: `x = easting − CE`, `z = CN − northing`. Helpers in
  `terrain/pipeline/roads/utm.py` and `buildings/build_buildings.py:to_world(lat,lon)`.
- **ACES tone mapping is applied once** to every material via the prototype hook in `20-scene.js`.
  Don't re-apply it in new shaders.
- **`#credit` HUD attribution** must stay — OSM + Microsoft Building Footprints are ODbL.

## Headless capture is the core verification, not tests alone

`snap.py` drives headless Chrome against Vite; the page's auto mode POSTs each frame to `serve.py`.
Read the `.json` **before** the `.png`: `errors` (empty = good), `calls`, `tris`, `renderMs`
(CPU-submit only — headless can't measure GPU fps), `visibleTerrainCoverage.complete` (must be
true). Named shots overwrite in place, so reproduce the same view before claiming a difference.
Suites: `--suite smoke|full|reference|benchmark|transport`. `views-*.json` at the repo root are
per-feature sets accumulated during development — candidates for cleanup, not canonical.

`python3 benchmark.py` is the 5-view Phase-0 quality gate (frame rate, draw calls, triangles,
stream-settle). `python3 snap.py --suite full` is broader visual review. `visual_compare.py`
diffs against `visual-baselines/` and exits nonzero on regression (needs Pillow).

## Hero-building batch pipeline

Multi-agent reconstruction lives in `terrain/pipeline/buildings/`. The runner
`hero_batch.py` owns deterministic gates; candidate packages under `hero_candidates/<id>/` carry
`candidate.json` / `architecture.json` / `reference-sources.json` / `README.md` / a
`generate_draft.py` Blender script. Draft runs are isolated under the **gitignored**
`terrain/pipeline/work/landmark-batches/<run-id>/` and surfaced via a draft preview at
`?landmarkDraftRun=<run-id>` (localhost only — `LandmarkManager.js` rejects it on any other host).

- `hero_batch.py audit --run-id <id>` is the consistency gate; run it whenever state or artifacts
  change. It cross-checks every recorded artifact SHA-256 against disk and reconciles state.json
  against each `quarantine-report.json` (status/stage/reason/attempt must match).
- A candidate is promoted only via `record --status draft_passed`, which requires independent
  verification (verifier actor ≠ worker owner), all of `draft_errors()` passing (sources, placement
  ≥ 0.85 confidence, LOD/texture budgets, all 6 required capture views, performance), and a valid
  `preview-landmark.json` whose LOD URLs are repository-local and inside the candidate folder.
- Per-candidate `retryLimitOverride` in `hero-batch.json` authorizes extra retry waves for that
  candidate without unfreezing the global `retryLimit`; `quarantineUnderLimit` on each quarantine
  records the limit that was active when it was quarantined so future audits validate against it.
- `work/landmark-batches/` is gitignored (the 54 MiB USGS `.laz` is kept there on purpose). Do not
  track candidate artifacts in git.
- Production landmark assets live in `terrain/public/models/` + `terrain/public/materials/` and the
  manifest `terrain/public/landmarks.json`; mutations go through `promote_hero_draft.py --write`
  from a `draft_passed` candidate's `promotion.json`. Never hand-edit `landmarks.json`.
- The T. A. Moulton Barn is the only production hero building so far and is the provenance template
  (`terrain/pipeline/buildings/moulton_barn/`, `docs/HERO-BUILDING-RECONSTRUCTION.md`). Wave-3 plan
  for John Moulton is in `docs/HERO-BUILDING-WAVE-3-JOHN-MOULTON.md`.

## Pipeline & data

Python pipeline in `terrain/pipeline/` bakes everything in `terrain/public/` (tiles, imagery,
landcover, roads, buildings, water, vegheight, forestmask, horizon/ao). Stdlib + a hand-rolled UTM
converter only — no `pyproj`/`rasterio` assumed. `terrain/pipeline/data/` holds downloaded sources;
see `terrain/pipeline/SOURCES.md` and `terrain/pipeline/STORAGE-PLAN.md`. Bulk tiles (~483 MB) live on **Cloudflare R2**,
not git; local dev serves them from `terrain/public/tiles`+`imagery/`. Validate the R2 path with
`GT_TILES="https://pub-…r2.dev/" python3 snap.py --views <name>`. After a pipeline rebake, re-upload
tiles to R2 (see `DEPLOY.md`) or deployed builds serve stale tiles.

## Deploy

CI (`test.yml`) runs `npm run verify` on every push and PR: `npm run test:all && npm run
validate:assets && vite build`. Publishing is manual and deliberately not a workflow — see
`DEPLOY.md` (wrangler leaks the Cloudflare account name into public Actions logs). Deploy with
`./build-web.sh && npx wrangler pages deploy dist --project-name grand-teton --branch main`
(`--branch main` is required — without it Cloudflare serves a preview, silently). `build-web.sh`
produces a trimmed `dist/` (no
pipeline, raw atlas sources, shots, or dev tooling). Don't commit `dist/`.

## Commit & branch

Fast path (docs / low-risk tooling): push to `main`. Review path (visual/runtime slices):
`feature/<short-name>` branch → PR → merge. Keep one active slice per implementation owner; do not
split a renderer subsystem across agents. Don't commit secrets; staged-only, matching repo style.