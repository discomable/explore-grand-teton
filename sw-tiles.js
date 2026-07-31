/* sw-tiles.js — browser-side cache for the immutable terrain/imagery tiles ONLY.
 *
 * Tiles are content-addressed (…/tiles|imagery/{z}/{x}/{y}.webp) so they never change → cache them
 * forever, cache-first. This cuts R2/network hits hard for the common case (panning around a region,
 * revisiting, repeat sessions) entirely client-side — no server, no Cloudflare Functions, no limits.
 *
 * SAFETY (see the project's cache-trap history): this worker NEVER touches HTML or JS or any other
 * request — the fetch handler returns early for anything that isn't a *.webp under /tiles|imagery/,
 * so those pass straight to the network and code/updates are always fresh. Old cache versions are
 * purged on activate; bump CACHE to invalidate everything after a tile rebake.
 */
const CACHE = 'gt-tiles-v1';
const TILE_RE = /\/(tiles|imagery)\/\d+\/\d+\/\d+\.webp$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never touch writes
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (!TILE_RE.test(url.pathname)) return;                // ONLY immutable tiles — everything else: network, untouched
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) => hit || fetch(req).then((res) => {
        // cache successful CORS/basic responses (r2.dev sends CORS; same-origin is basic)
        if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone()).catch(() => {});
        return res;
      }))
    )
  );
});
