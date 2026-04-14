// Service worker — network-first for index.html to prevent stale cache
const APP_VERSION = '20260414-1252';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== APP_VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
      .then(() => {
        // Force all open tabs to reload with fresh content
        return self.clients.matchAll({ type: 'window' });
      })
      .then(clients => {
        clients.forEach(client => client.navigate(client.url));
      })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // ALWAYS bypass cache for sw.js itself and version.json
  if (url.pathname.endsWith('sw.js') || url.pathname.endsWith('version.json')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }

  // Network-first for HTML navigation requests
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(r => {
          const clone = r.clone();
          caches.open(APP_VERSION).then(c => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for other assets (fonts, images, etc.)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
