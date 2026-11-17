/* Bluff! service worker: caches the app shell so bot games work offline.
   Online multiplayer still needs the game server.
   Strategy: NETWORK-FIRST for everything (so new versions arrive as soon
   as they are deployed), falling back to the cache when offline. The cache
   name carries the version — bump it whenever the shell changes so old
   caches are deleted on activate. */
const CACHE = 'bluff-v3';
const ASSETS = ['./', './index.html', './engine.js', './manifest.json'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
