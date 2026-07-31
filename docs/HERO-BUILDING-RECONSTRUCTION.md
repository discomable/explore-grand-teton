# Hero building reconstruction: the T. A. Moulton Barn pattern

**Status:** proven vertical slice  
**Reference implementation:** `terrain/pipeline/buildings/moulton_barn/`  
**Runtime owner:** `terrain/src/LandmarkManager.js`

## What we achieved

The T. A. Moulton Barn is a geographically placed, reference-backed landmark that reads much more
like the photographed building than the generic footprint extrusion it replaces. It remains small
enough for the browser world:

| Level | Use | Triangles | Material primitives | Switch distance |
|---|---|---:|---:|---:|
| LOD0 | close hero | 2,676 | 4 | 90 m |
| LOD1 | recognizable mid-field shape | 148 | 3 | 260 m |
| LOD2 | distant silhouette | 88 | 2 | beyond 260 m |

The result is best described as **measured reconstruction with image-assisted surfacing**, not
photogrammetry. LiDAR and documentary sources control the form. Image generation supplies
registered surface appearance where source photographs cannot safely or cleanly become a texture.

## Why the effect works

The effect is the combination of six inexpensive layers. No single layer is convincing alone.

### 1. Geographic truth

- The named OpenStreetMap footprint owns runtime position and collision.
- The 2022 USGS 3DEP building-class return owns the outer dimensions, ridge/eave heights,
  orientation and roof-pitch estimate.
- The original approximate latitude/longitude seed is retained only as discovery provenance; it
  is about 31 m from the authoritative runtime footprint.

This prevents a detailed model from floating in the wrong place—the most damaging landmark error
at landscape scale.

### 2. Documentary architectural truth

LiDAR gives an envelope, not an architectural interpretation. The NPS preservation plan and HABS
photograph resolved that envelope into:

- a central steep gable;
- two lower shed-roof additions;
- the photographed asymmetric door/opening arrangement;
- horizontal log walls, irregular vertical gable boards and a weathered board/shake roof.

The neighboring John Moulton barn has a gambrel roof. Keeping its photographs out of the T. A.
reference set was essential; otherwise a visually plausible but historically wrong hybrid results.

### 3. Silhouette-first geometry

The deterministic Blender generator spends geometry only where it changes recognition:

- measured gable and shed roof planes;
- closed triangular wall areas under both shed roofs;
- shallow log/plank relief and openings at close range;
- restrained roof sag, exposed log ends and sparse, partially buried foundation stones.

Small details are material-batched before export. LOD1 retains the main openings; LOD2 retains only
the two-material silhouette.

### 4. Two complementary texture strategies

The general surfaces use one compact 1024×512 atlas:

- weathered horizontal timber;
- dark weathered roof boards/shakes.

These are tileable, evenly lit material fields. They carry no landscape, perspective or baked
sunlight, so they remain stable under the game's lighting.

The hero front elevation uses a different technique:

1. Render the measured LOD0 from a fixed orthographic camera at 1536×1024.
2. Use that render as the edit target.
3. Ask the image tool to change surface appearance and opening detail while preserving the target
   silhouette and pixel registration.
4. Project the result back through the same camera onto front-facing LOD0 polygons only.

This is “faux photogrammetry” in the useful, constrained sense: photographs guide appearance, but
they do not infer or displace the geometry. Side/rear faces and lower LODs continue to use the
tileable atlas.

The successful façade prompt was structurally equivalent to:

> Preserve the exact registered target silhouette, proportions, roof pitch, framing and
> background. Reconstruct the T. A. Moulton Barn's asymmetric left access, central access, broad
> paired doors and narrow right doorway from the supplied HABS and west-elevation references.
> Keep weathered horizontal logs, pale chinking and irregular vertical gable boards. Do not add a
> gambrel roof, extra windows, new geometry, landscape, text, watermark or featureless black
> rectangles.

The constraint language matters more than stylistic language. A projection is useful only while
its edges remain registered to the target render.

### 5. Setting integration

A model pasted onto aerial imagery still looks synthetic. The landmark record adds a small,
irregular worn-earth apron that follows the streamed ground. Nearby authored fences and vegetation
remain visible; the tree exclusion was tightened after photographic comparison so it no longer
removed trees beside the nearest fence corner.

The generic building mesh is suppressed, but its footprint remains in collision and spatial
queries. The landmark is periodically re-based after finer terrain tiles settle.

### 6. Runtime discipline

`LandmarkManager`:

- loads all three GLBs once during optional world boot;
- displays exactly one LOD at a time;
- shares duplicate atlas/projection textures between LOD files;
- preserves cast/receive shadows and the normal environment/fog contract;
- adds texture-free object-space timber and roof variation in the shader;
- uses data-driven placement and LOD distances from `terrain/public/landmarks.json`.

The approach therefore improves one important place without increasing geometry everywhere in the
park.

## The production workflow

For a batch of landmarks, invoke the `hero-building-batch` Codex skill. Its
tracked contract is `terrain/pipeline/buildings/hero-batch.json`; deterministic
run state, quarantine reports, preview assembly and the local gallery are
managed by `terrain/pipeline/buildings/hero_batch.py`. Draft runs never alter
the production landmark manifest. The runner records named ownership, immutable
transition/verification events and artifact digests; it rejects self-approval,
direct attempt-one quarantine and stale or modified evidence during `audit`.

### 1. Register sources and uncertainty

Create a building folder containing:

- `building.json` — discovery seed, CRS and provisional estimates;
- `reference-sources.json` — source URL, author, licence and SHA-256 for every reference;
- `measurements.estimated.json` — explicit fallback values;
- `measurements.lidar-YYYY.json` — measured values plus provenance and uncertainty.

Prefer this source order:

1. measured drawings or HABS documentation;
2. classified LiDAR;
3. named footprint and surveyed/georeferenced mapping;
4. multi-angle public-domain or appropriately licensed photographs;
5. image-assisted synthesis only for missing clean surface information.

Never allow an image model to decide dimensions, roof topology or placement.

### 2. Acquire and process LiDAR

```sh
python3 -m pip install \
  -r terrain/pipeline/buildings/moulton_barn/requirements.txt
python3 terrain/pipeline/buildings/moulton_barn/download_lidar.py --list
python3 terrain/pipeline/buildings/moulton_barn/process_lidar.py
```

Downloaded clouds remain under ignored `terrain/pipeline/data/`; derived measurements are small,
reviewable JSON. Record the exact source hash so the envelope can be reproduced.

### 3. Generate and inspect the massing

```sh
blender --background --python \
  terrain/pipeline/buildings/moulton_barn/generate_barn.py -- \
  --measurements \
  terrain/pipeline/buildings/moulton_barn/measurements.lidar-2022.json \
  --output terrain/public/models
```

Review untextured massing before generating surface assets. Compare all four elevations where
possible. Correct the architectural interpretation in code, not in a texture.

### 4. Generate the registered façade

```sh
blender --background --python \
  terrain/pipeline/buildings/moulton_barn/render_projection_targets.py -- \
  --model terrain/public/models/ta-moulton-barn-lod0.glb \
  --output terrain/pipeline/data/moulton-barn/projection-targets
```

Use `front-clay.png` as the immutable edit target and only same-building photographs as visual
references. Keep generated source PNGs in the ignored pipeline area; compress the approved result
to WebP in `terrain/public/materials/<building>/`.

Do not regenerate geometry and projection independently. If the silhouette changes, render a new
target and repeat the registered edit.

### 5. Export and integrate LODs

- Hero LOD: silhouette cues, openings and registered façade.
- Mid LOD: primary openings and roof topology.
- Far LOD: unmistakable outline and broad material split only.
- Add one record to `terrain/public/landmarks.json`.
- Suppress the matching generic `BuildingManager` visual by stable footprint name.
- Keep the generic footprint registered for collision.

Before adding another landmark, generalize any building-specific shader/material names in
`LandmarkManager`; the manager should remain data-driven rather than becoming a list of special
cases.

### 6. Verify

```sh
npm run verify
python3 snap.py --suite reference
```

Add close, approach and distant fixed views for the new building. Review:

- silhouette and roof topology;
- ground contact and terrain re-basing;
- façade registration at grazing angles;
- tree/fence/context continuity;
- LOD transitions;
- day, golden-hour and overcast response;
- draw calls, triangles, transfer size, texture residency and console/network errors.

## Failure modes we encountered

| Failure | Cause | Durable correction |
|---|---|---|
| Wrong gambrel-like form | references from the neighboring John Moulton barn contaminated interpretation | source manifest plus an explicit exclusion list |
| Black rectangles over the façade | dark geometry/recess overlays duplicated openings already painted into the projection | projection owns hero opening appearance; omit LOD0 recess overlays |
| Daylight gaps beside the central roof | shed additions were flat-topped boxes under sloped roofs | wall profiles now follow the shed planes |
| Projection looks pasted on | unconstrained scene generation or silhouette drift | edit a fixed orthographic target; forbid geometry/background changes |
| Foundation looks like checkerboard teeth | stones were regular, bright and fully exposed | sparse deterministic placement, darker material and deeper burial |
| Barn floats on the landscape | model-only solution ignored the immediate setting | terrain-following worn apron, footing cues, fences and nearby vegetation |
| Missing nearby trees | exclusion zone treated the landmark as an isolated product render | tune exclusion against the photographic setting, not only model clearance |
| Excessive runtime cost | close detail was allowed to leak into every distance | three explicit LOD budgets and exactly one active LOD |

## Choosing the next buildings

The technique is strongest for a building with:

- a recognizable silhouette from public viewpoints;
- a mostly opaque exterior and simple material family;
- a named footprint or surveyable location;
- LiDAR or measured drawings;
- several legally usable, same-building views;
- no requirement for a seamless walkable interior;
- enough player visibility to justify a dedicated texture and three GLBs.

Score candidates from 0–2 on each of those seven criteria. Build candidates scoring 11 or more.
Use ordinary procedural buildings below that threshold.

## Recommended sequence

### 1. John Moulton barn and homestead — next

This is the best immediate reuse. It shares Mormon Row's terrain, fences, materials and approach
views, but has an unmistakable gambrel-with-shed barn and pink stucco house. The Library of
Congress HABS record provides nine photographs and one measured drawing, making source ambiguity
substantially lower than it was for the T. A. barn.

Scope the barn first, then add the house and small structures as a second cluster pass. Do not
reuse the T. A. façade projection; share only calibrated material families and pipeline code.

### 2. Andy Chambers homestead — next Mormon Row cluster

The National Park Service describes this as the most extensive surviving Mormon Row complex. Its
log cabin, stable and windmill would turn the current single-landmark scene into a convincing
historic settlement. This should use one cluster manifest with per-structure transforms and shared
textures rather than one monolithic high-detail mesh.

### 3. Cunningham Cabin — best standalone follow-up

The double-pen or “dogtrot” form—two cabins joined by an open breezeway beneath one roof—has a
strong silhouette and modest material needs. It is isolated, visitor-accessible and set against a
major Teton view, so a relatively small asset would have high recognition value.

### 4. Menor's cabin and country store — high visitor value

The Menors Ferry historic area is compact and frequently visited. Log construction fits the
existing material workflow well. Treat the cabin/store and ferry as separate assets: the building
pattern transfers directly, while the ferry needs its own thin-structure and water-contact rules.

### 5. Chapel of the Transfiguration — exterior first

The chapel is iconic and its altar window frames the Grand Teton. The exterior is suitable for
measured massing plus registered surfacing, but the meaningful interior view makes it a larger
slice. Ship an exterior landmark first; only add the interior as a separately budgeted,
portal-loaded scene.

### 6. Jenny Lake Ranger Station / Lee Manges cabin

This small rustic cabin is historically important and sits in a heavily visited area. It is a good
test of the technique under trees and close pedestrian inspection rather than an open sage-flat
vista. It should follow after vegetation/building contact shadows are stable enough for the cabin
to sit naturally beneath the canopy.

## Candidates to defer

- **Jackson Lake Lodge:** architecturally important but broad, modernist and dominated by glazing
  and interior/exterior relationships; a façade projection alone will not carry it.
- **Large lodge/cabin campuses:** repeated modular assets and occupancy logic should precede
  one-off hero reconstruction.
- **Bar BC Dude Ranch as a whole:** historically valuable, but the number and condition of
  structures make it a district-scale content project.
- **Generic service buildings:** insufficient recognition value; improve procedural archetypes
  instead.

## Primary reference starting points

- NPS Mormon Row cultural landscape:
  <https://home.nps.gov/articles/890056.htm>
- NPS Mormon Row history:
  <https://www.nps.gov/grte/learn/historyculture/mormon.htm>
- Library of Congress HABS, John Moulton Homestead:
  <https://www.loc.gov/pictures/item/wy0339/>
- NPS Cunningham Cabin:
  <https://www.nps.gov/places/000/cunningham-cabin.htm>
- NPS Menors Ferry Historic District:
  <https://www.nps.gov/grte/learn/historyculture/menors.htm>
- NPS Chapel of the Transfiguration:
  <https://www.nps.gov/places/000/chapel-of-the-transfiguration.htm>
- NPS Jenny Lake Historic District:
  <https://home.nps.gov/grte/learn/historyculture/jlhd.htm>
