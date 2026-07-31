# Photorealism asset sourcing shortlist

**Status:** candidates for calibration and optimization, not approved runtime assets  
**License policy:** CC0/public domain preferred; CC BY 4.0 accepted with attribution and modification notice

## Conifer bake sources

| Rank | Candidate | License | Intended use | Intake warning |
|---:|---|---|---|---|
| 1 | [Fir Tree 01](https://polyhaven.com/a/fir_tree_01), Rico Cilliers and Rob Tuytel | CC0 | Three mature structural masters, lower LODs, and impostors | Approximately 8M source triangles; ship only optimized derivatives |
| 2 | [Pine Tree 01](https://polyhaven.com/a/pine_tree_01), Rico Cilliers and Rob Tuytel | CC0 | Tall lodgepole-like silhouette family | Approximately 17M source triangles; requires branch-card rebuild and atlasing |
| 3 | [Fir Sapling](https://polyhaven.com/a/fir_sapling), Rico Cilliers and Rob Tuytel | CC0 | Young cohorts and understory | Approximately 433k source triangles; reduce to low thousands |

Poly Haven's [license](https://polyhaven.com/license) permits use, modification, and redistribution
under CC0. Download the 1K or 2K source packages first; retain higher-resolution sources only when
they materially improve offline bakes.

## Barn candidates

| Rank | Candidate | License | Intended use | Intake warning |
|---:|---|---|---|---|
| 1 | [Old wooden barn](https://sketchfab.com/3d-models/old-wooden-barn-4887c7e3de244a9db3eb5b4974418b1b), Elizabeth Watts | CC BY 4.0 | Primary Mormon Row prototype | Inspect authenticated download, remove non-Wyoming details, and rebuild to Moulton proportions |
| 2 | [American Old Barn](https://sketchfab.com/3d-models/american-old-barn-1d0b768a8e2449de990b3f69f94c5db6), andrewriddle | CC BY 4.0 | Lightweight structural fallback | Materials likely need complete replacement |
| 3 | [American Barn](https://sketchfab.com/3d-models/american-barn-c054eba247c44f49b0000793c07885d4), Yelldjarrin | CC BY 4.0 | Low-cost blockout or secondary structure | Requires topology, UV, and material review |

Sketchfab downloads require an authenticated account. Before selection, compare each candidate
against the fixed `mormon-row` pose and reject it if silhouette correction costs more than building
a simple reference-matched shell.

## Intake acceptance

Every selected asset must enter `terrain/public/assets-manifest.json`, retain its original source,
have a repeatable conversion recipe, use neutral/non-baked lighting, and pass an in-world M2 High
capture before becoming a production default.
