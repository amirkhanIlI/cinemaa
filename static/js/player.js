/**
 * player.js — Полноэкранный видеоплеер с HLS.js.
 *
 * Фичи:
 * - Воспроизведение HLS (.m3u8) потоков без задержек.
 * - Двойной тап: -10с / +10с с плавной анимацией.
 * - Переключение озвучки прямо во время просмотра.
 * - Переключение качества видео (Авто / 1080p / 720p / 480p / 360p).
 * - Автосохранение секунды каждые 2с + при блокировке экрана / сворачивании.
 * - Моментальное авто-возобновление с точностью до секунды.
 */

const CinemaPlayer = (() => {
    // ─── DOM ───
    const screen        = document.getElementById('screen-player');
    const video         = document.getElementById('video-player');
    const overlay       = document.getElementById('player-overlay');
    const btnBack       = document.getElementById('btn-player-back');
    const btnPlayPause  = document.getElementById('btn-play-pause');
    const iconPlay      = document.getElementById('icon-play');
    const iconPause     = document.getElementById('icon-pause');
    const btnAudio      = document.getElementById('btn-audio');
    const btnQuality    = document.getElementById('btn-quality');
    const btnNativePlayer = document.getElementById('btn-native-player');
    const btnFullscreen = document.getElementById('btn-fullscreen');
    const timeCurrent   = document.getElementById('player-time-current');
    const timeDuration  = document.getElementById('player-time-duration');
    const progressBar   = document.getElementById('player-progress-bar');
    const progressPlayed = document.getElementById('player-progress-played');
    const progressBuffered = document.getElementById('player-progress-buffered');
    const progressHandle = document.getElementById('player-progress-handle');
    const playerTitle   = document.getElementById('player-title');
    const tapLeft       = document.getElementById('tap-left');
    const tapRight      = document.getElementById('tap-right');
    const tapCenter     = document.getElementById('tap-center');
    const qualityModal  = document.getElementById('quality-modal');
    const qualityOptions = document.getElementById('quality-options');
    const audioModal    = document.getElementById('audio-modal');
    const audioOptions  = document.getElementById('audio-options');

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

    // ─── Инициализация ───

    function init() {
        btnBack.addEventListener('click', close);
        btnPlayPause.addEventListener('click', togglePlayPause);
        
        btnQuality.addEventListener('click', () => {
            qualityModal.classList.toggle('hidden');
            audioModal.classList.add('hidden');
        });
        
        btnAudio.addEventListener('click', () => {
            audioModal.classList.toggle('hidden');
            qualityModal.classList.add('hidden');
        });

        qualityModal.addEventListener('click', (e) => {
            if (e.target === qualityModal) qualityModal.classList.add('hidden');
        });
        audioModal.addEventListener('click', (e) => {
            if (e.target === audioModal) audioModal.classList.add('hidden');
        });

        btnFullscreen.addEventListener('click', toggleFullscreen);
        if (btnNativePlayer) {
            btnNativePlayer.addEventListener('click', toggleFullscreen);
        }

        // Прогресс-бар
        progressBar.addEventListener('pointerdown', onProgressDown);
        document.addEventListener('pointermove', onProgressMove);
        document.addEventListener('pointerup', onProgressUp);

        // Тапы
        tapLeft.addEventListener('click', () => handleDoubleTap('left'));
        tapRight.addEventListener('click', () => handleDoubleTap('right'));
        tapCenter.addEventListener('click', toggleControls);

        // События видео
        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('progress', updateBuffered);
        video.addEventListener('loadedmetadata', onMetadataLoaded);
        video.addEventListener('play',  updatePlayPauseIcon);
        video.addEventListener('pause', () => { updatePlayPauseIcon(); saveProgress(); });
        video.addEventListener('seeked', saveProgress);
        video.addEventListener('ended', onVideoEnded);

        // ─── Железобетонное сохранение секунды ───
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveProgress();
        });
        window.addEventListener('pagehide', saveProgress);
        window.addEventListener('beforeunload', saveProgress);

        // ─── События нативного плеера iOS (iPhone / iPad) ───
        video.addEventListener('webkitbeginfullscreen', () => {
            showControls();
        });
        video.addEventListener('webkitendfullscreen', () => {
            saveProgress();
            updatePlayPauseIcon();
            timeCurrent.textContent = formatTime(video.currentTime);
            onTimeUpdate();
        });

        // Контролы
        overlay.addEventListener('click', (e) => {
            if (e.target.closest('button, .tap-zone, .modal, .player-progress-bar')) return;
            toggleControls();
        });
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
            translatorId: opts.translatorId ?? 0,
            translatorName: opts.translatorName || '',
        };

        const streamUrl = opts.hls_url || Object.values(currentStreams)[0] || '';
        if (!streamUrl) {
            alert('Видеопоток не найден');
            return;
        }

        // Заголовок
        let titleText = currentState.title;
        if (currentState.type === 'series' && currentState.season && currentState.episode) {
            titleText += ` — S${currentState.season}E${currentState.episode}`;
        }
        playerTitle.textContent = titleText;
        btnQuality.textContent = 'Авто';
        btnAudio.textContent = currentState.translatorName || 'Озвучка';

        // Показать экран
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

        video.pause();
        video.removeAttribute('src');
        video.load();
        if (hls) { hls.destroy(); hls = null; }

        screen.classList.remove('active');
        qualityModal.classList.add('hidden');
        audioModal.classList.add('hidden');

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
                capLevelToPlayerSize: true,
            });

            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                buildQualityMenu(hls.levels);
                restorePosition(currentTime, wasPlaying);
            });

            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
                buildAudioMenu(hls.audioTracks);
                // Устанавливаем сохраненную озвучку если есть
                if (typeof currentState.translatorId === 'number' && hls.audioTracks[currentState.translatorId]) {
                    hls.audioTrack = currentState.translatorId;
                    if (audioTrackNames[currentState.translatorId]) {
                        btnAudio.textContent = audioTrackNames[currentState.translatorId];
                    }
                }
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('[HLS] Fatal:', data.type);
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari iOS
            video.src = url;
            video.addEventListener('loadedmetadata', () => {
                if (audioTrackNames && audioTrackNames.length > 0) {
                    buildAudioMenu(audioTrackNames.map(n => ({ name: n })));
                    if (video.audioTracks && video.audioTracks.length > currentState.translatorId) {
                        for (let i = 0; i < video.audioTracks.length; i++) {
                            video.audioTracks[i].enabled = (i === currentState.translatorId);
                        }
                    }
                }
                restorePosition(currentTime, wasPlaying);
            }, { once: true });
        }
    }

    function buildQualityMenu(levels) {
        qualityOptions.innerHTML = '';

        // Опция "Авто"
        const autoBtn = document.createElement('button');
        autoBtn.className = 'modal-option active';
        autoBtn.textContent = 'Авто (рекомендуется)';
        autoBtn.addEventListener('click', () => {
            if (hls) hls.currentLevel = -1;
            btnQuality.textContent = 'Авто';
            qualityOptions.querySelectorAll('.modal-option').forEach(o => o.classList.remove('active'));
            autoBtn.classList.add('active');
            qualityModal.classList.add('hidden');
        });
        qualityOptions.appendChild(autoBtn);

        if (!levels || levels.length === 0) return;

        // Сортируем от высшего к низшему
        const sortedLevels = levels.map((lvl, idx) => ({ lvl, idx }))
                                   .sort((a, b) => (b.lvl.height || 0) - (a.lvl.height || 0));

        sortedLevels.forEach(({ lvl, idx }) => {
            const h = lvl.height || (idx === 0 ? 1080 : 720);
            const label = `${h}p`;
            const btn = document.createElement('button');
            btn.className = 'modal-option';
            btn.textContent = label;
            btn.addEventListener('click', () => {
                if (hls) hls.currentLevel = idx;
                btnQuality.textContent = label;
                qualityOptions.querySelectorAll('.modal-option').forEach(o => o.classList.remove('active'));
                btn.classList.add('active');
                qualityModal.classList.add('hidden');
            });
            qualityOptions.appendChild(btn);
        });
    }

    function buildAudioMenu(tracks) {
        audioOptions.innerHTML = '';
        if (!tracks || tracks.length === 0) {
            btnAudio.classList.add('hidden');
            return;
        }
        btnAudio.classList.remove('hidden');

        tracks.forEach((track, idx) => {
            const name = (audioTrackNames && audioTrackNames[idx]) ? audioTrackNames[idx] : (track.name || `Дорожка ${idx + 1}`);
            const btn = document.createElement('button');
            btn.className = 'modal-option';
            if (idx === (hls ? hls.audioTrack : currentState.translatorId)) {
                btn.classList.add('active');
            }
            btn.textContent = name;
            btn.addEventListener('click', () => {
                if (hls) {
                    hls.audioTrack = idx;
                } else if (video.audioTracks && video.audioTracks.length > idx) {
                    for (let i = 0; i < video.audioTracks.length; i++) {
                        video.audioTracks[i].enabled = (i === idx);
                    }
                }
                currentState.translatorId = idx;
                currentState.translatorName = name;
                btnAudio.textContent = name;
                audioOptions.querySelectorAll('.modal-option').forEach(o => o.classList.remove('active'));
                btn.classList.add('active');
                audioModal.classList.add('hidden');
                saveProgress();
            });
            audioOptions.appendChild(btn);
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
        window.dispatchEvent(new CustomEvent('episode-ended', {
            detail: { season: currentState.season, episode: currentState.episode }
        }));
    }

    // ─── Двойной тап ───

    function handleDoubleTap(side) {
        tapCount++;
        clearTimeout(tapTimeout);

        if (tapCount >= 2) {
            const seekAmount = side === 'left' ? -10 : 10;
            video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seekAmount));
            saveProgress();

            const ripple = (side === 'left' ? tapLeft : tapRight).querySelector('.tap-ripple');
            ripple.classList.add('show');
            setTimeout(() => ripple.classList.remove('show'), 500);

            tapCount = 0;
        } else {
            tapTimeout = setTimeout(() => {
                tapCount = 0;
                toggleControls();
            }, 250);
        }
    }

    // ─── Прогресс-бар ───

    function onTimeUpdate() {
        if (isDragging || !video.duration) return;
        const pct = (video.currentTime / video.duration) * 100 || 0;
        progressPlayed.style.width = pct + '%';
        progressHandle.style.left = pct + '%';
        timeCurrent.textContent = formatTime(video.currentTime);
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
        saveProgress();
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
        clearTimeout(controlsTimeout);
        if (!video.paused) {
            controlsTimeout = setTimeout(() => {
                overlay.classList.add('hidden-controls');
            }, 3500);
        }
    }

    function toggleControls() {
        if (overlay.classList.contains('hidden-controls')) {
            showControls();
        } else {
            overlay.classList.add('hidden-controls');
            clearTimeout(controlsTimeout);
        }
    }

    function toggleFullscreen() {
        // 1. Приоритет для iPhone / iPad (открывает родной системный плеер iOS)
        if (typeof video.webkitEnterFullscreen === 'function') {
            try {
                video.webkitEnterFullscreen();
                return;
            } catch (e) {
                console.warn('[iOS] webkitEnterFullscreen fallback:', e);
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

    // ─── Сохранение ───

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

    return { open, close, saveProgress };
})();
