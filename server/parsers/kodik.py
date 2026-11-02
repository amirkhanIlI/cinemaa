"""
Kodik parser / API client — резервный и надёжный источник фильмов, сериалов и аниме.
API Kodik отдаёт прямые видеопотоки без Cloudflare-капчи и имеет огромную базу
с разбивкой по студиям озвучки (LostFilm, TVShows, HDRezka, Дубляж, Кубик в кубе и др.).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import quote_plus
import httpx

logger = logging.getLogger(__name__)

# Публичный токен Kodik (стандартный для открытых клиентов)
KODIK_API_URL = "https://kodikapi.com"
KODIK_TOKEN = "q848f02047db370724a8e0f146f731e8"  # Общеизвестный рабочий публичный токен

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

_client: Optional[httpx.AsyncClient] = None

async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            headers=HEADERS,
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=True,
        )
    return _client

async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None

@dataclass
class KodikSearchResult:
    id: str
    title: str
    orig_title: str
    year: str
    type: str  # "movie" | "series"
    poster_url: str
    kinopoisk_id: str
    imdb_id: str
    translation_title: str
    translation_id: int
    link: str

async def search(query: str, limit: int = 30) -> list[dict]:
    """Поиск материалов через Kodik API."""
    client = await _get_client()
    url = f"{KODIK_API_URL}/search"
    params = {
        "token": KODIK_TOKEN,
        "title": query,
        "limit": limit,
        "with_material_data": "true",
    }
    
    try:
        resp = await client.get(url, params=params)
        if resp.status_code != 200:
            logger.warning(f"Kodik search returned {resp.status_code}")
            return []
        
        data = resp.json()
        results = data.get("results", [])
        
        # Группируем по материалу (kinopoisk_id или title+year)
        grouped: dict[str, dict] = {}
        for item in results:
            kp_id = str(item.get("kinopoisk_id") or "")
            title = item.get("title") or item.get("title_orig") or "Без названия"
            year = str(item.get("year") or "")
            key = kp_id if kp_id else f"{title}_{year}"
            
            material_data = item.get("material_data") or {}
            poster = material_data.get("poster_url") or ""
            description = material_data.get("description") or ""
            rating = str(material_data.get("kinopoisk_rating") or material_data.get("imdb_rating") or "")
            
            # Определение типа
            item_type = item.get("type", "movie")
            is_series = "serial" in item_type or item.get("seasons") is not None
            type_str = "series" if is_series else "movie"
            
            translation = item.get("translation") or {}
            t_id = translation.get("id")
            t_title = translation.get("title") or "Оригинал / Стандартная"
            
            if key not in grouped:
                grouped[key] = {
                    "id": f"kodik_{item.get('id')}",
                    "raw_id": item.get("id"),
                    "title": title,
                    "orig_title": item.get("title_orig") or "",
                    "poster_url": poster,
                    "year": year,
                    "rating": rating,
                    "description": description,
                    "type": type_str,
                    "source": "kodik",
                    "url": item.get("link") or "",
                    "translators": [],
                    "seasons": {},
                    "_items": [],
                }
            
            grouped[key]["_items"].append(item)
            if t_id and not any(t["id"] == t_id for t in grouped[key]["translators"]):
                grouped[key]["translators"].append({
                    "id": t_id,
                    "name": t_title
                })
        
        return list(grouped.values())
    except Exception as e:
        logger.error(f"Kodik search exception: {e}")
        return []

async def get_stream_for_item(link: str) -> dict[str, str]:
    """
    Извлекает видеопоток из Kodik плеера.
    Kodik ссылка обычно вида //kodik.info/video/... или //aniqit.com/video/...
    """
    if not link.startswith("http"):
        link = "https:" + link
    
    # Kodik iframe отдаёт плеер, который можно напрямую вставить или распарсить его m3u8
    # Если это iframe link, отдаем его как плеерный url
    return {
        "player_url": link
    }
