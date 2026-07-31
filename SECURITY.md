# Security

## Scope

This is a fully client-side static site: no backend, no authentication, no database, no user
accounts, and no user data collected or stored. The deployed build is HTML, JS, and baked assets
on a CDN. That bounds the realistic attack surface to the browser-side code and the tile origin.

`serve.py` and `snap.py` are **development tooling only** — a local screenshot receiver and a
headless capture driver. They bind to localhost, are excluded from `dist/` by `build-web.sh`, and
are not part of any deployed artifact. Please don't report them as exposed services.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security → Report a
vulnerability). Please don't open a public issue for anything exploitable.

## Already-considered design decisions

These look like findings but are deliberate. Reporting them is welcome if you think the reasoning
is wrong — but please engage with the reasoning rather than just flagging the pattern:

- **`?tiles=` accepts only same-origin, relative, or the known R2 base when off localhost**
  (`grand-teton-3d.html`). An arbitrary origin would let a crafted link load a stranger's imagery
  into a victim's view and point their browser at that host. Unrestricted on localhost, on
  purpose, for development.
- **No `X-Frame-Options`** (`build-web.sh` `_headers`). Embedding the demo in a blog or iframe is
  intended, and there is nothing sensitive to clickjack.
- **The public `r2.dev` tile bucket is world-readable with permissive CORS.** It serves only
  public-domain terrain and imagery derivatives, and cross-origin `GET` is required for the app to
  stream tiles at all.
- **A localhost boot probe falls back to the public bucket** when no local pyramid exists
  (`92-boot.js` `resolveTileSource`). It is skipped when `?tiles=` is explicit.

## Dependencies

Runtime dependencies are deliberately minimal — `three` at a pinned version, with Vite as the only
build dependency. A version bump that fixes a real vulnerability is a welcome PR.
