// Service Worker — кэширование статики для быстрого старта PWA (V5)
const CACHE_NAME = 'clean-cinema-v5';
const STATIC_ASSETS = [
    '/',
    '/static/css/style.css?v=5',
    '/static/js/app.js?v=5',
    '/static/js/player.js?v=5',
    '/static/js/storage.js?v=5',
    '/static/manifest.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // API-запросы всегда идут в сеть
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // Для статики: сначала кэш, потом сеть
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                // Кэшируем новые статические ресурсы
                if (response.ok && url.pathname.startsWith('/static/')) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
