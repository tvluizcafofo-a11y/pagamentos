/* Service Worker — Sistema de Pagamentos */
const CACHE_VERSION = 'v3';
const CACHE_NAME = 'pagamentos-' + CACHE_VERSION;

const ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Adiciona um por um para não falhar tudo se um arquivo faltar
        return Promise.all(
          ARQUIVOS.map((url) =>
            cache.add(url).catch(() => console.warn('Não cacheado:', url))
          )
        );
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(
        nomes.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Nunca cacheia chamadas para GitHub (API ou raw) nem POST/PUT
  if (url.hostname.includes('github') || url.hostname.includes('githubusercontent')) return;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cacheado) => {
      const redePromessa = fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return resp;
        })
        .catch(() => cacheado);
      return cacheado || redePromessa;
    })
  );
});