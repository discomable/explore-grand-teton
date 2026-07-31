# Deploy

Live: **https://grand-teton.pages.dev** (Cloudflare Pages, project `grand-teton`,
account id `<your-cloudflare-account-id>`).

## Manual deploy (works today)
```bash
./build-web.sh          # assemble dist/ (~496 MB, ~8k files)
npx wrangler pages deploy dist --project-name grand-teton --branch main
```
`wrangler login` auth persists locally, so no re-login needed.

## Auto-deploy on git push (GitHub Actions)
`.github/workflows/deploy.yml`:
- **push to `main`** → production deploy → https://grand-teton.pages.dev
- **pull request** → preview deploy → `https://<branch>.grand-teton.pages.dev`, URL posted as a PR comment

Preview deploys are the review gate: open a PR, click the commented URL to see the change live,
merge when happy. One-time setup:

1. **Create the repo & push** (tiles included — see note):
   ```bash
   git add -A && git commit -m "Grand Teton world"
   git branch -M main
   git remote add origin git@github.com:<you>/grand-teton.git
   git push -u origin main
   ```
2. **Add two GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_ACCOUNT_ID` = `<your-cloudflare-account-id>`
   - `CLOUDFLARE_API_TOKEN`  = a token with **Cloudflare Pages: Edit**
     (dashboard → My Profile → API Tokens → Create Token).
3. Push again (or re-run the workflow) → it builds `dist/` and publishes to Pages.

## Tiles are on Cloudflare R2 (not in git)
The bulk height + imagery pyramids (~483 MB, ~8k files) live in the **R2 bucket
`grand-teton-tiles`**, served publicly at
`https://pub-7e6650521824431097870dcf01f3e4e2.r2.dev/` with a read-only CORS policy
(`GET`/`HEAD` from any origin — required because the app `fetch`es tiles cross-origin).
So `git` and `dist/` are code-only (~14 MB): fast clones, checkouts, and deploys.

- The app picks its tile source in `grand-teton-3d.html`: **localhost → local `terrain/public/`**,
  **any other host → R2**. Override with `?tiles=<baseUrl>` (`?tiles=` alone forces local).
  On localhost, `92-boot.js` (`resolveTileSource`) HEAD-probes the z0 root tile first and falls
  back to R2 when no local pyramid exists, so a fresh clone runs with no setup. The probe is
  skipped when `?tiles=` was given, so forcing local stays forced. `npm run dev:setup` fetches a
  local pyramid (optionally truncated) for offline work — see the README quick start.
  **The public `r2.dev` bucket is best-effort and rate-limited**; Cloudflare does not support it
  as a production endpoint. Forks that expect real traffic should host their own and point
  `window.GT_TILE_CDN` at it.
  Only `TerrainStreamer._urlH/_urlI` and the minimap use it; the ~13 MB of small baked assets
  (manifests, `ao/roads/landcover/horizon` PNGs, atlas, water surface) still ship on-origin.
- `build-web.sh` excludes `tiles/`+`imagery/` from `dist/`; `.gitignore` excludes them from git.
  The full pyramids stay in your **local** `terrain/public/` for offline dev.

Also on R2 (same bucket root, served at `…r2.dev/treepoints.bin`): **`treepoints.bin`** (~20 MB, the
dot-aligned tree point set). `ScatterManager` resolves it through `window.GT_TILE_CDN` like the
tiles; its tiny `treepoints_meta.json` stays on-origin. Absent/failed fetch → pure procedural forest.

**Re-uploading tiles after a pipeline rebake** (needs R2 S3 credentials in an rclone remote `r2:`):
```bash
rclone copy terrain/public/tiles   r2:grand-teton-tiles/tiles   --transfers 40 --s3-no-check-bucket
rclone copy terrain/public/imagery r2:grand-teton-tiles/imagery --transfers 40 --s3-no-check-bucket
rclone copy terrain/public/treepoints.bin r2:grand-teton-tiles/ --s3-no-check-bucket  # after bake_treepoints_full.py
```
Validate a local build against R2 before shipping:
```bash
GT_TILES="https://pub-7e6650521824431097870dcf01f3e4e2.r2.dev/" python3 snap.py --views shard-sky
```

## Excluded from git (see .gitignore)
`dist/` (build output), `terrain/pipeline/data/` (807 MB raw downloads; its provenance doc,
`terrain/pipeline/SOURCES.md`, is tracked separately), `atlas-candidates/` (baked atlas ships
instead; its provenance doc, `terrain/pipeline/VEG-ATLAS-SOURCES.md`, is tracked separately),
`terrain/public/tiles/` + `imagery/` + `treepoints.bin` (on R2, see above), `shots/`,
`views/` (per-feature capture lists; canonical `views.json` IS tracked), logs.

## Alternative: Cloudflare native Git integration
Instead of the Actions workflow, you can connect the repo to Pages in the CF dashboard
(build command `bash build-web.sh`, output dir `dist`) — no secrets needed, CF builds on push.
Either approach works; the Actions workflow is checked in and ready.
