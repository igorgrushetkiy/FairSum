// Service worker: приложение открывается без интернета.
// При изменении файлов приложения увеличьте VERSION.
const VERSION = 'fairsum-v16';
const RUNTIME = 'fairsum-runtime';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/calc.js',
  './js/parse.js',
  './js/ocr.js',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Файлы приложения: сначала сеть (всегда свежая версия), без сети или при медленной сети — из кэша.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        const cached = await cache.match(req, { ignoreSearch: true });
        if (!cached) return network;
        const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), 2500));
        return Promise.race([network.catch(() => cached), timeout]);
      }),
    );
    return;
  }

  // Модуль распознавания с CDN (версии зафиксированы) — кэш навсегда.
  // Языковые файлы (*.traineddata) Tesseract сам хранит в IndexedDB, их не дублируем.
  if (url.hostname === 'cdn.jsdelivr.net' && !url.pathname.includes('traineddata')) {
    e.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
  }
});
