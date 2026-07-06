// Railbird AI — Service Worker (v2.46.4)
//
// Goal: kill the "I see stale UI / I had to re-login" failure mode by giving
// the app a real, controlled cache layer instead of trusting Chrome/Fastly to
// do the right thing. Every shipped build registers this SW (sw.js) with a
// fresh CACHE_VERSION; on activate it deletes every prior cache, claims all
// open clients, and from that point on it intercepts requests directly.
//
// Strategy:
//   • Navigation / HTML  → network-first, fall back to cache, then offline.
//     Result: a fresh build is always shown the moment the network can fetch
//     it, even when the browser/PWA opens an old shortcut.
//   • version.json       → network-only, no-store. Used by the in-page poller
//                          to detect new builds. Must NEVER be cached.
//   • /api/*  & worker.dev → network-only (live data must be live).
//   • /data/brisnet-*.json → stale-while-revalidate. The file is rewritten
//                          per card; serving stale is fine for one render
//                          while we refresh in the background.
//   • everything else (CSS, JS, fonts, icons, manifest) →
//                          stale-while-revalidate against this cache.
//
// On every install the SW skipWaiting()s and then claim()s clients, so a
// freshly-deployed build takes over immediately and broadcasts a "reload"
// message to the page. The page's controllerchange handler swaps in the
// fresh HTML without a hard reload.

const CACHE_VERSION = '20260706-v2.49.20-brisnet'; // v2.49.20: handicapping-engine audit — isTruePass's scratch-ratio gate could never fire, Value Play/Exotic of the Day ignored the True-Pass gate entirely, the ticket only tracked the #1 Action Bet for expert-consensus, and the standalone Bet Evaluator had a stale-leg-selection bug plus a mislabeled verdict badge               // bump on every ship
const CACHE_NAME    = 'railbird-' + CACHE_VERSION;
const OFFLINE_URL   = '/offline.html';

// Hosts the page talks to that must NEVER be intercepted/cached. (These run
// through the SW because the page's fetch() is intercepted, but we hand them
// straight to the network without touching the cache.)
const NETWORK_ONLY_HOSTS = [
  'cloudflare-worker.jhwiv-online.workers.dev',
  'api.cloudflare.com',
];

function isHTML(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isVersionPing(url) {
  return url.pathname === '/version.json' || url.pathname.endsWith('/version.json');
}

function isBrisnetData(url) {
  return /\/data\/brisnet-/.test(url.pathname);
}

function isNetworkOnlyHost(url) {
  return NETWORK_ONLY_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}

function isSameOriginStatic(url) {
  if (url.origin !== self.location.origin) return false;
  // Anything under /api/ from our origin (if we ever proxy through Pages)
  if (url.pathname.startsWith('/api/')) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Install: cache the offline fallback. (We intentionally do NOT precache
// index.html — network-first will fetch it fresh.)
// ──────────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // Best-effort offline page; ignore failure.
      try { await cache.add(new Request(OFFLINE_URL, { cache: 'reload' })); } catch (_) {}
    } catch (_) {}
  })());
});

// ──────────────────────────────────────────────────────────────────────
// Activate: blow away every cache that isn't ours, claim all clients,
// and broadcast a "new SW active" message so the page can swap in fresh HTML.
// ──────────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try { c.postMessage({ type: 'SW_ACTIVATED', version: CACHE_VERSION }); } catch (_) {}
    }
  })());
});

// Allow the page to force-update by posting {type:'SKIP_WAITING'}
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ──────────────────────────────────────────────────────────────────────
// Fetch router
// ──────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only GETs are cacheable
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Live data / live API — never touch cache
  if (isNetworkOnlyHost(url)) return;
  if (isVersionPing(url)) {
    event.respondWith(fetch(new Request(req, { cache: 'no-store' })).catch(() => new Response('{}', { headers: { 'Content-Type':'application/json' } })));
    return;
  }

  // HTML navigations: network-first
  if (isHTML(req)) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // Brisnet per-card data: stale-while-revalidate (fast first paint, refresh in bg)
  if (url.origin === self.location.origin && isBrisnetData(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Same-origin static asset → stale-while-revalidate
  if (isSameOriginStatic(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Anything else: just go to network
});

async function networkFirstHTML(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // Force a fresh fetch even if HTTP cache wants to serve stale.
    const fresh = await fetch(new Request(req.url, {
      cache: 'reload',
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache' },
    }));
    if (fresh && fresh.ok) {
      // Cache for offline fallback
      try { cache.put(req, fresh.clone()); } catch (_) {}
      return fresh;
    }
    // Non-ok response: fall through to cache
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return fresh;
  } catch (_) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const off = await cache.match(OFFLINE_URL);
    if (off) return off;
    return new Response('<h1>Offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res && res.ok) {
      try { cache.put(req, res.clone()); } catch (_) {}
    }
    return res;
  }).catch(() => null);
  return cached || (await networkPromise) || new Response('', { status: 504 });
}
