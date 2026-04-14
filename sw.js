// Service worker — network-first strategy, minimal and safe
// Version is checked via version.json polling in index.html
// This SW only provides offline fallback, not caching benefits

const CACHE_NAME = 'ne-racing-v1';

// Never cache these paths — always go to network
const NEVER_CACHE = ['index.html', 'version.json'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  // Delete ALL caches on activate to ensure clean state
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const shouldNeverCache = NEVER_CACHE.some(p => url.pathname.endsWith(p));

  // Network-first for ALL requests with no-store
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(r => {
        // Cache a copy for offline fallback — but never cache index.html or version.json
        if (r.ok && e.request.method === 'GET' && !shouldNeverCache) {
          const clone = r.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => {
        // Only fall back to cache for non-critical resources
        if (shouldNeverCache) return new Response('Offline', { status: 503 });
        return caches.match(e.request);
      })
  );
});
