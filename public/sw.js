/* Keeps the app shell available with weak or no signal. Live data is cached by the app itself. */
const CACHE = 'isbogi-shell-v6';
const SHELL = ['/', '/index.html', '/css/app.css', '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js', '/vendor/inter/inter-latin-wght-normal.woff2', '/js/i18n.js', '/js/theme.js', '/js/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== location.origin) return;
  // Network first so testers always get the newest build; fall back to the cached shell offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
