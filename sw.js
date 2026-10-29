/* App-shell cache for the YPC camera UI.
 *
 * Only same-origin GET requests are handled. Camera traffic goes to
 * http://192.168.1.1:36299 (a different origin) and is deliberately left
 * alone: a service worker cannot and must not intercept it.
 *
 * Strategy: network first, cache as the fallback. The UI is served from
 * localhost, which is always up when the page is in use, so freshness matters
 * more than speed here — and a stale app.js paired with a new index.html is
 * exactly the kind of mismatch that breaks the page. The cache exists so the
 * installed app still opens while the server is stopped.
 */

const CACHE = 'ypc-shell-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // camera requests pass through

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || caches.match('./index.html'))),
  );
});
