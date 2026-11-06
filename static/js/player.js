/**
 * player.js — Полноэкранный видеоплеер Clean Cinema V2 (Mobile-First / iOS HIG)
 *
 * Фичи:
 * - HLS.js без ограничения 720p (capLevelToPlayerSize: false, честный 1080p).
 * - Шторка настроек (⚙️ iOS Bottom Sheet):
 *     * Выбор озвучки
 *     * Выбор качества (Авто, 1080p, 720p, 480p, 360p) с авто-запоминанием
 *     * Скорость (0.75x, 1x, 1.25x, 1.5x, 2x) с сохранением pitch
 *     * Источник / Балансер (Collaps, Kodik, Rezka)
 *     * Масштаб (Вписать / Заполнить)
 *     * Картинка в картинке (PiP / iOS webkitSetPresentationMode)
 *     * Таймер сна (15м, 30м, 45м, Конец серии)
 * - Автопереход: плавающая кнопка «Следующая серия (10с) ▶» за 10с до конца.
 * - Автоматический переход на след. серию при завершении видео.
 * - Кнопки ⏮/⏭ (Предыдущая/Следующая серия) с безопасным отступом от прогресс-бара.
 * - Двойной тап: ±10с с красивой анимацией.
 * - Полное сохранение прогресса в localStorage + sendBeacon.
 */

const CinemaPlayer = (() => {
    // ─── DOM элементы ───
    const screen             = document.getElementById('screen-player');
    const container          = document.getElementById('player-container');
    const video              = document.getElementById('video-player');
    const overlay            = document.getElementById('player-overlay');
    const btnBack            = document.getElementById('btn-player-back');
    const btnPlayPause       = document.getElementById('btn-play-pause');
    const iconPlay           = document.getElementById('icon-play');
    const iconPause          = document.getElementById('icon-pause');
    const btnPrevEp          = document.getElementById('btn-prev-ep');
    const btnNextEp          = document.getElementById('btn-next-ep');
    const btnNativePlayer    = document.getElementById('btn-native-player');
    const btnSettings        = document.getElementById('btn-settings');
    const btnFullscreen      = document.getElementById('btn-fullscreen');
    const timeCurrent        = document.getElementById('player-time-current');
    const timeDuration       = document.getElementById('player-time-duration');
    const progressBar        = document.getElementById('player-progress-bar');
    const progressPlayed     = document.getElementById('player-progress-played');
    const progressBuffered   = document.getElementById('player-progress-buffered');
    const progressHandle     = document.getElementById('player-progress-handle');
    const progressTooltip    = document.getElementById('player-progress-tooltip');
    const playerTitle        = document.getElementById('player-title');
    const tapLeft            = document.getElementById('tap-left');
    const tapRight           = document.getElementById('tap-right');
    const tapCenter          = document.getElementById('tap-center');

    // Кнопка обратного отсчета
    const btnNextCountdown   = document.getElementById('btn-next-countdown');
    const nextCountdownText  = document.getElementById('next-countdown-text');

    // Шторка настроек
    const settingsBackdrop   = document.getElementById('settings-backdrop');
    const settingsSheet      = document.getElementById('settings-sheet');
    const settingsAudioOpts  = document.getElementById('settings-audio-options');
    const settingsQualityOpts= document.getElementById('settings-quality-options');
    const settingsSpeedOpts  = document.getElementById('settings-speed-options');
    const settingsBalancerOpts = document.getElementById('settings-balancer-options');
    const settingsAspectOpts = document.getElementById('settings-aspect-options');
    const btnPip             = document.getElementById('btn-pip');
    const settingsSleepOpts  = document.getElementById('settings-sleep-options');

    // ─── Состояние ───
    let hls = null;
    let currentState = {};
    let currentStreams = {};
    let audioTrackNames = [];
    let controlsTimeout = null;
    let saveInterval = null;
    let isDragging = false;
    let tapTimeout = null;
    let tapCount = 0;
    let sleepTimerTimeout = null;
    let sleepOnEnd = false;

    // ─── Инициализация ───

    function init() {
        btnBack.addEventListener('click', close);
        btnPlayPause.addEventListener('click', togglePlayPause);

        // Переключение серий
        if (btnPrevEp) {
            btnPrevEp.addEventListener('click', (e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('episode-prev'));
            });
        }
        if (btnNextEp) {
            btnNextEp.addEventListener('click', (e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('episode-next'));
            });
        }

        // Кнопка следующей серии (плавающая)
        if (btnNextCountdown) {
            btnNextCountdown.addEventListener('click', (e) => {
                e.stopPropagation();
                btnNextCountdown.classList.add('hidden');
                window.dispatchEvent(new CustomEvent('episode-next'));
            });
        }

        // Открытие / закрытие настроек
        btnSettings.addEventListener('click', toggleSettings);
        if (settingsBackdrop) {
            settingsBackdrop.addEventListener('click', closeSettings);
        }

        // Полный экран / Нативный плеер iOS
        btnFullscreen.addEventListener('click', toggleFullscreen);
        if (btnNativePlayer) {
            btnNativePlayer.addEventListener('click', toggleFullscreen);
        }

        // Прогресс-бар
        progressBar.addEventListener('pointerdown', onProgressDown);
        document.addEventListener('pointermove', onProgressMove);
        document.addEventListener('pointerup', onProgressUp);
        progressBar.addEventListener('pointermove', onProgressHover);
        progressBar.addEventListener('pointerleave', onProgressLeave);

        // Управление с клавиатуры (ноутбук / ПК)
        window.addEventListener('keydown', onKeyDown);

        // Тапы и клики по экрану (ПК мышью: пауза/плей, мобильные: двойной тап ±10с / показ контролов)
        function onPlayerAreaClick(e, side) {
            if (e.target.closest('button, .player-progress-bar, #settings-sheet, .settings-modal, .player-top-bar, .player-bottom-bar, .btn-icon-touch, .btn-text-touch, .btn-play-pause-lg, .btn-ep-nav')) {
                return;
            }

            // На ПК и ноутбуках клик мышью в любую область экрана (видео или черные полосы) = мгновенный стоп/старт видео
            const isMouse = (e.pointerType === 'mouse') || (!e.pointerType && window.matchMedia('(pointer: fine)').matches);
            if (isMouse) {
                e.stopPropagation();
                togglePlayPause();
                return;
            }

            // На мобильных тач-устройствах (сенсор)
            if (side === 'left' || side === 'right') {
                handleDoubleTap(side);
            } else {
                toggleControls();
            }
        }

        tapLeft.addEventListener('click', (e) => onPlayerAreaClick(e, 'left'));
        tapRight.addEventListener('click', (e) => onPlayerAreaClick(e, 'right'));
        tapCenter.addEventListener('click', (e) => onPlayerAreaClick(e, 'center'));

        if (container) {
            container.addEventListener('click', (e) => {
                if (e.target.closest('.player-tap-zones')) return;
                onPlayerAreaClick(e, 'container');
            });
            container.addEventListener('dblclick', (e) => {
                if (e.target.closest('button, .player-progress-bar, #settings-sheet, .settings-modal')) return;
                toggleFullscreen();
            });
        }

        // События видео
        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('progress', updateBuffered);
        video.addEventListener('loadedmetadata', onMetadataLoaded);
        video.addEventListener('play', updatePlayPauseIcon);
        video.addEventListener('pause', () => { updatePlayPauseIcon(); saveProgress(); });
        video.addEventListener('seeked', saveProgress);
        video.addEventListener('ended', onVideoEnded);

        // Железобетонное сохранение секунды
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveProgress();
        });
        window.addEventListener('pagehide', saveProgress);
        window.addEventListener('beforeunload', saveProgress);

        // Нативный плеер iOS (iPhone / iPad)
        video.addEventListener('webkitbeginfullscreen', () => showControls());
        video.addEventListener('webkitendfullscreen', () => {
            saveProgress();
            updatePlayPauseIcon();
            timeCurrent.textContent = formatTime(video.currentTime);
            onTimeUpdate();
        });

        // Показ контролов при движении мыши (ПК / Ноутбук)
        screen.addEventListener('mousemove', () => {
            showControls();
        });
        screen.addEventListener('pointermove', () => {
            showControls();
        });

        // Клик по экрану (включая черные поля вокруг видео)
        screen.addEventListener('click', (e) => {
            if (e.target.closest('button, .settings-sheet, .player-progress-bar, input, select, .tap-zone')) return;
            toggleControls();
        });

        // Контролы
        overlay.addEventListener('click', (e) => {
            if (e.target.closest('button, .tap-zone, .settings-sheet, .player-progress-bar')) return;
            toggleControls();
        });

        // Настройка обработчиков шторки
        initSettingsSheetHandlers();
    }

    // ─── Шторка настроек ───

    function initSettingsSheetHandlers() {
        // Скорость
        if (settingsSpeedOpts) {
            settingsSpeedOpts.querySelectorAll('.settings-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const sp = parseFloat(chip.dataset.speed || '1');
                    setSpeed(sp);
                });
            });
        }

        // Балансер
        if (settingsBalancerOpts) {
            settingsBalancerOpts.querySelectorAll('.settings-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const source = chip.dataset.source;
                    setActiveBalancer(source);
                    closeSettings();
                    window.dispatchEvent(new CustomEvent('change-balancer', { 
                        detail: { 
                            source, 
                            preferredVoice: source === 'rezka' ? 'TVShows' : null 
                        } 
                    }));
                });
            });
        }

        // Масштаб
        if (settingsAspectOpts) {
            settingsAspectOpts.querySelectorAll('.settings-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const aspect = chip.dataset.aspect;
                    setAspect(aspect);
                });
            });
        }

        // PiP
        if (btnPip) {
            btnPip.addEventListener('click', () => {
                togglePiP();
                closeSettings();
            });
        }

        // Таймер сна
        if (settingsSleepOpts) {
            settingsSleepOpts.querySelectorAll('.settings-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const val = chip.dataset.sleep;
                    setSleepTimer(val);
                });
            });
        }
    }

    function toggleSettings() {
        if (settingsSheet.classList.contains('hidden')) {
            openSettings();
        } else {
            closeSettings();
        }
    }

    function openSettings() {
        buildAudioMenu();
        settingsSheet.classList.remove('hidden');
        settingsSheet.style.visibility = 'visible';
        if (settingsBackdrop) settingsBackdrop.classList.remove('hidden');
        clearTimeout(controlsTimeout); // не скрывать контролы пока открыты настройки
    }

    function closeSettings() {
        settingsSheet.classList.add('hidden');
        setTimeout(() => {
            if (settingsSheet.classList.contains('hidden')) {
                settingsSheet.style.visibility = 'hidden';
            }
        }, 280);
        if (settingsBackdrop) settingsBackdrop.classList.add('hidden');
        showControls();
    }

    function setSpeed(speed) {
        video.playbackRate = speed;
        try { video.preservesPitch = true; } catch {}
        localStorage.setItem('cinema_preferred_speed', String(speed));

        if (settingsSpeedOpts) {
            settingsSpeedOpts.querySelectorAll('.settings-chip').forEach(c => {
                c.classList.toggle('active', parseFloat(c.dataset.speed) === speed);
            });
        }
    }

    function setAspect(aspect) {
        video.style.objectFit = aspect;
        localStorage.setItem('cinema_preferred_aspect', aspect);

        if (settingsAspectOpts) {
            settingsAspectOpts.querySelectorAll('.settings-chip').forEach(c => {
                c.classList.toggle('active', c.dataset.aspect === aspect);
            });
        }
    }

    let currentBalancer = 'collaps';

    function getActiveBalancer() {
        return currentBalancer;
    }

    function setActiveBalancer(source) {
        currentBalancer = source;
        localStorage.setItem('cinema_preferred_balancer', source);
        if (settingsBalancerOpts) {
            settingsBalancerOpts.querySelectorAll('.settings-chip').forEach(c => {
                c.classList.toggle('active', c.dataset.source === source);
            });
        }
    }

    async function togglePiP() {
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
        const isStandalone = window.navigator.standalone === true || 
                             window.matchMedia('(display-mode: standalone)').matches;

        // Если запущено как иконка PWA на iOS (с экрана «Домой»)
        if (isIOS && isStandalone) {
            alert(
                '📱 Ограничение Apple iOS:\n\n' +
                'Apple блокирует режим «Картинка в картинке» для приложений, запущенных с экрана Домой (PWA).\n\n' +
                '💡 Чтобы смотреть фильм в маленьком окне и пользоваться телефоном, откройте сайт в обычном браузере Safari.'
            );
            return;
        }

        try {
            // Safari iOS (в обычной вкладке браузера)
            if (typeof video.webkitSetPresentationMode === 'function') {
                const currentMode = video.webkitPresentationMode;
                const targetMode = currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture';
                video.webkitSetPresentationMode(targetMode);
                return;
            }

            // Desktop / Chrome / Android
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (video.requestPictureInPicture) {
                await video.requestPictureInPicture();
            }
        } catch (e) {
            console.warn('[PiP error]:', e);
            if (isIOS) {
                alert('Режим «Картинка в картинке» поддерживается в браузере Safari.');
            }
        }
    }

    function setSleepTimer(val) {
        if (sleepTimerTimeout) {
            clearTimeout(sleepTimerTimeout);
            sleepTimerTimeout = null;
        }
        sleepOnEnd = false;

        if (settingsSleepOpts) {
            settingsSleepOpts.querySelectorAll('.settings-chip').forEach(c => {
                c.classList.toggle('active', c.dataset.sleep === val);
            });
        }

        if (val === '0') return;

        if (val === 'end') {
            sleepOnEnd = true;
            return;
        }

        const mins = parseInt(val, 10);
        if (mins > 0) {
            sleepTimerTimeout = setTimeout(() => {
                video.pause();
                close();
            }, mins * 60 * 1000);
        }
    }

    // ─── Публичные методы ───

    function open(opts) {
        currentStreams = opts.streams || {};
        audioTrackNames = opts.audioTracks || [];

        currentState = {
            filmId: opts.filmId,
            filmUrl: opts.filmUrl || '',
            title: opts.title || '',
            poster: opts.poster || '',
            type: opts.type || 'movie',
            season: opts.season || null,
            episode: opts.episode || null,
            episodeTitle: opts.episodeTitle || '',
            translatorId: opts.translatorId ?? 0,
            translatorName: opts.translatorName || '',
            source: opts.source || currentBalancer || 'collaps',
        };

        if (opts.source) {
            setActiveBalancer(opts.source);
        }

        if (audioTrackNames && audioTrackNames.length > 0) {
            buildAudioMenu(audioTrackNames.map(n => ({ name: n })));
        }

        const streamUrl = opts.hls_url || Object.values(currentStreams)[0] || '';
        if (!streamUrl) {
            alert('Видеопоток не найден');
            return;
        }

        // Показ / скрытие кнопок серий
        const isSeries = currentState.type === 'series';
        if (btnPrevEp) btnPrevEp.classList.toggle('hidden', !isSeries);
        if (btnNextEp) btnNextEp.classList.toggle('hidden', !isSeries);
        if (btnNextCountdown) btnNextCountdown.classList.add('hidden');

        // Заголовок в плеере
        let titleText = currentState.title;
        if (isSeries && currentState.season && currentState.episode) {
            titleText += ` · С${currentState.season}:Э${currentState.episode}`;
            if (currentState.episodeTitle) {
                titleText += ` «${currentState.episodeTitle}»`;
            }
        }
        playerTitle.textContent = titleText;

        // Восстановление сохранённых настроек пользователя
        const savedSpeed = parseFloat(localStorage.getItem('cinema_preferred_speed') || '1');
        setSpeed(savedSpeed);

        const savedAspect = localStorage.getItem('cinema_preferred_aspect') || 'contain';
        setAspect(savedAspect);

        const savedBalancer = localStorage.getItem('cinema_preferred_balancer') || 'collaps';
        if (settingsBalancerOpts) {
            settingsBalancerOpts.querySelectorAll('.settings-chip').forEach(c => {
                c.classList.toggle('active', c.dataset.source === savedBalancer);
            });
        }

        // Показать экран
        document.body.classList.add('player-active');
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        screen.classList.add('active');

        // Загрузить поток
        loadStream(streamUrl);

        // Автосохранение каждые 2 секунды
        clearInterval(saveInterval);
        saveInterval = setInterval(saveProgress, 2000);

        showControls();
    }

    function close() {
        saveProgress();
        clearInterval(saveInterval);
        if (sleepTimerTimeout) {
            clearTimeout(sleepTimerTimeout);
            sleepTimerTimeout = null;
        }

        video.pause();
        video.removeAttribute('src');
        video.load();
        if (hls) { hls.destroy(); hls = null; }

        document.body.classList.remove('player-active');
        screen.classList.remove('active');
        closeSettings();

        try { document.exitFullscreen?.() || document.webkitExitFullscreen?.(); } catch {}

        const detailsScreen = document.getElementById('screen-details');
        const homeScreen = document.getElementById('screen-home');
        if (detailsScreen && currentState.filmUrl) {
            detailsScreen.classList.add('active');
        } else {
            homeScreen.classList.add('active');
        }

        window.dispatchEvent(new CustomEvent('player-closed'));
    }

    // ─── Загрузка HLS ───

    function loadStream(url) {
        if (!url) return;

        const currentTime = video.currentTime || 0;
        const wasPlaying = !video.paused;

        if (hls) { hls.destroy(); hls = null; }

        if (Hls.isSupported()) {
            hls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                startLevel: -1,
                capLevelToPlayerSize: false, // ВАЖНО: false, чтобы 1080p не сбрасывалось на 720p!
                autoStartLoad: true,
            });

            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                buildQualityMenu(hls.levels);
                restorePosition(currentTime, wasPlaying);
            });

            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
                if (currentBalancer === 'rezka' || currentState.source === 'rezka') return;
                buildAudioMenu(hls.audioTracks);
                if (typeof currentState.translatorId === 'number' && hls.audioTracks[currentState.translatorId]) {
                    hls.audioTrack = currentState.translatorId;
                }
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('[HLS] Fatal:', data.type, data.details, data.response?.url);
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        if (currentState.source === 'offline' && url.includes('master.m3u8')) {
                            const altUrl = url.replace('master.m3u8', 'video.m3u8');
                            console.log('[HLS Offline] Falling back to direct video stream:', altUrl);
                            hls.loadSource(altUrl);
                            return;
                        }
                        hls.startLoad();
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        hls.recoverMediaError();
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari iOS (родная поддержка HLS)
            video.src = url;
            const onMeta = () => {
                video.removeEventListener('loadedmetadata', onMeta);
                if (audioTrackNames && audioTrackNames.length > 0) {
                    buildAudioMenu(audioTrackNames.map(n => ({ name: n })));
                    if (video.audioTracks && video.audioTracks.length > currentState.translatorId) {
                        for (let i = 0; i < video.audioTracks.length; i++) {
                            video.audioTracks[i].enabled = (i === currentState.translatorId);
                        }
                    }
                }
                restorePosition(currentTime, wasPlaying);
            };
            video.addEventListener('loadedmetadata', onMeta);
        }
    }

    function buildQualityMenu(levels) {
        if (!settingsQualityOpts) return;
        settingsQualityOpts.innerHTML = '';

        const preferredQuality = localStorage.getItem('cinema_preferred_quality') || 'auto';

        // Кнопка "Авто"
        const autoBtn = document.createElement('button');
        autoBtn.className = 'settings-chip' + (preferredQuality === 'auto' ? ' active' : '');
        autoBtn.textContent = 'Авто (Макс)';
        autoBtn.addEventListener('click', () => {
            if (hls) hls.currentLevel = -1;
            localStorage.setItem('cinema_preferred_quality', 'auto');
            settingsQualityOpts.querySelectorAll('.settings-chip').forEach(c => c.classList.remove('active'));
            autoBtn.classList.add('active');
        });
        settingsQualityOpts.appendChild(autoBtn);

        if (!levels || levels.length === 0) return;

        // Сортируем уровни от 1080p к 360p
        const sorted = levels.map((lvl, idx) => ({ lvl, idx }))
                             .sort((a, b) => (b.lvl.height || 0) - (a.lvl.height || 0));

        let applied = false;

        sorted.forEach(({ lvl, idx }) => {
            const h = lvl.height || 1080;
            const label = `${h}p`;
            const isMatch = (preferredQuality === label);

            const btn = document.createElement('button');
            btn.className = 'settings-chip' + (isMatch ? ' active' : '');
            btn.textContent = label;

            btn.addEventListener('click', () => {
                if (hls) hls.currentLevel = idx;
                localStorage.setItem('cinema_preferred_quality', label);
                settingsQualityOpts.querySelectorAll('.settings-chip').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
            });

            if (isMatch && hls) {
                hls.currentLevel = idx;
                applied = true;
            }

            settingsQualityOpts.appendChild(btn);
        });

        // Если было 'auto' или не найдено совпадение — ставим -1 (наилучшее адаптивное качество)
        if (!applied && hls && preferredQuality !== 'auto') {
            hls.currentLevel = -1;
        }
    }

    function buildAudioMenu(tracks) {
        if (!settingsAudioOpts) return;
        settingsAudioOpts.innerHTML = '';

        const isRezka = (currentBalancer === 'rezka' || currentState.source === 'rezka');
        let rawList = (tracks && tracks.length > 0 && !isRezka) ? tracks : (audioTrackNames && audioTrackNames.length > 0 ? audioTrackNames.map(n => ({ name: n })) : []);

        if (!rawList || rawList.length === 0) {
            const emptyLabel = document.createElement('span');
            emptyLabel.className = 'settings-chip';
            emptyLabel.textContent = currentState.translatorName || 'Основная';
            settingsAudioOpts.appendChild(emptyLabel);
            return;
        }

        let items = rawList.map((t, idx) => ({
            originalIndex: idx,
            fullName: (audioTrackNames && audioTrackNames[idx]) ? audioTrackNames[idx] : (t.name || `Дорожка ${idx + 1}`),
        }));

        if (isRezka) {
            // Приоритетная сортировка для Резки: TVShows на 1 месте, LostFilm на 2 месте!
            items.sort((a, b) => {
                const aLow = a.fullName.toLowerCase();
                const bLow = b.fullName.toLowerCase();
                const aScore = aLow.includes('tvshows') ? 0 : (aLow.includes('lostfilm') ? 1 : 2);
                const bScore = bLow.includes('tvshows') ? 0 : (bLow.includes('lostfilm') ? 1 : 2);
                return aScore - bScore;
            });
        }

        const currentName = (currentState.translatorName || '').toLowerCase().trim();

        function getVoiceDisplayLabel(name) {
            if (!name) return 'Озвучка';
            const lower = name.toLowerCase();
            if (lower.includes('18+') || lower.includes('без цензуры') || lower.includes('с матом') || lower.includes('нецензур')) {
                if (lower.includes('rezka')) return 'HDrezka (18+ с матом)';
                return name.replace(/\s*\([^)]*\)/g, '').trim() + ' (18+)';
            }
            if (lower.includes('rezka')) {
                return 'HDrezka (без мата)';
            }
            return name.replace(/\s*\([^)]*\)/g, '').trim() || name;
        }

        items.forEach((item) => {
            const fullName = item.fullName;
            const originalIdx = item.originalIndex;
            const displayLabel = getVoiceDisplayLabel(fullName);

            const btn = document.createElement('button');
            const fullNameLower = fullName.toLowerCase();
            const labelLower = displayLabel.toLowerCase();
            const isMatchByName = currentName && (
                fullNameLower === currentName ||
                labelLower === currentName ||
                fullNameLower.includes(currentName) || 
                currentName.includes(labelLower) ||
                (currentName.includes('18+') && (fullNameLower.includes('18+') || labelLower.includes('18+'))) ||
                (!currentName.includes('18+') && !fullNameLower.includes('18+') && fullNameLower.includes('rezka') && currentName.includes('rezka'))
            );
            let isActive = false;
            if (isRezka) {
                isActive = isMatchByName || (originalIdx === currentState.translatorId);
            } else {
                isActive = (hls && hls.audioTrack >= 0) ? (originalIdx === hls.audioTrack) : (originalIdx === currentState.translatorId || isMatchByName);
            }

            btn.className = 'settings-chip' + (isActive ? ' active' : '');
            btn.textContent = displayLabel;
            btn.title = fullName;

            btn.addEventListener('click', () => {
                if (isRezka) {
                    currentState.translatorId = originalIdx;
                    currentState.translatorName = displayLabel;
                    settingsAudioOpts.querySelectorAll('.settings-chip').forEach(c => c.classList.remove('active'));
                    btn.classList.add('active');
                    window.dispatchEvent(new CustomEvent('change-rezka-voice', {
                        detail: { translatorId: originalIdx, translatorName: fullName }
                    }));
                    return;
                }
                if (hls) {
                    hls.audioTrack = originalIdx;
                } else if (video.audioTracks && video.audioTracks.length > originalIdx) {
                    for (let i = 0; i < video.audioTracks.length; i++) {
                        video.audioTracks[i].enabled = (i === originalIdx);
                    }
                }
                currentState.translatorId = originalIdx;
                currentState.translatorName = displayLabel;
                settingsAudioOpts.querySelectorAll('.settings-chip').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                saveProgress();
            });

            settingsAudioOpts.appendChild(btn);
        });
    }

    function restorePosition(fallbackTime, autoPlay) {
        const saved = CinemaStorage.get(currentState.filmId);
        let targetTime = fallbackTime;

        if (saved && saved.time > 5 && fallbackTime < 1) {
            const sameEpisode = (!currentState.season && !currentState.episode) ||
                                (saved.season == currentState.season && saved.episode == currentState.episode);
            if (sameEpisode) {
                targetTime = saved.time;
            }
        }

        if (targetTime > 3) {
            video.currentTime = Math.max(0, targetTime - 1.5);
        }

        if (autoPlay || fallbackTime < 1) {
            video.play().catch(() => {});
        }
    }

    // ─── Управление воспроизведением ───

    function togglePlayPause() {
        if (video.paused) {
            video.play().catch(() => {});
        } else {
            video.pause();
        }
        showControls();
    }

    function updatePlayPauseIcon() {
        if (video.paused) {
            iconPlay.classList.remove('hidden');
            iconPause.classList.add('hidden');
        } else {
            iconPlay.classList.add('hidden');
            iconPause.classList.remove('hidden');
        }
    }

    function onVideoEnded() {
        showControls();
        if (sleepOnEnd) {
            close();
            return;
        }
        // Автоматический переход на след. серию
        if (currentState.type === 'series') {
            window.dispatchEvent(new CustomEvent('episode-next'));
        }
    }

    // ─── Двойной тап ±10с ───

    function handleDoubleTap(side) {
        tapCount++;
        clearTimeout(tapTimeout);

        if (tapCount >= 2) {
            const seekAmount = side === 'left' ? -10 : 10;
            video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seekAmount));
            saveProgress();

            const ripple = (side === 'left' ? tapLeft : tapRight).querySelector('.tap-ripple');
            ripple.classList.add('show');
            setTimeout(() => ripple.classList.remove('show'), 450);

            tapCount = 0;
        } else {
            tapTimeout = setTimeout(() => {
                tapCount = 0;
                toggleControls();
            }, 250);
        }
    }

    // ─── Прогресс-бар и авто-переход ───

    function onTimeUpdate() {
        if (isDragging || !video.duration) return;
        const pct = (video.currentTime / video.duration) * 100 || 0;
        progressPlayed.style.width = pct + '%';
        progressHandle.style.left = pct + '%';
        timeCurrent.textContent = formatTime(video.currentTime);

        // Логика плавающей кнопки «Следующая серия (10с) ▶»
        if (currentState.type === 'series' && btnNextCountdown && video.duration > 30) {
            const remaining = video.duration - video.currentTime;
            if (remaining <= 10 && remaining > 0.5) {
                const secs = Math.ceil(remaining);
                nextCountdownText.textContent = `Следующая серия (${secs}с)`;
                btnNextCountdown.classList.remove('hidden');
            } else {
                btnNextCountdown.classList.add('hidden');
            }
        }
    }

    function onMetadataLoaded() {
        timeDuration.textContent = formatTime(video.duration);
    }

    function updateBuffered() {
        if (video.buffered.length > 0 && video.duration) {
            const end = video.buffered.end(video.buffered.length - 1);
            const pct = (end / video.duration) * 100;
            progressBuffered.style.width = pct + '%';
        }
    }

    function onProgressDown(e) {
        isDragging = true;
        progressBar.classList.add('dragging');
        seekTo(e);
        progressBar.setPointerCapture(e.pointerId);
    }

    function onProgressMove(e) {
        if (!isDragging) return;
        seekTo(e);
    }

    function onProgressUp(e) {
        if (!isDragging) return;
        isDragging = false;
        progressBar.classList.remove('dragging');
        if (progressTooltip) progressTooltip.classList.add('hidden');
        saveProgress();
    }

    function onProgressHover(e) {
        if (!video.duration || !progressTooltip) return;
        const rect = progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        progressTooltip.textContent = formatTime(pct * video.duration);
        progressTooltip.style.left = `${pct * 100}%`;
        progressTooltip.classList.remove('hidden');
    }

    function onProgressLeave() {
        if (progressTooltip && !isDragging) {
            progressTooltip.classList.add('hidden');
        }
    }

    function onKeyDown(e) {
        // Игнорируем ввод в текстовые поля
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            return;
        }
        // Работает только когда экран плеера активен
        if (!screen.classList.contains('active')) return;

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            seekBy(-10); // 1 нажатие стрелки = моментальная перемотка -10с
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            seekBy(10);  // 1 нажатие стрелки = моментальная перемотка +10с
        } else if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
            e.preventDefault();
            toggleFullscreen();
        } else if (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь') {
            e.preventDefault();
            video.muted = !video.muted;
            showControls();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            video.volume = Math.min(1, Math.round((video.volume + 0.1) * 10) / 10);
            showControls();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            video.volume = Math.max(0, Math.round((video.volume - 0.1) * 10) / 10);
            showControls();
        } else if (e.key === 'Escape') {
            if (!settingsSheet.classList.contains('hidden')) {
                closeSettings();
            }
        }
    }

    function seekBy(seconds) {
        if (!video.duration && !video.currentTime) return;
        const newTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
        video.currentTime = newTime;
        onTimeUpdate();
        saveProgress();
        showControls();

        const side = seconds < 0 ? 'left' : 'right';
        const ripple = (side === 'left' ? tapLeft : tapRight)?.querySelector('.tap-ripple');
        if (ripple) {
            ripple.classList.add('show');
            setTimeout(() => ripple.classList.remove('show'), 350);
        }
    }

    function seekTo(e) {
        if (!video.duration) return;
        const rect = progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        video.currentTime = pct * video.duration;
        progressPlayed.style.width = (pct * 100) + '%';
        progressHandle.style.left = (pct * 100) + '%';
        timeCurrent.textContent = formatTime(video.currentTime);
    }

    // ─── Контролы ───

    function showControls() {
        overlay.classList.remove('hidden-controls');
        screen.style.cursor = 'default';
        clearTimeout(controlsTimeout);
        if (!video.paused && settingsSheet.classList.contains('hidden')) {
            controlsTimeout = setTimeout(() => {
                overlay.classList.add('hidden-controls');
                if (document.body.classList.contains('player-active') && !video.paused) {
                    screen.style.cursor = 'none';
                }
            }, 2000); // 2 секунды (удобно и не висит лишнее время)
        }
    }

    function toggleControls() {
        if (!settingsSheet.classList.contains('hidden')) {
            closeSettings();
            return;
        }
        if (overlay.classList.contains('hidden-controls')) {
            showControls();
        } else {
            overlay.classList.add('hidden-controls');
            clearTimeout(controlsTimeout);
        }
    }

    function toggleFullscreen() {
        // 1. Для iPhone / iPad родной системный плеер iOS
        if (typeof video.webkitEnterFullscreen === 'function') {
            try {
                video.webkitEnterFullscreen();
                return;
            } catch (e) {
                console.warn('[iOS] webkitEnterFullscreen:', e);
            }
        }

        // 2. Стандартный Fullscreen API (Android / Windows / macOS)
        const isFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (isFs) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            const el = screen;
            if (el.requestFullscreen) {
                el.requestFullscreen().catch(() => {
                    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
                });
            } else if (el.webkitRequestFullscreen) {
                el.webkitRequestFullscreen();
            } else if (video.requestFullscreen) {
                video.requestFullscreen().catch(() => {});
            }
        }
    }

    // ─── Сохранение прогресса ───

    function saveProgress() {
        if (!currentState.filmId || !video.duration) return;
        CinemaStorage.save({
            ...currentState,
            time: video.currentTime,
            duration: video.duration,
        });
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

    return { open, close, saveProgress, setSpeed, setAspect, togglePiP, getActiveBalancer, setActiveBalancer };
})();
