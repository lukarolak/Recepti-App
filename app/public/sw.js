// Caches the Weekly Plan and Shopping List pages (plus their JS/CSS) so a
// fresh navigation still loads something when there's no network at all.
// Network-first: always tries the live page first so data stays fresh when
// online, falling back to whatever was last cached when the fetch fails.
// Only registers in a secure context (https, or localhost) — see sync.js.
const CACHE_NAME = 'recipe-planner-v2';
const CACHEABLE_PAGES = ['/', '/shopping-list', '/recipes', '/ingredients'];
const PRECACHE_URLS = ['/style.css', '/sync.js', '/plan.js', '/shopping.js', '/recipes.js', '/ingredients.js', ...CACHEABLE_PAGES];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // A service worker never controls the page that first registered it, so
    // without precaching the pages here (not just reactively via fetch),
    // a single visit followed by going offline would have nothing cached yet.
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const cacheable = CACHEABLE_PAGES.includes(url.pathname) || PRECACHE_URLS.includes(url.pathname);
  if (!cacheable) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
