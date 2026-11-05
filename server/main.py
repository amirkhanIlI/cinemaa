"""
Clean Cinema — главный файл FastAPI-приложения.
Раздаёт API для поиска, деталей, HLS-стримов и истории просмотра,
а также статику для мобильного PWA.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from server.parsers import cinema_source
from server import db

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cinema")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🎬 Clean Cinema запускается...")
    await db.init_db()
    yield
    await cinema_source.close_client()
    logger.info("Clean Cinema остановлен.")


app = FastAPI(title="Clean Cinema", lifespan=lifespan)


# ---------------------------------------------------------------------------
# API — Поиск (TMDB + русские постеры)
# ---------------------------------------------------------------------------
@app.get("/api/search")
async def api_search(q: str = Query(..., min_length=1)):
    """Поиск фильмов и сериалов."""
    try:
        results = await cinema_source.search(q)
        return {"results": results}
    except Exception as e:
        logger.exception("Search error")
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# API — Популярные свежие сериалы недели (TMDB)
# ---------------------------------------------------------------------------
@app.get("/api/trending")
async def api_trending():
    """Популярные свежие сериалы недели."""
    try:
        results = await cinema_source.get_trending_series()
        return {"results": results}
    except Exception as e:
        logger.exception("Trending error")
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# API — Отладка Rezka на Render
# ---------------------------------------------------------------------------
@app.get("/api/debug_rezka")
async def api_debug_rezka():
    """Диагностика подключения к Rezka и Cinemar."""
    logs = {}
    try:
        from server.parsers import rezka
        logs["import_rezka"] = "OK"
        logs["has_curl_cffi"] = rezka.HAS_CURL_CFFI
        client = await rezka._get_client()
        for m in rezka.MIRRORS:
            try:
                r = await client.get(f"{m}/", timeout=6.0)
                logs[f"mirror_{m}"] = {"status": r.status_code, "server": r.headers.get("server"), "len": len(r.text)}
            except Exception as e:
                logs[f"mirror_{m}"] = {"error": f"{type(e).__name__}: {e}"}

        try:
            s_res = await rezka.search("Декстер: Новая кровь")
            logs["search_count"] = len(s_res)
            if s_res:
                logs["first_item"] = s_res[0]
                stream = await rezka.get_stream("Декстер: Новая кровь", season=1, episode=7, preferred_voice="TVShows")
                logs["stream_result"] = {
                    "ok": bool(stream.get("hls_url")),
                    "error": stream.get("error"),
                    "audio_tracks": stream.get("audio_tracks"),
                    "selected_idx": stream.get("selected_audio_index"),
                    "hls_sample": stream.get("hls_url", "")[:80] if stream.get("hls_url") else ""
                }
        except Exception as e:
            logs["search_or_stream_error"] = f"{type(e).__name__}: {e}"
    except Exception as e:
        logs["import_error"] = f"{type(e).__name__}: {e}"
    return logs


# ---------------------------------------------------------------------------
# API — Детальная информация (озвучки, сезоны, серии)
# ---------------------------------------------------------------------------
@app.get("/api/details")
async def api_details(url: str = Query(...)):
    """Информация о фильме/сериале: озвучки, сезоны, серии."""
    try:
        parts = url.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "details":
            m_type = "series" if parts[1] in ("tv", "series") else "movie"
            tmdb_id = parts[2]
        else:
            m_type = "movie"
            tmdb_id = url
            
        details = await cinema_source.get_details(m_type, tmdb_id)
        return details
    except Exception as e:
        logger.exception("Details error")
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# API — Метаданные эпизодов (названия, описания, хронометраж)
# ---------------------------------------------------------------------------
@app.get("/api/episodes")
async def api_episodes(tv_id: str = Query(...), season: int = Query(...)):
    """Get episode names and metadata from TMDB for a specific season."""
    try:
        data = await cinema_source.get_episode_names(tv_id, season)
        return data
    except Exception as e:
        logger.exception("Episodes metadata error")
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# API — Получение прямых HLS видеопотоков
# ---------------------------------------------------------------------------
@app.get("/api/stream")
async def api_stream(
    url: str = Query(...),
    translator_id: str | int = Query(0),
    season: int | None = Query(None),
    episode: int | None = Query(None),
    source: str = Query("collaps"),
    preferred_voice: str | None = Query(None),
):
    """Get HLS streams. source can be 'collaps', 'kodik', or 'rezka'."""
    try:
        parts = url.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "details":
            m_type = "series" if parts[1] in ("tv", "series") else "movie"
            tmdb_id = parts[2]
        else:
            m_type = "movie"
            tmdb_id = url

        stream_data = None
        if source == "kodik":
            try:
                int_tid = int(translator_id) if str(translator_id).isdigit() else 0
                stream_data = await cinema_source.get_stream_kodik(
                    media_type=m_type, tmdb_id=tmdb_id,
                    translator_id=int_tid, season=season, episode=episode,
                )
            except Exception:
                stream_data = None
        elif source == "rezka":
            try:
                stream_data = await cinema_source.get_stream_rezka(
                    media_type=m_type, tmdb_id=tmdb_id,
                    translator_id=translator_id, season=season, episode=episode,
                    preferred_voice=preferred_voice or "TVShows",
                )
            except Exception as e:
                logger.exception("Rezka stream error")
                stream_data = {"error": f"Rezka: {e}"}
            return stream_data

        # Железный авто-фоллбэк: если kodik/rezka выдали ошибку или пустой результат,
        # сервер сам мгновенно переключается на рабочий Collaps, чтобы видео ВСЕГДА играло!
        if not stream_data or stream_data.get("error") or not stream_data.get("streams"):
            int_tid = int(translator_id) if str(translator_id).isdigit() else 0
            stream_data = await cinema_source.get_stream(
                media_type=m_type,
                tmdb_id=tmdb_id,
                translator_id=int_tid,
                season=season,
                episode=episode,
            )
        return stream_data
    except Exception as e:
        logger.exception("Stream error")
        return JSONResponse({"error": str(e)}, status_code=502)


# ---------------------------------------------------------------------------
# API — История просмотров
# ---------------------------------------------------------------------------
@app.get("/api/history")
async def api_get_history():
    """Получить список сохранённых просмотров."""
    items = await db.get_history()
    return {"items": items}


@app.post("/api/history")
async def api_save_history(request: Request):
    """Сохранить прогресс просмотра (вызывается sendBeacon)."""
    try:
        body = await request.body()
        data = json.loads(body)
        await db.upsert_progress(
            film_id=str(data.get("filmId", "")),
            title=data.get("title", ""),
            poster_url=data.get("poster", ""),
            media_type=data.get("type", "movie"),
            season=data.get("season"),
            episode=data.get("episode"),
            translator_id=data.get("translatorId"),
            translator_name=data.get("translatorName", ""),
            position=float(data.get("time", 0)),
            duration=float(data.get("duration", 0)),
            film_url=data.get("filmUrl", ""),
        )
        return {"ok": True}
    except Exception as e:
        logger.exception("History save error")
        return JSONResponse({"error": str(e)}, status_code=400)


@app.delete("/api/history/{film_id}")
async def api_delete_history(film_id: str):
    """Удалить запись из истории."""
    await db.delete_history_item(film_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Раздача статических файлов и SPA fallback
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    """Раздаёт index.html для мобильного PWA."""
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return HTMLResponse(index_file.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>Clean Cinema</h1><p>Frontend not found.</p>")
