"""
HDRezka parser — поиск, озвучки, сезоны/серии, прямые HLS/MP4 потоки.

Работает через httpx + BeautifulSoup без сторонних обёрток, чтобы
не зависеть от PyPI-пакетов, которые могут отстать от смены зеркал.
"""

from __future__ import annotations

import re
import json
import base64
import logging
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urljoin, quote_plus

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------------

# Основное зеркало (при смене домена — поменять здесь)
REZKA_MIRROR = "https://rezka.ag"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Mobile Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
    "Referer": REZKA_MIRROR + "/",
}

# ---------------------------------------------------------------------------
# Дата-классы
# ---------------------------------------------------------------------------

@dataclass
class SearchResult:
    title: str
    url: str
    poster_url: str
    type: str  # "movie" | "series" | "cartoon" | "anime"
    year: str = ""
    info: str = ""  # жанр, страна и прочее

@dataclass
class Translator:
    id: int
    name: str
    is_camrip: bool = False
    is_ads: bool = False
    is_director: bool = False

@dataclass
class MediaDetails:
    id: str
    title: str
    orig_title: str
    poster_url: str
    description: str
    year: str
    rating: str
    type: str  # "movie" | "series"
    url: str
    translators: list[Translator] = field(default_factory=list)
    seasons: dict[str, list[int]] = field(default_factory=dict)  # {"1": [1,2,3], "2": [1,2]}

@dataclass
class StreamInfo:
    streams: dict[str, str]  # {"360p": "url", "720p": "url", ...}
    subtitle: Optional[str] = None
    subtitle_lns: Optional[dict] = None

# ---------------------------------------------------------------------------
# Утилиты декодирования
# ---------------------------------------------------------------------------

# Набор "мусорных" подстрок, вшитых в JS HDRezka для обфускации ссылок.
# Они периодически меняются — при поломке обновить этот список.
_TRASH_LIST: list[str] = [
    "$$!!@$$@^!@#$$@",
    "^^^^^^!@##@$$$$",
    "@!!@#!@@@###$$",
    "#!^^!@&&@!@$#",
    "!!@!!@#^^@$$$@",
    "^^^!@#!!##!@@",
    "!@!@^^#@@$$$#",
    "@#!@!@#!@#$$@",
    "!^^@$@@!@#$$@",
    "^^#@@!!@#$@$$",
]


def _decode_streams_url(encoded: str) -> str:
    """Декодирование обфусцированной строки с HLS/MP4 ссылками."""
    if not encoded or not isinstance(encoded, str):
        return encoded
    # Убрать маркер начала
    data = encoded
    if data.startswith("#h"):
        data = data[2:]
    # Убрать мусорные подстроки
    for trash in _TRASH_LIST:
        data = data.replace(trash, "")
    # Убрать остаточные спецсимволы-маркеры
    data = data.replace("//_//", "")
    try:
        decoded = base64.b64decode(data).decode("utf-8", errors="replace")
    except Exception:
        decoded = encoded
    return decoded


def _parse_streams(raw: str) -> dict[str, str]:
    """
    Разбирает декодированную строку вида:
      [360p]https://...,[480p]https://...  или  [360p]https://... or https://...
    в словарь {качество: url}.
    """
    result: dict[str, str] = {}
    if not raw:
        return result
    # Разбиваем по запятым — каждая запись: [quality]url or url2
    parts = raw.split(",")
    for part in parts:
        part = part.strip()
        m = re.match(r"\[(\d+p(?:\s*Ultra)?)\]\s*(.+)", part, re.IGNORECASE)
        if m:
            quality = m.group(1).strip()
            urls = m.group(2).strip()
            # "url1 or url2" — берём первый
            url = urls.split(" or ")[0].strip()
            result[quality] = url
    return result

# ---------------------------------------------------------------------------
# HTTP-клиент (shared)
# ---------------------------------------------------------------------------

_client: httpx.AsyncClient | None = None


async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            headers=HEADERS,
            timeout=httpx.Timeout(30.0, connect=15.0),
            follow_redirects=True,
            http2=False,
        )
    return _client


async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None

# ---------------------------------------------------------------------------
# Публичные методы
# ---------------------------------------------------------------------------

async def search(query: str) -> list[SearchResult]:
    """Поиск фильмов и сериалов по названию."""
    client = await _get_client()
    url = f"{REZKA_MIRROR}/search/?do=search&subaction=search&q={quote_plus(query)}"
    resp = await client.get(url)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    results: list[SearchResult] = []
    items = soup.select("div.b-content__inline_item")
    for item in items:
        link_tag = item.select_one("div.b-content__inline_item-link a")
        if not link_tag:
            continue
        title = link_tag.get_text(strip=True)
        href = link_tag.get("href", "")

        poster_tag = item.select_one("img")
        poster = poster_tag.get("src", "") if poster_tag else ""

        # Тип (фильм / сериал / мультфильм / аниме)
        cat = item.get("data-cat", "")
        type_map = {"1": "movie", "2": "series", "3": "cartoon", "82": "anime"}
        media_type = type_map.get(cat, "movie")

        # Дополнительная информация (год, страна, жанр)
        misc_tag = item.select_one("div.b-content__inline_item-link div")
        info = misc_tag.get_text(strip=True) if misc_tag else ""
        year_match = re.search(r"(\d{4})", info)
        year = year_match.group(1) if year_match else ""

        results.append(SearchResult(
            title=title,
            url=href,
            poster_url=poster,
            type=media_type,
            year=year,
            info=info,
        ))

    return results


async def get_details(page_url: str) -> MediaDetails:
    """Получить полные данные о фильме/сериале: озвучки, сезоны, описание."""
    client = await _get_client()
    resp = await client.get(page_url)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    # --- Базовая информация ---
    title = ""
    title_tag = soup.select_one("h1")
    if title_tag:
        title = title_tag.get_text(strip=True)

    orig_title = ""
    orig_tag = soup.select_one("div.b-post__origtitle")
    if orig_tag:
        orig_title = orig_tag.get_text(strip=True)

    poster_url = ""
    poster_tag = soup.select_one("div.b-sidecover img")
    if poster_tag:
        poster_url = poster_tag.get("src", "")

    description = ""
    desc_tag = soup.select_one("div.b-post__description_text")
    if desc_tag:
        description = desc_tag.get_text(strip=True)

    year = ""
    # Ищем в таблице характеристик
    for td in soup.select("td.l"):
        if "Дата выхода" in td.get_text() or "год" in td.get_text().lower():
            val_td = td.find_next_sibling("td")
            if val_td:
                ym = re.search(r"(\d{4})", val_td.get_text())
                if ym:
                    year = ym.group(1)
            break

    rating = ""
    rating_tag = soup.select_one("span.b-post__info_rates.imdb span")
    if rating_tag:
        rating = rating_tag.get_text(strip=True)

    # --- ID поста ---
    post_id = ""
    id_input = soup.select_one("input#post_id") or soup.select_one("[data-post_id]")
    if id_input:
        post_id = id_input.get("value", "") or id_input.get("data-post_id", "")
    if not post_id:
        id_match = re.search(r"/(\d+)-", page_url)
        if id_match:
            post_id = id_match.group(1)

    # --- Тип ---
    is_series = bool(soup.select_one("div#simple-seasons-tabs") or
                     soup.select_one("ul#translators-list"))
    # Уточняем по наличию сезонов
    seasons_block = soup.select_one("div#simple-seasons-tabs")
    media_type = "series" if seasons_block else "movie"

    # --- Озвучки ---
    translators: list[Translator] = []
    translator_list = soup.select("ul#translators-list li")
    if translator_list:
        for li in translator_list:
            tid = li.get("data-translator_id", "")
            tname = li.get_text(strip=True)
            if tid:
                translators.append(Translator(
                    id=int(tid),
                    name=tname,
                    is_camrip=li.get("data-camrip", "0") == "1",
                    is_ads=li.get("data-ads", "0") == "1",
                    is_director=li.get("data-director", "0") == "1",
                ))
    else:
        # Одна озвучка — ID зашит в JS
        js_match = re.search(
            r"sof\.tv\.initCDNSeries498\s*\(\s*(\d+)\s*,\s*(\d+)",
            resp.text,
        )
        if not js_match:
            js_match = re.search(
                r"sof\.tv\.initCDNMovies498\s*\(\s*(\d+)\s*,\s*(\d+)",
                resp.text,
            )
        if js_match:
            tid = int(js_match.group(2))
            translators.append(Translator(id=tid, name="Озвучка по умолчанию"))

    # --- Сезоны и серии ---
    seasons: dict[str, list[int]] = {}
    if media_type == "series":
        season_tabs = soup.select("li.b-simple_season__item")
        episode_lists = soup.select("ul.b-simple_episodes__list")

        for i, tab in enumerate(season_tabs):
            s_num = tab.get("data-tab_id", str(i + 1))
            episodes: list[int] = []
            if i < len(episode_lists):
                for ep_li in episode_lists[i].select("li.b-simple_episode__item"):
                    ep_num = ep_li.get("data-episode_id", "")
                    if ep_num:
                        episodes.append(int(ep_num))
            if not episodes:
                episodes = [1]
            seasons[s_num] = sorted(episodes)

        # Если сезоны не нашлись через HTML, попробуем через JS
        if not seasons:
            js_data = re.search(
                r"sof\.tv\.initCDNSeries498\s*\(.*?(\{.*?\})\s*\)",
                resp.text,
                re.DOTALL,
            )
            if js_data:
                try:
                    parsed = json.loads(js_data.group(1))
                    for s_key, eps in parsed.items():
                        if isinstance(eps, dict):
                            seasons[str(s_key)] = sorted(int(e) for e in eps.keys())
                except (json.JSONDecodeError, ValueError):
                    pass

    return MediaDetails(
        id=post_id,
        title=title,
        orig_title=orig_title,
        poster_url=poster_url,
        description=description,
        year=year,
        rating=rating,
        type=media_type,
        url=page_url,
        translators=translators,
        seasons=seasons,
    )


async def get_stream(
    post_id: str,
    translator_id: int,
    season: int | None = None,
    episode: int | None = None,
    *,
    page_url: str = "",
) -> StreamInfo:
    """
    Получить прямые ссылки на видеопотоки (HLS/MP4) для заданной
    озвучки, сезона и серии.
    """
    client = await _get_client()

    is_series = season is not None and episode is not None

    if is_series:
        ajax_url = f"{REZKA_MIRROR}/ajax/get_cdn_series/"
        payload = {
            "id": post_id,
            "translator_id": str(translator_id),
            "season": str(season),
            "episode": str(episode),
            "action": "get_stream",
        }
    else:
        ajax_url = f"{REZKA_MIRROR}/ajax/get_cdn_series/"
        payload = {
            "id": post_id,
            "translator_id": str(translator_id),
            "action": "get_movie",
        }

    # Рефер — страница фильма
    headers = dict(HEADERS)
    if page_url:
        headers["Referer"] = page_url

    resp = await client.post(ajax_url, data=payload, headers=headers)
    resp.raise_for_status()

    data = resp.json()
    encoded_url = data.get("url", "")
    subtitle = data.get("subtitle", "") or None
    subtitle_lns = data.get("subtitle_lns", None)

    decoded = _decode_streams_url(encoded_url)
    streams = _parse_streams(decoded)

    return StreamInfo(
        streams=streams,
        subtitle=subtitle if subtitle and subtitle != "false" else None,
        subtitle_lns=subtitle_lns if subtitle_lns else None,
    )
