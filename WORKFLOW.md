# Development workflow

How to evolve the Grand Teton world from your local machine, with the coding agent doing the
editing and validation and you holding the review gates. The loop:

```
  you ask  →  agent edits  →  headless capture + verify  →  you review  →  merge  →  auto-deploy
              (modules)        (snap.py, error/perf meta)    (shots / PR)   (PR)      (Cloudflare)
```

The agent drives everything except the two things only you can do: **interactive feel** (fps on
real hardware, audio, driving) and **the final yes**. Everything else — code, headless proof,
git, deploy — is automated.

---

## 0. One-time / per-session setup

Two long-running servers, started in **your** terminal:

```bash
python3 serve.py                 # screenshot inbox on :8123
npm run dev -- --port 8130      # Vite module dev server; proxies /shot to :8123
```

- App URL: `http://localhost:8130/grand-teton-3d.html`
- Restart the relevant server after editing `serve.py`, `snap.py`, or `vite.config.js`. Ordinary
  HTML/JS edits use Vite reload.

---

## 1. The everyday loop (small change)

1. **Ask.** Describe the change in plain terms ("make Willow Flats reeds shorter", "fix the
   LOD crack north of Jenny Lake"). Point at a viewpoint if you have one.
2. **The agent edits** the relevant ES module or manager. The remaining classic-module load order
   and the GLSL
   gotchas in `README.md` are respected — notably: never name a GLSL var `patch`/`filter`/`sample`
   (fatal), keep terrain deterministic, don't enable resolution scaling by default.
3. **The agent validates headlessly** (see §3) and reads back the metadata + the shot itself.
4. **You review.** The agent shows before/after shots inline. You drive it in the browser for
   anything headless can't judge (fps, motion, sound).
5. **Ship.** Either commit straight to `main` (fast, solo) or open a PR for a preview URL
   (reviewable, see §4).

For anything bigger than a tweak, skip to §2.

---

## 2. Weekly vertical-slice loop

Roadmap work ships as one reference-backed journey improvement per week. Each slice has one
implementation owner, one fixed view and route, one M2 High performance budget, and explicit
non-goals.

- **Monday — contract:** freeze the reference, pose, before capture, budget, and acceptance.
- **Tuesday/Wednesday — build:** integrate the smallest end-to-end change; use a temporary URL
  flag when rollback risk is meaningful.
- **Thursday — prove:** run focused tests, smoke captures, affected reference views, and the
  continuous route. A rotating verifier tries to refute the visual and performance claim.
- **Friday — ship:** review the PR preview interactively on M2-class hardware, then merge or reduce
  the slice.

Parallel lanes are limited to disjoint work such as asset sourcing or offline data preparation.
Do not split ownership of one renderer subsystem across several agents. Keep one active slice per
implementation owner.

---

## 3. Validation — how the implementation owner proves a change

### Headless capture (the core check)
```bash
python3 snap.py                              # fly every viewpoint in views.json
python3 snap.py --views sage-ground,treeline # just these
python3 snap.py --views jackson-shore --quality high
python3 snap.py views/views-water.json       # a saved per-feature set
```
Headless Chrome renders each view through Vite and posts it through Vite's `/shot` proxy to
`serve.py`. It writes `shots/auto-<name>.png` plus a
`.json` sidecar. **Named shots overwrite in place**, so the same viewpoint is directly comparable
across edits — that's the visual-regression baseline.

**Read the `.json` before trusting the image.** Each sidecar carries:

| field | meaning | what "bad" looks like |
|---|---|---|
| `errors` | page/JS/shader-compile errors | non-empty = something broke (a shader that fails to compile can blank whole terrain while the PNG still "renders") |
| `calls` | draw calls | sudden jump = batching regressed |
| `tris` | triangles submitted | runaway = LOD/streaming regressed |
| `renderMs` | CPU submit time | rising = CPU-side cost up |
| `visibleTerrainCoverage` | frustum leaves drawn through native or ancestor height data | `complete:false` = capture fails |

`renderMs` is **CPU-submit only** — headless cannot measure GPU frame time, real fps, or audio.
Those are yours to judge in the browser.

### Interactive validation (yours)
Drive `http://localhost:8130/grand-teton-3d.html` and use:
- the live HUD (`fps · ms · calls`) for real frame rate,
- the quality menu (`O` key) to trade fidelity for fps — default `ultra` reproduces the shipped look exactly,
- URL params to reach states headless setup covers via views: `?season=`, `?weather=`, `?auto=views.json`,
- `P` to grab a manual versioned shot (`shots/shot-NNN.png`) — dev builds only.

### Acceptance bar
A change is "good" when: visible terrain coverage is complete, `errors` empty across the affected views, no unexplained `calls`/`tris`
jump, `renderMs` flat or lower, the before/after shots show the intended difference and nothing
else, and — for anything that affects motion or performance — you've confirmed fps in the browser.
The standing visual target still governs: *from the valley floor the Tetons stay detailed and
dramatic; at night the world goes genuinely dark and is revealed by vehicle/moon/settlements; at
every distance the world stays physically continuous — no gaps, floating water, overlapping roads
or vegetation clipping.*

---

## 4. Review gates & deploy

Two paths, pick per change:

**Fast path (only documentation or low-risk tooling):**
```bash
git add -A && git commit -m "…" && git push        # push to main
```
→ GitHub Actions builds `dist/` and publishes to **production**: https://grand-teton.pages.dev

**Review path (all visual/runtime slices):**
```bash
git switch -c feature/short-name
git add -A && git commit -m "…" && git push -u origin feature/short-name
gh pr create --fill
```
→ Actions deploys a **preview** at `https://<branch>.grand-teton.pages.dev` and posts the URL as
a PR comment (updated on every push to the PR). Review the diff + the live preview + the
before/after shots, then `gh pr merge` → merging to `main` publishes to production.

Preview deploys are the natural stakeholder-review gate: a shareable live build of exactly the
proposed change, with production untouched until merge.

---

## Lightweight ownership

| Role | Owns |
|---|---|
| Roadmap owner | Weekly contract, scope, interactive M2 review, merge decision |
| Implementation owner | Code/data integration, focused evidence, performance budget |
| Asset-sourcing lane | Three candidates maximum, exact license, attribution, format, and optimization cost |
| Rotating verifier | Clean-checkout review intended to disprove the claimed result |

## Guardrails baked in (don't relearn these the hard way)
- **GLSL reserved words** `patch`/`filter`/`sample` as variable names = silent fatal shader
  failure → whole terrain vanishes. Check `errors` in shot meta first.
- **Load order** still matters for the classic managers loaded by `terrain/src/main.js`; package
  imports and application context are ES modules, while `app/00-…→97-…` retain ordered globals.
- **Determinism**: terrain/veg placement is seeded — keep it reproducible or captures stop being comparable.
- **No default resolution scaling** — you rejected it; the `O` menu makes it opt-in only.
- **Datum-relative Y**: true elevation ASL ≈ `y + 1897 m` (valley floor ≈ y 160, treeline ≈ y 1143).
- **Licensing**: OSM/Microsoft data is ODbL — the `#credit` HUD attribution must stay.

## Tiles live on R2 — local dev is unaffected
The bulk height/imagery tiles (~483 MB) are on Cloudflare R2, not in git, so clones/CI/previews
are fast (repo + `dist/` are ~14 MB code-only). This is transparent to the loop above:
- **Local (`localhost`)** serves tiles from your local `terrain/public/tiles`+`imagery/` — untouched.
- **Deployed** pulls them from R2 automatically.
- To validate the R2 path from a local build: `GT_TILES="https://pub-7e6650521824431097870dcf01f3e4e2.r2.dev/" python3 snap.py --views shard-sky`.
- After a pipeline rebake, re-upload the tiles to R2 (see `DEPLOY.md`) or the deployed site serves stale tiles.

See `DEPLOY.md` for the bucket, CORS policy, and re-upload commands.
