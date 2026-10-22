// StudyArc Progressive Web App (PWA) Service Worker — iOS Safari Bulletproof Edition
const CACHE_NAME = 'studyarc-pwa-v34';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/styles.css?v=7.6',
  '/app.js',
  '/app.js?v=7.1',
  '/levels.json',
  '/aura-particles.js',
  '/aura-particles.js?v=5.3',
  '/assets/socket.io.min.js',
  '/manifest.webmanifest',
  '/manifest.json',
  '/assets/favicon-32x32.png',
  '/assets/favicon-16x16.png',
  '/assets/favicon.ico',
  '/assets/icon-180.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-192-maskable.png',
  '/assets/icon-512-maskable.png',
  '/assets/banner-social.png'
];

// 1. Install: Resilient caching with Promise.allSettled so no single asset can fail the installation
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((assetUrl) =>
          cache.add(assetUrl).catch((err) => {
            console.warn('[PWA SW] Precache skipped for:', assetUrl, err);
          })
        )
      );
    })
  );
});

// 2. Activate: Clear old caches and claim existing clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Listen for skip waiting messages from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 3. Fetch: Bulletproof request routing
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // IMPORTANT FOR SAFARI: NEVER intercept cross-origin requests (Google Fonts, CDNs, Catbox, Socket.IO)
  // Let the browser handle cross-origin requests natively to avoid Safari CORS/opaque response failures
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept dynamic backend REST APIs, WebSockets, or health pings
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/ping') ||
    url.pathname.startsWith('/health')
  ) {
    return;
  }

  // Navigation requests: Detect navigation across all mobile browsers (iOS Safari PWA & standard tabs)
  const isNavigation =
    req.mode === 'navigate' ||
    req.destination === 'document' ||
    (req.headers.get('accept') && req.headers.get('accept').includes('text/html'));

  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && (resp.status === 200 || resp.type === 'basic')) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(async () => {
          // If network is offline or fails, return cached index.html or fallback to root
          const cache = await caches.open(CACHE_NAME);
          const cached = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          return fetch('/');
        })
    );
    return;
  }

  // Static Assets (CSS, JS, images, icons): Cache-first with network fallback
  // ALWAYS resolves to a valid Response (never null or undefined, which crashes Safari)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return networkRes;
        })
        .catch(async () => {
          // If offline and not in cache, try matching without query params
          const cleanUrl = url.pathname;
          const cleanCached = await caches.match(cleanUrl);
          if (cleanCached) return cleanCached;
          // Final fallback Response instead of throwing or returning null
          return new Response('', { status: 408, statusText: 'Request Timeout' });
        });
    })
  );
});
