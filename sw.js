// Service worker — network-first strategy for everything
// Version is checked via version.json polling in index.html
// This SW only provides offline fallback, not caching benefits

const CACHE_NAME = 'ne-racing-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first for ALL requests — never serve stale content
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(r => {
        // Cache a copy for offline fallback only
        if (r.ok && e.request.method === 'GET') {
          const clone = r.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
