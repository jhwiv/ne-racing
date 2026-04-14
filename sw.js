// Self-destructing service worker.
// If a browser still has a previous version of sw.js cached/registered,
// this new version will install, activate, clear all caches, and
// immediately unregister itself — leaving zero SW interference.
// This is intentional: the app no longer uses a service worker.

self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    // Delete all caches left behind by previous SW versions
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }).then(function() {
      // Take control of all clients
      return self.clients.claim();
    }).then(function() {
      // Unregister this SW — it's no longer needed
      return self.registration.unregister();
    })
  );
});

// Pass through all fetch requests — never intercept, never cache
self.addEventListener('fetch', function() {
  // Do nothing — let the browser handle the request normally
});
