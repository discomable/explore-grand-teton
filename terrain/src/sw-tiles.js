/* Service Worker: cache terrain tiles for offline use + instant revisit.
 *
 * Register once from the page:
 *     if ('serviceWorker' in navigator) navigator.serviceWorker.register('terrain/src/sw-tiles.js');
 *
 * Strategy: cache-first for /tiles/ (immutable content), network-first for tiles.json (so a
 * re-baked pyramid is picked up). Capped by count via FIFO trim.
 */
const CACHE = 'gt-tiles-v1';
const MAX_ENTRIES = 3000;          // ~3000 * 80 KB ≈ 240 MB on disk

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isTile = /\/(tiles|imagery)\/.*\.(webp|png)$/.test(url.pathname) ||
                 /horizon_[ab]\.png$/.test(url.pathname);
  const isManifest = /(tiles|imagery|horizon|landcover)\.json$/.test(url.pathname);
  if (!isTile && !isManifest) return;

  if (isManifest) {
    event.respondWith(
      fetch(event.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy));
        return r;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // tiles: cache-first
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) { cache.put(event.request, res.clone()); trim(cache); }
      return res;
    })
  );
});
