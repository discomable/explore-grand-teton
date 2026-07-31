# T. A. Moulton Barn reconstruction

This is the repository-native version of the reconstruction work from
`codex/build-reconstruction-pipeline-for-t.-a.-moulton-barn`.

The reusable method, image-assisted projection workflow, lessons learned, QA gate and next-building
shortlist are documented in
[`docs/HERO-BUILDING-RECONSTRUCTION.md`](../../../../docs/HERO-BUILDING-RECONSTRUCTION.md).

The pipeline deliberately separates three kinds of truth:

- `building.json` contains the editable LiDAR discovery seed and source notes.
- `measurements.estimated.json` is a deterministic, explicitly estimated fallback
  that keeps asset iteration unblocked when source LAS/LAZ data is unavailable.
- `terrain/public/buildings.json` remains authoritative for runtime placement. Its
  named OSM footprint centres the landmark at world `(4830.2, 8264.4)`.
- `measurements.lidar-2022.json` records the first measured envelope from the
  current USGS tile; `reference-sources.json` makes the local photo pack repeatable.

The seed coordinate is approximately 31 m from that footprint, so it must not be
used directly for final runtime placement.

> **Shape correction from primary sources:** the current GLBs use the corrected
> central gable with north/south shed-roof additions identified by the NPS
> preservation plan and HABS photograph—not the gambrel form used by the first
> branch generator. The envelope is measured; individual opening/detail placement
> remains photographic reconstruction.

## Build the runtime LODs

Blender 4.x is the only dependency for the deterministic fallback:

```sh
blender --background --python \
  terrain/pipeline/buildings/moulton_barn/generate_barn.py -- \
  --measurements terrain/pipeline/buildings/moulton_barn/measurements.lidar-2022.json \
  --output terrain/public/models
```

This emits `ta-moulton-barn-lod{0,1,2}.glb` plus
`ta-moulton-barn-validation.json`. LOD0 has board-and-batten relief and openings;
LOD1 keeps the main openings; LOD2 is a two-material silhouette.

## Upgrade from LiDAR

Install the scoped Python dependencies, then use `download_lidar.py` and
`process_lidar.py`. Keep downloaded point clouds under
`terrain/pipeline/data/moulton-barn/` and intermediate measurements under
`terrain/pipeline/work/moulton-barn/`; both are excluded from deployable assets.
After correcting the generator's massing and completing visual QA, pass the
measured JSON to it. Every measurement must retain its provenance and uncertainty.

```sh
python3 -m pip install -r terrain/pipeline/buildings/moulton_barn/requirements.txt
python3 terrain/pipeline/buildings/moulton_barn/download_lidar.py --list
python3 terrain/pipeline/buildings/moulton_barn/process_lidar.py
```

Runtime constraints:

- maximum three material primitives / draw calls for the active landmark LOD;
- only one LOD is visible at a time;
- LOD0 inside 90 m, LOD1 inside 260 m, LOD2 beyond;
- generic footprint geometry is suppressed, but its collision footprint remains.
