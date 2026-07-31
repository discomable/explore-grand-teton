# John Moulton hero-building candidate

This package describes a draft-only, batch-orchestrator input for the northern John and Bartha
Moulton homestead on Mormon Row. It does not contain production assets and must not mutate the
production landmark manifest.

## Intended result

- `barn`: hero two-story gambrel-with-shed log barn.
- `pink_house`: companion 1.5-story pink stucco residence.
- `minor_cluster`: optional shared-material bunkhouse, granary, pumphouse, two outhouses, and
  shower house; corral/fences remain setting props.

`candidate.json` owns orchestration, placement constraints, LOD/cluster budgets, projection rules,
validation, and quarantine gates. `reference-sources.json` owns official source identity, rights,
confidence, and acquisition requirements. `acquired-sources.json` hashes the retained official
derivatives. `measurements.documentary.json` records sheet-level measurements and blockers, while
`generate_draft.py` emits the deterministic three-LOD documentary draft.

## Required stage order

1. Acquire only the needed HABS WY-152, WY-152-A, and WY-152-C sheets/photos; record item-level
   rights, final URLs, retrieval dates, byte counts, and SHA-256 hashes.
2. Extract measured geometry before modelling. Do not estimate values that exist on a HABS sheet.
3. Match the HABS site geometry to unnamed current footprints. A unique placement reviewed by an
   independent agent is mandatory; never offset the model from the T. A. Moulton barn.
4. Generate deterministic geometry and the three LODs within the cluster budgets.
5. Render fixed orthographic targets, then use same-structure references only for registered
   surface edits.
6. Validate isolated and combined Mormon Row captures. On failure, perform one targeted retry,
   then apply the matching quarantine status.

The deliberate stop points are unresolved HABS measurements, non-unique footprint matching,
unclear image rights, or any risk of confusing the neighboring T. A. Moulton Barn with John's
gambrel barn.
