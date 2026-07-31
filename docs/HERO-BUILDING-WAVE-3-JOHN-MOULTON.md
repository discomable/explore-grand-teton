# Wave 3 plan — John Moulton Homestead

Run: `six-landmarks-2026-07-28`
Candidate: `john_moulton` (cluster: gambrel barn + pink house + minor outbuildings)
Activated: 2026-07-28. Scope: this candidate only. The other five remain
quarantined under their existing attempt-2 snapshots and are not retried.

## 1. Why wave 3 is justified for this candidate alone

Wave 2 ended in `quarantined_geometry` despite producing materially new
evidence. Per `placement-retry.json` the retry:

- Identified a unique OSM feature match for the barn (way 306529655) and the
  pink house (ways 332562306 + 1423654377), with a 0.65 m residual against
  the HABS site-relationship distance (41.8 m observed vs 41.15 m documented).
- Confirmed HABS WY-152 sheet 1 documents the omitted granary, bunkhouse,
  two outhouses, shower house, pumphouse, corral, irrigation ditch, and
  their relative site relationships.
- Confirmed HABS WY-152-A sheets 1 and 2 document the house plan,
  additions, dormer, roof topology, and four elevations.

Wave 2's only blocker was that the GLBs were never regenerated to embody
this evidence, and runtime placement/capture/performance review was never
run. Wave 3 turns already-acquired evidence into geometry and runtime proof.
No new external rights clearance is required.

## 2. Why wave 3 is NOT justified for the other five (no-regression guard)

| Candidate | Wave-3 blocker | Decision |
| --- | --- | --- |
| andy_chambers | No verified Barn HS-1313 vertical envelope; windmill identity still conflicting | Re-quarantine. External orthophoto/3DEP registration still required. |
| cunningham_cabin | No class-6 LiDAR returns; orthophoto footprint registration never performed | Re-quarantine. NAIP/USGS DOQ orthoimagery acquisition required first. |
| menor	s_homestead | Copied NPS photograph item-level rights unresolved | Re-quarantine. Substitute CC0 HABS/HAER LoC prints or Commons-licensed images first. |
| chapel_transfiguration | No second distinct calibrated elevation; Brides' Room vertical evidence missing | Re-quarantine. Needs new geometry from already-acquired entrance-axis imagery, not new evidence. |
| jenny_lake_ranger_station | Only one rights-cleared same-building exterior elevation | Re-quarantine. Needs a second item-cleared public-domain/CC0 elevation. |

## 3. Authorization

`terrain/pipeline/buildings/hero-batch.json` now carries
`retryLimitOverride: 2` on the `john_moulton` candidate only. The global
`retryLimit` remains 1 so the five other quarantines (each `attempt == 2`
under the original global limit) stay valid and the manifest freeze test is
preserved. `hero_batch.py` resolves the per-candidate limit via
`effective_limit()` and stamps `quarantineUnderLimit` into a candidate's
state record at quarantine time so future audits validate against the limit
that was in effect when the quarantine happened, not the current budget.

## 4. Gate-by-gate work plan

The runner's `draft_errors()` requires all gates to clear at once. Wave 3
must produce, in order:

1. **Regenerate geometry from the matched footprints.** Rebuild LOD0/1/2
   from the barn (OSM way 306529655) and the pink house (OSM ways
   332562306 + 1423654377) at their matched WGS84 centers and approximate
   0.35° true-north orientation. Embody the HABS-documented additions,
   dormer, and roof topology for the house (WY-152-A sheets 1 and 2). The
   minor cluster (bunkhouse, granary, pumphouse, two outhouses, shower
   house) is `required: false`; include only the components whose
   footprints can be resolved without speculation, and omit the rest rather
   than guess positions. Keep within the cluster triangle budget
   (LOD0: 12000, LOD1: 3000, LOD2: 750) and material-primitive budget
   (LOD0: 8, LOD1: 5, LOD2: 3) from `hero-batch.json`.

2. **Independent placement review.** Submit the matched OSM way IDs,
   center coordinates, orientation, and the 0.65 m site-relationship
   residual to an independent agent (not the worker that produced the
   geometry). Acceptance per `candidate.json`: confidence ≥ 0.85, primary
   center uncertainty ≤ 3 m, primary orientation uncertainty ≤ 5°, unique
   match. The independent reviewer records the verdict via
   `hero_batch.py verify --candidate john_moulton --actor <reviewer>
   --verdict passed --reason ... --evidence <placement-retry.json>
   <generation-report.json>`.

3. **Validation report.** Produce `validation-report.json` with:
   - `sources.passed = true`, `officialSources >= 1` (HABS WY-152,
     WY-152-A, WY-152-C are LoC official), `sameBuildingElevations >= 2`,
     `allRightsResolved = true` (HABS/LoC are CC0 item-cleared), and a
     SHA-256 provenance entry per acquired artifact.
   - `placement.passed = true`, `confidence >= 0.85`, with `evidence`
     listing the OSM extract, the HABS site sheet, and the placement retry
     artifact.
   - `lods` block with triangle and material-primitive counts under the
     cluster budget and repository-local LOD paths inside the candidate
     folder.
   - `textures.totalBytes <= 1572864` with per-file byte counts matching
     disk.
   - `captures` array containing all six required views from
     `hero-batch.json` (`close-day`, `approach-day`, `distant-day`,
     `close-overcast`, `approach-overcast`, `distant-overcast`), each with
     `consoleErrors: []`, `failedRequests: []`, and
     `visibleTerrainCoverage.complete: true`.
   - `performance.passed = true`.

4. **Preview fragment.** Produce `preview-landmark.json` pointing at the
   in-candidate-folder LOD URLs (repository-local, schema-validated by
   `preview_records()`).

5. **Promotion.** With independent verification recorded and all gates
   passing, call
   `hero_batch.py record --run-id six-landmarks-2026-07-28
   --candidate john_moulton --status draft_passed --stage verified
   --actor worker-john --artifact <lod0> --artifact <lod1> ...`.
   The runner enforces: worker cannot self-approve, attempt ≥ 1, all
   `draft_errors()` clear, and `preview-landmark.json` validates.

## 5. Failure handling

If wave 3 cannot clear every gate, the candidate re-quarantines at
`attempt == 3 == retryLimitOverride + 1`. The runner will stamp
`quarantineUnderLimit: 2` into the john_moulton state record at that
quarantine, and subsequent audits will validate against it (not the global
default). After wave 3 quarantine, john_moulton is exhausted; further work
requires a new manifest revision.

## 6. Out of scope for wave 3

- No production asset mutation. `terrain/public/` is unchanged; only
  `?landmarkDraftRun=six-landmarks-2026-07-28` reflects a draft.
- No retries for the other five candidates. Their `attempt == 2`
  quarantines remain canonical.
- No new external source acquisition. Wave 3 reuses the HABS WY-152 /
  WY-152-A / WY-152-C sheets and the OSM extract already hashed into
  `placement-retry.json` and `quarantine-report.json`.
- No minor-cluster guessing. Unresolved minor components stay omitted per
  `architecture.json` `generation_policy.fallback`.

## 7. Verification checklist before invoking `record --status draft_passed`

- [ ] LOD0/1/2 GLBs rebuilt from matched OSM footprints (not arbitrary frame)
- [ ] House additions and dormer present per WY-152-A sheets 1 and 2
- [ ] Barn retains gambrel-with-shed silhouette at every LOD
- [ ] Placement confidence ≥ 0.85, center uncertainty ≤ 3 m, orientation
      uncertainty ≤ 5°, unique match, reviewer ≠ worker
- [ ] `--actor <reviewer> --verdict passed` recorded via `verify`
- [ ] All six required captures present with clean runtime and complete
      terrain coverage
- [ ] `performance.passed = true`
- [ ] Triangle, material-primitive, and texture budgets all under cluster
      limits
- [ ] `preview-landmark.json` LOD URLs are repository-local and inside the
      candidate folder
- [ ] `hero_batch.py audit --run-id six-landmarks-2026-07-28` still reports
      six candidates consistent after promotion