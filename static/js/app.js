/**
 * app.js — Основная логика приложения Clean Cinema.
 *
 * Управляет навигацией между экранами, поиском, отображением деталей,
 * выбором озвучек/сезонов/серий и запуском плеера.
 */

const CinemaApp = (() => {
    // ─── DOM ───
    const screenHome     = document.getElementById('screen-home');
    const screenDetails  = document.getElementById('screen-details');
    const searchInput    = document.getElementById('search-input');
    const searchClear    = document.getElementById('search-clear');
    const continueSection = document.getElementById('continue-section');
    const continueList   = document.getElementById('continue-list');
    const resultsSection = document.getElementById('results-section');
    const resultsList    = document.getElementById('results-list');
    const emptyState     = document.getElementById('empty-state');
    const spinner        = document.getElementById('loading-spinner');

    const btnBack        = document.getElementById('btn-back');
    const detailsTitle   = document.getElementById('details-title');
    const detailsPoster  = document.getElementById('details-poster');
    const detailsYear    = document.getElementById('details-year');
    const detailsRating  = document.getElementById('details-rating');
    const detailsType    = document.getElementById('details-type');
    const detailsOrigTitle = document.getElementById('details-orig-title');
    const detailsDesc    = document.getElementById('details-description');
    const translatorsList = document.getElementById('translators-list');
    const seasonsSection = document.getElementById('seasons-section');
    const seasonsList    = document.getElementById('seasons-list');
    const episodesSection = document.getElementById('episodes-section');
    const episodesList   = document.getElementById('episodes-list');
    const btnPlayMovie   = document.getElementById('btn-play-movie');
    const qualityOptions = document.getElementById('quality-options');

    // ─── Состояние ───
    let currentDetails = null;   // MediaDetails из API
    let selectedTranslator = null;
    let selectedSeason = null;
    let selectedEpisode = null;
    let searchTimeout = null;

    // ─── Инициализация ───

    function init() {
        // Поиск с дебаунсом
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim();
            searchClear.classList.toggle('hidden', !q);
            clearTimeout(searchTimeout);
            if (q.length >= 2) {
                searchTimeout = setTimeout(() => doSearch(q), 400);
            } else {
                resultsSection.classList.add('hidden');
                emptyState.classList.toggle('hidden', continueList.children.length > 0);
            }
        });

        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            searchClear.classList.add('hidden');
            resultsSection.classList.add('hidden');
            emptyState.classList.toggle('hidden', continueList.children.length > 0);
            searchInput.focus();
        });

        // Кнопка Назад (из деталей)
        btnBack.addEventListener('click', showHome);

        // Кнопка «Смотреть» (для фильмов)
        btnPlayMovie.addEventListener('click', () => {
            if (selectedTranslator) {
                playStream();
            }
        });

        // При закрытии плеера — обновить «Продолжить»
        window.addEventListener('player-closed', () => {
            loadContinueWatching();
        });

        // Автопереход на следующую серию
        window.addEventListener('episode-ended', (e) => {
            const { season, episode } = e.detail;
            if (currentDetails && currentDetails.type === 'series') {
                playNextEpisode(season, episode);
            }
        });

        // Синхронизация и загрузка истории
        CinemaStorage.syncWithServer().then(() => {
            loadContinueWatching();
        });

        // PWA Service Worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/static/sw.js').catch(() => {});
        }
    }

    // ─── Навигация ───

    function showHome() {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        screenHome.classList.add('active');
        loadContinueWatching();
    }

    function showDetails() {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        screenDetails.classList.add('active');
    }

    // ─── Поиск ───

    async function doSearch(query) {
        spinner.classList.remove('hidden');
        emptyState.classList.add('hidden');

        try {
            const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const data = await resp.json();

            resultsList.innerHTML = '';
            if (data.results && data.results.length > 0) {
                for (const item of data.results) {
                    resultsList.appendChild(createSearchCard(item));
                }
                resultsSection.classList.remove('hidden');
            } else {
                resultsSection.classList.add('hidden');
                emptyState.classList.remove('hidden');
            }
        } catch (e) {
            console.error('Search failed:', e);
        } finally {
            spinner.classList.add('hidden');
        }
    }

    function createSearchCard(item) {
        const card = document.createElement('div');
        card.className = 'search-card';
        card.innerHTML = `
            <img class="search-card-img" src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}" loading="lazy"
                 onerror="this.style.background='var(--bg-elevated)'">
            <div class="search-card-info">
                <div class="search-card-title">${escapeHtml(item.title)}</div>
                <div class="search-card-year">${escapeHtml(item.year)} · ${typeLabel(item.type)}</div>
            </div>
        `;
        card.addEventListener('click', () => openDetails(item.url));
        return card;
    }

    // ─── Клиентский фоллбэк на Collaps CDN (для обхода блокировки серверных IP / 410) ───

    async function fetchCollapsHtml(imdbId) {
        try {
            const resp = await fetch(`https://api.nextembed.ws/embed/imdb/${imdbId}`);
            if (resp.ok) {
                return await resp.text();
            }
        } catch (e) {
            console.warn('[Collaps Client] direct fetch failed:', e);
        }
        return null;
    }

    async function enrichDetailsClientSide(data) {
        if (!data || !data.imdb_id) return;
        const html = await fetchCollapsHtml(data.imdb_id);
        if (!html) return;

        if (data.type === 'series') {
            for (const line of html.split('\n')) {
                if (line.includes('seasons:[{') || line.includes('seasons: [{')) {
                    const m = line.match(/seasons\s*:\s*(\[\s*\{.*\}\s*\])/);
                    if (m) {
                        try {
                            const sList = JSON.parse(m[1]);
                            data.seasons = {};
                            data.translators = [];
                            for (const s of sList) {
                                const sNum = String(s.season);
                                const eps = (s.episodes || [])
                                    .map(e => parseInt(e.episode))
                                    .filter(e => !isNaN(e));
                                if (eps.length > 0) {
                                    data.seasons[sNum] = eps.sort((a, b) => a - b);
                                }
                                if (data.translators.length === 0 && s.episodes && s.episodes[0]) {
                                    const names = s.episodes[0].audio?.names || [];
                                    data.translators = names.map((name, idx) => ({ id: idx, name }));
                                }
                            }
                        } catch (err) {
                            console.error('[Collaps Client] seasons parse error:', err);
                        }
                    }
                    break;
                }
            }
        } else {
            const audioMatch = html.match(/audio\s*:\s*(\{.*?\})\s*,\s*subtitles/);
            if (audioMatch) {
                try {
                    const audData = JSON.parse(audioMatch[1]);
                    const names = audData.names || [];
                    if (names.length > 0) {
                        data.translators = names.map((name, idx) => ({ id: idx, name }));
                    }
                } catch (e) {}
            }
        }
    }

    async function fetchClientSideStream(imdbId, mediaType, season, episode, translatorId) {
        const html = await fetchCollapsHtml(imdbId);
        if (!html) return null;

        let tokenVal = '';
        const tokenMatch = html.match(/var\s+lok\s*=\s*1\s*,\s*([a-f0-9]+)\s*=\s*["']([^"']+)["']/);
        if (tokenMatch) {
            tokenVal = tokenMatch[2];
        }

        let baseHls = '';
        let audioTracks = [];

        if (mediaType === 'series' && season != null && episode != null) {
            for (const line of html.split('\n')) {
                if (line.includes('seasons:[{') || line.includes('seasons: [{')) {
                    const m = line.match(/seasons\s*:\s*(\[\s*\{.*\}\s*\])/);
                    if (m) {
                        try {
                            const sList = JSON.parse(m[1]);
                            for (const s of sList) {
                                if (parseInt(s.season) === parseInt(season)) {
                                    for (const ep of (s.episodes || [])) {
                                        if (parseInt(ep.episode) === parseInt(episode)) {
                                            baseHls = ep.hls || '';
                                            audioTracks = ep.audio?.names || [];
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch (err) {}
                    }
                    break;
                }
            }
        } else {
            const hlsMatch = html.match(/hls\s*:\s*["']([^"']+)["']/);
            if (hlsMatch) {
                baseHls = hlsMatch[1];
            }
            const audioMatch = html.match(/audio\s*:\s*(\{.*?\})\s*,\s*subtitles/);
            if (audioMatch) {
                try {
                    const audData = JSON.parse(audioMatch[1]);
                    audioTracks = audData.names || [];
                } catch (e) {}
            }
        }

        if (!baseHls) return null;

        let finalHls = baseHls;
        if (tokenVal) {
            finalHls += (finalHls.includes('?') ? '&' : '?') + tokenVal;
        }

        const streams = {
            'Auto (1080p/720p)': finalHls,
            '1080p': finalHls,
            '720p': finalHls,
            '480p': finalHls,
            '360p': finalHls,
        };

        return {
            streams: streams,
            hls_url: finalHls,
            audio_tracks: audioTracks,
            selected_audio_index: translatorId || 0,
        };
    }

    // ─── Детали фильма ───

    async function openDetails(url) {
        showDetails();
        spinner.classList.remove('hidden');

        try {
            const resp = await fetch(`/api/details?url=${encodeURIComponent(url)}`);
            const data = await resp.json();
            currentDetails = data;

            // Если сервер вернул пустые сезоны или стандартную заглушку (из-за блокировки 410 серверного IP),
            // парсим сезоны и озвучки напрямую из браузера
            if (data.imdb_id && ((data.type === 'series' && (!data.seasons || Object.keys(data.seasons).length === 0)) || (!data.translators || data.translators.length <= 1))) {
                await enrichDetailsClientSide(data);
            }

            // Заполняем UI
            detailsTitle.textContent = data.title;
            detailsPoster.src = data.poster_url;
            detailsYear.textContent = data.year || '';
            detailsRating.textContent = data.rating ? `★ ${data.rating}` : '';
            detailsRating.classList.toggle('hidden', !data.rating);
            detailsType.textContent = typeLabel(data.type);
            detailsOrigTitle.textContent = data.orig_title || '';
            detailsDesc.textContent = data.description || '';

            // Озвучки
            translatorsList.innerHTML = '';
            selectedTranslator = null;
            if (data.translators && data.translators.length > 0) {
                // Проверяем сохранённую озвучку
                const saved = CinemaStorage.get(data.id);
                const savedTid = saved ? saved.translatorId : null;

                for (const t of data.translators) {
                    const chip = document.createElement('button');
                    chip.className = 'chip';
                    chip.textContent = t.name;
                    chip.dataset.id = t.id;

                    chip.addEventListener('click', () => selectTranslator(t));

                    // Выбираем сохранённую или первую
                    if (t.id === savedTid || (!savedTid && !selectedTranslator)) {
                        chip.classList.add('active');
                        selectedTranslator = t;
                    }

                    translatorsList.appendChild(chip);
                }
            }

            // Сезоны/серии
            if (data.type === 'series' && data.seasons && Object.keys(data.seasons).length > 0) {
                seasonsSection.classList.remove('hidden');
                episodesSection.classList.remove('hidden');
                btnPlayMovie.classList.add('hidden');

                renderSeasons(data.seasons);
            } else {
                seasonsSection.classList.add('hidden');
                episodesSection.classList.add('hidden');
                btnPlayMovie.classList.remove('hidden');
            }
        } catch (e) {
            console.error('Details failed:', e);
        } finally {
            spinner.classList.add('hidden');
        }
    }

    function selectTranslator(translator) {
        selectedTranslator = translator;
        translatorsList.querySelectorAll('.chip').forEach(c => {
            c.classList.toggle('active', c.dataset.id == translator.id);
        });
    }

    function renderSeasons(seasons) {
        seasonsList.innerHTML = '';
        const keys = Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b));

        // Восстанавливаем сохранённый сезон
        const saved = CinemaStorage.get(currentDetails.id);
        const savedSeason = saved ? saved.season : null;
        let firstSeason = savedSeason && keys.includes(String(savedSeason))
                        ? String(savedSeason)
                        : keys[0];

        for (const sKey of keys) {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = `Сезон ${sKey}`;
            chip.dataset.season = sKey;

            chip.addEventListener('click', () => {
                selectedSeason = parseInt(sKey);
                seasonsList.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                renderEpisodes(seasons[sKey]);
            });

            if (sKey === firstSeason) {
                chip.classList.add('active');
                selectedSeason = parseInt(sKey);
            }

            seasonsList.appendChild(chip);
        }

        // Показать серии первого сезона
        if (firstSeason && seasons[firstSeason]) {
            renderEpisodes(seasons[firstSeason]);
        }
    }

    function renderEpisodes(episodes) {
        episodesList.innerHTML = '';
        const saved = CinemaStorage.get(currentDetails.id);
        const savedEp = saved ? saved.episode : null;

        for (const ep of episodes) {
            const btn = document.createElement('button');
            btn.className = 'episode-btn';
            btn.textContent = ep;
            btn.dataset.episode = ep;

            // Пометить просмотренные серии
            const watchKey = `${currentDetails.id}_s${selectedSeason}_e${ep}`;
            const epSaved = CinemaStorage.get(currentDetails.id);
            if (epSaved && epSaved.season == selectedSeason && epSaved.episode == ep && epSaved.time > 10) {
                btn.classList.add('watched');
            }

            btn.addEventListener('click', () => {
                selectedEpisode = ep;
                episodesList.querySelectorAll('.episode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                playStream();
            });

            episodesList.appendChild(btn);
        }
    }

    // ─── Запуск потока ───

    async function playStream() {
        if (!selectedTranslator || !currentDetails) return;

        spinner.classList.remove('hidden');

        try {
            let data = null;
            try {
                let url = `/api/stream?url=${encodeURIComponent(currentDetails.url)}&translator_id=${selectedTranslator.id}`;
                if (currentDetails.type === 'series' && selectedSeason && selectedEpisode) {
                    url += `&season=${selectedSeason}&episode=${selectedEpisode}`;
                }

                const resp = await fetch(url);
                data = await resp.json();
            } catch (err) {
                console.warn('Backend stream request failed:', err);
            }

            // Если сервер вернул 410 (блокировка серверного IP в облаке) или ошибку,
            // запускаем резервное прямое извлечение из браузера клиента
            if (!data || data.error || !data.streams || Object.keys(data.streams).length === 0) {
                if (currentDetails.imdb_id) {
                    console.log('[Collaps Client] Falling back to direct client-side stream extraction...');
                    const clientStream = await fetchClientSideStream(
                        currentDetails.imdb_id,
                        currentDetails.type,
                        selectedSeason,
                        selectedEpisode,
                        selectedTranslator ? selectedTranslator.id : 0
                    );
                    if (clientStream && clientStream.hls_url) {
                        data = clientStream;
                    }
                }
            }

            if (!data || data.error) {
                alert('Ошибка: ' + (data ? data.error : 'Не удалось получить видеопоток'));
                return;
            }

            if (!data.streams || Object.keys(data.streams).length === 0) {
                alert('Видеопотоки не найдены. Попробуйте другую озвучку.');
                return;
            }

            // Обновить модалку качества
            renderQualityOptions(data.streams);

            // Запуск плеера
            CinemaPlayer.open({
                streams: data.streams,
                hls_url: data.hls_url,
                audioTracks: data.audio_tracks,
                filmId: currentDetails.id,
                filmUrl: currentDetails.url,
                title: currentDetails.title,
                poster: currentDetails.poster_url,
                type: currentDetails.type,
                season: selectedSeason,
                episode: selectedEpisode,
                translatorId: selectedTranslator ? selectedTranslator.id : 0,
                translatorName: selectedTranslator ? selectedTranslator.name : '',
            });
        } catch (e) {
            console.error('Stream failed:', e);
            alert('Не удалось загрузить поток. Попробуйте позже.');
        } finally {
            spinner.classList.add('hidden');
        }
    }

    function renderQualityOptions(streams) {
        qualityOptions.innerHTML = '';
        const qualities = Object.keys(streams);
        // Сортируем: 360p, 480p, 720p, 1080p, 1080p Ultra
        qualities.sort((a, b) => {
            const numA = parseInt(a) || 0;
            const numB = parseInt(b) || 0;
            return numA - numB;
        });

        for (const q of qualities) {
            const btn = document.createElement('button');
            btn.className = 'modal-option';
            btn.textContent = q;
            btn.addEventListener('click', () => {
                qualityOptions.querySelectorAll('.modal-option').forEach(o => o.classList.remove('active'));
                btn.classList.add('active');
                CinemaPlayer.switchQuality(q);
            });
            if (q === '720p') btn.classList.add('active');
            qualityOptions.appendChild(btn);
        }
    }

    // ─── Автопереход на следующую серию ───

    function playNextEpisode(currentSeason, currentEpisode) {
        if (!currentDetails || !currentDetails.seasons) return;

        const seasons = currentDetails.seasons;
        const sKey = String(currentSeason);
        const episodes = seasons[sKey] || [];
        const idx = episodes.indexOf(currentEpisode);

        if (idx >= 0 && idx < episodes.length - 1) {
            // Следующая серия в том же сезоне
            selectedEpisode = episodes[idx + 1];
            playStream();
        } else {
            // Следующий сезон
            const sKeys = Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b));
            const sIdx = sKeys.indexOf(sKey);
            if (sIdx >= 0 && sIdx < sKeys.length - 1) {
                const nextSeason = sKeys[sIdx + 1];
                selectedSeason = parseInt(nextSeason);
                selectedEpisode = seasons[nextSeason][0] || 1;
                playStream();
            }
        }
    }

    // ─── «Продолжить просмотр» ───

    function loadContinueWatching() {
        const items = CinemaStorage.getAll();
        continueList.innerHTML = '';

        if (items.length === 0) {
            continueSection.classList.add('hidden');
            if (!resultsSection.classList.contains('hidden')) return;
            emptyState.classList.remove('hidden');
            return;
        }

        continueSection.classList.remove('hidden');
        emptyState.classList.add('hidden');

        for (const item of items.slice(0, 20)) {
            continueList.appendChild(createContinueCard(item));
        }
    }

    function createContinueCard(item) {
        const card = document.createElement('div');
        card.className = 'continue-card';

        const progress = item.duration > 0 ? Math.min(100, (item.time / item.duration) * 100) : 0;
        const timeStr = formatTime(item.time);
        let subtitle = item.translatorName || '';
        if (item.type === 'series' && item.season && item.episode) {
            subtitle = `S${item.season}E${item.episode}` + (subtitle ? ` · ${subtitle}` : '');
        }

        card.innerHTML = `
            <button class="continue-card-delete" title="Удалить" data-id="${escapeHtml(item.filmId)}">✕</button>
            <img class="continue-card-img" src="${escapeHtml(item.poster || '')}" alt="" loading="lazy"
                 onerror="this.style.background='var(--bg-elevated)'">
            <div class="continue-card-info">
                <div class="continue-card-title">${escapeHtml(item.title)}</div>
                <div class="continue-card-sub">${escapeHtml(subtitle)} · ${timeStr}</div>
                <div class="continue-progress-bar">
                    <div class="continue-progress-fill" style="width:${progress}%"></div>
                </div>
            </div>
        `;

        // Клик по карточке — открыть и продолжить
        card.addEventListener('click', (e) => {
            if (e.target.closest('.continue-card-delete')) return;
            if (item.filmUrl) {
                openDetails(item.filmUrl);
            }
        });

        // Кнопка удаления
        const delBtn = card.querySelector('.continue-card-delete');
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            CinemaStorage.remove(item.filmId);
            card.remove();
            if (continueList.children.length === 0) {
                continueSection.classList.add('hidden');
            }
        });

        return card;
    }

    // ─── Утилиты ───

    function typeLabel(type) {
        const labels = { movie: 'Фильм', series: 'Сериал', cartoon: 'Мультфильм', anime: 'Аниме' };
        return labels[type] || type;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // Запуск
    init();

    return { openDetails, showHome, loadContinueWatching };
})();
