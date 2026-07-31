# Photorealism screenshot audit

**Audit date:** 2026-07-26  
**Runtime:** Three.js r184 migration worktree  
**Evidence:** canonical `full` capture suite in `shots/`

## Verdict

The world currently reads as a sophisticated real-terrain game prototype rather than a
photograph. Geographic scale, the core Teton silhouette, dark-night exposure, and the Jackson
Lake composition are convincing foundations. Repeated vegetation representations, visibly
polygonal shoreline treatment, close-ground blur, and insufficient material/atmospheric
separation are the strongest synthetic cues.

## Priority findings

### P0 — Water and shoreline integrity

`auto-forest-air.png` and `auto-overcast-valley.png` expose straight water boundaries,
rectangular extensions, and repeated pale shoreline slabs. The baked water field is sampled on a
10 m grid, while independently jittered shoreline chords emit broad trapezoids that overlap and
make the raster outline conspicuous.

**Acceptance:** no rectangular or repeated shoreline slabs from the canonical aerial view; the
water remains continuous; close views retain a narrow wet-sediment transition without exposing
the mask grid.

### P0 — Vegetation representation and color

Trees are predominantly grey/brown, repeat the same narrow silhouette, and form hard forest
bands. Distant impostors create bright horizontal card-like marks across mountain slopes.
Night views expose repeated cut-out rows rather than a coherent forest mass.

**Acceptance:** no bright card streaks in `treeline`, `golden-peaks`, or `moonlit-range`; forest
edges are irregular; near trees retain green species variation and believable crown/trunk ratios;
distant forest reads as canopy mass rather than individual repeated sprites.

### P1 — Eye-height ground materials

Valley-floor imagery is visibly stretched and blurred. Sage, grass, and stones repeat with weak
contact and little soil, duff, gravel, normal, or roughness structure.

**Acceptance:** `sage-ground` and `grove-ground` remain credible at a 1.7 m eye height without
obvious aerial-image blur, repeated rosettes, floating stones, or a smooth heightfield response.

### P1 — Terrain/geology material separation

Rock, snow, forest, and soil share too much of the same draped-image response. Daylight produces
strong green/white separation; golden hour turns broad surfaces uniformly orange. Foothills can
read inflated rather than geologically structured.

**Acceptance:** the Cathedral Group remains recognizable under flat noon light; rock, snow,
talus, forest, and soil have distinct normals and roughness; dramatic lighting is not required to
make the peak faces legible.

### P1 — Lighting and atmospheric depth

Clear daylight is flat and saturated, overcast retains excessive contrast, golden hour is heavily
orange, and clouds appear stretched in static frames. Foreground foothills, the core range, and
distant ridges need stronger but restrained depth separation.

**Acceptance:** clear, overcast, golden-hour, and night views each have coherent sky/terrain
illumination; overcast becomes broad and cool without crushed forest; haze separates distance
planes without bleaching the mountains.

### P2 — Lake reflection

`auto-jackson-shore.png` is a strong composition, but the reflection approaches a perfect mirror
and shows a horizontal transition at the far shore.

**Acceptance:** Fresnel, distance roughness, depth color, shoreline integration, and atmospheric
convergence remove the visible transition while retaining a recognizable reflection.

## Delivery order

1. Remove polygonal shoreline slabs.
2. Correct vegetation atlas/color/alpha and distant card streaks.
3. Replace uniform forest rows with coherent canopy mass and near-tree variation.
4. Add biome-aware close-ground material response.
5. Recalibrate daylight, overcast, atmosphere, and terrain saturation.
6. Refine lake reflection and shoreline response.
7. Build the Cathedral Group hero geology dataset.

## Review discipline

Every change must retain empty `errors` and `failedRequests` in capture sidecars, compare the
same named viewpoints, and include temporal inspection for streaming, LOD transitions, wind,
water, and exposure. A new r184 visual baseline should be approved only after interactive review;
the absence of a baseline must not be treated as approval.

## Progress

### 2026-07-26 — first P0 correction pass

- Narrowed the generic shoreline strip, changed it from a universal pale beach to a darker
  wet-bank transition, and faded the final water cell into terrain. The giant pale trapezoidal
  slabs are removed. The remaining angular contour is limited by the 10 m baked field and still
  requires a higher-resolution or vector-aware water rebake for full acceptance.
- Removed the legacy ultra-far forest's horizontal crown-cap fragments. They hid crossed cards
  from directly above but appeared as repeated pale islands in `golden-peaks` and bright dashes
  at grazing angles in `treeline`. Upright cards remain as the temporary distant silhouette;
  the planned batched terrain-conforming canopy shell is the long-term replacement.
- Corrected the baked conifer photos at material time: photographic luminance detail is retained
  while blue-grey/brown needles are steered toward a restrained dark evergreen response. The
  fuller lodgepole crown now has a 52% deterministic share, with open and sparse variants retained,
  and atlas columns carry deterministic crown-width variation. `grove-ground` now reads as healthy
  conifer forest instead of uniform grey deadfall without changing placement density.
- Removed the procedural cylinder and curved-branch trunk geometry from close trees. The photo
  cards now supply the trunk, with lower-centre darkening and atlas-column variation preventing the
  previous bright, flat, identical poles. Contact shading and crown detail slices remain.
- Removed fixed emissive floors from tree shells and ground-cover tufts, and made the wildlife
  materials explicitly non-emissive. Building atlas emission is now confined to window-mask
  pixels, reduced in strength, and gated to full night; walls remain scene-lit at all times.
- Explicit time scrubs now synchronize exposure in the same frame as the sun, hemisphere light,
  fog, and shared shader uniforms. Continuous clock playback retains gradual eye adaptation.
  This removes the one-to-two-second interval in which vegetation, animals, and buildings could
  appear to retain the previous time-of-day brightness.
- Fixed the remaining environment-light lag: explicit time scrubs now bypass the 1.5-second PMREM
  throttle (continuous playback remains throttled), and playback publishes its new lighting state
  before terrain and vegetation manager updates. This closes the transient old-sky illumination
  still visible on foliage after the first exposure fix.

### 2026-07-26 — eye-height ground and foliage contact pass

- Extended the existing deterministic ground-detail atlas from a luminance overlay into a
  world-anchored material response. NLCD class and local patch fields now separate dry mineral
  soil, forest duff, meadow grass, gravel/scree and snow through restrained colour, per-material
  micro-normal relief and roughness. The aerial image remains the large-scale albedo source.
- Strengthened ground-cover root occlusion, softened the lowest alpha transition and embedded tuft
  pivots a further 2 cm so cards meet rolling terrain rather than appearing placed on top of it.
- Replaced hard stand and biome-zone placement cutoffs with deterministic probabilistic feathering.
  The main-thread fallback and presentation worker use identical thresholds and seeded draws, so
  community edges soften without mode-dependent placement or temporal crawling.
- Revalidated `sage-ground`, `grove-ground` and `moonlit-developed`; all capture sidecars report
  empty `errors` and `failedRequests`. The next material calibration pass should address the wider
  valley imagery's remaining yellow-green saturation, separately from close-ground structure.

### 2026-07-26 — adaptive shoreline contour refinement

- Decoupled shoreline contour resolution from interior water geometry. Far chunks now march the
  continuously interpolated water/terrain field at 5 m instead of 20 m, and nearby chunks at 2.5 m
  instead of 10 m. A packed 2.5 m mask rasterized from the original NHD polygons constrains shallow
  shoreline spill, while the authoritative 10 m elevation texture remains unchanged. This avoids
  expanding the Uint16 elevation field and retains only a compact bitset for the vector mask.
- The bake now grows river and lake candidates independently: rivers retain the wider corridor
  needed to bridge NHD segmentation gaps, while lakes no longer expand four 10 m pixels into
  neighbouring depressions. Same-view recaptures of `forest-air` and `overcast-valley` remove the
  false wetland-sized rectangle and repeated pale slabs; the remaining mapped pond follows the
  irregular NHD outline. `jackson-shore`, `snake-overlook`, and `snake-river-flow` were also
  recaptured without browser errors or failed requests.
- Follow-up field captures exposed an over-constraint in the first vector-gate integration: it
  reduced the Snake at Dornans to its low-flow source polygon and emptied Taggart Lake where the
  vector and DEM shoreline registrations differ. The strict 2.5 m vector gate is now limited to
  ponds below 0.05 km². Rivers and substantial lakes retain their authoritative terrain-derived
  waterlines. Dedicated Dornans and Taggart regression views confirm both surfaces are restored,
  while `forest-air` confirms the small-pond spill remains removed.

### 2026-07-26 — distant stand impostors

- Rejected the continuous canopy shell as the production destination. Band 3 now uses irregular
  eight-tree stand clumps in deterministic 128 m microcells, retaining the existing 512 m cache,
  moving ring, distance fade and single instanced draw.
- Five-sample forest strength thins mixed edge cells and preserves openings. Several conditioned
  atlas columns, varied tree heights and four card headings replace the previous repeated crossed
  rows. `?farRows=1` is the matched old-representation control.
- Same-view `treeline` comparison removes the bright horizontal slope streaks and keeps forest
  structure legible. `golden-peaks`, `forest-air`, and `moonlit-range` remain clean; the stand and
  row controls have effectively equal measured average frame time.
