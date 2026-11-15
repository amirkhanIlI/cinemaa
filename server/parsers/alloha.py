"""
Модуль интеграции с видеобалансером Alloha TV.
Позволяет получать данные о фильмах и сериалах, доступных озвучках
(включая TVShows, LostFilm, LE-Production и др.) и ссылку на готовый плеер.
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any, Dict, List, Optional
import httpx

logger = logging.getLogger("cinema.alloha")

ALLOHA_TOKEN = "45e20a5f584becf7a64dffb7174ddf"
ALLOHA_API_URLS = [
    f"https://api.alloha.tv/?token={ALLOHA_TOKEN}",
    f"https://api.apbugall.org/?token={ALLOHA_TOKEN}",
]

# Кэш ответов для минимизации лишних запросов
_cache: Dict[str, Dict[str, Any]] = {}


async def fetch_alloha_data(
    imdb_id: Optional[str] = None,
    kp_id: Optional[str | int] = None,
    tmdb_id: Optional[str | int] = None,
) -> Optional[Dict[str, Any]]:
    """Получить сырые данные фильма/сериала от Alloha."""
    cache_key = f"{imdb_id}_{kp_id}_{tmdb_id}"
    if cache_key in _cache:
        return _cache[cache_key]

    params = {}
    if imdb_id:
        params["imdb"] = str(imdb_id)
    if kp_id:
        params["kp"] = str(kp_id)
    if tmdb_id:
        params["tmdb"] = str(tmdb_id)

    if not params:
        return None

    query_str = urllib.parse.urlencode(params)

    async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
        for base_url in ALLOHA_API_URLS:
            try:
                url = f"{base_url}&{query_str}"
                resp = await client.get(url, headers={"User-Agent": "CleanCinema/1.0"})
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("status") == "success" and data.get("data"):
                        result = data["data"]
                        _cache[cache_key] = result
                        return result
            except Exception as e:
                logger.warning(f"[Alloha] Failed to fetch from {base_url}: {e}")

    return None


async def get_alloha_player(
    imdb_id: Optional[str] = None,
    kp_id: Optional[str | int] = None,
    tmdb_id: Optional[str | int] = None,
    season: Optional[int] = None,
    episode: Optional[int] = None,
    translation: Optional[str | int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Получить прямую ссылку на плеер Alloha и список доступных озвучек.
    """
    data = await fetch_alloha_data(imdb_id=imdb_id, kp_id=kp_id, tmdb_id=tmdb_id)
    if not data:
        return None

    raw_iframe = data.get("iframe") or data.get("iframe_url")
    if not raw_iframe:
        return None

    # Собираем список всех озвучек
    translations_map: Dict[int, str] = {}
    seasons_data = data.get("seasons", {})

    if isinstance(seasons_data, dict):
        for s_key, s_val in seasons_data.items():
            eps = s_val.get("episodes", {})
            if isinstance(eps, dict):
                for e_key, e_val in eps.items():
                    tr_dict = e_val.get("translation", {})
                    if isinstance(tr_dict, dict):
                        for tr_id, tr_info in tr_dict.items():
                            try:
                                tid = int(tr_id)
                                tname = tr_info.get("translation")
                                if tname and tid not in translations_map:
                                    translations_map[tid] = tname
                            except (ValueError, TypeError):
                                pass

    # Для фильмов
    if not translations_map and data.get("translation"):
        tr_info = data.get("translation")
        if isinstance(tr_info, dict):
            for tr_id, tr_name in tr_info.items():
                try:
                    translations_map[int(tr_id)] = str(tr_name)
                except Exception:
                    pass

    translations_list = [{"id": k, "name": v} for k, v in translations_map.items()]

    # Ищем подходящий id перевода, если передан name или id
    target_translation_id = None
    if translation is not None:
        tr_str = str(translation).strip().lower()
        if tr_str.isdigit():
            target_translation_id = int(tr_str)
        else:
            for tid, tname in translations_map.items():
                if tr_str in tname.lower() or tname.lower() in tr_str:
                    target_translation_id = tid
                    break

    # Формируем финальный URL плеера
    iframe_url = raw_iframe
    params_to_add = {}

    if season is not None:
        params_to_add["season"] = str(season)
    if episode is not None:
        params_to_add["episode"] = str(episode)
    if target_translation_id is not None:
        params_to_add["translation"] = str(target_translation_id)

    if params_to_add:
        delimiter = "&" if "?" in iframe_url else "?"
        iframe_url += delimiter + urllib.parse.urlencode(params_to_add)

    return {
        "status": "ok",
        "name": data.get("name"),
        "iframe_url": iframe_url,
        "translations": translations_list,
        "selected_translation_id": target_translation_id,
        "has_tvshows": any("tvshows" in t["name"].lower() for t in translations_list),
    }
