# Andy Chambers hero-building candidate

This package is declarative input for the generic hero-building batch orchestrator. It scopes a
shared-texture cluster containing the 1916 log cabin, the original stable as expanded into barn
`#1313`, and—conditionally—the Chambers generator windmill.

The worker must resolve placement before generating geometry. The HABS coordinate is only a search
seed, and `terrain/public/buildings.json` contains no named Andy Chambers footprint. Register the
HABS/National Register site plans to Mormon Row Road, Ditch Creek, the service road and fence lines,
then confirm individual structures against LiDAR or current orthophotography. Do not suppress
generic buildings until those matches pass `candidate.json` gates.

`reference-sources.json` registers official NPS and HABS starting points without downloading their
large source files. A worker that acquires selected sheets or images must add item-level rights,
retrieval hashes and dates. `architecture.json` records the non-negotiable silhouettes and calls
out unresolved measurements instead of presenting photographic estimates as fact.

The windmill intentionally starts quarantined. NPS visitor history associates a 1946 windmill with
the Chambers story, while the National Register description labels a windmill in the adjacent Roy
Chambers complex. The batch may finish the cabin and barn draft while holding the windmill until a
registered site map and field evidence resolve its identity and transform.

## Documentary draft

`acquired-sources.json` records the small Library of Congress HABS drawings and photographs retained
under ignored `terrain/pipeline/data/hero-buildings/andy_chambers/`.
`measurements.documentary.json` transcribes the ranch-house dimensions and a scaled site-plan barn
envelope, preserving uncertainty and sheet provenance. Barn heights remain provisional pending
LiDAR, and the local origin is not a runtime placement.

Generate the three review-only GLBs with:

```sh
blender --background --python \
  terrain/pipeline/buildings/hero_candidates/andy_chambers/generate_draft.py -- \
  --output-directory \
  terrain/pipeline/work/landmark-batches/six-landmarks-2026-07-28/candidates/andy_chambers
```

The generator is deterministic, exports one mesh with material-batched primitives per LOD, and
omits the unresolved windmill.
