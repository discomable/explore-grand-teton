# Grand Teton — Visual Roadmap

> **Historical record.** Active delivery authority moved to
> [`PHOTOREALISTIC-EXPLORATION-ROADMAP.md`](PHOTOREALISTIC-EXPLORATION-ROADMAP.md) on 2026-07-28.
> Checkboxes below describe earlier arcs and must not be used as current status.

> 📐 **Design docs for the remaining features** (bridges, waterfalls, PBR/IBL, water, road signs,
> route shields, contact AO) — each with its approach + the failure mode to avoid — live at
> [`docs/ROADMAP-DESIGN-DOCS.html`](docs/ROADMAP-DESIGN-DOCS.html) (open in a browser).

**M1–M4 ✅ COMPLETE (2026-07-11).** Onward arc **M5–M7** below (opened 2026-07-16).
Delivery decision (2026-07-16): **max visual quality, accept lower fps** — the old "~30-45 fps
retina, no resolution scaling" constraint is relaxed for this arc; resolution scaling is allowed and
the auto quality-governor becomes opt-in (must not fight max quality). Benchmark = real Grand Teton
photography (wildflower meadow, autumn reflections, forest+peaks, golden-hour dirt path) + the
Grand Wagoneer first-person cabin reference.

Central target: **from the valley floor the Tetons must remain detailed, recognisable and
dramatic. At night the landscape must become genuinely dark, revealed primarily by vehicle,
moon and settlements. At every distance the world must remain physically continuous — no gaps,
floating water, overlapping roads or vegetation clipping.**

## Delivery sequence

### Milestone 1 — World integrity  ✅ COMPLETE (2026-07-11, verified)
- [x] 1. Terrain cell gaps / LOD cracks eliminated (shared boundary verts, skirts-as-fallback,
      stitched LOD edges, ≤1 LOD level between neighbours, LOD-consistent height decode,
      imagery border overlap so no white seams). Accept: no holes from ground/air/oblique,
      no cracks in transitions, **no sky through terrain at night**, transitions unidentifiable
      in screenshots.
- [x] 2. Water correctness + shorelines (one authoritative surface elevation per connected
      segment; validate vs simplified terrain; clip water against terrain; fill segment gaps;
      shoreline geometry from heightfield∩water-level; damp-soil/sediment→sand/gravel→sparse
      reeds banding; never climbs steep banks or under roads). Accept: Snake continuously
      filled, no rectangular boundaries, natural shoreline width, no floating/buried water,
      aligned at every LOD.
- [x] 3. Roads/tracks/intersections (splines w/ turning radii, explicit hierarchy — paved cuts
      gravel cuts track, terrain graded under carriageway + blended, shoulders/ditches/verges).
      Accept: main roads render above dirt, no overlap/z-fight, natural curves, no mesh-terrain
      gap. (Layered surface materials → M4.)
- [x] 4. Foliage exclusion (no trees on carriageways/tracks/buildings/water/rock/steep; per-type
      exclusion distances; clustered not uniform scatter). Accept: no clipping into roads,
      buildings, water.
- [x] Fix any geometry that lets the player see through the world.

### Milestone 2 — Landscape readability  ✅ COMPLETE (2026-07-11; distant range improved but Grand still reads foothill-ish — geometry silhouette limit, candidate for a bespoke core-range pass)
- [x] Distant mountain fidelity: material LOD decoupled from geometry LOD, macro normals from
      the heightfield, mip-bias/aniso review, streamed high-res pages for landmark views,
      restrained atmospheric perspective (no bleaching), bespoke budget for the core range.
      Accept: Grand Teton detailed from the valley; gullies/ridges legible at range; no uniform
      white/green/blur at distance.
- [x] Better distant terrain shadowing.
- [x] Land-cover/imagery-driven foliage: NAIP-darkness probability mask, zones (dense conifer /
      sparse / riparian / sagebrush / meadow / alpine), aspect+moisture terms, treeline thinning.
      Accept: trees align with imagery forest patterns; edges irregular; distant forests read as
      masses, not isolated spikes.

### Milestone 3 — Lighting and atmosphere  ✅ COMPLETE (2026-07-11, verified — genuine dark nights, terrain-aware headlights, weather)
- [x] Real night model: ambient way down; moonlight ≠ sky ambient; moon phase/cloud/exposure
      vary brightness; careful eye adaptation. Accept: moonless unlit terrain ≈ black; moonlit
      navigable but far darker than dusk.
- [x] Terrain-aware headlights: cones light terrain/roads/buildings/water-edges/foliage
      (NOTE: terrain+roads are custom shaders — spotlights don't touch them; needs explicit
      headlight uniforms in those shaders), dipped/full beams, falloff+cutoff, slight volumetric
      scatter, nearby headlight shadows, reflective road markings/signs/wildlife eyes.
      Accept: player instantly distinguishes off/dipped/full.
- [x] Clouds & weather: layered types (cirrus/cumulus/systems), parallaxed primary layer, soft
      moving cloud shadows tied to sun/skylight/exposure, valley mist, humidity-driven haze.
      Accept: clouds visibly alter terrain light; weather makes materially different landscapes.

### Milestone 4 — Location detail  ✅ COMPLETE (2026-07-11, verified)
- [x] Shoreline dressing (reeds/debris where slope permits).
- [x] Road material detail (aggregate variation, tyre wear, patches, roughness, edge dirt,
      vegetation encroachment).
- [x] Building archetypes & landmark assets (facade variation, windows/entrances, material
      library, bespoke Jackson Lake Lodge / Moulton Barn; correct seating on graded terrain;
      mesh+impostor LODs). Accept: settlements read as places; placeholders gone; landmarks
      recognisable by silhouette.
- [x] Environmental props.

## Onward arc (M5–M7, opened 2026-07-16)

### Milestone 5 — Driving & vehicle  ⏳ MOSTLY DONE (interior fine-tuning is interactive)
Cohesive in-car experience; contained perf cost. Order:
- [x] 5.1 **Ride stability** (9ad0f46, +a8315c1 FP-eye-rigid fix) — critically-damped suspension +
      tilt low-pass; off-road sine removed; FP eye rigid on the seat (a damped eye lagged and the
      cabin drifted ahead while driving).
- [x] 5.2 **Road-aware seating + no-clip** (330d6cb) — seats +LIFT on-road (wheels on asphalt);
      blocks driving onto >50° cliff faces. (Runtime road surface height not exposed → approximated;
      tree collision deferred.)
- [x] 5.3 **Full modeled interior** (28cf9d1 scaffold, 6f9571f seal+near-clip, 9dd2e66 hood) —
      sealed procedural cabin (floor/roof/walls/firewall + dash/pillars/seats/wheel/mirror), FP
      near-plane lowered to 0.12 so the close cabin doesn't clip, dash cowl hides the hood. Remaining
      = interactive framing (aperture size, side windows — sides are currently solid dark).
- [x] 5.4 **Headlight refinement** (89f1369) — retired the 31 m sky-filling volumetric cone; real
      light is the per-fragment ground bounce + light-pool (lights sage naturally, dark sky). Beam
      meshes kept hidden for a future subtle beam. (Footprint reads natural; props/buildings still
      lit by the SpotLights.)

### Milestone 6 — Ground & paths  ⏳ IN PROGRESS
- [x] 6.1 **Trails draped like roads** (625529b) — ported RoadRibbon's grading core (movAvgArc +
      gradeProfile: smoothed longitudinal profile + clamped cross-tilt + anti-burial) into
      TrailBuilder, applied at build AND in the finer-tile re-drape. Trails now drape as smooth
      graded dirt paths, no faceted ground-hug jitter. (Verge band + junction fans not ported —
      bigger change, deferred; core draped/curved/graded done.)
- [x] 6.2 **Real 3D grass/brush + wildflowers** (2ec1907 + two-meadow follow-up) — near-field flat
      cards replaced with 3D crossed-card clumps + root-to-tip "fluffy" shading; TWO land-cover-driven
      fluffy meadow variants (tall lush green on grass/riparian 71/90/95, short dry pale on sage flats
      52 + sage sprigs), wildflowers through both, road/water/building exclusion intact. Dense
      continuous carpet, not discrete clumps.
- [x] 6.3 **Bridges — unified drivable surface** (v2, shipped; in-sim verified) — v1 reverted TWICE
      because deck/road/physics were three disagreeing surfaces. v2 collapses to ONE: BridgeBuilder
      only DETECTS crossings (dry-bounded over-water run ≤240 m + opposite-banks chord-wet test) and
      exposes `bridgeFloor(x,z)` (waterY+freeboard) as a *clearance floor*, never an elevation.
      RoadRibbon folds the floor into its single grading pass so the one graded profile arcs up to
      clear the water, then publishes `drivableSurfaceAt(x,z)` (pre-LIFT); `sampleGround` (physics,
      40-terrain) + `waterBlocked` (82-drive) fold that in, and the deck mesh is pinned to it (+LIFT).
      Deck top ≡ running surface ⇒ v1 mislevel structurally impossible; ±24° roll clamp kills the edge
      flip. Roads only (foot-trail bridges deferred). Files: BridgeBuilder.js (rewrite), RoadRibbon.js,
      app/40-terrain.js, app/82-drive.js, app/92-boot.js. Verified routes: Moose/Snake River
      crossings and the Jenny Lake and Jackson Lake approach crossings, in walking and driving modes.

### Milestone 7 — Cinematic photorealism suite  ⏳ IN PROGRESS (max quality, accept lower fps)
Benchmark #8–12. Largest, perf-heavy; perf floor relaxed per the 2026-07-16 decision.
- [~] 7.1 **Post stack** — experimental bloom + grade/vignette available behind `?postfx`
      (terrain/src/PostFX.js), but removed from the default path after same-view photographic review
      found the native Three ACES render more neutral and natural. The direct path is now the visual
      baseline; `?post8` retains compatibility testing for the experiment. REMAINING: decide whether
      selective effects can beat the baseline without a global grade before adding SSAO/GTAO or DoF.
      Historical implementation: hand-rolled
      self-contained stack (NO examples/js — would double-apply the unified teton tone-map). Scene ->
      MSAA target (keeps edge AA) -> bright-pass -> 3-level gaussian bloom pyramid -> composite
      (base + bloom, saturation lift, vignette) -> screen. Operates on the already-tone-mapped LDR
      image (no HDR refactor risk); auto-tracks the governor's pixel ratio.
- [x] 7.2 **Shadows** — softer shadows (scoped down from full CSM: terrain already casts 20 km valley
      shadows via baked 8-azimuth horizon maps, so a second object cascade was low ROI). All three
      custom receivers (terrain/road/trail sunCastShadow) use a wider 8-tap (terrain +4-tap inner) soft
      PCF ring. Kernel widens ONLY with smooth camera distance — a first pass derived the penumbra from
      the sampled blocker depth (PCSS-lite) + raised the box/altitude-gate, but that FLICKERED (penumbra
      width read the moving shadow map) and RIBBONED at altitude (low-res box seen from high up); both
      reverted. Coverage kept at the tuned 260 m ring / 560 m gate. DEFERRED: second CSM cascade.
- [x] 7.3 **Sky/atmosphere** — (a) graded aerial perspective (terrain-shaders.js): distant terrain
      reads as DEPTH — accumulating chroma-loss + cool-blue cast growing with distance (ramp 1.8→11 km)
      AND altitude, so ranges recede as blue layers while the core Tetons stay crisp; suppressed toward
      golden hour. (b) low-horizon haze band — luminous atmospheric layer pooling at the valley/
      distant-base (gated to low terrain height so peaks stay clear; self-gates at night; warms at gold).
      (c) volumetric/parallax cloud depth (30-sun-sky.js): sunward-offset density comparison gives
      cumulus real self-shadowing (bright sunlit tops, dark undersides) + a second more-parallaxed lower
      cloud bank for layered depth in motion.
- [ ] 7.4 **Selective PBR + IBL** — Standard/Physical materials + env lighting for water, snow, wet
      rock, the car (terrain keeps draped NAIP; add material response where it reads).
- [ ] 7.5 **Water** — higher-res reflections + depth-based color (+ SSR if affordable).
- [x] 7.6 **Seasonal color** (c4b0a4d) — shared `uSeason` threaded into terrain-shaders, ScatterManager
      and GroundCover for autumn/wildflower palettes.
- [x] 7.x **Governor** (2ffa072) — adaptive quality-drop is now OPT-IN so it doesn't fight max quality.

## Already delivered (earlier sprints, verify against M-criteria as we go)
2:1-balanced stitched terrain LOD + relief skirts · marching-squares shorelines + shore fade ·
ribbon roads w/ lane markings + lane snap + grading-free drape · LANDFIRE-driven veg density/
height + photo impostors + top caps · baked AO + horizon shadows + cloud shadows (decorative) ·
ACES tone pipeline · buildings v1 (extruded + collision) · labels/minimap/fast-travel · drive
mode · perf: amortized streaming, frustum culling, altitude LOD.

## In flight (Sprint 5, running): real cast shadows (near-field) · water chop/flow + planar lake
reflections · building texture atlas v1 · veg pop-in fade + far forest band · CC0 car model +
first-person cam · class-aware ground detail textures · compass/discovery labels.

Constraints (standing): ~30-45 fps retina baseline, NO resolution scaling, storage-light
(<10 MB/lane), CC0/ODbL-verified assets only, deterministic placement, every lane revertible.
