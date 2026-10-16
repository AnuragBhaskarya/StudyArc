// StudyArc Progressive Web App (PWA) Service Worker
const CACHE_NAME = 'studyarc-pwa-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/styles.css?v=5.0',
  '/app.js',
  '/app.js?v=5.0',
  '/aura-particles.js',
  '/aura-particles.js?v=5.0',
  '/manifest.webmanifest',
  '/manifest.json',
  '/assets/favicon-32x32.png',
  '/assets/favicon-16x16.png',
  '/assets/favicon.ico',
  '/assets/icon-180.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-192-maskable.png',
  '/assets/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin caching for Google Fonts
  if (url.origin !== self.location.origin) {
    if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
      event.respondWith(
        caches.match(req).then((cached) => {
          const fetchPromise = fetch(req)
            .then((networkRes) => {
              if (networkRes && networkRes.status === 200) {
                const copy = networkRes.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
              }
              return networkRes;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      );
    }
    return;
  }

  // Never cache API or real-time WebSockets
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/ping') ||
    url.pathname.startsWith('/health')
  ) {
    return;
  }

  // HTML page navigation: Network-first with cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => caches.match('/index.html').then((res) => res || caches.match('/')))
    );
    return;
  }

  // Core static assets: Cache-first with background network revalidation
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => null);

      return cached || fetchPromise;
    })
  );
});
