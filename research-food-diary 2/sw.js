// Service worker: keeps the app shell and the food database on the phone so the
// diary opens and works without signal. Meal uploads (POST to Google) are never
// intercepted — the app queues them itself and retries when back online.
//
// Bump CACHE_VERSION on every deploy so phones pick up the new files.
const CACHE_VERSION = 'fd-v2.2.0';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'foods.json',
  'manifest.webmanifest',
  'assets/wordmark-transparent.png',
  'assets/emblem.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];
const RUNTIME_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The food database only changes with a new CACHE_VERSION: serve it from the phone.
  if (url.origin === self.location.origin && url.pathname.endsWith('/foods.json')) {
    event.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); }));
    return;
  }

  // Other app files: network first (so updates arrive), cache as fallback offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then(function (resp) {
        if (resp.ok) { const copy = resp.clone(); caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); }); }
        return resp;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('index.html'); });
      })
    );
    return;
  }

  // Fonts and the Excel library: cache first.
  if (RUNTIME_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (resp) {
          if (resp.ok || resp.type === 'opaque') { const copy = resp.clone(); caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); }); }
          return resp;
        });
      })
    );
  }
});
