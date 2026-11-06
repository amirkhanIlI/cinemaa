/**
 * app.js — Основная логика приложения Clean Cinema V2
 *
 * Управляет навигацией между экранами, поиском, деталями, названиями серий (TMDB),
 * переключением балансеров (Collaps, Kodik, Rezka), «Продолжить просмотр»,
 * автопереходом серий и ПОЛНОЙ ОФЛАЙН-СИСТЕМОЙ (Скачивание в память браузера).
 */

const CinemaApp = (() => {
    // ─── DOM элементы ───
    const screenHome           = document.getElementById('screen-home');
    const screenDetails        = document.getElementById('screen-details');
    const screenDownloads      = document.getElementById('screen-downloads');
    const searchInput          = document.getElementById('search-input');
    const searchClear          = document.getElementById('search-clear');
    const continueSection      = document.getElementById('continue-section');
    const continueList         = document.getElementById('continue-list');
    const trendingSection      = document.getElementById('trending-section');
    const trendingList         = document.getElementById('trending-list');
    const resultsSection       = document.getElementById('results-section');
    const resultsList          = document.getElementById('results-list');
    const emptyState           = document.getElementById('empty-state');
    const spinner              = document.getElementById('loading-spinner');

    const btnBack              = document.getElementById('btn-back');
    const detailsTitle         = document.getElementById('details-title');
    const detailsPoster        = document.getElementById('details-poster');
    const detailsYear          = document.getElementById('details-year');
    const detailsRating        = document.getElementById('details-rating');
    const detailsType          = document.getElementById('details-type');
    const detailsOrigTitle     = document.getElementById('details-orig-title');
    const detailsDesc          = document.getElementById('details-description');
    const translatorsList      = document.getElementById('translators-list');
    const seasonsSection       = document.getElementById('seasons-section');
    const seasonsList          = document.getElementById('seasons-list');
    const episodesSection      = document.getElementById('episodes-section');
    const episodesList         = document.getElementById('episodes-list');
    const btnPlayMovie         = document.getElementById('btn-play-movie');
    const btnDownloadMovie     = document.getElementById('btn-download-movie');

    // Навигация (Bottom Bar) и Офлайн
    const navBtnHome           = document.getElementById('nav-btn-home');
    const navBtnDownloads      = document.getElementById('nav-btn-downloads');
    const navDownloadsBadge    = document.getElementById('nav-downloads-badge');
    const downloadsStorageSize = document.getElementById('downloads-storage-size');
    const activeDownloadsSection = document.getElementById('active-downloads-section');
    const activeDownloadsList  = document.getElementById('active-downloads-list');
    const savedDownloadsSection= document.getElementById('saved-downloads-section');
    const savedDownloadsList   = document.getElementById('saved-downloads-list');
    const downloadsEmpty       = document.getElementById('downloads-empty');
    const btnGotoCinema        = document.getElementById('btn-goto-cinema');

    // ─── Состояние ───
    let currentDetails     = null; // MediaDetails из API
    let selectedTranslator = null;
    let selectedSeason     = null;
    let selectedEpisode    = null;
    let searchTimeout      = null;
    let episodeNamesCache  = {};   // { [season]: { [episode]: "Title" } }
    let pendingResume      = null; // объект для мгновенного запуска из истории
    let activeTab          = 'home';

    // ─── Инициализация ───

    function init() {
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
        btnBack.addEventListener('click', () => switchTab('home'));

        // Кнопка «Смотреть» (для фильмов)
        btnPlayMovie.addEventListener('click', () => {
            if (selectedTranslator) {
                playStream();
            }
        });

        // Кнопка «Скачать фильм» (для фильмов)
        if (btnDownloadMovie) {
            btnDownloadMovie.addEventListener('click', () => {
                startMovieDownload();
            });
        }

        // Переключение табов нижней навигации
        if (navBtnHome) {
            navBtnHome.addEventListener('click', () => switchTab('home'));
        }
        if (navBtnDownloads) {
            navBtnDownloads.addEventListener('click', () => switchTab('downloads'));
        }
        if (btnGotoCinema) {
            btnGotoCinema.addEventListener('click', () => switchTab('home'));
        }

        // События офлайн-загрузок
        window.addEventListener('downloads-updated', () => {
            updateDownloadsBadge();
            if (activeTab === 'downloads') {
                renderDownloadsScreen();
            }
            updateEpisodeChipsStatus();
        });

        window.addEventListener('download-progress', (e) => {
            handleDownloadProgress(e.detail);
        });

        window.addEventListener('download-completed', (e) => {
            showToast(`Загрузка завершена: ${e.detail?.title || 'Серия'}`);
            updateDownloadsBadge();
            if (activeTab === 'downloads') renderDownloadsScreen();
            updateEpisodeChipsStatus();
        });

        window.addEventListener('download-error', (e) => {
            showToast(`Ошибка скачивания: ${e.detail?.error || 'Сбой'}`);
            updateEpisodeChipsStatus();
        });

        // Детекция офлайн-режима
        window.addEventListener('offline', () => {
            showToast('📡 Режим офлайн: доступно воспроизведение из «Скачанных»');
            if (activeTab !== 'downloads' && !document.body.classList.contains('player-active')) {
                switchTab('downloads');
            }
        });

        // События плеера
        window.addEventListener('player-closed', () => {
            loadContinueWatching();
            if (currentDetails && currentDetails.type === 'series') {
                highlightWatchedEpisodes();
                updateEpisodeChipsStatus();
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

            if (newSource === 'rezka') {
                selectedTranslator = { 
                    id: 'rezka_tvshows', 
                    name: 'TVShows (Проф. многоголосый)', 
                    source: 'rezka', 
                    rezka_id: 3,
                    rezka_voice: 'TVShows' 
                };
            }
            CinemaPlayer.setActiveBalancer(newSource);
            const ok = await playStream(newSource, newSource === 'rezka' ? 'TVShows' : null);
            if (!ok) {
                CinemaPlayer.setActiveBalancer(prevSource);
            }
        });

        // Переключение озвучки Rezka из шторки ⚙️
        window.addEventListener('change-rezka-voice', async (e) => {
            const { translatorId, translatorName } = e.detail || {};
            const voiceShort = translatorName.split('(')[0].trim();
            selectedTranslator = { 
                id: translatorId, 
                name: translatorName, 
                source: 'rezka', 
                rezka_id: translatorId,
                rezka_voice: voiceShort 
            };
            localStorage.setItem('cinema_preferred_balancer', 'rezka');
            await playStream('rezka', voiceShort);
        });

        // Загрузка популярных сериалов, истории и бейджа скачанных
        loadTrendingSeries();
        CinemaStorage.syncWithServer().then(() => {
            loadContinueWatching();
        });
        updateDownloadsBadge();

        // PWA Service Worker с областью видимости scope: / для 100% офлайн-просмотра
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js', { scope: '/' })
                .then(reg => {
                    console.log('[SW] Root service worker registered with scope:', reg.scope);
                    reg.update();
                })
                .catch(err => {
                    console.warn('[SW] Root SW registration failed, trying /static/sw.js:', err);
                    navigator.serviceWorker.register('/static/sw.js', { scope: '/' }).catch(() => {});
                });
        }
    }

    // ─── Навигация по табам ───

    function switchTab(tab) {
        activeTab = tab;
        if (tab === 'home') {
            if (navBtnHome) navBtnHome.classList.add('active');
            if (navBtnDownloads) navBtnDownloads.classList.remove('active');
            if (screenDownloads) screenDownloads.classList.remove('active');

            if (currentDetails) {
                document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
                screenDetails.classList.add('active');
            } else {
                showHome();
            }
        } else if (tab === 'downloads') {
            if (navBtnDownloads) navBtnDownloads.classList.add('active');
            if (navBtnHome) navBtnHome.classList.remove('active');
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            if (screenDownloads) screenDownloads.classList.add('active');
            renderDownloadsScreen();
        }
    }

    function showHome() {
        activeTab = 'home';
        currentDetails = null;
        if (navBtnHome) navBtnHome.classList.add('active');
        if (navBtnDownloads) navBtnDownloads.classList.remove('active');
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
                            data.seasons = data.seasons || {};
                            for (const s of sList) {
                                const sNum = String(s.season);
                                const eps = (s.episodes || [])
                                    .map(e => parseInt(e.episode))
                                    .filter(e => !isNaN(e));
                                if (eps.length > 0) {
                                    data.seasons[sNum] = eps.sort((a, b) => a - b);
                                }
                            }

                            // Сохраняем уже существующие озвучки из Rezka (TVShows, LostFilm и др.)
                            const existingTranslators = data.translators || [];
                            const existingNames = new Set(existingTranslators.map(t => t.name.toLowerCase()));

                            if (sList[0]?.episodes?.[0]?.audio?.names) {
                                const names = sList[0].episodes[0].audio.names || [];
                                names.forEach((name, idx) => {
                                    if (!existingNames.has(name.toLowerCase())) {
                                        existingTranslators.push({ id: idx, name: name, source: 'collaps' });
                                        existingNames.add(name.toLowerCase());
                                    }
                                });
                            }
                            data.translators = existingTranslators;
                        } catch (e) {
                            console.warn('[Collaps Client] failed to parse seasons JSON:', e);
                        }
                    }
                    break;
                }
            }
        }
    }

    async function fetchClientSideStream(imdbId, type, season = null, episode = null, voiceName = null) {
        try {
            const html = await fetchCollapsHtml(imdbId);
            if (!html) return null;

            let hlsPath = null;
            let audioNames = [];

            if (type === 'series') {
                for (const line of html.split('\n')) {
                    if (line.includes('seasons:[{') || line.includes('seasons: [{')) {
                        const m = line.match(/seasons\s*:\s*(\[\s*\{.*\}\s*\])/);
                        if (m) {
                            const sList = JSON.parse(m[1]);
                            const sObj = sList.find(s => s.season == season) || sList[0];
                            if (sObj && sObj.episodes) {
                                const epObj = sObj.episodes.find(e => e.episode == episode) || sObj.episodes[0];
                                if (epObj) {
                                    hlsPath = epObj.hls;
                                    audioNames = epObj.audio?.names || [];
                                }
                            }
                        }
                        break;
                    }
                }
            } else {
                const hlsMatch = html.match(/hls\s*:\s*['"]([^'"]+)['"]/);
                if (hlsMatch) hlsPath = hlsMatch[1];
                const audMatch = html.match(/audio\s*:\s*(\{.*?\})\s*,\s*subtitles/s);
                if (audMatch) {
                    try {
                        const aud = JSON.parse(audMatch[1]);
                        audioNames = aud.names || [];
                    } catch {}
                }
            }

            if (!hlsPath) return null;

            let hostMatch = html.match(/masterHost\s*:\s*['"]([^'"]+)['"]/);
            let host = hostMatch ? hostMatch[1] : 'stream.voidboost.cc';
            if (host.startsWith('http://') || host.startsWith('https://')) {
                try { host = new URL(host).host; } catch {}
            }
            if (!host) host = 'stream.voidboost.cc';

            let baseHls = hlsPath.startsWith('http') ? hlsPath : `https://${host}${hlsPath}`;

            const tokenMatch = html.match(/makeToken\s*=\s*['"]([^'"]+)['"]/);
            if (tokenMatch) {
                baseHls += (baseHls.includes('?') ? '&' : '?') + tokenMatch[1];
            }

            const streams = {
                'Auto (1080p/720p)': baseHls,
                '1080p': baseHls,
                '720p': baseHls,
                '480p': baseHls,
                '360p': baseHls,
            };

            let selIdx = 0;
            if (voiceName && audioNames.length > 0) {
                const found = audioNames.findIndex(n => n.toLowerCase().includes(voiceName.toLowerCase()));
                if (found !== -1) selIdx = found;
            }

            return {
                streams,
                hls_url: baseHls,
                audio_tracks: audioNames,
                selected_audio_index: selIdx,
                source: 'collaps',
            };
        } catch (e) {
            console.error('[Collaps Client] fetch error:', e);
            return null;
        }
    }

    // ─── Загрузка деталей и названий серий TMDB ───

    async function loadEpisodeNames(filmId, season) {
        const cacheKey = `${filmId}_s${season}`;
        if (episodeNamesCache[cacheKey]) return;

        try {
            const resp = await fetch(`/api/episodes?tv_id=${encodeURIComponent(filmId)}&season=${encodeURIComponent(season)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.episodes) {
                episodeNamesCache[cacheKey] = data.episodes;
            }
        } catch (e) {
            console.warn('[TMDB] failed to fetch episode names:', e);
        }
    }

    async function openDetails(url, autoPlay = false) {
        spinner.classList.remove('hidden');
        try {
            const resp = await fetch(`/api/details?url=${encodeURIComponent(url)}`);
            const data = await resp.json();
            currentDetails = data;

            activeTab = 'home';
            if (navBtnHome) navBtnHome.classList.add('active');
            if (navBtnDownloads) navBtnDownloads.classList.remove('active');

            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            screenDetails.classList.add('active');

            if (data.type === 'series' && (!data.seasons || Object.keys(data.seasons).length === 0)) {
                await enrichDetailsClientSide(data);
            }

            await renderDetails(data);

            if (autoPlay && pendingResume) {
                await playStream();
            }
        } catch (e) {
            console.error('Details fetch error:', e);
            alert('Не удалось загрузить данные фильма');
        } finally {
            spinner.classList.add('hidden');
        }
    }

    async function renderDetails(data) {
        detailsTitle.textContent = data.title || '';
        detailsPoster.src = data.poster_url || '';
        detailsYear.textContent = data.year || '';
        detailsRating.textContent = data.rating ? `★ ${data.rating}` : '';
        detailsType.textContent = typeLabel(data.type);
        detailsOrigTitle.textContent = data.original_title || '';
        detailsDesc.textContent = data.description || '';

        // Приоритетная сортировка: TVShows и LostFilm первыми!
        if (data.translators && data.translators.length > 0) {
            data.translators.sort((a, b) => {
                const aName = (a.name || '').toLowerCase();
                const bName = (b.name || '').toLowerCase();
                const aScore = aName.includes('tvshows') ? 0 : (aName.includes('lostfilm') ? 1 : 2);
                const bScore = bName.includes('tvshows') ? 0 : (bName.includes('lostfilm') ? 1 : 2);
                return aScore - bScore;
            });
        }

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
                let displayName = t.name;
                const lower = (t.name || '').toLowerCase();
                if (lower.includes('18+') || lower.includes('без цензуры') || lower.includes('с матом') || lower.includes('нецензур')) {
                    if (lower.includes('rezka')) displayName = 'HDrezka (18+ с матом)';
                } else if (lower.includes('rezka')) {
                    displayName = 'HDrezka (без мата)';
                }
                chip.textContent = displayName;
                chip.dataset.id = t.id;

                chip.addEventListener('click', () => selectTranslator(t));

                const isMatch = (t.id === savedTid) || (savedTName && t.name.toLowerCase().includes(savedTName.toLowerCase()));
                if (isMatch || (!savedTid && !savedTName && !selectedTranslator)) {
                    chip.classList.add('active');
                    selectedTranslator = t;
                }

                translatorsList.appendChild(chip);
            }

            if (!selectedTranslator && data.translators.length > 0) {
                selectedTranslator = data.translators[0];
                translatorsList.children[0]?.classList.add('active');
            }
        }

        // Сезоны и серии
        if (data.type === 'series' && data.seasons && Object.keys(data.seasons).length > 0) {
            seasonsSection.classList.remove('hidden');
            episodesSection.classList.remove('hidden');
            btnPlayMovie.classList.add('hidden');
            if (btnDownloadMovie) btnDownloadMovie.classList.add('hidden');

            await renderSeasons(data.seasons);
        } else {
            seasonsSection.classList.add('hidden');
            episodesSection.classList.add('hidden');
            btnPlayMovie.classList.remove('hidden');
            if (btnDownloadMovie) {
                btnDownloadMovie.classList.remove('hidden');
                const dlId = `${data.id}_movie`;
                const isDl = await OfflineManager.isDownloaded(dlId);
                const dlTxt = document.getElementById('btn-download-movie-text');
                if (dlTxt) dlTxt.textContent = isDl ? '✓ Скачано офлайн' : 'Скачать фильм';
            }
        }
    }

    function selectTranslator(t) {
        selectedTranslator = t;
        translatorsList.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        const chip = translatorsList.querySelector(`.chip[data-id="${t.id}"]`);
        if (chip) chip.classList.add('active');
        updateEpisodeChipsStatus();
    }

    async function renderSeasons(seasons) {
        seasonsList.innerHTML = '';
        const seasonKeys = Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b));
        if (seasonKeys.length === 0) return;

        const saved = pendingResume || CinemaStorage.get(currentDetails.id);
        const savedSeason = saved ? String(saved.season) : seasonKeys[0];

        selectedSeason = parseInt(savedSeason) || parseInt(seasonKeys[0]);

        for (const s of seasonKeys) {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = `${s} сезон`;
            chip.dataset.season = s;

            if (s === String(selectedSeason)) {
                chip.classList.add('active');
            }

            chip.addEventListener('click', async () => {
                selectedSeason = parseInt(s);
                seasonsList.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                await renderEpisodes(seasons[s]);
            });

            seasonsList.appendChild(chip);
        }

        const activeKey = String(selectedSeason);
        if (seasons[activeKey]) {
            await renderEpisodes(seasons[activeKey]);
        } else {
            const firstSeason = seasonKeys[0];
            selectedSeason = parseInt(firstSeason);
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
            const chip = document.createElement('div');
            chip.className = 'episode-chip';
            chip.dataset.episode = ep;

            if (saved && saved.season == selectedSeason && saved.episode == ep) {
                chip.classList.add('active');
                selectedEpisode = ep;
            }

            // Зона нажатия для воспроизведения
            const playZone = document.createElement('div');
            playZone.className = 'ep-play-zone';
            playZone.textContent = ep;
            playZone.addEventListener('click', () => {
                selectedEpisode = ep;
                episodesList.querySelectorAll('.episode-chip').forEach(b => b.classList.remove('active'));
                chip.classList.add('active');
                playStream();
            });

            // Зона нажатия для скачивания (офлайн)
            const dlZone = document.createElement('div');
            dlZone.className = 'ep-dl-zone';
            dlZone.dataset.episode = ep;
            dlZone.title = 'Скачать серию офлайн';
            dlZone.innerHTML = '📥';

            const dlId = `${currentDetails.id}_s${selectedSeason}_e${ep}`;
            const isDl = await OfflineManager.isDownloaded(dlId);
            const isDling = OfflineManager.isDownloading(dlId);

            if (isDl) {
                chip.classList.add('downloaded');
                dlZone.classList.add('downloaded');
                dlZone.innerHTML = '✓';
                dlZone.title = 'Скачано офлайн';
            } else if (isDling) {
                dlZone.classList.add('downloading');
                const prog = OfflineManager.getActiveProgress(dlId);
                dlZone.innerHTML = `${prog || 0}%`;
                dlZone.title = 'Скачивается...';
            }

            dlZone.addEventListener('click', async (e) => {
                e.stopPropagation();
                const downloaded = await OfflineManager.isDownloaded(dlId);
                if (downloaded) {
                    if (confirm(`Серия ${ep} уже скачана для офлайн-просмотра. Открыть скачанные?`)) {
                        switchTab('downloads');
                    }
                    return;
                }
                if (OfflineManager.isDownloading(dlId)) {
                    if (confirm(`Отменить скачивание ${ep} серии?`)) {
                        OfflineManager.cancelDownload(dlId);
                    }
                    return;
                }
                startEpisodeDownload(ep);
            });

            chip.appendChild(playZone);
            chip.appendChild(dlZone);
            episodesList.appendChild(chip);
        }

        highlightWatchedEpisodes();
    }

    function highlightWatchedEpisodes() {
        if (!currentDetails || !episodesList) return;
        const saved = CinemaStorage.get(currentDetails.id);
        if (!saved) return;

        episodesList.querySelectorAll('.episode-chip').forEach(chip => {
            const ep = parseInt(chip.dataset.episode);
            if (saved.season == selectedSeason && saved.episode == ep && saved.time > 10) {
                chip.classList.add('watched');
            }
        });
    }

    async function updateEpisodeChipsStatus() {
        if (!currentDetails || !episodesList || currentDetails.type !== 'series') return;
        const s = selectedSeason;
        const chips = episodesList.querySelectorAll('.episode-chip');
        for (const chip of chips) {
            const ep = chip.dataset.episode;
            const dlId = `${currentDetails.id}_s${s}_e${ep}`;
            const isDl = await OfflineManager.isDownloaded(dlId);
            const isDling = OfflineManager.isDownloading(dlId);
            const dlZone = chip.querySelector('.ep-dl-zone');
            if (!dlZone) continue;

            if (isDl) {
                chip.classList.add('downloaded');
                dlZone.className = 'ep-dl-zone downloaded';
                dlZone.textContent = '✓';
                dlZone.title = 'Скачано офлайн';
            } else if (isDling) {
                chip.classList.remove('downloaded');
                dlZone.className = 'ep-dl-zone downloading';
                const prog = OfflineManager.getActiveProgress(dlId);
                dlZone.textContent = `${prog || 0}%`;
                dlZone.title = 'Скачивается...';
            } else {
                chip.classList.remove('downloaded');
                dlZone.className = 'ep-dl-zone';
                dlZone.textContent = '📥';
                dlZone.title = 'Скачать серию офлайн';
            }
        }
    }

    // ─── Запуск загрузки серии или фильма (Офлайн) ───

    async function startEpisodeDownload(ep) {
        if (!currentDetails) return;
        const s = selectedSeason;
        const e = ep;
        const dlId = `${currentDetails.id}_s${s}_e${e}`;

        const chip = episodesList.querySelector(`.episode-chip[data-episode="${e}"]`);
        const dlZone = chip?.querySelector('.ep-dl-zone');
        if (dlZone) {
            dlZone.className = 'ep-dl-zone downloading';
            dlZone.textContent = '⏳';
        }

        let epTitle = `Серия ${e}`;
        const cacheKey = `${currentDetails.id}_s${s}`;
        const eps = episodeNamesCache[cacheKey];
        if (eps && eps[String(e)]) {
            epTitle = eps[String(e)].name || epTitle;
        }

        let source = 'collaps';
        let voiceName = 'TVShows';
        let tid = 0;
        if (selectedTranslator) {
            if (selectedTranslator.source === 'rezka' || String(selectedTranslator.id).startsWith('rezka_')) {
                source = 'rezka';
                voiceName = selectedTranslator.rezka_voice || selectedTranslator.name || 'TVShows';
                tid = selectedTranslator.rezka_id ?? 0;
            } else {
                source = localStorage.getItem('cinema_preferred_balancer') || 'collaps';
                voiceName = selectedTranslator.name || '';
                tid = selectedTranslator.id;
            }
        }

        showToast(`Запуск загрузки: ${currentDetails.title} (S${s}E${e})...`);

        try {
            let streamUrl = '';
            let url = `/api/stream?url=${encodeURIComponent(currentDetails.url)}&translator_id=${encodeURIComponent(tid)}&source=${source}&season=${s}&episode=${e}`;
            if (voiceName) {
                url += `&preferred_voice=${encodeURIComponent(voiceName)}`;
            }

            try {
                const resp = await fetch(url);
                const data = await resp.json();
                if (data && data.hls_url) {
                    streamUrl = data.hls_url;
                }
            } catch (netErr) {
                console.warn('[Offline] Backend stream fetch failed:', netErr);
            }

            if (!streamUrl && currentDetails.imdb_id) {
                const clientStream = await fetchClientSideStream(currentDetails.imdb_id, currentDetails.type, s, e, voiceName);
                if (clientStream && clientStream.hls_url) {
                    streamUrl = clientStream.hls_url;
                }
            }

            if (!streamUrl) {
                alert(`Не удалось получить видеопоток для скачивания серии ${e}`);
                if (dlZone) {
                    dlZone.className = 'ep-dl-zone';
                    dlZone.textContent = '📥';
                }
                return;
            }

            OfflineManager.startDownload({
                filmId: currentDetails.id,
                filmUrl: currentDetails.url,
                title: currentDetails.title,
                poster: currentDetails.poster_url,
                type: 'series',
                season: s,
                episode: e,
                episodeTitle: epTitle,
                voiceName,
                streamUrl,
            });

            updateDownloadsBadge();
        } catch (err) {
            console.error('[Offline] Episode download error:', err);
            alert(`Ошибка при начале загрузки: ${err.message}`);
            if (dlZone) {
                dlZone.className = 'ep-dl-zone';
                dlZone.textContent = '📥';
            }
        }
    }

    async function startMovieDownload() {
        if (!currentDetails) return;
        const dlId = `${currentDetails.id}_movie`;
        const isDl = await OfflineManager.isDownloaded(dlId);
        if (isDl) {
            if (confirm(`Фильм «${currentDetails.title}» уже скачан. Открыть вкладку скачанных?`)) {
                switchTab('downloads');
            }
            return;
        }

        const btnTxt = document.getElementById('btn-download-movie-text');
        if (btnTxt) btnTxt.textContent = '⏳ Запуск загрузки...';

        let source = 'collaps';
        let voiceName = selectedTranslator?.name || '';
        let tid = selectedTranslator ? selectedTranslator.id : 0;

        try {
            let streamUrl = '';
            let url = `/api/stream?url=${encodeURIComponent(currentDetails.url)}&translator_id=${encodeURIComponent(tid)}&source=${source}`;
            if (voiceName) url += `&preferred_voice=${encodeURIComponent(voiceName)}`;

            try {
                const resp = await fetch(url);
                const data = await resp.json();
                if (data && data.hls_url) {
                    streamUrl = data.hls_url;
                }
            } catch (netErr) {
                console.warn('[Offline] Backend stream fetch failed:', netErr);
            }

            if (!streamUrl && currentDetails.imdb_id) {
                const clientStream = await fetchClientSideStream(currentDetails.imdb_id, 'movie', null, null, voiceName);
                if (clientStream && clientStream.hls_url) {
                    streamUrl = clientStream.hls_url;
                }
            }

            if (!streamUrl) {
                alert('Не удалось получить видеопоток фильма для скачивания');
                if (btnTxt) btnTxt.textContent = 'Скачать фильм';
                return;
            }

            OfflineManager.startDownload({
                filmId: currentDetails.id,
                filmUrl: currentDetails.url,
                title: currentDetails.title,
                poster: currentDetails.poster_url,
                type: 'movie',
                episodeTitle: 'Полный фильм',
                voiceName,
                streamUrl,
            });

            showToast(`Загрузка фильма «${currentDetails.title}» началась`);
            updateDownloadsBadge();
        } catch (err) {
            alert(`Ошибка: ${err.message}`);
            if (btnTxt) btnTxt.textContent = 'Скачать фильм';
        }
    }

    function handleDownloadProgress(detail) {
        // Обновляем бейдж на чипе серии
        if (currentDetails && episodesList && currentDetails.type === 'series') {
            const chip = episodesList.querySelector(`.episode-chip[data-episode="${detail.episode}"]`);
            const dlZone = chip?.querySelector('.ep-dl-zone');
            if (dlZone) {
                dlZone.textContent = `${detail.progress}%`;
            }
        }

        // Обновляем прогресс-бар на экране скачанных
        if (activeTab === 'downloads') {
            const card = document.getElementById(`dl-task-${detail.id}`);
            if (card) {
                const bar = card.querySelector('.progress-bar-fill');
                const status = card.querySelector('.dl-status-text');
                const size = card.querySelector('.dl-size-text');
                if (bar) bar.style.width = `${detail.progress}%`;
                if (status) status.textContent = `Загрузка... ${detail.progress}%`;
                if (size) size.textContent = detail.formattedSize;
            }
        }
    }

    // ─── Отображение экрана «Скачанные» ───

    async function renderDownloadsScreen() {
        if (!screenDownloads) return;

        // 1. Активные задачи
        const activeTasks = OfflineManager.getActiveDownloads();
        if (activeTasks.length > 0) {
            activeDownloadsSection.classList.remove('hidden');
            activeDownloadsList.innerHTML = '';
            for (const t of activeTasks) {
                const card = document.createElement('div');
                card.className = 'download-active-card';
                card.id = `dl-task-${t.id}`;
                const sub = t.type === 'series'
                    ? `${t.season} сезон · ${t.episode} серия ${t.episodeTitle ? '· ' + t.episodeTitle : ''}`
                    : 'Фильм';
                card.innerHTML = `
                    <div class="download-active-row">
                        <div class="download-active-info">
                            <div class="download-active-title">${escapeHtml(t.title)}</div>
                            <div class="download-active-subtitle">${escapeHtml(sub)} (${escapeHtml(t.voiceName || 'Озвучка')})</div>
                        </div>
                        <button class="btn-cancel-dl" title="Отменить загрузку">✕</button>
                    </div>
                    <div class="progress-bar-wrap">
                        <div class="progress-bar-fill" style="width: ${t.progress || 0}%"></div>
                    </div>
                    <div class="progress-meta">
                        <span class="dl-status-text">Загрузка... ${t.progress || 0}%</span>
                        <span class="dl-size-text">${OfflineManager.formatBytes(t.downloadedBytes)}</span>
                    </div>
                `;
                card.querySelector('.btn-cancel-dl').addEventListener('click', () => {
                    OfflineManager.cancelDownload(t.id);
                });
                activeDownloadsList.appendChild(card);
            }
        } else {
            activeDownloadsSection.classList.add('hidden');
            activeDownloadsList.innerHTML = '';
        }

        // 2. Готовые сохранённые серии и фильмы
        const items = await OfflineManager.getAll();
        items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

        if (items.length === 0 && activeTasks.length === 0) {
            downloadsEmpty.classList.remove('hidden');
            savedDownloadsSection.classList.add('hidden');
            savedDownloadsList.innerHTML = '';
        } else {
            downloadsEmpty.classList.add('hidden');
            savedDownloadsSection.classList.remove('hidden');
            savedDownloadsList.innerHTML = '';

            for (const item of items) {
                const card = document.createElement('div');
                card.className = 'download-card';
                const sub = item.type === 'series'
                    ? `${item.season} сезон · ${item.episode} серия ${item.episodeTitle ? '· ' + item.episodeTitle : ''}`
                    : 'Фильм';

                card.innerHTML = `
                    <img class="download-card-poster" src="${escapeHtml(item.poster || '/static/icons/icon-192.png')}" alt="Постер">
                    <div class="download-card-info">
                        <div class="download-card-title">${escapeHtml(item.title)}</div>
                        <div class="download-card-ep">${escapeHtml(sub)}</div>
                        <div class="download-card-meta">
                            <span class="badge-offline-ready">● Офлайн доступно</span>
                            <span>·</span>
                            <span>${escapeHtml(item.formattedSize || '0 МБ')}</span>
                            ${item.voiceName ? `<span>·</span><span>${escapeHtml(item.voiceName)}</span>` : ''}
                        </div>
                    </div>
                    <button class="btn-delete-dl" title="Удалить из памяти" aria-label="Удалить">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                `;

                // Клик по карточке — запуск видео офлайн без интернета
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.btn-delete-dl')) return;
                    playOfflineItem(item);
                });

                // Клик по корзине — удаление из памяти
                card.querySelector('.btn-delete-dl').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm(`Удалить «${item.title} (${sub})» из скачанных?`)) {
                        await OfflineManager.remove(item.id);
                        renderDownloadsScreen();
                        updateDownloadsBadge();
                        showToast('Удалено из памяти');
                    }
                });

                savedDownloadsList.appendChild(card);
            }
        }

        // 3. Общий объём занятой памяти
        const totalSize = await OfflineManager.getTotalStorageSize();
        if (downloadsStorageSize) {
            downloadsStorageSize.textContent = totalSize;
        }
    }

    function playOfflineItem(item) {
        CinemaPlayer.open({
            streams: {
                'Офлайн (локально)': item.offlineUrl,
            },
            hls_url: item.offlineUrl,
            filmId: item.filmId,
            filmUrl: item.filmUrl || '',
            title: item.title,
            poster: item.poster,
            type: item.type,
            season: item.season,
            episode: item.episode,
            episodeTitle: item.episodeTitle || '',
            translatorName: item.voiceName || 'Офлайн',
            source: 'offline',
        });
    }

    async function updateDownloadsBadge() {
        try {
            const items = await OfflineManager.getAll();
            const active = OfflineManager.getActiveDownloads();
            const count = items.length + active.length;

            if (navDownloadsBadge) {
                if (count > 0) {
                    navDownloadsBadge.textContent = count;
                    navDownloadsBadge.classList.remove('hidden');
                } else {
                    navDownloadsBadge.classList.add('hidden');
                }
            }

            const totalSize = await OfflineManager.getTotalStorageSize();
            if (downloadsStorageSize) {
                downloadsStorageSize.textContent = totalSize;
            }
        } catch (e) {
            console.warn('updateDownloadsBadge error:', e);
        }
    }

    // ─── Запуск потока (Онлайн или Офлайн) ───

    async function playStream(preferredSource = null, explicitVoice = null) {
        if (!currentDetails) return;
        if (!selectedTranslator && currentDetails.translators?.length > 0) {
            selectedTranslator = currentDetails.translators[0];
        }

        // 1. Проверяем, скачана ли уже эта серия/фильм локально
        const dlId = currentDetails.type === 'series'
            ? `${currentDetails.id}_s${selectedSeason}_e${selectedEpisode}`
            : `${currentDetails.id}_movie`;

        const offlineItem = await OfflineManager.get(dlId);
        if (offlineItem) {
            console.log('[Clean Cinema] Запуск из офлайн-памяти:', dlId);
            playOfflineItem(offlineItem);
            return true;
        }

        // Если сети нет, а серия не скачана
        if (!navigator.onLine) {
            alert('Нет подключения к интернету. Эта серия не была скачана. Перейдите во вкладку «Скачанные», чтобы смотреть сохранённые серии.');
            switchTab('downloads');
            return false;
        }

        spinner.classList.remove('hidden');

        let source = preferredSource;
        if (!source) {
            if (selectedTranslator && (selectedTranslator.source === 'rezka' || String(selectedTranslator.id).startsWith('rezka_'))) {
                source = 'rezka';
            } else {
                source = localStorage.getItem('cinema_preferred_balancer') || 'collaps';
            }
        }

        let voiceName = explicitVoice || selectedTranslator?.rezka_voice || selectedTranslator?.name || '';
        if (source === 'rezka') {
            const isCollapsOnly = voiceName.includes('Novamedia') || voiceName.includes('JASKIER') || voiceName.includes('Дубляж') || voiceName.includes('Eng.Original');
            if (!voiceName || isCollapsOnly) {
                voiceName = 'TVShows';
            }
        }

        try {
            let data = null;
            try {
                const tid = selectedTranslator ? (selectedTranslator.rezka_id ?? selectedTranslator.id) : 0;
                let url = `/api/stream?url=${encodeURIComponent(currentDetails.url)}&translator_id=${encodeURIComponent(tid)}&source=${source}`;
                if (voiceName) {
                    url += `&preferred_voice=${encodeURIComponent(voiceName)}`;
                }
                if (currentDetails.type === 'series' && selectedSeason && selectedEpisode) {
                    url += `&season=${selectedSeason}&episode=${selectedEpisode}`;
                }

                const resp = await fetch(url);
                data = await resp.json();
            } catch (err) {
                console.warn('Backend stream request failed:', err);
            }

            // Фоллбэк на клиентский плеер при ЛЮБЫХ ошибках сервера (410, 503, блокировки датацентров)
            if (!data || data.error || !data.streams || Object.keys(data.streams).length === 0) {
                if (currentDetails.imdb_id) {
                    console.log('[Clean Cinema] Backend stream unavailable, extracting direct client-side stream...');
                    const clientStream = await fetchClientSideStream(
                        currentDetails.imdb_id,
                        currentDetails.type,
                        selectedSeason,
                        selectedEpisode,
                        voiceName
                    );
                    if (clientStream && clientStream.streams && Object.keys(clientStream.streams).length > 0) {
                        data = clientStream;
                        showToast('Запущен видеопоток через прямой плеер');
                    }
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

            // Название серии из TMDB
            let epTitle = '';
            if (currentDetails.type === 'series' && selectedSeason && selectedEpisode) {
                const cacheKey = `${currentDetails.id}_s${selectedSeason}`;
                const eps = episodeNamesCache[cacheKey];
                if (eps && eps[String(selectedEpisode)]) {
                    epTitle = eps[String(selectedEpisode)].name || '';
                }
            }

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
                episodeTitle: epTitle,
                translatorId: (data.selected_audio_index !== undefined) ? data.selected_audio_index : (selectedTranslator ? (selectedTranslator.rezka_id ?? selectedTranslator.id) : 0),
                translatorName: (data.source === 'rezka' && voiceName) ? voiceName : (selectedTranslator ? selectedTranslator.name : ''),
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

    // ─── Переключение серий ───

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

        card.addEventListener('click', (e) => {
            if (e.target.closest('.continue-card-delete')) return;
            if (item.filmUrl) {
                pendingResume = item;
                openDetails(item.filmUrl, true);
            }
        });

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

    // ─── Всплывающие уведомления (Toast) ───

    function showToast(msg) {
        let t = document.getElementById('cinema-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'cinema-toast';
            t.className = 'cinema-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('visible');
        clearTimeout(t._timer);
        t._timer = setTimeout(() => t.classList.remove('visible'), 2800);
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

    return { openDetails, showHome, switchTab, loadContinueWatching, playStream };
})();
