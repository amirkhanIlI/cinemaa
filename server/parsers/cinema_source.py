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

async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        )
    return _client

async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None

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
