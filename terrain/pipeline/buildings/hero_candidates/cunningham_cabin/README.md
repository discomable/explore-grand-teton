# Cunningham Cabin candidate

Self-contained input package for the hero-building batch orchestrator. It reconstructs only the
surviving J. Pierce Cunningham double-pen cabin in its present restored state; vanished ranch
outbuildings are excluded.

The strongest source is the Library of Congress HABS WY-25 record: three photographs, five
measured drawings and five data pages. Sheet 2 fixes the plan at 41 ft 5 in overall, with two
roughly 15 ft 8 in pens separated by a 10 ft 2 in open dogtrot. The open breezeway and common
low sod-covered gable roof are geometry contracts, not texture effects.

## Orchestrator hand-off

1. Read `candidate.json`, then acquire and hash every required item in
   `reference-sources.json`.
2. Register HABS sheets 2–5; transcribe height, pitch, eaves and every opening before generating
   geometry.
3. Use upstream OSM way `106472595` for draft centroid/bearing and fit the HABS wall envelope
   within it.
4. Generate three LODs, registered clay/elevation targets and the three required review captures.
5. Apply every quarantine gate before marking the candidate `draft_passed`.

The production placement gate is intentionally unresolved: current upstream OSM has a suitable
Wikidata-linked building way at approximately `43.7786094, -110.5582988`, but that way is absent
from the repository's local building extract. A local preview may use the recorded anchor;
promotion must refresh/add and independently verify the footprint against orthophoto or LiDAR.

Do not paint the dogtrot black. It must remain a true open volume at every LOD.

## Deterministic draft

`documentary-measurements.json` records every implemented measurement and its sheet provenance.
Generate the three unpromoted GLBs with Blender 5.x:

```sh
blender --background \
  --python terrain/pipeline/buildings/hero_candidates/cunningham_cabin/generate_draft.py -- \
  --output-dir terrain/pipeline/work/landmark-batches/<run-id>/candidates/cunningham_cabin
```

The generator uses geometry for exterior openings and the breezeway, keeps one object per
material after batching, and emits `geometry-report.json` alongside the GLBs.
