/**
 * Clean Cinema — Офлайн-загрузки (Offline Storage & Download Engine V12)
 * Скачивание серий и фильмов в память браузера (Cache API + IndexedDB) как в Telegram / Netflix.
 * Полная поддержка HLS с раздельными дорожками видео + аудио (Collaps и др.).
 * 100% офлайн без интернета, без галереи телефона, удаление в один клик.
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

    // ─── Получение записей ───
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

    // ─── Вспомогательная функция скачивания сегментов одного субплейлиста ───
    async function downloadSegments(playlistText, baseUrl, id, prefix, cache, controller, onChunk) {
        const lines = playlistText.split('\n');
        const segmentUrls = [];
        const rewrittenLines = [];

        let segIndex = 0;
        let keyIndex = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXT-X-KEY')) {
                const uriMatch = trimmed.match(/URI=["']([^"']+)["']/);
                if (uriMatch) {
                    const originalKeyUrl = new URL(uriMatch[1], baseUrl).href;
                    try {
                        const keyResp = await fetch(originalKeyUrl, { signal: controller.signal });
                        if (keyResp.ok) {
                            const keyBlob = await keyResp.blob();
                            const cachedKeyPath = `/offline-stream/${id}/${prefix}-key-${keyIndex}.bin`;
                            await cache.put(cachedKeyPath, new Response(keyBlob, {
                                headers: { 'Content-Type': 'application/octet-stream' }
                            }));
                            rewrittenLines.push(trimmed.replace(uriMatch[1], cachedKeyPath));
                            keyIndex++;
                            continue;
                        }
                    } catch (ke) {
                        console.warn('[Offline] Key fetch skipped:', ke);
                    }
                }
                rewrittenLines.push(line);
            } else if (trimmed && !trimmed.startsWith('#')) {
                const absUrl = new URL(trimmed, baseUrl).href;
                segmentUrls.push(absUrl);
                rewrittenLines.push(`/offline-stream/${id}/${prefix}-seg-${segIndex}.ts`);
                segIndex++;
            } else {
                rewrittenLines.push(line);
            }
        }

        const total = segmentUrls.length;
        const CONCURRENCY = 3;
        let currentIndex = 0;

        async function worker() {
            while (currentIndex < total) {
                if (controller.signal.aborted) throw new Error('Загрузка отменена');
                const i = currentIndex++;
                const segUrl = segmentUrls[i];

                const segResp = await fetch(segUrl, { signal: controller.signal });
                if (!segResp.ok) throw new Error(`Ошибка загрузки сегмента ${i}: ${segResp.status}`);
                const segBlob = await segResp.blob();

                const cacheUrl = `/offline-stream/${id}/${prefix}-seg-${i}.ts`;
                await cache.put(cacheUrl, new Response(segBlob, {
                    headers: {
                        'Content-Type': 'video/mp2t',
                        'Content-Length': String(segBlob.size),
                        'Accept-Ranges': 'bytes',
                    }
                }));

                if (onChunk) onChunk(segBlob.size);
            }
        }

        const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
        await Promise.all(workers);

        return rewrittenLines.join('\n');
    }

    // ─── Запуск загрузки (Видео + Аудио) ───
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
                throw new Error('Кэш браузера CacheStorage не поддерживается');
            }

            const cache = await caches.open(OFFLINE_CACHE);

            // 0. Сохраняем постер в кэш
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

            let totalDownloadedBytes = 0;
            let currentProgress = 0;

            const notifyProgress = (pct) => {
                task.progress = pct;
                task.downloadedBytes = totalDownloadedBytes;
                window.dispatchEvent(new CustomEvent('download-progress', {
                    detail: {
                        id,
                        episode,
                        progress: pct,
                        downloadedBytes: totalDownloadedBytes,
                        formattedSize: formatBytes(totalDownloadedBytes),
                    }
                }));
            };

            // 2. Ищем и фильтруем аудиодорожки (#EXT-X-MEDIA:TYPE=AUDIO)
            const masterLines = masterText.split('\n');
            const audioTracks = [];
            for (const line of masterLines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('TYPE=AUDIO') && trimmed.includes('URI=')) {
                    const mUri = trimmed.match(/URI=["']([^"']+)["']/);
                    const mName = trimmed.match(/NAME=["']([^"']+)["']/);
                    if (mUri) {
                        audioTracks.push({
                            name: mName ? mName[1] : '',
                            url: new URL(mUri[1], streamUrl).href,
                            line: trimmed,
                        });
                    }
                }
            }

            const hasSeparateAudio = audioTracks.length > 0;
            let audioSubUrl = null;

            if (hasSeparateAudio) {
                // Если передано voiceName, пытаемся найти подходящую дорожку
                let chosenAudio = null;
                if (voiceName) {
                    const vLower = voiceName.toLowerCase();
                    chosenAudio = audioTracks.find(t => t.name.toLowerCase().includes(vLower));
                }
                if (!chosenAudio) {
                    // Ищем по rus или def, иначе берем первую
                    chosenAudio = audioTracks.find(t => t.name.toLowerCase().startsWith('rus') || t.name.toLowerCase().startsWith('def')) || audioTracks[0];
                }
                audioSubUrl = chosenAudio ? chosenAudio.url : audioTracks[0].url;

                console.log('[Offline] Downloading audio track:', audioSubUrl);
                const aResp = await fetch(audioSubUrl, { signal: controller.signal });
                if (aResp.ok) {
                    const aText = await aResp.text();
                    const rewrittenAudioText = await downloadSegments(
                        aText,
                        audioSubUrl,
                        id,
                        'audio',
                        cache,
                        controller,
                        (chunkSize) => {
                            totalDownloadedBytes += chunkSize;
                            notifyProgress(Math.min(25, Math.round(currentProgress + 1)));
                        }
                    );

                    await cache.put(`/offline-stream/${id}/audio.m3u8`, new Response(rewrittenAudioText, {
                        headers: {
                            'Content-Type': 'application/vnd.apple.mpegurl',
                            'Accept-Ranges': 'bytes',
                        }
                    }));
                }
            }

            // 4. Находим видеопоток (720p > 1080p > 480p)
            let videoSubUrl = streamUrl;
            let videoSubText = masterText;

            if (masterText.includes('#EXT-X-STREAM-INF')) {
                let chosenUrl = null;
                for (let i = 0; i < masterLines.length; i++) {
                    const l = masterLines[i].trim();
                    if (l.startsWith('#EXT-X-STREAM-INF')) {
                        for (let j = i + 1; j < masterLines.length; j++) {
                            const cand = masterLines[j].trim();
                            if (cand && !cand.startsWith('#')) {
                                if (l.includes('720') || l.includes('1280x720')) {
                                    chosenUrl = cand;
                                    break;
                                }
                                if (!chosenUrl && (l.includes('1080') || l.includes('1920x1080'))) {
                                    chosenUrl = cand;
                                } else if (!chosenUrl) {
                                    chosenUrl = cand;
                                }
                                break;
                            }
                        }
                        if (chosenUrl && (l.includes('720') || l.includes('1280x720'))) {
                            break;
                        }
                    }
                }

                if (chosenUrl) {
                    videoSubUrl = new URL(chosenUrl, streamUrl).href;
                    const vResp = await fetch(videoSubUrl, { signal: controller.signal });
                    if (!vResp.ok) throw new Error(`Ошибка загрузки видеодорожки: ${vResp.status}`);
                    videoSubText = await vResp.text();
                }
            }

            // 5. Скачиваем видео-сегменты
            const rewrittenVideoText = await downloadSegments(
                videoSubText,
                videoSubUrl,
                id,
                'video',
                cache,
                controller,
                (chunkSize) => {
                    totalDownloadedBytes += chunkSize;
                    const baseProg = hasSeparateAudio ? 25 : 5;
                    const remaining = 99 - baseProg;
                    currentProgress = Math.min(99, Math.round(baseProg + (totalDownloadedBytes / (totalDownloadedBytes + 20000000)) * remaining));
                    notifyProgress(currentProgress);
                }
            );

            // Сохраняем видео-манифест
            await cache.put(`/offline-stream/${id}/video.m3u8`, new Response(rewrittenVideoText, {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Accept-Ranges': 'bytes',
                }
            }));

            // 6. Формируем чистый 100% автономный мастер-манифест БЕЗ внешних ссылок
            let finalMasterText = '';
            if (hasSeparateAudio) {
                finalMasterText = [
                    '#EXTM3U',
                    '#EXT-X-VERSION:3',
                    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="${voiceName || 'Русский'}",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="ru",URI="/offline-stream/${id}/audio.m3u8"`,
                    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio0"',
                    `/offline-stream/${id}/video.m3u8`,
                    '',
                ].join('\n');
            } else {
                finalMasterText = [
                    '#EXTM3U',
                    '#EXT-X-VERSION:3',
                    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
                    `/offline-stream/${id}/video.m3u8`,
                    '',
                ].join('\n');
            }

            const masterUrl = `/offline-stream/${id}/master.m3u8`;
            await cache.put(masterUrl, new Response(finalMasterText, {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Accept-Ranges': 'bytes',
                }
            }));

            // Также сохраняем дубликат на manifest.m3u8
            await cache.put(`/offline-stream/${id}/manifest.m3u8`, new Response(rewrittenVideoText, {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Accept-Ranges': 'bytes',
                }
            }));

            // 7. Сохраняем запись в IndexedDB
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
                totalBytes: totalDownloadedBytes,
                formattedSize: formatBytes(totalDownloadedBytes),
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
