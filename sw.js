// Service worker — pass-through for HTML/JSON/JS, only caches images
// iOS standalone mode aggressively caches via SW — this SW ensures
// HTML, JSON, and JS ALWAYS come from the network, never from cache.
// If the network is down, show a clear offline message instead of stale data.

const APP_VERSION = '20260414-2320';
const CACHE_NAME = 'ne-racing-static-' + APP_VERSION;

// Only cache these static asset types (images, fonts)
const CACHEABLE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf'];

function isCacheableAsset(url) {
  var path = url.pathname.toLowerCase();
  return CACHEABLE_EXTENSIONS.some(function(ext) { return path.endsWith(ext); });
}

self.addEventListener('install', function() {
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  // Delete ALL old caches on activate
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // For cacheable static assets (images, fonts): network-first with cache fallback
  if (isCacheableAsset(url)) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // For EVERYTHING else (HTML, JS, JSON, CSS): network-only, no caching ever
  // If network fails, return a clear offline message — never stale content
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(function() {
      // Return offline fallback for navigation (HTML) requests
      if (e.request.mode === 'navigate') {
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Offline</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;' +
          'justify-content:center;min-height:100vh;margin:0;background:#1B4332;color:#FAF3E0;text-align:center}' +
          '.box{padding:2rem}h1{font-size:1.3rem;margin-bottom:1rem}p{opacity:0.8}' +
          'button{margin-top:1.5rem;padding:0.75rem 2rem;background:#C9A84C;color:#1B4332;border:none;' +
          'border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}</style></head><body>' +
          '<div class="box"><h1>You\'re Offline</h1><p>NE Racing needs an internet connection to show the latest race data.</p>' +
          '<button onclick="location.reload()">Try Again</button></div></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html' } }
        );
      }
      // For non-navigation requests (JS, JSON, CSS), return a simple error
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
