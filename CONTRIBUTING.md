# Contributing

Bug reports, fixes, and improvements are welcome. Open an issue or a pull request.

Before anything else, get the app running — `README.md`'s quick start works from a fresh clone
with no setup. Then run `npm run verify` once so you know what green looks like: it chains the
Node and Python test suites, the asset-provenance check, and a production build. CI runs exactly
that on every pull request.

## The one rule that isn't obvious: assets need provenance

Every runtime asset under `terrain/public/` must have an entry in
`terrain/public/assets-manifest.json` naming its `source`, `author`, `license`, `attribution`,
and a `recipe` — the script or documented process that reproduces it. `npm run validate:assets`
**fails** if a shipped asset has no entry, if two entries claim the same file, or if a file type
appears that isn't classified either way.

This is not bureaucracy for its own sake. The project ships baked government data, CC0 and CC-BY
third-party models, AI-generated textures, and measured building reconstructions, all under
different terms — and `LICENSE-ASSETS.md` is only trustworthy because the manifest is enforced.
So: adding a texture means adding a manifest entry in the same commit.

Licensing constraints on new assets:

- **Preferred:** CC0 / public domain, or generated for this project.
- **Accepted with attribution:** CC-BY-4.0 and ODbL-1.0. The validator requires the entry's
  `attribution` string to name the obligation, and the credit must be visible in-app — see the
  `#credit` HUD in `grand-teton-3d.html`. **Never remove that line.**
- **Not accepted:** anything share-alike beyond ODbL, anything non-commercial, anything whose
  license you cannot point at a permanent URL for.

Reference photographs are for look development and measurement only. Do not commit them, and do
not copy source pixels into a shipped texture.

## Traps that will cost you an afternoon

These are documented at length in `AGENTS.md` and `WORKFLOW.md`; the short version:

- **Load order matters.** The `terrain/src/app/*.js` modules share one global lexical scope and
  load in the order listed at the top of `00-core.js`. Declare each binding in exactly one file.
- **Never name a GLSL variable `patch`, `filter`, or `sample`.** ANGLE rejects them, the terrain
  shader fails silently, and all terrain vanishes.
- **Placement must stay deterministic.** Use the seeded `mulberry32`; no `Math.random()` or
  `Date.now()` in per-frame or cell-fill paths, or the world changes between visits and every
  screenshot comparison becomes noise.
- **`serve.py`, `snap.py`, and `vite.config.js` are not hot-reloaded.** Restart them after edits.
- **Seeing stale geometry?** It's almost always browser cache, not your change.

## Pull requests

Keep them focused, explain what you observed rather than only what you changed, and say how you
verified it. For anything visual, a before/after screenshot is worth more than a description —
`snap.py` can capture reproducible fixed poses if you want them comparable.
