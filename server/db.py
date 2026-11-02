"""
SQLite-хранилище истории просмотров.
Работает асинхронно через aiosqlite.
"""

from __future__ import annotations

import os
import time
import aiosqlite

DB_PATH = os.environ.get("CINEMA_DB_PATH", "cinema_history.db")

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS watch_history (
    film_id   TEXT NOT NULL,
    title     TEXT NOT NULL DEFAULT '',
    poster_url TEXT NOT NULL DEFAULT '',
    type      TEXT NOT NULL DEFAULT 'movie',
    season    INTEGER,
    episode   INTEGER,
    translator_id   INTEGER,
    translator_name TEXT NOT NULL DEFAULT '',
    position  REAL NOT NULL DEFAULT 0,
    duration  REAL NOT NULL DEFAULT 0,
    film_url  TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL,
    PRIMARY KEY (film_id)
);
"""


async def init_db():
    """Создать таблицу, если ещё нет."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(_CREATE_TABLE)
        await db.commit()


async def upsert_progress(
    film_id: str,
    title: str = "",
    poster_url: str = "",
    media_type: str = "movie",
    season: int | None = None,
    episode: int | None = None,
    translator_id: int | None = None,
    translator_name: str = "",
    position: float = 0,
    duration: float = 0,
    film_url: str = "",
):
    """Вставить или обновить запись о прогрессе просмотра."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO watch_history
                (film_id, title, poster_url, type, season, episode,
                 translator_id, translator_name, position, duration, film_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(film_id) DO UPDATE SET
                title = excluded.title,
                poster_url = excluded.poster_url,
                type = excluded.type,
                season = excluded.season,
                episode = excluded.episode,
                translator_id = excluded.translator_id,
                translator_name = excluded.translator_name,
                position = excluded.position,
                duration = excluded.duration,
                film_url = excluded.film_url,
                updated_at = excluded.updated_at
            """,
            (
                film_id, title, poster_url, media_type,
                season, episode, translator_id, translator_name,
                position, duration, film_url, time.time(),
            ),
        )
        await db.commit()


async def get_history(limit: int = 30) -> list[dict]:
    """
    Получить список незавершённых просмотров,
    отсортированных по дате последнего обновления.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT * FROM watch_history
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def delete_history_item(film_id: str):
    """Удалить запись из истории."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM watch_history WHERE film_id = ?", (film_id,))
        await db.commit()
