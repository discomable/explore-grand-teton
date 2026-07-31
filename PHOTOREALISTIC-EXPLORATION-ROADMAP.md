# Grand Teton Photorealistic Exploration Roadmap

**Status:** Active delivery authority — rebased 2026-07-28
**Prepared from repository review:** 2026-07-23
**Planning horizon:** 6–9 months for a small, focused team
**Scope:** Browser-based, geographically faithful exploration of Grand Teton National Park

**Current delivery decision:** ship one reference-backed vertical slice per week. M2-class hardware
at the High preset is the blocking performance tier. `ROADMAP.md` is historical; delivery status
and exceptions are recorded here.

## Executive decision

The project already has the difficult geographic foundation: real 1.25 m USGS elevation and NAIP
imagery, quadtree streaming, aligned hydrology, roads, trails, structures, vegetation masks,
wildlife, driving, weather, day/night, audio, labels, and deterministic screenshot capture.

The most impactful path is **not to keep adding independent effects to the present renderer**.
The next visible leap requires one coherent program:

1. Keep the photographic benchmark and quality/performance gates authoritative.
2. Preserve the visually approved direct r184 ACES path; improve physical coherence in scene
   shaders and materials without reviving the rejected global HDR grade.
3. Replace billboard/procedural content only inside a high-quality near-field “experience bubble.”
4. Make water, atmosphere, terrain materials, vegetation, and authored landmark corridors agree
   under the same lighting model.
5. Turn the technically explorable world into a compelling park experience through routes,
   discovery, ecology, sound, and graceful streaming.

This order matters. The direct renderer won the same-view review over the experimental HDR stack,
so another global post rewrite is not a prerequisite. New materials must instead agree under the
existing ACES, sky-environment, exposure, fog, and shadow contracts. Producing thousands of assets
before establishing target viewpoints and budgets would still create cost without reliable gain.

## North-star outcome

A user should be able to start at a recognizable trailhead, walk or drive through a continuous
landscape, and believe the scene at three perceptual scales:

- **Vista (1–20 km):** the Cathedral Group has the correct silhouette, geological structure,
  snow distribution, aerial depth, and light.
- **Place (20 m–1 km):** forests, meadows, water, roads, buildings, and weather form a coherent,
  recognizable Wyoming landscape without obvious LOD bands or repeated assets.
- **Presence (0–20 m):** the ground, plants, rocks, water edges, vehicle, and audio hold up during
  slow walking and close inspection.

The experience must also feel alive: weather and time alter visibility and sound; routes lead to
meaningful discoveries; wildlife appears plausibly and sparingly; and movement is smooth enough
that streaming artifacts do not break presence.

## Repository assessment

### What is already strong

| Area | Evidence in the repository | Assessment |
|---|---|---|
| Geographic base | `TerrainStreamer`, z0–z7 terrain/imagery manifests, 1.25 m native pixel size | Strong foundation; preserve |
| World alignment | NHD/NLCD/LANDFIRE/OSM/GNIS-derived water, landcover, vegetation, roads, trails, buildings, and labels | High leverage already captured |
| Terrain continuity | Balanced quadtree LOD, stitching, morphing, streamed collision | Mature for a browser project |
| Environmental breadth | Water, ground cover, props, wildlife, seasons, weather, day/night, driving, held map, audio | Broad feature coverage |
| Repeatability | Seeded placement, fixed `views.json`, headless screenshots with error/perf metadata | Excellent starting point for visual QA |
| Delivery | Static web architecture, R2 tile delivery, service-worker tile cache, Cloudflare deployment | Simple and deployable |

### Constraints now limiting realism

| Constraint | Current evidence | Consequence |
|---|---|---|
| Mixed material contracts | The approved r184 direct ACES path combines custom terrain/road/water shaders with built-in materials | Surfaces require calibration under one lighting/fog contract; a global grade cannot repair local mismatches |
| Transitional application architecture | Three.js is r184, but ordered classic world modules remain | Cross-cutting work still needs bounded slices and complete late-loaded shader coverage |
| Inconsistent material model | Custom terrain/road/water shaders mixed with Lambert and selectively planned PBR | Surfaces do not respond to light as one physical world |
| Near-field asset ceiling | Photo-impostor trees, crossed-card ground cover, procedural box wildlife and structures | Silhouettes and shading reveal the simulation at walking distance |
| Shadow compromise | A single camera-following shadow region is active near the player and can reveal its boundary | Contact improves locally, but coverage and fade must remain restrained |
| Water ceiling | Planar lake reflection plus custom shading; roadmap still calls for depth color/reflection work | Lakes and the Snake River remain a dominant unreal surface |
| Limited experience structure | Navigation, fast travel, labels, driving, and map exist; routes and discoveries are mostly systemic | Technically explorable, but not yet a curated park journey |
| Validation gap | Device budgets and representative routes exist, but visual settlement did not prove that every visible terrain leaf drew | A nominally settled, error-free capture can still contain a severity-one hole |
| Near-field asset provenance | Existing assets have file-local notes but no machine-checked inventory | Free/attributed asset intake can drift without a single validated ledger |

## Product and technical principles

1. **Photorealism is coherence, not effect count.** Lighting, exposure, atmosphere, materials,
   scale, motion, and sound must tell the same story.
2. **Spend geometry near the user and data at distance.** Preserve the streamed geographic base;
   use true 3D assets inside a bounded near field, clusters/impostors in the middle, and
   terrain-integrated representations at distance.
3. **Author the important journeys.** A small number of exceptional routes will outperform an
   evenly polished but anonymous whole park.
4. **No invisible quality claims.** Each investment gets fixed reference scenes, quantitative
   budgets, and a named reviewer gate.
5. **Progressive enhancement is mandatory.** “Cinematic” may be expensive, but the public build
   still needs robust high/medium fallbacks and a clear unsupported-device path.
6. **Geographic and ecological truth beats decorative density.** Correct sparseness, seasonality,
   and habitat are more convincing than more objects.

## Prioritized roadmap

### Phase 0 — Establish truth and remove planning risk

**Duration:** 2 weeks
**Impact:** Enables every later phase
**Exit decision:** A reproducible baseline and an agreed target bar exist.

#### Deliverables

- Select 12–16 photographic reference scenes covering:
  - dawn, midday, golden hour, overcast, storm, moonlit night;
  - mountain vista, lake, river, sage flat, dense forest, trail, road, and developed area;
  - summer, autumn, and snow-season states.
- Match each reference to a fixed in-world camera pose in versioned view files.
- Add a baseline manifest per view: resolution, quality preset, weather, season, time, calls,
  triangles, CPU time, GPU time where supported, memory estimate, and expected tile-settle time.
- Add perceptual screenshot comparison (SSIM/LPIPS or equivalent) as an advisory CI artifact.
  Do not use a single pixel threshold for weather or animated vegetation.
- Define three tested hardware tiers:

| Tier | Target | Resolution target | Performance floor |
|---|---|---|---|
| Cinematic desktop | Recent discrete GPU / Apple Silicon | 1440p or device-native with temporal upscaling | 30 fps, 1% low ≥ 24 |
| High desktop | Integrated modern GPU | 1080p | 45 fps, 1% low ≥ 30 |
| Accessible fallback | Lower-end WebGL2 device | 720–900p | 30 fps |

- Record route-level metrics: cold-start interactive time, visible tile pop count, frame-time
  spikes, peak resident textures, and traversal hitching on a repeatable drive and hike.
- Reconcile `README.md`, `ROADMAP.md`, and the design docs so one document is the delivery truth.
- ~~Place the opt-in `97-poc.js` work behind a clearly labeled experimental flag or remove it from
  the production load path after useful ideas are migrated.~~ Done: the module and its `poc/`
  assets have been deleted (no recorded licence for several bundled GLBs).

#### Acceptance

- One command produces the canonical screenshots and a machine-readable performance report.
- Every later milestone cites the reference views and performance deltas it is expected to move.
- Product owners agree on five “hero” scenes that must look genuinely photographic.

---

### Phase 1 — Rendering foundation: physically coherent direct rendering

**Status:** engine migration and renderer-path decision complete; material coherence remains active
**Duration:** completed foundation plus incremental weekly calibration
**Impact:** Highest visual leverage in the roadmap
**Dependencies:** Phase 0

Three.js is now pinned to r184. Same-view review selected the direct ACES renderer over the
experimental HDR composite, which remains opt-in for diagnostics. Do not reopen that decision
without a measured reference-scene win.

#### Deliverables

1. **Unified environmental illumination**
   - Generate or supply time/weather-specific sky radiance for image-based lighting.
   - Use physically plausible sun/sky intensity relationships and a calibrated camera exposure.
   - Add slow, bounded auto-exposure with separate indoor/vehicle tuning; prevent pumping during
     tree occlusion and fast turns.

2. **Shadow strategy**
   - Use stable cascaded sun shadows for a limited near/mid field, texel-snapped in world space.
   - Retain baked terrain horizon shadows for the distant range.
   - Add contact shadows or GTAO only after stable depth/normal buffers exist.
   - Moving objects and hero foliage must receive and cast compatible shadows.

3. **Output discipline**
   - Keep one ACES/output transform on the direct path and treat `?postfx` as experimental.
   - Add selective effects only when the fixed hero scenes prefer them and M2 High remains inside
     its frame budget.
   - Keep depth of field off during normal exploration.

#### Acceptance

- Sunlit snow and water highlights retain detail without flattening the shaded forest.
- Entering a vehicle or dense trees adapts naturally without visible exposure pumping.
- No double tone mapping, mismatched fog convergence, shadow boxes, or color discontinuity between
  terrain, vegetation, buildings, water, and glTF assets.
- Five hero scenes show a clear blind-review preference over the current renderer.
- Cinematic tier stays at or above its frame-time and memory budgets.

---

### Phase 2 — Natural-world material system

**Duration:** 5–7 weeks
**Impact:** Converts good geography into believable surfaces
**Dependencies:** Phase 1

#### 2.1 Terrain and geology

- Keep NAIP for macro truth, but separate it from surface response.
- Build tiled, biome-aware material layers for granite/talus, forest duff, sage soil, meadow,
  mud, gravel, and snow.
- Derive or bake normal, roughness, ambient-occlusion, wetness, and material-ID data at useful
  scales; use stochastic/detail-normal techniques to suppress repetition.
- Add slope/aspect/elevation rules for exposed rock, scree, persistent snow, soil moisture, and
  erosion channels.
- Create a **Cathedral Group hero dataset**: improved source DEM or selectively authored
  displacement/normal detail for the Grand, Middle, and South Teton silhouettes and major faces.
  The repository itself notes that the Grand can still read as foothill-like; this is a higher
  priority than adding more distant props.

#### 2.2 Water and shoreline

- Use one physically based water family with separate lake and river parameters.
- Add depth/bed color, Beer–Lambert absorption, Fresnel reflection, sky/sun specular, shoreline
  foam/wetness, and flow-aligned normals.
- Improve lake reflections using a quality-tiered solution: stable planar reflections for hero
  lakes, probe/sky fallback elsewhere, optional screen-space detail only where it remains stable.
- Make rain and recent weather affect roughness, turbidity, puddles, roads, rocks, and foliage.
- Validate all water/road/bridge interactions from walking, driving, and aerial views.

#### 2.3 Roads, trails, buildings, and vehicle

- Convert hero surfaces to a consistent metallic/roughness workflow.
- Add decals and mesh details only where they communicate use and scale: aggregate, cracks,
  drainage, tire wear, trail erosion, signs, road markings, window interiors, and roof variation.
- Finish a production-quality vehicle interior/exterior with correct materials, glass, gauges,
  mirrors, exposure transition, and spatial audio.

#### Acceptance

- Close ground remains credible at a 1.7 m eye height without obvious imagery blur or repeating
  textures.
- The core peaks remain recognizable in silhouette under flat noon light, not only dramatic light.
- Water reads correctly in still, wind, overcast, sunset, and night reference scenes.
- Rain changes material response across the whole scene rather than only changing clouds.

---

### Phase 3 — Vegetation and ecological presence

**Duration:** 6–8 weeks, overlapping late Phase 2
**Impact:** Highest near-field presence gain
**Dependencies:** Phase 1; terrain material IDs from Phase 2

#### Deliverables

- Replace the closest production tree cards with a small, botanically appropriate 3D library:
  lodgepole pine, Douglas fir, Engelmann spruce, subalpine fir, aspen, cottonwood, willow, sage,
  common grasses, and seasonal flowers.
- Use a four-representation hierarchy:

| Distance | Representation |
|---|---|
| 0–40 m | Full 3D hero vegetation with wind, receiving/casting shadows |
| 40–150 m | Simplified clustered geometry |
| 150–800 m | High-quality impostors with matching normals and seasonal color |
| Beyond | Terrain-integrated canopy/forest mass |

- Preserve the current LANDFIRE/NAIP/tree-point placement data, but improve species assignment
  using elevation, aspect, moisture, canopy height, burn history where available, and proximity to
  water.
- Add temporal-stable wind: shared low-frequency gust field, branch/leaf response by species,
  restrained motion at distance, and no screen-space shimmer.
- Improve ground transitions: roots, duff, deadfall, small rocks, grass suppression under dense
  canopy, irregular forest edges, and trail/road disturbance.
- Replace procedural box wildlife in the near field with rigged, licensed models and a restrained
  behavior system. Keep distant wildlife sparse; support grazing, alert, flee, crossing avoidance,
  and habitat/time-of-day schedules.

#### Acceptance

- A slow 60-second walk through forest, sage, and riparian zones has no obvious cross-card reveal,
  synchronized wind, repeated clone pattern, or hard LOD pop.
- Species and density are plausible in a review by a regional ecology reference or authoritative
  park material.
- Wildlife can be absent without the scene feeling empty; encounters feel exceptional, not spawned
  for the player.

---

### Phase 4 — Author five exceptional exploration corridors

**Duration:** 6–8 weeks
**Impact:** Converts visual technology into a memorable product
**Dependencies:** Phases 1–3 sufficiently stable

Do not distribute bespoke work evenly across the full park. Concentrate it along five journeys:

1. **Moose–Wilson / sage and wildlife drive**
2. **Jenny Lake shore and Hidden Falls approach**
3. **Cascade Canyon hike**
4. **Teton Park Road scenic drive**
5. **Oxbow Bend / Jackson Lake sunrise and reflection route**

The exact set can change after Phase 0 reference selection, but it should span driving, walking,
water, forest, alpine vistas, built landmarks, and different times of day.

#### Deliverables

- Correct trailheads, parking, bridges, signs, barriers, viewpoints, shoreline access, landmark
  structures, and localized prop/ecology dressing.
- Route-aware streaming prefetch and transition masking so normal travel does not expose tile,
  vegetation, building, or texture arrival.
- Lightweight experience layer:
  - optional route guidance through the held map and physical signs;
  - discovery moments and short factual interpretation;
  - viewpoint/photo challenges;
  - sunrise, sunset, weather, and wildlife recommendations;
  - reversible accessibility assists for navigation and movement.
- Movement polish:
  - footstep surfaces, slope-aware gait/camera motion, crouch/step handling;
  - driving traction, suspension, road noise, collision, bridge continuity;
  - fast travel framed as returning to trailheads/viewpoints, not arbitrary teleportation.
- Photo mode with time/weather controls, focal length, exposure compensation, clean HUD, and
  high-resolution capture.

#### Acceptance

- Each corridor completes without getting stuck, falling through geometry, visible world holes,
  severe pop-in, or a sustained frame-rate failure.
- A first-time user can discover, navigate, and complete one route without reading keyboard docs.
- Each route contains at least three views that pass the photographic target in blind comparison.
- Interactive evaluation confirms camera motion, driving feel, sound, and controls; headless tests
  are not accepted as substitutes for these qualities.

---

### Phase 5 — Weather, sound, and living systems

**Duration:** 4–6 weeks
**Impact:** Multiplies replayability and atmosphere
**Dependencies:** HDR/material pipeline

#### Deliverables

- Replace purely visual weather switching with coherent states: clear, high overcast, broken
  cloud, valley fog, rain/thunder, light snow, and post-storm clearing.
- Use physically connected transitions across sky radiance, visibility, cloud shadow, wind,
  precipitation, wetness, water roughness, vegetation motion, temperature/season, and sound.
- Upgrade synthesized ambience with geographically appropriate field recordings or a hybrid
  system: spatial river/lake beds, wind filtered by exposure/forest, localized birds/insects,
  thunder delay, rain occlusion in the vehicle, tire/engine/surface layers, and quiet zones.
- Add time-of-day ecology schedules and rare deterministic events without turning the park into a
  theme park.
- Preserve a compact no-audio and reduced-motion mode.

#### Acceptance

- A weather transition produces no abrupt lighting, fog, material, audio, or reflection mismatch.
- Blind listeners can distinguish forest, lakeshore, river, open sage, vehicle, and storm contexts.
- Night remains genuinely dark and navigable through plausible moon, vehicle, settlement, and
  adaptation cues.

---

### Phase 6 — Scale, robustness, and public release

**Duration:** 3–5 weeks, with work pulled forward continuously
**Impact:** Makes quality reliably reachable
**Dependencies:** All phases

#### Deliverables

- Content-addressed/versioned R2 assets and manifests so code and terrain/material updates cannot
  become mismatched.
- Compressed GPU textures (KTX2/Basis), mesh compression, range requests where useful, and explicit
  CPU/GPU memory budgets.
- Predictive prefetch based on speed, route, camera direction, and drive mode; cancellation and
  priority queues for rapid fast travel.
- Quality presets that change coherent systems rather than isolated toggles:

| Preset | Key behavior |
|---|---|
| Cinematic | HDR, high shadow/reflection range, full near-field vegetation, volumetrics, temporal upscaling |
| High | Reduced ranges/resolution, same material and lighting model |
| Medium | Clustered vegetation, simpler shadows/reflections/fog, lower internal resolution |
| Safe | Geographic terrain/imagery, essential water/roads/labels, minimal dynamic effects |

- First-run capability benchmark and recommended preset, with user override.
- Browser/device test matrix, context-loss recovery, network interruption recovery, cache versioning,
  loading progress, and useful error states.
- Accessibility: remappable controls, keyboard/touch/gamepad parity, motion reduction, captions for
  interpreted content, contrast/readability settings, and no audio-dependent navigation.
- Data-source provenance and in-product attribution audit.

#### Acceptance

- Repeatable route tests pass on all supported tiers.
- Fast travel and network interruption recover without permanently missing content.
- No single asset failure prevents entry into the park.
- Deployment can roll back code and asset manifests together.

## Impact order and investment split

If capacity is limited, allocate effort in this order:

| Rank | Investment | Share of effort | Why |
|---:|---|---:|---|
| 1 | HDR/PBR lighting and renderer foundation | 22% | Removes the ceiling affecting every pixel |
| 2 | Terrain/geology, water, and atmosphere coherence | 21% | Peaks and water dominate nearly every Grand Teton view |
| 3 | Near-field vegetation and ground | 18% | Walking exposes the current billboard/procedural ceiling immediately |
| 4 | Five authored exploration corridors | 17% | Turns systems into a compelling experience |
| 5 | Streaming, performance, and device resilience | 12% | Protects presence and public reach |
| 6 | Weather, spatial audio, and wildlife depth | 10% | Multiplies mood after the visual foundation works |

## What not to prioritize yet

- **Full-park handcrafted detail.** Finish the five corridors first and measure whether users leave
  them.
- **More post effects on the current LDR stack.** SSAO, SSR, DoF, and stronger bloom will not solve
  the foundational color/lighting mismatch and may add instability.
- **Unbounded feature additions.** Waterfalls, more vehicle types, deep survival systems, NPCs, or
  multiplayer are lower impact than resolving the renderer, peaks, water, and near field.
- **Uniformly high 3D vegetation range.** It will consume the budget without improving distant
  forest masses.
- **Photogrammetry everywhere.** Use scan-derived assets selectively and keep terrain/geospatial
  continuity authoritative; inconsistent captures can look less real than a coherent material set.
- **DoF during ordinary exploration.** It conflicts with human vision and makes navigation less
  clear; retain it for photo mode.
- **A second roadmap that duplicates delivery state.** After approval, fold this plan into one
  canonical tracker and archive stale milestone prose.

## Measurement framework

### Visual

- Blind A/B preference against the current main branch for the five hero scenes.
- Reference-photo review for silhouette, terrain color/value, vegetation scale, water response,
  atmospheric depth, and material consistency.
- Temporal review clips for shimmer, shadow swimming, LOD transitions, exposure pumping, cloud
  motion, reflections, and vegetation wind. Still images alone are insufficient.

### Performance

- Median and 1% low fps on each tier.
- CPU main-thread, GPU frame time, draw calls, triangles, texture/geometry memory.
- Cold start, time to interactive, time to first credible scene, tile settle time.
- Frame-time spikes and visible content arrivals during each canonical route.

### Experience

- Time for a new user to enter, move, find a route, and reach a viewpoint.
- Route completion and abandonment points.
- Percentage of time spent walking, driving, using the map, taking photos, and fast traveling.
- User ratings for “felt present,” “recognized Grand Teton,” “movement felt natural,” and
  “wanted to keep exploring.”

### Quality gates

Every milestone should pass:

1. Code/shader errors empty in all affected capture metadata.
2. No unexplained regression in frame time, calls, memory, or settle time.
3. Still-image approval for target views.
4. Motion review for all temporal systems.
5. Interactive approval for control, audio, driving, and performance changes.
6. Source/license/provenance recorded for every new dataset and asset family.

## First 30 days

### Week 1

- Name one roadmap owner and make this the proposed canonical direction.
- Select the five hero scenes and five exploration corridors.
- Capture current stills and 20–30 second traversal clips on the three hardware tiers.
- Resolve the current status contradictions across `README.md` and `ROADMAP.md`.

### Week 2

- Add benchmark manifests and route telemetry.
- Establish visual comparison artifacts in CI.
- Inventory every custom shader and material against the modern three.js/color-management API.
- Record asset/network/GPU memory baselines.

### Weeks 3–4

- Build a narrow modern-three.js + linear-HDR spike containing:
  - one terrain tile;
  - one tree;
  - one building;
  - one road;
  - one water surface;
  - the car;
  - one representative sky/weather state.
- Reproduce one midday and one golden-hour hero scene.
- Decide go/no-go on incremental engine migration based on visual preference, compatibility effort,
  and measured frame cost.

At day 30, the project should not have accumulated many new features. It should have answered the
most important technical question—whether a modern linear HDR foundation can preserve the current
geographic system while producing a clearly more photographic, measurable result.

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Engine upgrade breaks custom shaders and classic-script globals | Prove a vertical slice first; migrate by subsystem; keep current build as visual oracle |
| Cinematic quality becomes unusable | Tier budgets from Phase 0; temporal upscaling/dynamic resolution; bounded representation ranges |
| New PBR assets look disconnected from terrain | Shared calibration scene, material value ranges, IBL, and one final color pipeline |
| TAA/temporal effects ghost on vegetation | Stable motion strategy, alpha-tested foliage tuning, reactive masks or disable temporal effects by tier |
| Photographic references bias toward exceptional light | Include flat noon and overcast acceptance scenes |
| Asset production expands without end | Five corridors, fixed species/material libraries, measurable hero-view impact |
| Public data or asset licensing is unclear | Provenance manifest and review gate before import |
| “Max quality” hides public reliability problems | Cinematic remains a tier, not the sole supported configuration |

## Definition of success

The roadmap succeeds when the experience is not merely an accurate map rendered in 3D, but a
convincing visit: the Tetons are unmistakable in ordinary light; the Snake River and lakes react
naturally to sky and weather; walking through sage, forest, and shoreline survives close scrutiny;
driving and hiking remain smooth; and five complete journeys feel deliberately made without
sacrificing the geographic continuity that is already the repository’s greatest strength.
