# Phase 0 Baseline and Performance Gates

**Status:** Acceptance contract
**Applies to:** The five canonical hero scenes and the versioned drive and hike routes
**Roadmap authority:** `PHOTOREALISTIC-EXPLORATION-ROADMAP.md`

## Purpose

Phase 0 establishes a repeatable visual and performance baseline before the rendering pipeline is
changed. It does not claim that the current build meets the photorealism target. It defines the
measurements, target hardware, and approval rules that make later improvements comparable.

The canonical five-view benchmark remains:

```bash
python3 benchmark.py
```

Its screenshots and `benchmark-results/report.json` are the fast regression artifact. Hardware-tier
certification must additionally run in a visible browser on representative physical hardware.

## Tested hardware tiers

These tiers describe capability classes, not particular vendors. The test record must name the
actual device used.

| Tier | Representative capability | Test resolution and preset | Performance floor |
|---|---|---|---|
| Cinematic desktop | Recent discrete GPU or current Apple Silicon | 2560×1440, Cinematic/Ultra, native or documented temporal upscaling | Average ≥ 30 fps; 1% low ≥ 24 fps |
| High desktop | Modern integrated GPU or older mid-range discrete GPU | 1920×1080, High, native | Average ≥ 45 fps; 1% low ≥ 30 fps |
| Accessible fallback | Lower-end WebGL2-capable desktop or laptop | 1280×720 to 1600×900, Medium/Fallback, native | Average ≥ 30 fps; 1% low ≥ 24 fps |

A machine qualifies for a tier only when its GPU, browser, power mode, and resolution are recorded
and the suite passes without browser flags that alter normal rendering. A faster machine may test a
lower tier, but only with a documented GPU power or performance profile that is representative of
that tier.

## Measurement protocol

- Test the exact commit intended for approval, served through the production-equivalent static
  delivery path.
- Close unrelated GPU-heavy applications and disable browser extensions.
- Use a visible browser at 100% page zoom. The viewport must match the tier resolution.
- Use a cold browser profile for cold-start tests and a warmed profile for steady-state tests.
- Run each hero scene and route three times. Report the median run; retain all raw reports.
- Begin steady-state frame sampling only after the canonical stream-settle condition is reached.
- Sample at least 10 seconds or 600 presented frames per hero scene, whichever is longer.
- Compute 1% low as the fps equivalent of the 99th-percentile presented-frame time. Do not derive it
  from CPU submit time.
- Treat GPU time as unavailable unless `EXT_disjoint_timer_query_webgl2` returns valid,
  non-disjoint samples. Never substitute CPU submit time and label it GPU time.
- A failed network request, uncaught exception, WebGL context loss, missing required asset, or
  benchmark timeout fails the run.

## Hero-scene budgets

All five canonical hero scenes must independently satisfy the applicable tier row. A good average
cannot hide one failing scene.

| Metric, per hero scene | Cinematic | High | Accessible | Gate |
|---|---:|---:|---:|---|
| Average presented fps | ≥ 30 | ≥ 45 | ≥ 30 | Blocking |
| 1% low presented fps | ≥ 24 | ≥ 30 | ≥ 24 | Blocking |
| Stream-settle time, warm cache | ≤ 5.0 s | ≤ 4.0 s | ≤ 5.0 s | Blocking |
| Stream-settle time, cold cache | ≤ 12.0 s | ≤ 10.0 s | ≤ 12.0 s | Advisory until production CDN runs are stable |
| Uncaught errors / failed required requests | 0 | 0 | 0 | Blocking |
| WebGL context losses | 0 | 0 | 0 | Blocking |
| Draw calls after settle | ≤ 325 | ≤ 275 | ≤ 225 | Advisory |
| Rendered triangles after settle | ≤ 6.75 M | ≤ 5.0 M | ≤ 3.25 M | Advisory |
| Main-thread frame spikes > 50 ms during sample | ≤ 2 | ≤ 2 | ≤ 3 | Blocking |
| Visual artifact review | No severity-1 defect | No severity-1 defect | No severity-1 defect | Blocking |

Draw-call and triangle limits are diagnostic ceilings, not a license to trade visible quality for
lower counts. They become blocking only after two approved baselines demonstrate that the limit is
stable and representative. A severity-1 defect is missing terrain or imagery, opaque/invalid
transparency, broken camera or controls, severe tile cracks, a persistent LOD hole, gross exposure
failure, or another defect that prevents credible exploration.

Screenshot similarity is advisory because weather, vegetation, water, and exposure can contain
intentional variance. Every run must still publish the comparison image and numeric result.

## Route-run budgets

The fixed drive and hike routes must start from versioned poses and inputs, use deterministic
weather/time/season, and include at least one dense-forest segment, open vista, water crossing or
shoreline, and rapid camera turn. The drive is five minutes at normal road speed; the hike is five
minutes at normal walking speed. If shorter canonical routes are adopted, loop them to five minutes
without resetting the world.

| Metric, per five-minute route | Cinematic | High | Accessible | Gate |
|---|---:|---:|---:|---|
| Average presented fps | ≥ 30 | ≥ 45 | ≥ 30 | Blocking |
| 1% low presented fps | ≥ 24 | ≥ 30 | ≥ 24 | Blocking |
| Frames > 50 ms after initial settle | ≤ 0.5% | ≤ 0.5% | ≤ 1.0% | Blocking |
| Individual frame time | No frame > 250 ms | No frame > 250 ms | No frame > 350 ms | Blocking |
| Visible tile pops | ≤ 3 | ≤ 3 | ≤ 5 | Advisory, human-counted from capture |
| Peak resident textures | ≤ 1.25× approved tier baseline | ≤ 1.20× | ≤ 1.15× | Advisory until tier baselines exist |
| Texture count growth, final minute | ≤ 5% | ≤ 5% | ≤ 5% | Blocking; detects unbounded residency |
| Errors, failed required requests, context losses | 0 | 0 | 0 | Blocking |

Cold-start interactive time is measured separately from navigation start to the first frame in
which movement and camera input respond, without waiting for every distant tile:

| Cold-start metric | Cinematic | High | Accessible | Gate |
|---|---:|---:|---:|---|
| First responsive interaction, warm HTTP cache | ≤ 4.0 s | ≤ 4.0 s | ≤ 5.0 s | Blocking |
| First responsive interaction, cold HTTP cache | ≤ 8.0 s | ≤ 8.0 s | ≤ 10.0 s | Advisory until production CDN runs are stable |

## Blocking and advisory policy

Blocking gates protect correctness, interaction, and the promised frame-rate floor. A pull request
that changes rendering, streaming, assets, or route behavior cannot be approved while a blocking
gate regresses, unless the product and rendering owners record a time-bounded exception in the
baseline report.

Advisory gates expose cost or perceptual drift that still needs judgment. An advisory miss requires
an explanation and before/after artifacts, but does not by itself prevent merge. Phase 0 converts an
advisory gate to blocking only through a reviewed document change; CI must not silently tighten it.

## Required environment metadata

Every retained report must include:

- commit SHA, dirty-worktree flag, benchmark/schema version, date, and run identifier;
- route or hero-scene identifier, seed, camera pose, season, weather, time of day, and quality
  preset;
- browser name and full version, user agent, headless/visible mode, WebGL version, renderer/vendor
  strings, enabled relevant extensions, and GPU timing backend;
- operating system and version, CPU model/logical core count, GPU model, total system memory, and
  power/battery mode;
- display and viewport resolution, device-pixel ratio, page zoom, refresh rate, fullscreen state,
  and upscaling/render scale;
- delivery URL/origin, local versus production-equivalent server, HTTP cache state, service-worker
  state, tile-cache state, and network shaping if any;
- sampling duration/frame count, settle rule and timeout, plus raw per-frame samples or a linked
  artifact;
- calls, triangles, geometry count, texture count, cache residency, settle time, presented fps,
  1% low, CPU submit time, valid GPU time where supported, errors, and failed requests.

Missing tier-identifying metadata makes a run useful for debugging but invalid for certification.

## Baseline approval workflow

1. The author runs the five hero scenes and both routes on the exact candidate commit, preserving
   screenshots, videos, JSON, environment metadata, and comparison artifacts.
2. Automation validates schema completeness and all blocking numeric gates.
3. A rendering reviewer inspects every hero image plus route captures for exposure, transparency,
   LOD, streaming, temporal stability, and geographic coherence.
4. A performance reviewer verifies measurement validity, hardware-tier classification, and any
   advisory variance.
5. The product owner selects or confirms the five hero scenes and records visual acceptance.
6. Rendering and performance owners jointly approve the baseline manifest. Any exception names an
   owner, reason, affected metric, expiry commit or date, and remediation issue.
7. Approved artifacts are immutable and identified by commit SHA. Replacing them requires the same
   review; a later run cannot overwrite historical evidence.

Phase 0 exits only after each tier has one approved real-hardware run, both routes have deterministic
definitions, the photographic references are mapped to versioned views, and the five hero scenes
have product approval.

## Current baseline (2026-07-23)

The current fast benchmark completed all five views in headless Chrome at **1600×813** using the
**Ultra** preset. It reported:

| Measure | Current result |
|---|---:|
| Hero views completed | 5 / 5 |
| Median frame time | 24.54 ms |
| Worst 1% low | 20 fps |
| Maximum stream-settle time | 4,395 ms |
| Maximum draw calls | 287 |
| Maximum triangles | 6,104,485 |
| Console errors | 0 |
| Failed requests | 0 |

This is a useful regression baseline, not a hardware-tier certification. The run was headless, its
1600×813 viewport does not match a tier resolution, and 24.54 ms is not sufficient evidence of
presented-frame performance or true GPU time. In particular, the worst 1% low is below every tier's
floor. The result therefore establishes that capture and reporting work end to end; it does not
establish that Cinematic, High, or Accessible performance has passed.
