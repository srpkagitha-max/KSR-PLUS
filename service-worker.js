const CACHE_NAME = 'ksr-plus-sprint13-create-exam-rebuild-v1';
const APP_SHELL = [
  './offline.html', './manifest.json', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'CLEAR_OLD_CACHES') {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') || url.hostname.includes('gstatic')) return;

  const isPage = request.mode === 'navigate' || request.destination === 'document';
  const isReleaseFile = isPage || ['script', 'style', 'worker'].includes(request.destination)
    || /\.(?:js|css|html|json)$/i.test(url.pathname);

  // Pages, JS and CSS must always check GitHub first. This prevents an old screen
  // appearing before refresh after a new upload.
  if (isReleaseFile) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        return fresh;
      } catch (error) {
        if (isPage) return (await caches.match(request)) || caches.match('./offline.html');
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }

  // Static images/icons can use cache, while updating quietly in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(response => {
      if (response && response.ok) {
        caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => cached);
    return cached || network;
  })());
});
