// Service Worker — кэширование статики и офлайн-видео Clean Cinema (V14)
const CACHE_NAME = 'clean-cinema-v14';
const OFFLINE_CACHE = 'cinema-downloads';

const STATIC_ASSETS = [
    '/',
    '/sw.js',
    '/static/sw.js',
    '/static/css/style.css?v=14',
    '/static/js/hls.min.js?v=14',
    '/static/js/app.js?v=14',
    '/static/js/player.js?v=14',
    '/static/js/storage.js?v=14',
    '/static/js/offline.js?v=14',
    '/static/manifest.json',
    '/static/icons/icon-192.png',
    '/static/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch((e) => {
            console.warn('[SW] Cache addAll warning:', e);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    // НЕ удаляем кэш скачанных фильмов cinema-downloads!
                    .filter((k) => k !== CACHE_NAME && k !== OFFLINE_CACHE)
                    .map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // ─── ОФЛАЙН-ВИДЕО: перехват стримов и фрагментов из кэша downloads ───
    if (url.pathname.startsWith('/offline-stream/')) {
        event.respondWith(handleOfflineStream(event.request, url));
        return;
    }

    // API-запросы всегда идут в сеть
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // Для навигации (открытие сайта без интернета)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => caches.match('/'))
        );
        return;
    }

    // Для статики: сначала кэш, потом сеть
    event.respondWith(
        caches.match(event.request, { ignoreSearch: false }).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response.ok && (url.pathname.startsWith('/static/') || url.pathname === '/')) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Если нет сети, пробуем найти без query string
                return caches.match(url.pathname, { ignoreSearch: true });
            });
        })
    );
});

async function handleOfflineStream(request, url) {
    try {
        const cache = await caches.open(OFFLINE_CACHE);
        // Ищем по полному запросу, по href, или по pathname
        let matched = await cache.match(request);
        if (!matched) matched = await cache.match(request.url);
        if (!matched) matched = await cache.match(url.href);
        if (!matched) matched = await cache.match(url.pathname);
        if (!matched) matched = await cache.match(url.pathname, { ignoreSearch: true });

        if (!matched) {
            console.warn('[SW Offline] Not found in cache:', url.pathname);
            return new Response('Offline stream resource not found', {
                status: 404,
                statusText: 'Not Found',
            });
        }

        // Если браузер запрашивает Range (Safari iOS и Chrome MSE)
        const rangeHeader = request.headers.get('Range');
        if (!rangeHeader) {
            return matched;
        }

        const arrayBuffer = await matched.arrayBuffer();
        const totalSize = arrayBuffer.byteLength;
        const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);

        if (matches) {
            const start = parseInt(matches[1], 10);
            const end = matches[2] ? parseInt(matches[2], 10) : totalSize - 1;

            if (start >= totalSize || end >= totalSize) {
                return new Response('Requested range not satisfiable', {
                    status: 416,
                    headers: { 'Content-Range': `bytes */${totalSize}` },
                });
            }

            const chunk = arrayBuffer.slice(start, end + 1);
            const headers = new Headers(matched.headers);
            headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
            headers.set('Content-Length', String(chunk.byteLength));
            headers.set('Accept-Ranges', 'bytes');

            return new Response(chunk, {
                status: 206,
                statusText: 'Partial Content',
                headers: headers,
            });
        }

        return matched;
    } catch (e) {
        console.warn('[SW Offline] error:', e);
        return new Response('Offline stream error', { status: 500 });
    }
}
