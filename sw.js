var APP_VERSION = '20260416-0850';

// SELF-DESTRUCTING SERVICE WORKER v4
// Purpose: Replace ANY previously-cached service worker.
// On install: skip waiting (take over immediately).
// On activate: nuke all caches, then unregister itself.
// On fetch: pass everything to network (never serve from cache).
// DOES NOT reload or navigate clients — that caused infinite loops.

self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(keys.map(function(k) { return caches.delete(k); }));
      })
      .then(function() {
        return self.clients.claim();
      })
      .then(function() {
        // Unregister — no service worker should exist for this site
        return self.registration.unregister();
      })
  );
});

// Pass ALL requests to network — never serve cached content
self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});
