# Foliage architecture assessment

Date: 2026-07-23  
Scope: photorealistic, navigable Grand Teton vegetation in the Three.js/WebGL application.

> Written while the engine was three.js r128; it is now r184 (see
> `docs/R184-WORKER-ARCHITECTURE.md`). The r128 constraints cited below are the constraints that
> shaped these decisions, not current limitations. The architectural conclusions still hold.

## Executive decision

The best approach is a **hybrid, ecology-driven foliage system**:

1. Instanced structural trees close to the camera: real trunks and primary branches with clustered
   needle/leaf geometry.
2. Simplified clustered trees through the middle distance.
3. Multi-angle, depth-aware impostors at long range.
4. The existing terrain-integrated forest-patch band beyond individual-tree distance.

This is not “one 3D tree everywhere.” It is one rendering system fed by a small, deliberately
varied library. Start with 12 conifer masters: four ecological archetypes times three silhouettes.
Derive their lower LODs and impostors from the same masters, then add deciduous and riparian sets.

This is the highest-impact and lowest-regret route for this repository. Improving the current
photographic crossed-card atlas cannot fix its view-dependent collapse, pale fringes, inconsistent
lighting, card intersections, or overhead silhouette. Conversely, rendering full geometric trees
throughout a 2.1 km individual-tree radius is unsuitable for the project's WebGL triangle,
overdraw, memory, and draw-call budgets.

## Evidence from the current implementation

`ScatterManager.js` already provides most of the difficult world system:

- deterministic 256 m streaming cells and bounded memory;
- NLCD class densities, LANDFIRE vegetation height/cover and NAIP forest-mask alignment;
- stand/glade clustering;
- water, slope, road and building rejection;
- elevation-driven treeline, subalpine form, scale, tilt and tint;
- seasonal conifer/deciduous response;
- pooled `InstancedMesh` objects;
- an individual-tree radius near 2.1 km and a terrain-integrated canopy band to 6 km.

Keep those data sources and rules. The present visual failure is mainly representation:

- near trees are a low-poly trunk plus three crossed photographs and a horizontal cap;
- middle trees are two crossed cards plus a cap;
- the source atlas mixes independently photographed trees and aggressive tint multipliers;
- alpha-tested photographic fringes become pale outlines under changing light;
- cards contain baked illumination that is lit again by the real sun;
- crowns lack stable volume, branch parallax, coherent normals and believable backlighting;
- per-cell/per-species meshes spend draw calls while still showing repeated atlas silhouettes.

The measured baseline is already close to or beyond some performance gates: the recorded median
frame time is 24.54 ms, worst 1% low is 20 fps, maximum draw calls are 287 and maximum triangles
are 6.10 M. The foliage replacement must therefore improve quality per visible pixel, not merely
add geometry.

## What established practice says

The durable production pattern is hybrid geometry plus image-based LOD:

- NVIDIA's SpeedTree rendering chapter combines alpha-tested foliage, alpha-to-coverage,
  transmission-like lighting and dithered LOD transitions. It specifically identifies harsh,
  scintillating cutout edges as a foliage problem.
- NVIDIA's Crysis vegetation chapter separates trunk and foliage shading, uses alpha-tested
  double-sided leaves, stores stiffness/phase data for procedural wind, adds a thin-material
  transmission approximation and bakes local occlusion into foliage attributes.
- Unity's SpeedTree pipeline uses geometry LODs followed by a cross-faded billboard transition.
  Its general LOD documentation describes screen-space dithering/cross-fade instead of abrupt
  swaps.
- Unreal's conventional foliage system relies on instancing and mesh LOD. Its newer Nanite
  foliage architecture uses repeated branch/frond assemblies—evidence for reusable structural
  parts, but not a technique available in WebGL/r128.
- Three.js `InstancedMesh` is the relevant browser primitive because it reduces draw calls for
  repeated geometry with unique transforms.
- The glTF specification recommends masked rather than blended transparency for foliage-like
  surfaces and explicitly permits alpha-to-coverage at mask edges.
- Large-scale forest-rendering research consistently combines multiresolution trees, instancing
  and impostors rather than choosing only geometry or only sprites.

The conclusion is not engine-specific: use geometry where parallax and lighting are noticed,
impostors where projected size makes geometry wasteful, and make transitions stable.

## Options considered

| Approach | Visual ceiling | Web fit | Homogeneity risk | Decision |
|---|---:|---:|---:|---|
| Retune the current photo atlas | Low | Excellent | High | Reject as primary path; retain only as rollback |
| More crossed cards per tree | Low–medium | Poor overdraw | High | Reject |
| Full geometric trees to 2.1 km | High close-up | Poor | Medium | Reject |
| Runtime procedural/L-system trees | Potentially high | Poor CPU/startup complexity | Low | Reject for runtime; useful offline |
| Point/gaussian/neural foliage | Experimental | Poor r128/WebGL integration | Low | Defer |
| Hybrid structural LOD + impostors | High | Good | Low with authored variation | **Adopt** |

Buying or authoring high-quality tree masters is preferable to attempting to synthesize final
assets in browser code. SpeedTree is the fastest commercial authoring route if its licence and
export terms fit. A Blender Geometry Nodes pipeline is the best controllable/open route: build
reusable branch clusters, generate variants offline, bake maps and export compact runtime meshes.
In either case, the runtime architecture should remain vendor-neutral.

## Recommended runtime architecture

### 1. Asset families, not individual random trees

Begin with conifers because they dominate ground-level park views:

- lodgepole: young/narrow, mature/even-aged, open/irregular;
- Engelmann spruce/subalpine fir: dense spire, mature broad base, high-elevation narrow form;
- disturbance: broken top, asymmetric/wind-shaped, sparse/dead-limbed;
- snag remains a separate inexpensive geometry.

Initial production target: four archetypes with three master silhouettes each. Per-instance
parameters then vary height, radius, crown start, lean, azimuth, hue, needle density and wind
phase. Twelve coherent masters are enough to avoid obvious repetition when placement also creates
age cohorts and stands. Do not create dozens of unrelated models with incompatible colour and
lighting.

Add later:

- 6–8 aspen masters in age-group clusters;
- 4–6 cottonwood/willow riparian masters;
- saplings, fallen logs and deadwood as near-field secondary layers.

### 2. LOD representation

Use projected screen height as the authority, with distance bands as starting values:

| Level | Starting range | Representation | Indicative budget per tree |
|---|---:|---|---:|
| LOD0 | 0–35 m | 3D trunk/primary branches + 3D branch clusters | 1.5–3.5 k triangles |
| LOD1 | 25–110 m | simplified trunk + coarser branch clusters | 350–900 triangles |
| LOD2 | 90–450 m | 8-view octahedral impostor with normal/depth data | 2 triangles |
| LOD3 | 350 m–2.1 km | lower-resolution multi-angle impostor or stand impostor | 2 triangles |
| Forest mass | 1.4–6 km | existing terrain-aligned patch system, upgraded atlas | current budget |

The overlaps are transition zones, not duplicate steady-state bands. Scale thresholds by tree
height and quality tier. Tall foreground trees deserve geometry farther away than saplings.

### 3. Batching and culling

Do not multiply the current per-cell draw-call pattern by every new archetype and LOD. Maintain
streaming cells for placement ownership, but repack visible instances into global render buckets:

`species family × archetype × LOD × material class`.

Each bucket is one `InstancedMesh` with instance transform, colour/variation, wind phase and fade
attributes. CPU cell/frustum selection is appropriate for r128/WebGL; GPU compute culling and
Nanite-style micro-instancing are not.

Target no more than 20–30 foliage colour-pass draw calls in a typical view, plus bounded shadow
passes. Rebuild only buckets affected when the camera crosses a cell/LOD boundary and amortize
repacking across frames.

### 4. Foliage material

Use one masked, double-sided foliage shader and a separate opaque bark material:

- sRGB base colour, tangent-space normal, roughness and thickness/transmission map;
- face-forwarded or two-sided corrected foliage normals;
- restrained wrap diffuse and sun-opposed transmission, never emissive “glow”;
- per-vertex/texture ambient occlusion to anchor branch interiors;
- distance-normal blending so middle foliage does not sparkle;
- world-coherent trunk bend plus branch/needle flutter using vertex stiffness and phase;
- alpha dilation in source textures to eliminate white/transparent RGB fringes;
- mip-safe coverage preservation so crowns do not thin with distance.

Prefer alpha masking over conventional blending: it preserves depth writing, ordering and
instancing. WebGL exposes sample alpha-to-coverage, and it is valuable on an MSAA default
framebuffer, but r128 does not provide the modern material conveniences of current Three.js.
Implement it as a capability-tested enhancement, not the only edge solution. The robust baseline
is blue-noise/Bayer alpha dithering with stable world/instance phase and temporal-free transitions.

Do not add TAA merely to hide foliage edges: the current renderer has no motion-vector/reactive-mask
infrastructure, and foliage wind would make ghosting a likely regression.

### 5. Impostor generation

Generate impostors offline from the exact LOD1 masters under neutral, unshadowed lighting:

- 8 azimuth views, with optional two elevation rows for air/overlook views;
- base colour without baked sunlight;
- alpha with colour dilation;
- view-space normal;
- linear depth or parallax offset;
- consistent bounding box, pivot and crown scale across every view.

At runtime select/blend adjacent views. Use depth to add modest parallax and improve intersections,
not expensive ray marching. Render billboard shadows facing the light or switch distant shadowing
to canopy/terrain terms; a camera-facing card must not cast a camera-facing rectangular shadow.

### 6. Ecological variation

Visual diversity should arise from correlated causes, not independent random noise:

- elevation and exposure choose species and crown form;
- LANDFIRE height constrains age/height distribution;
- canopy cover controls spacing, cohort density and understory light;
- moisture/riparian masks choose cottonwood, willow and aspen pockets;
- slope/aspect influences Douglas-fir/drier forms versus spruce-fir;
- disturbance/fire-age fields create even-aged lodgepole stands, gaps, snags and regeneration;
- high elevation produces shorter, narrower, asymmetric crowns and krummholz;
- stand-level seeds select a related palette and age cohort, while tree-level seeds add variation.

US Forest Service sources support lodgepole at intermediate elevations, spruce/fir toward
timberline, Douglas-fir on lower/southerly sites, and aspen/riparian communities in appropriate
patches. This reinforces the existing repo's data-driven direction but calls for more
stand-correlated structure.

## Implementation plan

### Gate A — one-tree vertical slice

Build three lodgepole masters and their complete LOD chain. Replace existing conifers only within
120 m behind `?foliage3d`; retain current placement and distant trees. Validate walking, driving,
overhead and backlit views before expanding scope.

Acceptance:

- no pale halo or baked-light mismatch;
- no crossed-card reveal during a 360° orbit;
- crown remains volumetric from ground and low-altitude views;
- no obvious LOD pop in a slow approach;
- foliage colour remains neutral under midday, overcast and golden hour;
- dense-forest frame time and 1% low stay within the declared cinematic gate.

### Gate B — complete conifer system

Add all 12 masters, global LOD buckets, wind, shadow policy and multi-angle impostors. Compare
stand diversity at lodgepole flats, Jenny Lake, Signal Mountain and subalpine treeline.

### Gate C — ecology and secondary structure

Introduce stand cohorts, disturbance, saplings, snags, fallen logs and forest-floor response.
This is where repetition is defeated at landscape scale.

### Gate D — deciduous/riparian

Add aspen and cottonwood/willow families, including leaf-on, autumn and leaf-off variants derived
from shared structure so seasonal transitions do not swap to unrelated silhouettes.

### Gate E — retire old representations

Only after reference routes pass should the old crossed-photo near/mid path be removed. Keep the
6 km terrain-integrated forest mass, but regenerate its textures from the new assets for colour
and silhouette continuity.

## Measurement and failure criteria

Record same-route comparisons, not isolated beauty shots:

- 60-second forest walk with slow turns and sun behind/in front of foliage;
- driving transition at 20–60 mph;
- low-altitude aerial orbit exposing crown tops;
- dense forest, treeline, mixed aspen/conifer and riparian routes;
- summer, autumn, winter, clear, overcast and golden hour.

Capture average/1%-low fps, GPU time where available, calls, triangles, texture/geometry memory,
stream-settle time and frame spikes. Also measure overdraw indirectly by comparing foliage GPU
cost at equal triangle counts.

Stop or redesign if:

- the vertical slice needs more than roughly 3.5 k triangles per LOD0 tree to look credible;
- typical foliage colour-pass calls exceed 30 after global bucketing;
- alpha edges shimmer at normal walking speed;
- an LOD transition changes crown area, brightness or shadow abruptly;
- variants read as clones at 20–100 m;
- high-altitude views reveal cards, empty crown tops or a circular LOD boundary;
- new geometry worsens the already-subthreshold 1% low without a documented quality-tier fallback.

## Final recommendation

Proceed with Gate A, not a full forest rewrite. Use Blender and CC0 photographic source material
to produce three neutral lodgepole masters, build the shader and complete LOD chain, and integrate
them into the existing placement system behind a flag. No commercial generator or asset pack is
required. The proof should answer the expensive questions—asset quality, alpha stability,
lighting, LOD continuity and frame cost—before scaling to twelve conifers.

The likely winning system is:

`existing ecological placement + authored structural variants + global GPU instancing + stable
masked foliage shading + generated multi-angle impostors + existing distant forest mass`.

That combination addresses both concerns: it makes foliage materially more three-dimensional
without making the park homogeneous or exceeding what a browser renderer can sustain.

## Vertical-slice result and revised direction (2026-07-23)

Two zero-cost replacement experiments were tested and rejected:

- A hand-assembled Poly Haven derivative produced sparse, shelf-like crowns.
- 99.Miles' CC BY 4.0 Low Poly Forest Tree Pack improved close-up volume but lost the production
  system's distance coherence. Its best moving-route test measured 75.23 ms median frame time
  against 49.09 ms for the matched legacy control, despite aggressive foreground caps.

Neither replacement remains in the runtime or repository. The production photographic hybrid is
the stronger foundation at every exploration distance.

The experiment did expose a legacy streaming defect: when a 256 m cell changed LOD band, the old
cell was removed immediately, its replacement was queued, and the replacement then grew from
near-zero scale for 600 ms. This caused distant trees to disappear and reappear while approaching.
Band changes now retain the old cell until the replacement is completely built, then swap
atomically. Only genuinely new cells at the streaming rim use the gradual entrance.

The revised roadmap is therefore incremental:

1. Preserve the existing ecological placement, atlas variants and three-band photographic system.
2. Improve its source cutouts and near hybrid geometry without changing the stable far silhouette.
3. Keep atomic band replacement and existing hysteresis as non-negotiable continuity rules.
4. Validate every model change on the eight-second driving route before expanding it park-wide.

### Legacy close-detail slice

The first incremental model pass is now implemented without changing the established medium/far
trees:

- The nearest conifers and spires receive an additive close-detail overlay containing an
  eight-sided curved/tapered trunk, two major branch stubs and six crown-only depth slices.
- Crown slices reuse vertical regions of the existing licensed atlas rather than repeating the
  complete photographed tree, avoiding duplicated photographic trunks.
- A single camera-following `InstancedMesh` is capped at 32 trees on high/ultra, 20 on balanced and
  8 on low. It enters at 46 m, exits at 58 m, refreshes only after meaningful movement or view
  rotation, and prioritizes trees in front of the camera.
- The production hybrid remains visible underneath at all times. A missing, exhausted or delayed
  detail pool can therefore remove only extra parallax—not the tree or its silhouette.
- `?treedetail=0` provides a matched control without changing placement or streaming.

At the close-tree reference camera, 29 detailed trees added one draw call and 3,364 submitted
triangles. The detailed capture measured 1.1 ms versus 1.4 ms for the matched control, which should
be interpreted as no measurable regression rather than a speed-up. The driving benchmark remained
dominated by terrain-streaming variance; the detail run did not show a systematic regression.

The overlay improves trunk fullness and near crown layering, but the dominant remaining close-range
defect is now clearly the source photography: pale baked highlights and alpha-edge colour limit
realism more than polygon count. Atlas de-lighting, neutral colour and alpha-aware edge dilation
should precede additional geometry variants.

### Runtime atlas conditioning

The pre-baked conifer atlas is now conditioned once on its existing boot-time canvas before it is
uploaded to the GPU:

- Highlight compression reduces the pale blue/white illumination baked into the source foliage
  while protecting brown trunk pixels.
- A restrained neutral forest tint reduces the source image's cool cast without forcing every tree
  to the same green.
- Alpha-edge colour is conditioned before the existing dilation pass, reducing bright fringes when
  cards are filtered at distance.
- The same deterministic pass is applied if the runtime falls back to rebuilding the atlas from
  candidate cutouts.

This changes neither tree placement nor geometry and adds no per-frame work or texture memory.
`?atlasclean=0` is the exact visual control. Matched close captures show substantially less
white/blue glare without flattening the photographic variation; the aerial capture preserves the
established forest silhouette and density. Further colour work should target the ground-cover
palette separately rather than pushing more correction into the tree atlas.

### Ground Cover V2

The near-field ground layer has been rebuilt as an ecological, world-anchored system while
retaining its original one-texture, one-draw-call architecture:

- An eleven-column procedural atlas provides three meadow forms, three dry bunchgrass forms,
  two sage forms, forest understory, rare flowers and dead stems.
- Placement combines broad 68 m habitat zones, 13–17 m stands/openings and 3.8 m bunch noise.
  Wet meadow, sage steppe and forest floor use different coverage, mixture, scale and slope limits.
- Flowers occur in rare colonies instead of uniform coloured speckle. Sage forms local communities;
  dry grass and woody understory remain separate forms.
- Terrain slope affects plant contact and lean. Imagery tint contributes restrained local hue but
  is luminance- and saturation-bounded so bright source texels cannot create fluorescent cards.
- Root shading, a small canopy-bounce floor, plant-specific wind and type-specific distance exits
  improve contact and transition without per-frame terrain sampling.
- Three vertex-shader silhouette profiles reshape the same six-triangle clump into upright grass,
  low/broad sage or narrow woody understory. World-anchored asymmetry and type-specific two-axis
  wind break the shared card outline without adding geometry, attributes or draw calls.
- Amortized cell filling and the single `InstancedMesh` are unchanged. V2 right-sizes the pool to
  64,000 slots from the legacy 83,200 because visible bare ground is intentional; dense community
  cells retain up to 2,000 instances while permanently unnecessary vertex work is not submitted.

`?groundv2=0` restores the exact legacy atlas, placement and shader treatment;
`?groundcover=0` disables the layer, and `?grounddensity=0..2` supplies a diagnostic density
multiplier. Captures record both the live instance count and fixed pool capacity.

The subsequent fluffy-grass adaptation keeps that ecology but changes submission:

- Close plants use four radial cards. The fourth card fades by 20 m, the third by 26 m and the
  second by 48 m, leaving a single alpha card at the longest useful distance.
- A twelfth atlas column supplies pale, short straw only in gaps between primary sage-steppe
  communities. Straw always uses one card and exits by 48 m.
- The existing 32 m cells are filtered to the camera-facing sector. A turn fills newly visible
  cells before retiring hidden ones, reducing active instances without exposing an empty wedge.
- `?grasslod=0` restores the pre-adaptation three-card V2 system for matched testing.

## Distant stand-impostor result (2026-07-26)

The experimental terrain-conforming canopy shell is no longer the intended production direction.
It is useful as a diagnostic, but its connected 64 m surface suppresses meadow fingers, openings,
roads and recognizable stand structure; its per-cell worker protocol also failed the moving-ring
streaming budget.

Band 3 now keeps the established 512 m ring, deterministic cache, bounded repack and single
`InstancedMesh`, but changes both representation and placement:

- Each instance is an irregular eight-tree stand assembled from several conditioned conifer atlas
  columns. Tree heights, azimuths and offsets differ within the clump, and transparent gaps expose
  the underlying terrain. The old crossed rows and discarded horizontal crown caps are absent.
- Candidates occupy world-stable 128 m microcells. Centre and four neighbour samples combine into
  stand strength; mixed edge cells thin probabilistically, while interior cells retain fuller
  clumps. This preserves negative space instead of converting the forest mask into a raised sheet.
- `?farRows=1` restores the previous two-crossed-row geometry and random candidate placement for
  matched comparison. `?canopyShell=1` remains an explicit experiment, not a production fallback.

Matched `treeline` captures remove the old horizontal slope streaks and retain individually legible
forest structure. The stand and row controls measured effectively identical average frame time
(20.93 versus 20.86 ms) and average frame rate (47.8 versus 47.9 fps); treat this as no measurable
performance regression. `golden-peaks`, `forest-air`, and `moonlit-range` recaptures report empty
browser errors and failed requests.

## Sources

- [NVIDIA GPU Gems 3: Next-Generation SpeedTree Rendering](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-4-next-generation-speedtree-rendering)
- [NVIDIA GPU Gems 3: Vegetation Procedural Animation and Shading in Crysis](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis)
- [Unity manual: SpeedTree model LOD and cross-fading](https://docs.unity3d.com/2019.4/Documentation/Manual/SpeedTreeImporter-Model.html)
- [Unreal Engine documentation: conventional instanced foliage and LOD](https://dev.epicgames.com/documentation/en-us/unreal-engine/foliage-mode-in-unreal-engine)
- [Unreal Engine documentation: Nanite foliage assemblies](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-foliage)
- [Three.js documentation: InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Khronos glTF 2.0 specification: alpha coverage](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#alpha-coverage)
- [Khronos WebGL specification: sample alpha-to-coverage](https://registry.khronos.org/webgl/specs/latest/1.0/)
- [Bao et al., Large-scale forest rendering: Real-time, realistic, and progressive](https://doi.org/10.1016/j.cag.2012.01.005)
- [US Forest Service: Lodgepole pine silvics](https://research.fs.usda.gov/silvics/lodgepole-pine)
- [US Forest Service: Engelmann spruce silvics](https://research.fs.usda.gov/silvics/engelmann-spruce)
- [Blender manual: Geometry Nodes instances](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/instances.html)
