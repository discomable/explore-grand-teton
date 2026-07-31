# Jenny Lake Ranger Station hero-building candidate

This package is the draft-only batch input for the **Jenny Lake Ranger Station**, the relocated
Lee Mangus/Manges homestead cabin at South Jenny Lake. It does not contain production assets and
must not mutate the production landmark manifest.

## Identity boundary

Three similarly described Grand Teton buildings must remain separate:

- **Included:** the Lee Mangus/Manges cabin moved to South Jenny Lake in 1930 and now used as the
  Jenny Lake Ranger Station.
- **Excluded:** the nearby Jenny Lake Visitor Center, which is the relocated Harrison Crandall
  Studio and has a different cupola-bearing form.
- **Excluded:** the James or Jimmy Manges Cabin near Cottonwood Creek, represented in
  `terrain/public/buildings.json` by the separate exact name `Manges Cabin`.

The authoritative runtime selector is the single exact named footprint `Jenny Lake Ranger
Station`. Never fall back to a fuzzy match on `Manges`, `cabin`, `ranger station`, or proximity to
the visitor center.

## Documentary basis

Library of Congress HABS survey WY-108 provides four measured sheets and a data page. The
reviewed sheets document:

- a 20-foot-6-inch by 36-foot-9-inch wall envelope;
- an 18-foot ridge above floor line and a 7-foot-9-inch ceiling line;
- north, south, east, and west elevations;
- a steep gable, west entrance porch, asymmetric doors and multi-light windows;
- stone foundation, saddle-jointed log walls, and wood-shingle roof;
- the east-end room added in 1937.

HABS controls geometry. NPS sources control current identity, setting, use, and exterior
condition. Image generation, if the photographic rights gate later passes, may change registered
surface appearance only.

## Required stage order

1. Resolve and hash the exact `Jenny Lake Ranger Station` footprint. Explicitly reject `Jenny Lake
   Visitor Center` and `Manges Cabin`.
2. Acquire only the necessary HABS WY-108 sheets at the smallest legible resolution; record final
   URLs, sheet numbers, retrieval dates, byte counts, and SHA-256 hashes.
3. Extract the porch, opening centers, eave height, addition joint, and runtime orientation before
   modelling. Reconcile the HABS 18-foot ridge with the footprint extract's unverified 6.9-metre
   height field.
4. Generate deterministic exterior-only geometry and three LODs within the single-building
   budgets. Keep the west porch and primary gable recognizable in every LOD.
5. Acquire at least two useful same-building photographic elevations with item-level creator and
   rights metadata. If that gate fails, quarantine projection rather than borrowing another
   rustic cabin.
6. Render fixed orthographic targets and constrain any image-assisted edit to measured surfaces,
   openings, silhouette, and camera registration.
7. Validate close, approach, and distant views in daylight and overcast conditions. Preserve the
   surrounding canopy outside physical building and collision clearance.

The deliberate stop points are ambiguous building identity, a non-unique named footprint,
illegible HABS dimensions, unresolved photographic rights, fewer than two photographic
elevations, or any need to distort measured geometry to fit the current footprint.

## Deterministic draft

The active batch draft can be regenerated without network access:

```sh
blender --background --python \
  terrain/pipeline/buildings/hero_candidates/jenny_lake_ranger_station/generate_draft.py -- \
  --measurements \
  terrain/pipeline/buildings/hero_candidates/jenny_lake_ranger_station/measurements.habs-wy-108.json \
  --output-dir \
  terrain/pipeline/work/landmark-batches/six-landmarks-2026-07-28/candidates/jenny_lake_ranger_station/models
```

The generator exports only the ranger station. It contains no visitor-center or separate Manges
Cabin geometry. Compact source hashes and rights are recorded in
`terrain/pipeline/data/hero-buildings/jenny_lake_ranger_station/source-manifest.json`.
