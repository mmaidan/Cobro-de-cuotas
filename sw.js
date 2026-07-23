// Service worker mínimo. Objetivo: cumplir el requisito técnico para que el
// navegador ofrezca "Instalar app" / "Agregar a pantalla de inicio", y dar
// algo de resiliencia offline para la interfaz (no para los datos, que
// siempre vienen de Firebase y necesitan conexión).
const CACHE_NAME = 'cuotas-isj-v2';
const ARCHIVOS_SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './logo.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Solo interceptamos pedidos a nuestro propio origen (el shell).
  // Todo lo de Firebase, Tailwind, fuentes, etc. sigue yendo directo a la red.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
