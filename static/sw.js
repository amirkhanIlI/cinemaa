// Service Worker — кэширование статики и офлайн-видео Clean Cinema (V11)
const CACHE_NAME = 'clean-cinema-v11';
const OFFLINE_CACHE = 'cinema-downloads';

const STATIC_ASSETS = [
    '/',
    '/static/css/style.css?v=11',
    '/static/js/app.js?v=11',
    '/static/js/player.js?v=11',
    '/static/js/storage.js?v=11',
    '/static/js/offline.js?v=11',
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
            Promise.all(
                keys
                    // НЕ удаляем кэш скачанных фильмов cinema-downloads!
                    .filter(k => k !== CACHE_NAME && k !== OFFLINE_CACHE)
                    .map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // ─── ОФЛАЙН-ВИДЕО: перехват стримов и фрагментов из кэша downloads ───
    if (url.pathname.startsWith('/offline-stream/')) {
        event.respondWith(
            caches.open(OFFLINE_CACHE).then(async (cache) => {
                // Ищем по полному запросу или по pathname
                const matched = await cache.match(event.request) || await cache.match(url.pathname);
                if (matched) return matched;
                return new Response('Offline stream segment not found', {
                    status: 404,
                    statusText: 'Not Found'
                });
            })
        );
        return;
    }

    // API-запросы всегда идут в сеть
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // Для статики: сначала кэш, потом сеть
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response.ok && url.pathname.startsWith('/static/')) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Офлайн фоллбэк на главную для SPA навигации
                if (event.request.mode === 'navigate') {
                    return caches.match('/');
                }
            });
        })
    );
});
