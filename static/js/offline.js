/**
 * Clean Cinema — Офлайн-загрузки (Offline Storage & Download Engine V11)
 * Скачивание серий и фильмов в память браузера (Cache API + IndexedDB) как в Telegram / Netflix.
 * Работает 100% без интернета, без галереи телефона, с удалением в один клик.
 */

const OfflineManager = (function () {
    const DB_NAME = 'CleanCinemaOfflineDB';
    const DB_VERSION = 2;
    const STORE_NAME = 'downloads';
    const OFFLINE_CACHE = 'cinema-downloads';

    let db = null;
    const activeDownloads = new Map(); // id -> { controller, progress, totalBytes, ... }

    // ─── Инициализация IndexedDB ───
    function initDB() {
        return new Promise((resolve, reject) => {
            if (db) return resolve(db);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains(STORE_NAME)) {
                    d.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };
            req.onerror = (e) => reject(e);
        });
    }

    // ─── Получение списка и отдельных записей ───
    async function getAll() {
        try {
            const d = await initDB();
            return new Promise((resolve) => {
                const tx = d.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        } catch (e) {
            console.warn('[Offline] getAll error:', e);
            return [];
        }
    }

    async function get(id) {
        try {
            const d = await initDB();
            return new Promise((resolve) => {
                const tx = d.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch (e) {
            return null;
        }
    }

    async function isDownloaded(id) {
        const item = await get(id);
        return !!item;
    }

    function isDownloading(id) {
        return activeDownloads.has(id);
    }

    function getActiveProgress(id) {
        const task = activeDownloads.get(id);
        return task ? task.progress : null;
    }

    function getActiveDownloads() {
        return Array.from(activeDownloads.values());
    }

    // ─── Сохранение и удаление ───
    async function save(item) {
        const d = await initDB();
        return new Promise((resolve, reject) => {
            const tx = d.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put(item);
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e);
        });
    }

    async function remove(id) {
        // Отменяем активную загрузку, если идёт
        if (activeDownloads.has(id)) {
            cancelDownload(id);
        }

        // 1. Очистка кэша сегментов
        if ('caches' in window) {
            try {
                const cache = await caches.open(OFFLINE_CACHE);
                const keys = await cache.keys();
                const prefix = `/offline-stream/${id}/`;
                for (const req of keys) {
                    if (req.url.includes(prefix)) {
                        await cache.delete(req);
                    }
                }
            } catch (e) {
                console.warn('[Offline] Cache delete error:', e);
            }
        }

        // 2. Удаление из IndexedDB
        try {
            const d = await initDB();
            return new Promise((resolve) => {
                const tx = d.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                store.delete(id);
                tx.oncomplete = () => {
                    window.dispatchEvent(new CustomEvent('downloads-updated', { detail: { id, action: 'removed' } }));
                    resolve(true);
                };
                tx.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    function cancelDownload(id) {
        const task = activeDownloads.get(id);
        if (task) {
            try { task.controller.abort(); } catch {}
            activeDownloads.delete(id);
            window.dispatchEvent(new CustomEvent('download-cancelled', { detail: { id } }));
            window.dispatchEvent(new CustomEvent('downloads-updated', { detail: { id, action: 'cancelled' } }));
        }
    }

    // ─── Запуск загрузки ───
    async function startDownload(opts) {
        const {
            filmId,
            filmUrl,
            title,
            poster,
            type = 'series',
            season = null,
            episode = null,
            episodeTitle = '',
            voiceName = '',
            streamUrl,
        } = opts;

        const id = type === 'series'
            ? `${filmId}_s${season}_e${episode}`
            : `${filmId}_movie`;

        if (activeDownloads.has(id)) {
            console.log(`[Offline] Download already in progress: ${id}`);
            return false;
        }

        const controller = new AbortController();
        const task = {
            id,
            filmId,
            filmUrl,
            title,
            poster,
            type,
            season,
            episode,
            episodeTitle,
            voiceName,
            progress: 0,
            downloadedBytes: 0,
            controller,
        };
        activeDownloads.set(id, task);

        window.dispatchEvent(new CustomEvent('download-started', { detail: task }));
        window.dispatchEvent(new CustomEvent('downloads-updated', { detail: { id, action: 'started' } }));

        try {
            if (!('caches' in window)) {
                throw new Error('CacheStorage не поддерживается вашим браузером');
            }

            const cache = await caches.open(OFFLINE_CACHE);

            // 0. Кэшируем постер для полного офлайн-отображения
            let offlinePoster = poster;
            if (poster) {
                try {
                    const pResp = await fetch(poster, { signal: controller.signal });
                    if (pResp.ok) {
                        const pBlob = await pResp.blob();
                        const pUrl = `/offline-stream/${id}/poster.jpg`;
                        await cache.put(pUrl, new Response(pBlob, { headers: { 'Content-Type': pBlob.type || 'image/jpeg' } }));
                        offlinePoster = pUrl;
                    }
                } catch (e) {
                    console.warn('[Offline] Poster cache skipped:', e);
                }
            }

            // 1. Получаем мастер-плейлист
            const masterResp = await fetch(streamUrl, {
                signal: controller.signal,
                headers: { 'Accept': '*/*' },
            });
            if (!masterResp.ok) throw new Error(`Ошибка загрузки плейлиста: ${masterResp.status}`);
            const masterText = await masterResp.text();

            // 2. Ищем подходящий видеопоток (720p > 1080p > 480p)
            let subPlaylistUrl = streamUrl;
            let subPlaylistText = masterText;

            if (masterText.includes('#EXT-X-STREAM-INF')) {
                const lines = masterText.split('\n');
                let chosenUrl = null;
                for (let i = 0; i < lines.length; i++) {
                    const l = lines[i].trim();
                    if (l.startsWith('#EXT-X-STREAM-INF')) {
                        for (let j = i + 1; j < lines.length; j++) {
                            const candidate = lines[j].trim();
                            if (candidate && !candidate.startsWith('#')) {
                                if (!chosenUrl || l.includes('720') || l.includes('1280x720') || l.includes('1080')) {
                                    chosenUrl = candidate;
                                    if (l.includes('720') || l.includes('1280x720')) break;
                                }
                                break;
                            }
                        }
                    }
                }

                if (chosenUrl) {
                    subPlaylistUrl = new URL(chosenUrl, streamUrl).href;
                    const subResp = await fetch(subPlaylistUrl, { signal: controller.signal });
                    if (!subResp.ok) throw new Error(`Ошибка загрузки дорожки: ${subResp.status}`);
                    subPlaylistText = await subResp.text();
                }
            }

            // 3. Собираем сегменты (.ts) и ключи шифрования (если есть)
            const subLines = subPlaylistText.split('\n');
            const segmentUrls = [];
            const rewrittenLines = [];

            let segIndex = 0;
            let keyIndex = 0;

            for (const line of subLines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('#EXT-X-KEY')) {
                    // Обработка AES ключа если есть
                    const uriMatch = trimmed.match(/URI=["']([^"']+)["']/);
                    if (uriMatch) {
                        const originalKeyUrl = new URL(uriMatch[1], subPlaylistUrl).href;
                        try {
                            const keyResp = await fetch(originalKeyUrl, { signal: controller.signal });
                            if (keyResp.ok) {
                                const keyBlob = await keyResp.blob();
                                const cachedKeyPath = `/offline-stream/${id}/key-${keyIndex}.bin`;
                                await cache.put(cachedKeyPath, new Response(keyBlob));
                                rewrittenLines.push(trimmed.replace(uriMatch[1], cachedKeyPath));
                                keyIndex++;
                                continue;
                            }
                        } catch (ke) {
                            console.warn('[Offline] Key fetch error:', ke);
                        }
                    }
                    rewrittenLines.push(line);
                } else if (trimmed && !trimmed.startsWith('#')) {
                    const absoluteSegUrl = new URL(trimmed, subPlaylistUrl).href;
                    segmentUrls.push(absoluteSegUrl);
                    rewrittenLines.push(`/offline-stream/${id}/seg-${segIndex}.ts`);
                    segIndex++;
                } else {
                    rewrittenLines.push(line);
                }
            }

            if (segmentUrls.length === 0) {
                throw new Error('В видеопотоке не найдены фрагменты для скачивания');
            }

            const totalSegments = segmentUrls.length;
            let downloadedCount = 0;
            let totalBytes = 0;

            // 4. Скачиваем сегменты параллельно (по 3 потока одновременно)
            const CONCURRENCY = 3;
            let currentIndex = 0;

            async function downloadWorker() {
                while (currentIndex < totalSegments) {
                    if (controller.signal.aborted) throw new Error('Загрузка отменена');
                    const i = currentIndex++;
                    const segUrl = segmentUrls[i];

                    const segResp = await fetch(segUrl, { signal: controller.signal });
                    if (!segResp.ok) throw new Error(`Ошибка сегмента ${i}: ${segResp.status}`);
                    const segBlob = await segResp.blob();

                    totalBytes += segBlob.size;
                    downloadedCount++;

                    // Сохраняем сегмент в Cache API
                    const cacheUrl = `/offline-stream/${id}/seg-${i}.ts`;
                    await cache.put(cacheUrl, new Response(segBlob, {
                        headers: {
                            'Content-Type': 'video/mp2t',
                            'Content-Length': String(segBlob.size),
                        }
                    }));

                    const pct = Math.min(99, Math.round((downloadedCount / totalSegments) * 100));
                    task.progress = pct;
                    task.downloadedBytes = totalBytes;

                    window.dispatchEvent(new CustomEvent('download-progress', {
                        detail: {
                            id,
                            progress: pct,
                            downloadedBytes: totalBytes,
                            formattedSize: formatBytes(totalBytes),
                            downloadedCount,
                            totalSegments,
                        }
                    }));
                }
            }

            const workers = Array.from({ length: Math.min(CONCURRENCY, totalSegments) }, () => downloadWorker());
            await Promise.all(workers);

            // 5. Сохраняем переписанный плейлист в Cache API
            const finalManifestText = rewrittenLines.join('\n');
            const manifestUrl = `/offline-stream/${id}/manifest.m3u8`;
            await cache.put(manifestUrl, new Response(finalManifestText, {
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
            }));

            // Также сохраняем master.m3u8
            const masterM3u8Text = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\n${manifestUrl}\n`;
            const masterUrl = `/offline-stream/${id}/master.m3u8`;
            await cache.put(masterUrl, new Response(masterM3u8Text, {
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
            }));

            // 6. Сохраняем запись в IndexedDB
            const record = {
                id,
                filmId,
                filmUrl: filmUrl || '',
                title,
                poster: offlinePoster,
                type,
                season,
                episode,
                episodeTitle: episodeTitle || '',
                voiceName: voiceName || '',
                offlineUrl: masterUrl,
                totalBytes,
                formattedSize: formatBytes(totalBytes),
                totalSegments,
                savedAt: Date.now(),
            };

            await save(record);

            activeDownloads.delete(id);
            window.dispatchEvent(new CustomEvent('download-completed', { detail: record }));
            window.dispatchEvent(new CustomEvent('downloads-updated', { detail: { id, action: 'completed' } }));
            return true;
        } catch (err) {
            console.error('[Offline] Download failed:', err);
            activeDownloads.delete(id);
            window.dispatchEvent(new CustomEvent('download-error', {
                detail: { id, error: err.message || 'Ошибка загрузки' }
            }));
            window.dispatchEvent(new CustomEvent('downloads-updated', { detail: { id, action: 'error' } }));
            return false;
        }
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 МБ';
        const mb = bytes / (1024 * 1024);
        if (mb >= 1000) {
            return `${(mb / 1024).toFixed(1)} ГБ`;
        }
        return `${Math.round(mb)} МБ`;
    }

    async function getTotalStorageSize() {
        const items = await getAll();
        const total = items.reduce((acc, it) => acc + (it.totalBytes || 0), 0);
        return formatBytes(total);
    }

    return {
        initDB,
        getAll,
        get,
        save,
        remove,
        isDownloaded,
        isDownloading,
        getActiveProgress,
        getActiveDownloads,
        startDownload,
        cancelDownload,
        formatBytes,
        getTotalStorageSize,
    };
})();
