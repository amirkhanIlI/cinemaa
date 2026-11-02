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
# API — Получение прямых HLS видеопотоков
# ---------------------------------------------------------------------------
@app.get("/api/stream")
async def api_stream(
    url: str = Query(...),
    translator_id: int = Query(0),
    season: int | None = Query(None),
    episode: int | None = Query(None),
):
    """Получить прямые ссылки на HLS видеопотоки."""
    try:
        parts = url.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "details":
            m_type = "series" if parts[1] in ("tv", "series") else "movie"
            tmdb_id = parts[2]
        else:
            m_type = "movie"
            tmdb_id = url

        stream_data = await cinema_source.get_stream(
            media_type=m_type,
            tmdb_id=tmdb_id,
            translator_id=translator_id,
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
