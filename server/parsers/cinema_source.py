"""
Unified Cinema Data & Video Provider
- Поиск: TMDB API v3 (официальная русскоязычная база, постеры, описания, рейтинги)
- Балансер видео: Collaps CDN (высокоскоростной HLS, все сезоны/серии, озвучки: LostFilm, RHS, Кубик в кубе, Дубляж)
- Резерв: HDRezka parser
"""

from __future__ import annotations

import json
import logging
import re
import asyncio
from typing import Optional
import httpx

logger = logging.getLogger(__name__)

TMDB_API_KEY = "4ef0d7355d9ffb5151e987764708ce96"
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"

COLLAPS_EMBED_BASE = "https://api.nextembed.ws/embed"
COLLAPS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://api.nextembed.ws/",
}

_client: Optional[httpx.AsyncClient] = None
_client_loop = None

async def _get_client() -> httpx.AsyncClient:
    global _client, _client_loop
    curr_loop = asyncio.get_running_loop()
    if _client is None or _client.is_closed or _client_loop != curr_loop:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        )
        _client_loop = curr_loop
    return _client

async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None

# ---------------------------------------------------------------------------
# Популярные сериалы (Trending TV)
# ---------------------------------------------------------------------------
async def get_trending_series() -> list[dict]:
    """Получает свежие популярные сериалы недели из TMDB."""
    client = await _get_client()
    url = f"{TMDB_BASE}/trending/tv/week"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "ru-RU",
    }
    try:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        raw_results = data.get("results", [])
        
        items = []
        for r in raw_results:
            title = r.get("name") or r.get("original_name") or ""
            orig_title = r.get("original_name") or ""
            poster_path = r.get("poster_path")
            poster_url = f"{TMDB_IMAGE_BASE}{poster_path}" if poster_path else ""
            date = r.get("first_air_date") or ""
            year = date[:4] if date else ""
            rating = f"{r.get('vote_average', 0):.1f}" if r.get("vote_average") else ""
            
            items.append({
                "id": str(r.get("id")),
                "tmdb_id": r.get("id"),
                "title": title,
                "orig_title": orig_title,
                "year": year,
                "rating": rating,
                "poster_url": poster_url,
                "type": "series",
                "info": f"{year} · Сериал",
                "url": f"/details/tv/{r.get('id')}",
            })
        return items
    except Exception as e:
        logger.error(f"Trending series error: {e}")
        return []

# ---------------------------------------------------------------------------
# Поиск
# ---------------------------------------------------------------------------
async def search(query: str) -> list[dict]:
    """Поиск фильмов и сериалов через TMDB с постерами и метаданными."""
    client = await _get_client()
    url = f"{TMDB_BASE}/search/multi"
    params = {
        "api_key": TMDB_API_KEY,
        "query": query,
        "language": "ru-RU",
        "include_adult": "false",
    }
    
    try:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        raw_results = data.get("results", [])
        
        items = []
        for r in raw_results:
            m_type = r.get("media_type")
            if m_type not in ("movie", "tv"):
                continue
            
            title = r.get("title") or r.get("name") or ""
            orig_title = r.get("original_title") or r.get("original_name") or ""
            poster_path = r.get("poster_path")
            poster_url = f"{TMDB_IMAGE_BASE}{poster_path}" if poster_path else ""
            
            date = r.get("release_date") or r.get("first_air_date") or ""
            year = date[:4] if date else ""
            rating = f"{r.get('vote_average', 0):.1f}" if r.get("vote_average") else ""
            
            items.append({
                "id": str(r.get("id")),
                "tmdb_id": r.get("id"),
                "title": title,
                "orig_title": orig_title,
                "year": year,
                "rating": rating,
                "poster_url": poster_url,
                "type": "series" if m_type == "tv" else "movie",
                "info": f"{year} · {'Сериал' if m_type == 'tv' else 'Фильм'}",
                "url": f"/details/{m_type}/{r.get('id')}",
            })
        return items
    except Exception as e:
        logger.error(f"Search error: {e}")
        return []

# ---------------------------------------------------------------------------
# Получение IMDB ID
# ---------------------------------------------------------------------------
async def get_imdb_id(media_type: str, tmdb_id: str | int) -> Optional[str]:
    """Получает IMDB ID (ttXXXXXXX) для материала через TMDB."""
    client = await _get_client()
    m_type = "tv" if media_type == "series" else "movie"
    url = f"{TMDB_BASE}/{m_type}/{tmdb_id}/external_ids"
    params = {"api_key": TMDB_API_KEY}
    
    try:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        return data.get("imdb_id")
    except Exception as e:
        logger.error(f"Error fetching imdb_id for {media_type}/{tmdb_id}: {e}")
        return None

# ---------------------------------------------------------------------------
# Получение деталей и доступных сезонов / озвучек
# ---------------------------------------------------------------------------
async def get_details(media_type: str, tmdb_id: str | int) -> dict:
    """Получает подробную информацию, сезоны, серии и озвучки."""
    client = await _get_client()
    m_type = "tv" if media_type == "series" else "movie"
    
    # 1. Получаем инфо из TMDB
    url = f"{TMDB_BASE}/{m_type}/{tmdb_id}"
    params = {"api_key": TMDB_API_KEY, "language": "ru-RU"}
    resp = await client.get(url, params=params)
    resp.raise_for_status()
    tmdb_data = resp.json()
    
    title = tmdb_data.get("title") or tmdb_data.get("name") or ""
    orig_title = tmdb_data.get("original_title") or tmdb_data.get("original_name") or ""
    description = tmdb_data.get("overview") or ""
    poster_path = tmdb_data.get("poster_path")
    poster_url = f"{TMDB_IMAGE_BASE}{poster_path}" if poster_path else ""
    date = tmdb_data.get("release_date") or tmdb_data.get("first_air_date") or ""
    year = date[:4] if date else ""
    rating = f"{tmdb_data.get('vote_average', 0):.1f}" if tmdb_data.get("vote_average") else ""
    
    # 2. Получаем IMDB ID
    imdb_id = await get_imdb_id(media_type, tmdb_id)
    
    translators = []
    seasons = {}
    
    # 3. Парсим Collaps балансер для озвучек и сезонов
    if imdb_id:
        try:
            collaps_url = f"{COLLAPS_EMBED_BASE}/imdb/{imdb_id}"
            c_resp = await client.get(collaps_url, headers=COLLAPS_HEADERS)
            if c_resp.status_code == 200:
                html = c_resp.text
                
                # Если сериал — парсим seasons
                if media_type == "series":
                    for line in html.split("\n"):
                        if "seasons:[{" in line or "seasons: [{" in line:
                            m = re.search(r'seasons\s*:\s*(\[\s*\{.*\}\s*\])', line)
                            if m:
                                s_list = json.loads(m.group(1))
                                for s in s_list:
                                    s_num = str(s.get("season"))
                                    eps = [int(e.get("episode")) for e in s.get("episodes", []) if e.get("episode")]
                                    if eps:
                                        seasons[s_num] = sorted(eps)
                                    
                                    # Озвучки из первого доступного эпизода
                                    if not translators and s.get("episodes"):
                                        first_ep = s["episodes"][0]
                                        audio_names = first_ep.get("audio", {}).get("names", [])
                                        for idx, aname in enumerate(audio_names):
                                            translators.append({"id": idx, "name": aname})
                            break
                else:
                    # Фильм — парсим список аудиодорожек
                    audio_match = re.search(r'audio\s*:\s*(\{.*?\})\s*,\s*subtitles', html, re.DOTALL)
                    if audio_match:
                        try:
                            aud_data = json.loads(audio_match.group(1))
                            for idx, aname in enumerate(aud_data.get("names", [])):
                                translators.append({"id": idx, "name": aname})
                        except Exception:
                            pass
        except Exception as e:
            logger.error(f"Collaps details fetch error: {e}")
            
    # 4. Если сериал, проверяем и добавляем озвучки из HDRezka (например TVShows)
    if media_type == "series" and title:
        try:
            from server.parsers import rezka
            direct_emb = rezka.KNOWN_EMBEDS.get(str(tmdb_id))
            r_stream = await rezka.get_stream(title, season=1, episode=1, preferred_voice="TVShows", item_url=direct_emb)
            r_tracks = r_stream.get("audio_tracks", [])
            if r_tracks:
                existing_lower = [t["name"].lower() for t in translators]
                for r_idx, r_name in enumerate(r_tracks):
                    clean_name = r_name.split("(")[0].strip().lower()
                    if not any(clean_name in el for el in existing_lower):
                        translators.append({
                            "id": f"rezka_{r_idx}",
                            "name": r_name,
                            "source": "rezka",
                            "rezka_id": r_idx,
                            "rezka_voice": r_name.split("(")[0].strip(),
                        })
        except Exception as e:
            logger.debug(f"Rezka details merge skipped: {e}")

        # Гарантируем, что для сериалов в списке всегда первыми стоят TVShows и LostFilm
        has_tvshows = any("tvshows" in t["name"].lower() for t in translators)
        if not has_tvshows:
            translators.append({
                "id": "rezka_tvshows",
                "name": "TVShows (Проф. многоголосый)",
                "source": "rezka",
                "rezka_id": 3,
                "rezka_voice": "TVShows",
            })
        has_lostfilm = any("lostfilm" in t["name"].lower() for t in translators)
        if not has_lostfilm:
            translators.append({
                "id": "rezka_lostfilm",
                "name": "LostFilm (Проф. многоголосый)",
                "source": "rezka",
                "rezka_id": 0,
                "rezka_voice": "LostFilm",
            })

        # Принудительно ставим TVShows на 1 место, а LostFilm на 2 место!
        def _sort_voice_key(t):
            t_name = (t.get("name") or "").lower()
            if "tvshows" in t_name:
                return 0
            if "lostfilm" in t_name:
                return 1
            if t.get("source") == "rezka":
                return 2
            return 3
        translators.sort(key=_sort_voice_key)

    if not translators:
        translators = [{"id": 0, "name": "Стандартная (Дубляж)"}]
        
    return {
        "id": f"{media_type}_{tmdb_id}",
        "tmdb_id": tmdb_id,
        "imdb_id": imdb_id,
        "title": title,
        "orig_title": orig_title,
        "poster_url": poster_url,
        "description": description,
        "year": year,
        "rating": rating,
        "type": media_type,
        "url": f"/details/{media_type}/{tmdb_id}",
        "translators": translators,
        "seasons": seasons,
    }

# ---------------------------------------------------------------------------
# Получение прямого HLS видеопотока
# ---------------------------------------------------------------------------
async def get_stream(
    media_type: str,
    tmdb_id: str | int,
    translator_id: int = 0,
    season: int | None = None,
    episode: int | None = None,
) -> dict:
    """Получает прямой рабочий master.m3u8 поток с выбранной озвучкой и качествами."""
    client = await _get_client()
    imdb_id = await get_imdb_id(media_type, tmdb_id)
    if not imdb_id:
        return {"error": "IMDB ID не найден для этого фильма"}
        
    collaps_url = f"{COLLAPS_EMBED_BASE}/imdb/{imdb_id}"
    resp = await client.get(collaps_url, headers=COLLAPS_HEADERS)
    if resp.status_code != 200:
        return {"error": f"Балансер вернул статус {resp.status_code}"}
        
    html = resp.text
    
    # 1. Извлекаем секретный токен для HLS потока
    token_val = ""
    token_match = re.search(r'var\s+lok\s*=\s*1\s*,\s*([a-f0-9]+)\s*=\s*["\']([^"\']+)["\']', html)
    if token_match:
        token_val = token_match.group(2)
        
    base_hls = ""
    audio_tracks = []
    
    # 2. Если сериал — ищем нужный сезон и серию
    if media_type == "series" and season is not None and episode is not None:
        for line in html.split("\n"):
            if "seasons:[{" in line or "seasons: [{" in line:
                m = re.search(r'seasons\s*:\s*(\[\s*\{.*\}\s*\])', line)
                if m:
                    s_list = json.loads(m.group(1))
                    for s in s_list:
                        if s.get("season") == season:
                            for ep in s.get("episodes", []):
                                if int(ep.get("episode", -1)) == episode:
                                    base_hls = ep.get("hls", "")
                                    audio_tracks = ep.get("audio", {}).get("names", [])
                                    break
                break
    else:
        # 3. Фильм
        hls_match = re.search(r'hls\s*:\s*["\']([^"\']+)["\']', html)
        if hls_match:
            base_hls = hls_match.group(1)
        audio_match = re.search(r'audio\s*:\s*(\{.*?\})\s*,\s*subtitles', html, re.DOTALL)
        if audio_match:
            try:
                aud_data = json.loads(audio_match.group(1))
                audio_tracks = aud_data.get("names", [])
            except Exception:
                pass

    if not base_hls:
        return {"error": "Видеопоток не найден на балансере"}

    # Добавляем защитный токен к ссылке
    final_hls = base_hls
    if token_val:
        final_hls += ("&" if "?" in base_hls else "?") + token_val

    # В Collaps один master.m3u8 содержит сразу все качества (360p, 480p, 720p, 1080p)
    # и все аудиодорожки
    streams = {
        "Auto (1080p/720p)": final_hls,
        "1080p": final_hls,
        "720p": final_hls,
        "480p": final_hls,
        "360p": final_hls,
    }
    
    return {
        "streams": streams,
        "hls_url": final_hls,
        "audio_tracks": audio_tracks,
        "selected_audio_index": translator_id,
    }

# ---------------------------------------------------------------------------
# Получение метаданных эпизодов из TMDB
# ---------------------------------------------------------------------------
async def get_episode_names(tv_id: str | int, season_number: int) -> dict:
    """Get episode names, overviews, and runtimes from TMDB."""
    clean_id = str(tv_id).replace("series_", "").replace("tv_", "")
    client = await _get_client()
    url = f"{TMDB_BASE}/tv/{clean_id}/season/{season_number}"
    params = {"api_key": TMDB_API_KEY, "language": "ru-RU"}

    try:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        episodes = {}
        for ep in data.get("episodes", []):
            ep_num = ep.get("episode_number")
            if ep_num:
                episodes[str(ep_num)] = {
                    "name": ep.get("name") or f"Серия {ep_num}",
                    "overview": ep.get("overview") or "",
                    "runtime": ep.get("runtime"),
                    "still_path": f"https://image.tmdb.org/t/p/w300{ep['still_path']}" if ep.get("still_path") else None,
                }
        return {"episodes": episodes}
    except Exception as e:
        logger.error(f"Error fetching episode names for tv/{tv_id}/season/{season_number}: {e}")
        return {"episodes": {}}

# ---------------------------------------------------------------------------
# Получение потока из Kodik
# ---------------------------------------------------------------------------
async def get_stream_kodik(
    media_type: str,
    tmdb_id: str | int,
    translator_id: int = 0,
    season: int | None = None,
    episode: int | None = None,
) -> dict:
    """Try to get stream from Kodik balancer."""
    try:
        clean_id = str(tmdb_id).replace("series_", "").replace("tv_", "").replace("movie_", "")
        from server.parsers import kodik
        # Get IMDB ID first
        imdb_id = await get_imdb_id(media_type, clean_id)

        # Get title from TMDB for search
        client = await _get_client()
        m_type = "tv" if media_type == "series" else "movie"
        url = f"{TMDB_BASE}/{m_type}/{tmdb_id}"
        params = {"api_key": TMDB_API_KEY, "language": "ru-RU"}
        resp = await client.get(url, params=params)
        title = ""
        if resp.status_code == 200:
            tmdb_data = resp.json()
            title = tmdb_data.get("title") or tmdb_data.get("name") or ""

        if not title:
            return {"error": "Не удалось найти фильм в Kodik"}

        results = await kodik.search(title)
        if not results:
            return {"error": "Фильм не найден в Kodik"}

        # Find best match
        best = results[0]
        kodik_link = best.get("url") or ""
        if not kodik_link:
            items = best.get("_items", [])
            if items:
                kodik_link = items[0].get("link", "")

        if not kodik_link:
            return {"error": "Ссылка на поток не найдена в Kodik"}

        stream_info = await kodik.get_stream_for_item(kodik_link)
        player_url = stream_info.get("player_url", "")

        if not player_url:
            return {"error": "Видеопоток не найден в Kodik"}

        return {
            "player_url": player_url,
            "source": "kodik",
            "audio_tracks": [t["name"] for t in best.get("translators", [])],
        }
    except Exception as e:
        logger.error(f"Kodik stream error: {e}")
        return {"error": f"Kodik: {e}"}

# ---------------------------------------------------------------------------
# Получение потока из HDRezka
# ---------------------------------------------------------------------------
async def get_stream_rezka(
    media_type: str,
    tmdb_id: str | int,
    translator_id: int | str = 0,
    season: int | None = None,
    episode: int | None = None,
    preferred_voice: str | None = None,
) -> dict:
    """Получает прямой рабочий поток из HDRezka через Cinemar."""
    try:
        from server.parsers import rezka
        # Преобразуем строковый ID вида "rezka_3" в число 3
        int_tid = 0
        if isinstance(translator_id, str):
            if translator_id.startswith("rezka_"):
                try:
                    int_tid = int(translator_id.replace("rezka_", ""))
                except Exception:
                    int_tid = 0
            else:
                try:
                    int_tid = int(translator_id)
                except Exception:
                    int_tid = 0
        elif isinstance(translator_id, int):
            int_tid = translator_id

        # Получаем название фильма/сериала из TMDB
        client = await _get_client()
        clean_id = str(tmdb_id).replace("series_", "").replace("tv_", "").replace("movie_", "")
        m_type = "tv" if media_type == "series" else "movie"
        url = f"{TMDB_BASE}/{m_type}/{clean_id}"
        params = {"api_key": TMDB_API_KEY, "language": "ru-RU"}
        resp = await client.get(url, params=params)
        title = ""
        if resp.status_code == 200:
            tmdb_data = resp.json()
            title = tmdb_data.get("title") or tmdb_data.get("name") or ""

        if not title:
            return {"error": "Не удалось определить название фильма"}

        # Проверяем прямую ссылку из базы
        direct_url = rezka.KNOWN_EMBEDS.get(clean_id) or rezka.KNOWN_SLUGS.get(clean_id)

        stream_info = await rezka.get_stream(
            title=title,
            season=season,
            episode=episode,
            translator_id=int_tid,
            preferred_voice=preferred_voice or "TVShows",
            item_url=direct_url,
        )
        return stream_info
    except Exception as e:
        logger.error(f"Rezka stream error: {e}")
        return {"error": f"Rezka: {e}"}
