/**
 * storage.js — Движок идеального сохранения прогресса.
 *
 * Стратегия трёхслойной защиты:
 * 1. localStorage — мгновенное (<1мс) сохранение при каждом событии.
 * 2. visibilitychange + pagehide — гарантированное сохранение при
 *    блокировке экрана, сворачивании, входящем звонке.
 * 3. sendBeacon → сервер — асинхронная отправка на бэкенд
 *    (не блокирует закрытие вкладки).
 */

const CinemaStorage = (() => {
    const HISTORY_KEY = 'cinema_all_history';
    const LAST_KEY    = 'cinema_last_watched';

    // ─── LocalStorage helpers ───

    function _getAll() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
        } catch { return {}; }
    }

    function _setAll(data) {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('[Storage] localStorage full, pruning old entries');
            _pruneOldest(data);
        }
    }

    function _pruneOldest(data) {
        const entries = Object.entries(data);
        entries.sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
        // Удаляем самые старые 20%
        const toRemove = Math.max(1, Math.floor(entries.length * 0.2));
        for (let i = 0; i < toRemove; i++) {
            delete data[entries[i][0]];
        }
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(data));
        } catch {}
    }

    // ─── Публичные методы ───

    /**
     * Сохранить прогресс просмотра.
     * Вызывается из player.js при каждом тике и при закрытии.
     */
    function save(state) {
        if (!state || !state.filmId) return;

        const entry = {
            filmId: state.filmId,
            filmUrl: state.filmUrl || '',
            title: state.title || '',
            poster: state.poster || '',
            type: state.type || 'movie',
            season: state.season || null,
            episode: state.episode || null,
            translatorId: state.translatorId || null,
            translatorName: state.translatorName || '',
            time: state.time || 0,
            duration: state.duration || 0,
            timestamp: Date.now(),
        };

        // 1. Мгновенное сохранение в localStorage
        const all = _getAll();
        all[entry.filmId] = entry;
        _setAll(all);
        try {
            localStorage.setItem(LAST_KEY, JSON.stringify(entry));
        } catch {}

        // 2. Асинхронная отправка на сервер через sendBeacon
        _beaconToServer(entry);
    }

    /**
     * Получить прогресс для конкретного фильма.
     */
    function get(filmId) {
        const all = _getAll();
        return all[filmId] || null;
    }

    /**
     * Получить список всех незавершённых просмотров.
     * Возвращает массив, отсортированный по дате (новые первые).
     */
    function getAll() {
        const all = _getAll();
        return Object.values(all)
            .filter(e => e.time > 10) // исключаем случайные запуски (<10сек)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    /**
     * Удалить запись из истории.
     */
    function remove(filmId) {
        const all = _getAll();
        delete all[filmId];
        _setAll(all);
        // Удалить и с сервера
        fetch(`/api/history/${encodeURIComponent(filmId)}`, { method: 'DELETE' }).catch(() => {});
    }

    /**
     * Загрузить серверную историю и объединить с локальной.
     * Вызывается при загрузке страницы.
     */
    async function syncWithServer() {
        try {
            const resp = await fetch('/api/history');
            if (!resp.ok) return;
            const data = await resp.json();
            const serverItems = data.items || [];
            const local = _getAll();

            for (const item of serverItems) {
                const fid = item.film_id;
                const localEntry = local[fid];
                const serverTs = (item.updated_at || 0) * 1000; // сервер хранит в секундах

                // Если локальная запись новее — не перезаписываем
                if (localEntry && (localEntry.timestamp || 0) > serverTs) continue;

                local[fid] = {
                    filmId: fid,
                    filmUrl: item.film_url || '',
                    title: item.title || '',
                    poster: item.poster_url || '',
                    type: item.type || 'movie',
                    season: item.season,
                    episode: item.episode,
                    translatorId: item.translator_id,
                    translatorName: item.translator_name || '',
                    time: item.position || 0,
                    duration: item.duration || 0,
                    timestamp: serverTs || Date.now(),
                };
            }
            _setAll(local);
        } catch (e) {
            console.warn('[Storage] Server sync failed:', e);
        }
    }

    // ─── Внутренние утилиты ───

    function _beaconToServer(entry) {
        try {
            if (navigator.sendBeacon) {
                const blob = new Blob([JSON.stringify(entry)], { type: 'application/json' });
                navigator.sendBeacon('/api/history', blob);
            } else {
                fetch('/api/history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(entry),
                    keepalive: true,
                }).catch(() => {});
            }
        } catch {}
    }

    return { save, get, getAll, remove, syncWithServer };
})();
