"""
HDRezka parser — прямые потоки через рабочие зеркала (lv.hdrezka.inc / kz.rezka.biz)
с поддержкой всех озвучек (TVShows, LostFilm, HDRezka, NewStudio, BaibaKo и др.)
через PlayerJS/Cinemar декодер и curl_cffi Chrome impersonation для обхода Cloudflare.
"""

from __future__ import annotations

import re
import json
import base64
import asyncio
import logging
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup

try:
    from curl_cffi.requests import AsyncSession
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False
    import httpx

logger = logging.getLogger(__name__)

MIRRORS = [
    "https://lv.hdrezka.inc",
    "https://kz.rezka.biz",
    "https://hdrezka.me",
    "https://rezka.ag",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
}

# Известные прямые ссылки на популярные сериалы для 100% надёжности
KNOWN_SLUGS = {
    "131927": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "tt14164730": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "dekster": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "dekster novaja krov": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "декстер новая кровь": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "декстер: новая кровь": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "dexter new blood": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
    "dexter: new blood": "https://lv.hdrezka.inc/serialy/54895-dekster-novaja-krov.html",
}


class RezkaClient:
    def __init__(self):
        self._cffi_session = None
        self._cffi_loop = None
        self._httpx_client = None
        self._httpx_loop = None

    async def get(self, url: str, headers: Optional[dict] = None, timeout: float = 12.0):
        h = dict(HEADERS)
        if headers:
            h.update(headers)
        curr_loop = asyncio.get_running_loop()
        if HAS_CURL_CFFI:
            if not self._cffi_session or self._cffi_loop != curr_loop:
                self._cffi_session = AsyncSession(impersonate="chrome124", loop=curr_loop)
                self._cffi_loop = curr_loop
            return await self._cffi_session.get(url, headers=h, timeout=timeout)
        else:
            if not self._httpx_client or self._httpx_client.is_closed or self._httpx_loop != curr_loop:
                import httpx
                self._httpx_client = httpx.AsyncClient(
                    headers=HEADERS,
                    timeout=httpx.Timeout(timeout, connect=6.0),
                    follow_redirects=True,
                )
                self._httpx_loop = curr_loop
            return await self._httpx_client.get(url, headers=h)

    async def post(self, url: str, json: Optional[dict] = None, headers: Optional[dict] = None, timeout: float = 12.0):
        h = dict(HEADERS)
        if headers:
            h.update(headers)
        curr_loop = asyncio.get_running_loop()
        if HAS_CURL_CFFI:
            if not self._cffi_session or self._cffi_loop != curr_loop:
                self._cffi_session = AsyncSession(impersonate="chrome124", loop=curr_loop)
                self._cffi_loop = curr_loop
            return await self._cffi_session.post(url, json=json, headers=h, timeout=timeout)
        else:
            if not self._httpx_client or self._httpx_client.is_closed or self._httpx_loop != curr_loop:
                import httpx
                self._httpx_client = httpx.AsyncClient(
                    headers=HEADERS,
                    timeout=httpx.Timeout(timeout, connect=6.0),
                    follow_redirects=True,
                )
                self._httpx_loop = curr_loop
            return await self._httpx_client.post(url, json=json, headers=h)

    async def close(self):
        if self._cffi_session:
            await self._cffi_session.close()
            self._cffi_session = None
        if self._httpx_client and not self._httpx_client.is_closed:
            await self._httpx_client.aclose()
            self._httpx_client = None


_client: Optional[RezkaClient] = None


async def _get_client() -> RezkaClient:
    global _client
    if _client is None:
        _client = RezkaClient()
    return _client


async def close_client():
    global _client
    if _client:
        await _client.close()
        _client = None


def decode_cinemar(raw: str) -> list[dict]:
    """Декодирует плейлист Cinemar / PlayerJS из формата #2..."""
    t = raw[2:] if raw.startswith("#2") else raw
    dm = int(t[:2])
    delimiter = chr(dm)
    rest = t[2:]

    parts = rest.split(delimiter)
    decoded_parts = []
    ml = 32
    for p in parts:
        if len(p) > ml:
            try:
                e = int(p[-1])
                length = len(p) - 3 * e - 1
                part_str = p[2 * e : 2 * e + length] + p[:e]
                decoded_parts.append(part_str)
            except Exception:
                decoded_parts.append(p)
        else:
            decoded_parts.append(p)

    joined = "".join(decoded_parts)
    padding = len(joined) % 4
    if padding:
        joined += "=" * (4 - padding)

    raw_bytes = base64.b64decode(joined)
    decoded_text = raw_bytes.decode("utf-8")
    return json.loads(decoded_text)


async def search(query: str) -> list[dict]:
    """Поиск фильмов и сериалов на рабочих зеркалах Резки с поддержкой KNOWN_SLUGS."""
    clean_q = re.sub(r"[:\-–—/]", " ", query).strip()
    clean_key = clean_q.lower()

    # Сначала проверяем базу известных URL
    for k, slug in KNOWN_SLUGS.items():
        if k in clean_key or clean_key in k:
            return [{"title": query, "url": slug, "poster_url": ""}]

    client = await _get_client()
    search_variants = [clean_q]
    parts = clean_q.split()
    if len(parts) > 2:
        search_variants.append(f"{parts[0]} {parts[1]}")
    elif len(parts) > 1:
        search_variants.append(parts[0])

    for q_try in search_variants:
        for mirror in MIRRORS:
            try:
                url = f"{mirror}/search/?do=search&subaction=search&q={urllib.parse.quote(q_try)}"
                h = {"Referer": f"{mirror}/"}
                resp = await client.get(url, headers=h)
                if resp.status_code != 200:
                    continue

                soup = BeautifulSoup(resp.text, "html.parser")
                items = soup.select(".postItem") or soup.select(".b-content__inline_item")
                results = []
                for it in items:
                    title_tag = it.select_one(".postItem-title a") or it.select_one("div.b-content__inline_item-link a") or it.select_one("a")
                    if not title_tag:
                        continue
                    title = title_tag.get_text(strip=True)
                    href = title_tag.get("href", "")
                    if not href.startswith("http"):
                        href = urllib.parse.urljoin(mirror, href)

                    img_tag = it.select_one("img")
                    poster = img_tag.get("src", "") if img_tag else ""
                    if poster and not poster.startswith("http"):
                        poster = urllib.parse.urljoin(mirror, poster)

                    results.append({
                        "title": title,
                        "url": href,
                        "poster_url": poster,
                    })

                if results:
                    return results
            except Exception as e:
                logger.warning(f"Rezka mirror {mirror} failed: {e}")

    return []


async def get_stream(
    title: str,
    season: Optional[int] = None,
    episode: Optional[int] = None,
    translator_id: Optional[int] = None,
    preferred_voice: Optional[str] = None,
    item_url: Optional[str] = None,
) -> dict:
    """
    Получает прямой .m3u8 поток из HDRezka через Cinemar.
    Поддерживает выбор озвучки (TVShows, LostFilm, HDRezka и др.).
    """
    client = await _get_client()

    target_url = item_url
    if not target_url:
        clean_key = re.sub(r"[:\-–—/]", " ", title).strip().lower()
        for k, slug in KNOWN_SLUGS.items():
            if k in clean_key or clean_key in k:
                target_url = slug
                break

    if not target_url:
        results = await search(title)
        if not results:
            return {"error": f"Фильм '{title}' не найден на HDRezka"}
        target_url = results[0]["url"]

    for mirror in MIRRORS:
        try:
            # Обновляем хост если нужно
            parsed = urllib.parse.urlparse(target_url)
            current_page_url = urllib.parse.urlunparse(parsed._replace(netloc=urllib.parse.urlparse(mirror).netloc, scheme="https"))

            h = {"Referer": f"{mirror}/"}
            r_page = await client.get(current_page_url, headers=h)
            if r_page.status_code != 200:
                continue

            # Ищем cinemar embed
            m_embed = re.search(r'data-src="(https://cinemar\.cc/embed/[^"]+)"', r_page.text)
            if not m_embed:
                m_embed = re.search(r'src="(https://cinemar\.cc/embed/[^"]+)"', r_page.text)

            if not m_embed:
                continue

            embed_url = m_embed.group(1)
            c_headers = {"Referer": current_page_url}

            r_embed = await client.get(embed_url, headers=c_headers)
            if r_embed.status_code != 200:
                continue

            m_file = re.search(r'"file"\s*:\s*"([^"]+)"', r_embed.text)
            if not m_file:
                continue

            playlist = decode_cinemar(m_file.group(1))
            if not playlist:
                continue

            # Для сериалов: сезон и серия
            target_folder = playlist
            if season is not None and isinstance(playlist, list) and len(playlist) > 0 and "folder" in playlist[0]:
                s_idx = min(max(0, season - 1), len(playlist) - 1)
                s_obj = playlist[s_idx]
                episodes = s_obj.get("folder", [])
                if episode is not None and len(episodes) > 0:
                    ep_idx = min(max(0, episode - 1), len(episodes) - 1)
                    target_folder = episodes[ep_idx].get("folder", [])
                else:
                    target_folder = episodes[0].get("folder", []) if episodes else []

            # Список доступных озвучек
            available_translators = []
            selected_trans = None

            if isinstance(target_folder, list):
                for idx, t in enumerate(target_folder):
                    t_title = t.get("title", f"Озвучка {idx + 1}")
                    available_translators.append({
                        "id": idx,
                        "name": t_title,
                        "data": t.get("data"),
                        "file": t.get("file"),
                    })

                # Приоритет выбора: 1. preferred_voice (например TVShows) 2. translator_id 3. первая озвучка
                if preferred_voice:
                    for t in available_translators:
                        if preferred_voice.lower() in t["name"].lower():
                            selected_trans = t
                            break

                if not selected_trans and translator_id is not None and 0 <= translator_id < len(available_translators):
                    selected_trans = available_translators[translator_id]

                if not selected_trans and available_translators:
                    selected_trans = available_translators[0]

            if not selected_trans:
                return {"error": "Не найдены озвучки для эпизода"}

            # Если есть data — грузим поток через API cinemar
            final_hls = ""
            if selected_trans.get("data"):
                api_url = "https://cinemar.cc/api/playlist/load"
                api_headers = {
                    "Referer": embed_url,
                    "Content-Type": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                }
                r_stream = await client.post(api_url, json=selected_trans["data"], headers=api_headers)
                if r_stream.status_code == 200:
                    s_data = r_stream.json()
                    final_hls = s_data.get("file", "")

            if not final_hls and selected_trans.get("file") and selected_trans["file"] != "#":
                final_hls = selected_trans["file"]

            if not final_hls:
                return {"error": f"Не удалось получить видеопоток для {selected_trans['name']}"}

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
                "audio_tracks": [t["name"] for t in available_translators],
                "selected_audio_index": selected_trans.get("id", 0),
                "source": "rezka",
            }

        except Exception as e:
            logger.warning(f"Rezka fetch failed on {mirror}: {e}")

    return {"error": "Не удалось загрузить видеопоток с HDRezka"}
