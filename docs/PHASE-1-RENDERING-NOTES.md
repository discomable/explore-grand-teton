# Phase 1 rendering migration notes

## Outcome update — 2026-07-23

Same-position review of the half-float, forced-byte, and direct renderer paths found the direct
Three.js ACES path materially more natural. The post composite introduced a persistent green/sepia
cast even after exposure and white-balance corrections. Direct rendering is therefore the default;
`?postfx` enables the retained HDR experiment and `?post8` forces its byte target. `?nopost` remains
accepted for old links but is now equivalent to the default.

The migration design and audit below remain useful technical history, not the active visual default.

This note records the compatibility audit and acceptance contract for the Phase 1 rendering
foundation. It complements, rather than replaces, the product outcomes in
`PHOTOREALISTIC-EXPLORATION-ROADMAP.md` and the measurement rules in
`docs/PHASE-0-BASELINE.md`.

## Decision: a bounded r128 migration

Phase 1 will keep the vendored three.js r128 runtime and move only the scene-color path to a
linear, high-dynamic-range frame. Exposure, ACES tone mapping, bloom, gamut/output conversion,
and sRGB encoding must happen in the final composite exactly once. A capability-selected
lower-precision linear target remains available when half-float rendering is not viable.

This is intentionally not a three.js upgrade. Updating the engine at the same time would combine
two cross-cutting changes: the application's color-pipeline rewrite and several years of renderer,
shader-chunk, color-management, loader, PMREM, shadow, and examples-module API changes. A failure
would be difficult to attribute, and the current global-script build has no module/bundler boundary
to contain it. Keeping r128 makes the present image the comparison target and lets the five Phase 0
hero scenes prove the HDR design independently.

The bounded migration is:

1. Remove the application-wide late tone-map surgery only as the final linear output path takes
   ownership of every scene material.
2. Render scene color into a linear target, preferring half float only after an actual framebuffer
   completeness and render/read capability check.
3. Keep scene shaders, textures, PMREM, glTF loading, and the shadow implementation on their r128
   APIs. Convert each custom shader's output/fog contract to linear space without opportunistic
   material rewrites.
4. Perform bloom in linear HDR, then exposure, one ACES curve, optional display-space grading,
   and one output encoding in the final screen pass.
5. Preserve a kill switch that selects the known LDR renderer until all Phase 1 acceptance gates
   pass. Do not maintain both paths indefinitely after approval.

A modern three.js upgrade should be a separate, measured milestone after Phase 1. It should start
with modules/build tooling and a compatibility branch, then migrate deprecated APIs deliberately.

## Current r128 risk inventory

### Color management and tone mapping

- `app/20-scene.js` sets `renderer.outputEncoding = THREE.sRGBEncoding` and
  `renderer.toneMapping = THREE.ACESFilmicToneMapping`, then mutates
  `THREE.ShaderChunk.tonemapping_fragment`, appends a display-space round trip to
  `fog_fragment`, and overrides `THREE.ShaderMaterial.prototype.onBeforeCompile`. That global
  prototype/chunk surgery is the largest double-tone-map risk. It affects materials created later
  by streaming as well as materials that appear unrelated to the migration.
- Current custom shaders generally author a display-looking color and mix fog before the global
  hook converts it back to linear for ACES. In the new path, terrain, road, trail, sky, and water
  must instead emit linear radiance and mix a linear fog color. Removing only the hook without
  converting those contracts will darken or desaturate them.
- Built-in Lambert/Standard materials already use r128's texture decode and lighting chunks.
  Their `map`, vertex colors, emissive terms, and numeric colors must be checked separately:
  texture encoding is metadata, while literal `THREE.Color` values are currently tuned to the old
  output. A blanket `convertSRGBToLinear()` is unsafe.
- Materials intentionally marked `toneMapped = false` are display overlays, not scene radiance.
  Known examples include the held map and PostFX full-screen passes. They must remain outside
  exposure/tone mapping, or be composited after the final transform.
- `PostFX.js` explicitly assumes an 8-bit, already tone-mapped sRGB scene target. Its threshold,
  bloom intensity, saturation, and render-target encoding are not transferable constants. In
  particular, keeping `rtScene.texture.encoding = THREE.sRGBEncoding` on the HDR scene target
  would cause an unwanted encode/decode path.
- The existing analytic eye adaptation changes `renderer.toneMappingExposure`. Phase 1 must give
  exposure ownership to one final-pass uniform and ensure screenshots, reflection renders,
  cubemap bakes, shadow passes, and overlay renders cannot advance or apply it twice.

### Shader API and compilation

- The app depends on mutable r128 `ShaderChunk` strings and exact `#include`/source replacement
  anchors across terrain streaming, vegetation, buildings, shadows, and depth materials. Phase 1
  should minimize edits to these anchors and compile every material variant, including variants
  that appear only after streamed content arrives.
- `ShaderMaterial.prototype.onBeforeCompile` is global state. Instance hooks can shadow it, as
  PostFX does, and built-in material hooks use different paths. Acceptance cannot rely on one
  representative shader compiling.
- Custom shaders implement their own distance fog in `terrain-shaders.js`, `RoadRibbon.js`,
  `TrailBuilder.js`, `WaterBuilder.js`, and `app/50-water.js`; built-in materials
  use r128 fog chunks. Both paths must share the same linear fog color and distance response.
- `WaterBuilder.js` contains an explicit inverse of r128 ACES plus an sRGB round trip for planar
  reflection recovery. That workaround becomes invalid once the reflection source is linear and
  must not survive unnoticed.
- Raw and depth shaders must stay exempt from scene-color transforms. Alpha-tested vegetation
  depth materials must continue to use their atlas offsets and silhouette threshold.

### Render targets, post-processing, and PMREM

- The current scene target is RGBA8, with an r128 `WebGLMultisampleRenderTarget` on WebGL2.
  Half-float color-buffer renderability, filtering, MSAA resolve, and framebuffer completeness
  vary by browser/GPU. Extension presence alone is not a sufficient capability test.
- The bloom pyramid is RGBA8 and thresholds display values near `0.90`. Linear HDR bloom needs
  new thresholds in scene/exposure-relative units and must demonstrate that snow, sky, and pale
  grass do not become a broad crawling glow.
- Every pass changes `renderer.setRenderTarget`. The final implementation must restore target,
  viewport/scissor, clear state, tone-mapping/output state, and auto-clear state around cubemap,
  reflection, capture, overlay, and fallback paths.
- The sky environment uses a linear cube target and r128 PMREM, whose internal renderer work
  temporarily changes output encoding and tone mapping. Verify state restoration and confirm
  that the global shader hook is not applied to PMREM internals.
- Planar water reflection uses an sRGB-tagged render target today. It must become a documented
  linear intermediate or remain a deliberately isolated LDR path; a texture must never be tagged
  sRGB merely to compensate for a dark result.
- Half-float targets increase bandwidth and memory. The cinematic hardware-tier frame-time and
  memory budgets remain blocking; target precision must be reported in benchmark metadata.

### glTF and material continuity

Recorded when the engine was r128 and the `?poc` foliage/wildlife module still existed. The engine
is now three.js r184 with `GLTFLoader` imported from `three/addons`, and the POC module and its
`terrain/public/poc/` assets have been deleted, so the POC references below are historical: only
the vehicle glTF path remains a live test target.

- The vendored `GLTFLoader.js` is matched to r128 and loaded dynamically by the vehicle and POC
  paths. It should remain paired with the r128 core. Replacing only the loader or core is unsupported.
- r128 GLTFLoader assigns sRGB encoding to base-color/emissive textures and linear treatment to
  metallic/roughness/normal data. Post-load car material customization must preserve those maps
  and encodings. Glass transparency, double-sidedness, depth write, and interior/exterior views
  are explicit regression targets because they have failed before.
- The pickup/interior vehicle loads late (as did the POC wildlife/conifers), so a boot-only shader
  audit misses it. Tests must enter both first- and third-person vehicle views and trigger every
  lazy glTF family.
- Environment intensity and numeric material colors were tuned against the old LDR pipeline.
  Retuning is expected, but wholesale material replacement is deferred; continuity at boundaries
  matters more than maximizing any single asset.

### Shadows

- r128 PCF shadows combine built-in receiver chunks with manual terrain/road/trail sampling through
  `SHADOW_UNIFORMS`. Linear HDR must not change shadow comparison values, depth packing, bias, or
  alpha-cutout depth behavior.
- The directional shadow map is camera-following, altitude gated, luminance gated, and enabled by
  `DYNAMIC_SHADOWS`. Its visible-box and swimming risks predate HDR. Phase 1 may validate or disable
  this implementation, but cascaded shadows are a separate feature, not a prerequisite for the
  color migration.
- PMREM, water reflection, and shadow/depth passes render the scene through non-screen cameras.
  The color migration must not cause those passes to apply exposure or final output encoding.

## Acceptance matrix

Run the five hero scenes and both Phase 0 traversal routes on the exact candidate commit, retaining
all screenshots, route clips, JSON reports, environment metadata, and comparison artifacts. Run
the relevant rows with post-processing enabled and disabled, and on both preferred HDR and forced
fallback target paths.

| Area | Coverage | Pass condition |
|---|---|---|
| Single output transform | Midday snow/water, golden hour, moonlit developed scene; PostFX on/off | Instrumentation reports one final exposure/ACES/output transform for screen color and zero for scene intermediates; on/off changes bloom/grading only, not base exposure or white balance |
| Fog convergence | Long views in every hero scene; drive and hike clips | Terrain, vegetation, buildings, road/trail, water, and glTF objects converge to the same fog value with no colored halo or material boundary |
| Material continuity | Terrain/road edges, shorelines, buildings, vegetation, wildlife, pickup exterior/interior | No abrupt value/color response caused by material implementation; base-color textures are decoded once; non-color maps remain linear |
| Exposure | Open sun to dense trees, first-/third-person vehicle transition, golden hour to shadow | Highlights retain detail; shaded forest remains readable; adaptation is monotonic and bounded with no turn/occlusion pumping or capture-to-capture drift |
| Shadows | Ground-level sun and moon views, altitude threshold, forced off, moving drive route | No shadow box, swimming, acne, peter-panning, stale map, or one-frame flash; built-in and custom receivers agree; disabling shadows changes lighting only |
| Water/reflections | Jenny Lake and Snake River poses, PostFX on/off | Reflection has correct brightness/color, no inverse-ACES residue, no double encoding, and no recursive exposure; shoreline fog matches terrain |
| glTF | Pickup outside and cabin, steering wheel, windows | Lazy assets compile without warnings; windows remain transparent from both sides; steering wheel/interior remain visible; emissive/base-color/PBR maps retain intended response |
| Overlays and capture | HUD, held map at day/night, screenshot burst | Overlays remain legible and independent of scene exposure; captures match the displayed frame; repeated captures do not advance adaptation |
| Target fallback | Preferred half-float, forced RGBA8/alternate linear path, WebGL1 where supported | Same scene relationships and no severity-1 visual defect; capability choice and precision appear in report; unsupported combinations fail over cleanly |
| State isolation | Sky PMREM rebake, planar reflection, resize, quality/pixel-ratio change | Render target, viewport/scissor, clear, output, tone-map, and exposure state are restored; no one-frame flash or accumulating brightness |
| Performance | All hero scenes/routes on declared hardware tier | Existing Phase 0 blocking frame-time, 1%-low, settling, memory, and error budgets pass; no new console errors, failed requests, or incomplete reports |

Before approval, also inspect shader/program diagnostics after the complete route run rather than
after boot. A passing still is insufficient for exposure pumping, shadow swimming, reflection
state leaks, or bloom crawl.

## Required evidence

- A machine-readable record of target type/precision, WebGL version, relevant extensions, fallback
  reason, final exposure, tone-map operator, output encoding, and PostFX state.
- Side-by-side current-main and candidate captures for all five hero scenes, plus temporal clips for
  the drive and hike routes.
- A small debug mode that can show linear scene color, bloom input, final output, and shadow enable
  state independently. Debug views must bypass the final transform deliberately.
- A blind-review result showing a clear preference for the candidate hero scenes, with exceptions
  recorded rather than averaged away.

## Explicitly deferred

- A three.js core/GLTFLoader upgrade, ES-module conversion, bundler adoption, WebGPU, or a new
  examples-based composer.
- Full physical sky/atmospheric scattering, volumetric clouds/fog, precipitation, and weather-state
  integration.
- Cascaded shadow maps or a wholesale replacement of the current camera-following shadow system.
- Broad conversion of Lambert/custom materials to MeshStandard/physical materials, terrain
  material layering, new geology assets, and production vegetation replacement.
- Local reflection probes, screen-space reflections, temporal AA/upscaling, motion vectors, depth
  of field, and cinematic lens effects.
- Histogram/luminance-readback auto-exposure. Phase 1 may retain calibrated analytic exposure if it
  meets the transition tests; a more complex meter is justified only by measured failures.
- Retuning every time/weather/season permutation. Phase 1 must cover the reference and hero set,
  then record additional permutations as follow-up work.

Deferral does not waive continuity: any deferred system that already exists must still render
without a severity-1 regression through the new frame.
