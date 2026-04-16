var APP_VERSION = '20260416-0555';

// SELF-DESTRUCTING SERVICE WORKER v3
// Purpose: Replace ANY previously-cached service worker.
// On install: skip waiting (take over immediately).
// On activate: nuke all caches, claim all tabs, reload them, then unregister.
// On fetch: pass everything straight to the network (never serve from cache).

self.addEventListener('install', function(event) {
  // Force this SW to become the active SW immediately,
  // even if an older SW is currently controlling pages
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    // Step 1: Delete every cache
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    })
    .then(function() {
      // Step 2: Take control of all open tabs/windows
      return self.clients.claim();
    })
    .then(function() {
      // Step 3: Tell every open tab to reload with fresh content
      return self.clients.matchAll({ type: 'window' });
    })
    .then(function(clients) {
      clients.forEach(function(client) {
        client.postMessage({ type: 'SW_CACHE_CLEARED', version: APP_VERSION });
        // Navigate to force a full reload
        if (client.url && client.navigate) {
          client.navigate(client.url);
        }
      });
    })
    .then(function() {
      // Step 4: Unregister this SW — we don't want ANY service worker
      return self.registration.unregister();
    })
  );
});

// CRITICAL: Pass ALL requests to network. respondWith(fetch()) ensures
// the browser does NOT use any cached response from a previous SW.
self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});
