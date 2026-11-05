/**
 * app.js — Основная логика приложения Clean Cinema V2
 *
 * Управляет навигацией между экранами, поиском, отображением деталей,
 * названиями серий (TMDB), переключением балансеров (Collaps, Kodik, Rezka),
 * мгновенным запуском из «Продолжить просмотр» и автопереходом серий.
 */

const CinemaApp = (() => {
    // ─── DOM элементы ───
    const screenHome      = document.getElementById('screen-home');
    const screenDetails   = document.getElementById('screen-details');
    const searchInput     = document.getElementById('search-input');
    const searchClear     = document.getElementById('search-clear');
    const continueSection = document.getElementById('continue-section');
    const continueList    = document.getElementById('continue-list');
    const trendingSection = document.getElementById('trending-section');
    const trendingList    = document.getElementById('trending-list');
    const resultsSection  = document.getElementById('results-section');
    const resultsList     = document.getElementById('results-list');
    const emptyState      = document.getElementById('empty-state');
    const spinner         = document.getElementById('loading-spinner');

    const btnBack         = document.getElementById('btn-back');
    const detailsTitle    = document.getElementById('details-title');
    const detailsPoster   = document.getElementById('details-poster');
    const detailsYear     = document.getElementById('details-year');
    const detailsRating   = document.getElementById('details-rating');
    const detailsType     = document.getElementById('details-type');
    const detailsOrigTitle= document.getElementById('details-orig-title');
    const detailsDesc     = document.getElementById('details-description');
    const translatorsList = document.getElementById('translators-list');
    const seasonsSection  = document.getElementById('seasons-section');
    const seasonsList     = document.getElementById('seasons-list');
    const episodesSection = document.getElementById('episodes-section');
    const episodesList    = document.getElementById('episodes-list');
    const btnPlayMovie    = document.getElementById('btn-play-movie');

    // ─── Состояние ───
    let currentDetails     = null; // MediaDetails из API
    let selectedTranslator = null;
    let selectedSeason     = null;
    let selectedEpisode    = null;
    let searchTimeout      = null;
    let episodeNamesCache  = {};   // { [season]: { [episode]: "Title" } }
    let pendingResume      = null; // объект для мгновенного запуска из истории

    // ─── Инициализация ───

    function init() {
        // Автоматическое лечение: если в хранилище застрял неработающий балансер, сразу сбрасываем на collaps
        try {
            const savedBal = localStorage.getItem('cinema_preferred_balancer');
            if (savedBal && savedBal !== 'collaps') {
                localStorage.setItem('cinema_preferred_balancer', 'collaps');
            }
        } catch {}

        // Поиск с дебаунсом
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim();
            searchClear.classList.toggle('hidden', !q);
            clearTimeout(searchTimeout);
            if (q.length >= 2) {
                searchTimeout = setTimeout(() => doSearch(q), 350);
                if (trendingSection) trendingSection.classList.add('hidden');
            } else {
                resultsSection.classList.add('hidden');
                if (trendingList && trendingList.children.length > 0) trendingSection.classList.remove('hidden');
                emptyState.classList.toggle('hidden', continueList.children.length > 0 || (trendingList && trendingList.children.length > 0));
            }
        });

        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            searchClear.classList.add('hidden');
            resultsSection.classList.add('hidden');
            if (trendingList && trendingList.children.length > 0) trendingSection.classList.remove('hidden');
            emptyState.classList.toggle('hidden', continueList.children.length > 0 || (trendingList && trendingList.children.length > 0));
            searchInput.focus();
        });

        // Кнопка Назад (из деталей на главную)
        btnBack.addEventListener('click', showHome);

        // Кнопка «Смотреть» (для фильмов)
        btnPlayMovie.addEventListener('click', () => {
            if (selectedTranslator) {
                playStream();
            }
        });

        // События плеера
        window.addEventListener('player-closed', () => {
            loadContinueWatching();
            // Обновляем выделение серий на экране деталей
            if (currentDetails && currentDetails.type === 'series') {
                highlightWatchedEpisodes();
            }
        });

        // Переход на следующую серию
        window.addEventListener('episode-next', () => {
            playNextEpisode();
        });

        // Переход на предыдущую серию
        window.addEventListener('episode-prev', () => {
            playPrevEpisode();
        });

        // Переключение балансера из шторки ⚙️
        window.addEventListener('change-balancer', async (e) => {
            const newSource = e.detail?.source || 'collaps';
            const prevSource = CinemaPlayer.getActiveBalancer() || 'collaps';
            const ok = await playStream(newSource);
            if (!ok) {
                // Если не удалось загрузить — возвращаем кнопку на рабочий плеер!
                CinemaPlayer.setActiveBalancer(prevSource);
            } else {
                CinemaPlayer.setActiveBalancer(newSource);
            }
        });

        // Переключение озвучки Rezka из шторки ⚙️
        window.addEventListener('change-rezka-voice', async (e) => {
            const { translatorId, translatorName } = e.detail || {};
            selectedTranslator = { id: translatorId, name: translatorName, source: 'rezka', rezka_id: translatorId };
            await playStream('rezka');
        });

        // Загрузка популярных сериалов и истории
        loadTrendingSeries();
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
        if (trendingList && trendingList.children.length > 0 && (!searchInput.value.trim())) {
            trendingSection.classList.remove('hidden');
        }
    }

    async function loadTrendingSeries() {
        if (!trendingSection || !trendingList) return;
        try {
            const resp = await fetch('/api/trending');
            if (!resp.ok) return;
            const data = await resp.json();
            const items = data.results || [];
            if (items.length === 0) return;

            trendingList.innerHTML = '';
            for (const item of items) {
                const card = document.createElement('div');
                card.className = 'continue-card';
                card.innerHTML = `
                    <div class="continue-poster-wrap">
                        <img class="continue-poster" src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}" loading="lazy"
                             onerror="this.style.background='var(--bg-elevated)'">
                        ${item.rating ? `<span class="continue-rating">★ ${escapeHtml(item.rating)}</span>` : ''}
                    </div>
                    <div class="continue-card-info">
                        <div class="continue-card-title">${escapeHtml(item.title)}</div>
                        <div class="continue-card-sub">${escapeHtml(item.year)} · Сериал</div>
                    </div>
                `;
                card.addEventListener('click', () => {
                    openDetails(item.url);
                });
                trendingList.appendChild(card);
            }
            trendingSection.classList.remove('hidden');
            emptyState.classList.add('hidden');
        } catch (e) {
            console.warn('[Trending] failed to load:', e);
        }
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

    // ─── Клиентский фоллбэк на Collaps CDN (обход 410 / датацентров) ───

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

    // ─── Загрузка названий серий из TMDB ───

    async function loadEpisodeNames(tvId, season) {
        if (!tvId || !season) return;
        const cacheKey = `${tvId}_s${season}`;
        if (episodeNamesCache[cacheKey]) return episodeNamesCache[cacheKey];

        try {
            const resp = await fetch(`/api/episodes?tv_id=${encodeURIComponent(tvId)}&season=${season}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.episodes) {
                    episodeNamesCache[cacheKey] = data.episodes;
                    return data.episodes;
                }
            }
        } catch (e) {
            console.warn('[TMDB episodes] load failed:', e);
        }
        return {};
    }

    // ─── Детали фильма / сериала ───

    async function openDetails(url, autoPlayResume = false) {
        showDetails();
        spinner.classList.remove('hidden');

        try {
            const resp = await fetch(`/api/details?url=${encodeURIComponent(url)}`);
            const data = await resp.json();
            currentDetails = data;

            // Если пустые сезоны из-за 410 Render IP, парсим через клиентский браузер
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
                const saved = pendingResume || CinemaStorage.get(data.id);
                const savedTid = saved ? saved.translatorId : null;
                const savedTName = saved ? saved.translatorName : null;

                for (const t of data.translators) {
                    const chip = document.createElement('button');
                    chip.className = 'chip';
                    chip.textContent = t.name;
                    chip.dataset.id = t.id;

                    chip.addEventListener('click', () => selectTranslator(t));

                    const isMatch = (t.id === savedTid) || (savedTName && t.name.toLowerCase().includes(savedTName.toLowerCase()));
                    if (isMatch || (!savedTid && !savedTName && !selectedTranslator)) {
                        chip.classList.add('active');
                        selectedTranslator = t;
                    }

                    translatorsList.appendChild(chip);
                }
            }

            // Сезоны и серии
            if (data.type === 'series' && data.seasons && Object.keys(data.seasons).length > 0) {
                seasonsSection.classList.remove('hidden');
                episodesSection.classList.remove('hidden');
                btnPlayMovie.classList.add('hidden');

                await renderSeasons(data.seasons);
            } else {
                seasonsSection.classList.add('hidden');
                episodesSection.classList.add('hidden');
                btnPlayMovie.classList.remove('hidden');
            }

            // Мгновенный запуск при клике из «Продолжить просмотр»
            if (autoPlayResume && pendingResume) {
                const resumeTarget = pendingResume;
                pendingResume = null;
                if (resumeTarget.season) selectedSeason = resumeTarget.season;
                if (resumeTarget.episode) selectedEpisode = resumeTarget.episode;
                playStream();
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

    async function renderSeasons(seasons) {
        seasonsList.innerHTML = '';
        const keys = Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b));

        const saved = pendingResume || CinemaStorage.get(currentDetails.id);
        const savedSeason = saved ? saved.season : null;
        let firstSeason = savedSeason && keys.includes(String(savedSeason))
                        ? String(savedSeason)
                        : keys[0];

        for (const sKey of keys) {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = `Сезон ${sKey}`;
            chip.dataset.season = sKey;

            chip.addEventListener('click', async () => {
                selectedSeason = parseInt(sKey);
                seasonsList.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                await renderEpisodes(seasons[sKey]);
            });

            if (sKey === firstSeason) {
                chip.classList.add('active');
                selectedSeason = parseInt(sKey);
            }

            seasonsList.appendChild(chip);
        }

        if (firstSeason && seasons[firstSeason]) {
            await renderEpisodes(seasons[firstSeason]);
        }
    }

    async function renderEpisodes(episodes) {
        episodesList.innerHTML = '';
        const saved = pendingResume || CinemaStorage.get(currentDetails.id);
        const savedEp = saved ? saved.episode : null;

        // Предзагрузка названий серий из TMDB в фоне
        if (currentDetails && currentDetails.id) {
            loadEpisodeNames(currentDetails.id, selectedSeason);
        }

        for (const ep of episodes) {
            const btn = document.createElement('button');
            btn.className = 'episode-btn';
            btn.textContent = ep;
            btn.dataset.episode = ep;

            if (saved && saved.season == selectedSeason && saved.episode == ep) {
                btn.classList.add('active');
                selectedEpisode = ep;
            }

            btn.addEventListener('click', () => {
                selectedEpisode = ep;
                episodesList.querySelectorAll('.episode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                playStream();
            });

            episodesList.appendChild(btn);
        }

        highlightWatchedEpisodes();
    }

    function highlightWatchedEpisodes() {
        if (!currentDetails || !episodesList) return;
        const saved = CinemaStorage.get(currentDetails.id);
        if (!saved) return;

        episodesList.querySelectorAll('.episode-btn').forEach(btn => {
            const ep = parseInt(btn.dataset.episode);
            if (saved.season == selectedSeason && saved.episode == ep && saved.time > 10) {
                btn.classList.add('watched');
            }
        });
    }

    // ─── Запуск потока ───

    async function playStream(preferredSource = null) {
        if (!currentDetails) return;
        if (!selectedTranslator && currentDetails.translators?.length > 0) {
            selectedTranslator = currentDetails.translators[0];
        }

        spinner.classList.remove('hidden');

        // Определение источника (Collaps или Rezka)
        let source = preferredSource;
        if (!source) {
            if (selectedTranslator && (selectedTranslator.source === 'rezka' || String(selectedTranslator.id).startsWith('rezka_'))) {
                source = 'rezka';
            } else {
                source = localStorage.getItem('cinema_preferred_balancer') || 'collaps';
            }
        }

        try {
            let data = null;
            try {
                const tid = selectedTranslator ? (selectedTranslator.rezka_id ?? selectedTranslator.id) : 0;
                let url = `/api/stream?url=${encodeURIComponent(currentDetails.url)}&translator_id=${encodeURIComponent(tid)}&source=${source}`;
                if (selectedTranslator?.name) {
                    url += `&preferred_voice=${encodeURIComponent(selectedTranslator.name)}`;
                }
                if (currentDetails.type === 'series' && selectedSeason && selectedEpisode) {
                    url += `&season=${selectedSeason}&episode=${selectedEpisode}`;
                }

                const resp = await fetch(url);
                data = await resp.json();
            } catch (err) {
                console.warn('Backend stream request failed:', err);
            }

            // Фоллбэк на прямой клиентский парсинг Collaps при ошибках сервера / 410
            if (source === 'collaps' && (!data || data.error || !data.streams || Object.keys(data.streams).length === 0)) {
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

            // Железный авто-фоллбэк: если kodik или rezka не отдали поток, 
            // МГНОВЕННО переключаемся на надежный Collaps, чтобы видео ВСЕГДА играло!
            if (!data || data.error || !data.streams || Object.keys(data.streams).length === 0) {
                if (source !== 'collaps') {
                    console.warn(`[Balancer] Source '${source}' failed, auto-falling back to Collaps...`);
                    try { localStorage.setItem('cinema_preferred_balancer', 'collaps'); } catch {}
                    if (window.CinemaPlayer) CinemaPlayer.setActiveBalancer('collaps');
                    return await playStream('collaps');
                }
            }

            if (!data || data.error) {
                const errMsg = data?.error || 'Не удалось получить видеопоток';
                alert('Ошибка: ' + errMsg);
                return false;
            }

            if (!data.streams || Object.keys(data.streams).length === 0) {
                alert('Видеопотоки не найдены. Попробуйте другую озвучку.');
                return false;
            }

            // Получаем красивое название серии (если сериал)
            let epTitle = '';
            if (currentDetails.type === 'series' && selectedSeason && selectedEpisode) {
                const cacheKey = `${currentDetails.id}_s${selectedSeason}`;
                const eps = episodeNamesCache[cacheKey];
                if (eps && eps[String(selectedEpisode)]) {
                    epTitle = eps[String(selectedEpisode)].name || '';
                }
            }

            // Запуск плеера Clean Cinema V2
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
                episodeTitle: epTitle,
                translatorId: selectedTranslator ? (selectedTranslator.rezka_id ?? selectedTranslator.id) : 0,
                translatorName: selectedTranslator ? selectedTranslator.name : '',
                source: data.source || source,
            });
            return true;
        } catch (e) {
            console.error('Stream failed:', e);
            alert('Не удалось загрузить поток. Попробуйте позже.');
            return false;
        } finally {
            spinner.classList.add('hidden');
        }
    }

    // ─── Переключение серий (следующая / предыдущая) ───

    function playNextEpisode() {
        if (!currentDetails || !currentDetails.seasons || !selectedSeason || !selectedEpisode) return;

        const seasons = currentDetails.seasons;
        const sKey = String(selectedSeason);
        const episodes = seasons[sKey] || [];
        const idx = episodes.indexOf(selectedEpisode);

        if (idx >= 0 && idx < episodes.length - 1) {
            selectedEpisode = episodes[idx + 1];
            playStream();
        } else {
            // Переход на следующий сезон
            const sKeys = Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b));
            const sIdx = sKeys.indexOf(sKey);
            if (sIdx >= 0 && sIdx < sKeys.length - 1) {
                const nextSeason = sKeys[sIdx + 1];
                selectedSeason = parseInt(nextSeason);
                selectedEpisode = seasons[nextSeason][0] || 1;
                playStream();
            } else {
                alert('Сезон завершён 🎉');
            }
        }
    }

    function playPrevEpisode() {
        if (!currentDetails || !currentDetails.seasons || !selectedSeason || !selectedEpisode) return;

        const seasons = currentDetails.seasons;
        const sKey = String(selectedSeason);
        const episodes = seasons[sKey] || [];
        const idx = episodes.indexOf(selectedEpisode);

        if (idx > 0) {
            selectedEpisode = episodes[idx - 1];
            playStream();
        } else {
            // Переход на предыдущий сезон
            const sKeys = Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b));
            const sIdx = sKeys.indexOf(sKey);
            if (sIdx > 0) {
                const prevSeason = sKeys[sIdx - 1];
                selectedSeason = parseInt(prevSeason);
                const prevEps = seasons[prevSeason] || [];
                selectedEpisode = prevEps[prevEps.length - 1] || 1;
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

        // Клик по карточке — мгновенный запуск прямо на сохранённом моменте!
        card.addEventListener('click', (e) => {
            if (e.target.closest('.continue-card-delete')) return;
            if (item.filmUrl) {
                pendingResume = item;
                openDetails(item.filmUrl, true);
            }
        });

        // Кнопка удаления из истории
        const delBtn = card.querySelector('.continue-card-delete');
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            CinemaStorage.remove(item.filmId);
            card.remove();
            if (continueList.children.length === 0) {
                continueSection.classList.add('hidden');
                if (resultsSection.classList.contains('hidden')) {
                    emptyState.classList.remove('hidden');
                }
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

    init();

    return { openDetails, showHome, loadContinueWatching, playStream };
})();
