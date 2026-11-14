"""SQLite layer: schema + idempotent upserts. (Swap for Postgres later via same interface.)"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[1] / "newsmind.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS news (
    id           TEXT PRIMARY KEY,      -- sha256 of normalised headline (dedupe key)
    source       TEXT NOT NULL,
    headline     TEXT NOT NULL,
    summary      TEXT,
    url          TEXT,
    published_at TEXT NOT NULL,         -- ISO-8601 UTC
    ingested_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at);

CREATE TABLE IF NOT EXISTS news_ticker (
    news_id TEXT NOT NULL REFERENCES news(id),
    ticker  TEXT NOT NULL,
    PRIMARY KEY (news_id, ticker)
);
CREATE INDEX IF NOT EXISTS idx_news_ticker_ticker ON news_ticker(ticker);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    fetched    INTEGER NOT NULL,
    inserted   INTEGER NOT NULL,
    rejected   INTEGER NOT NULL
);
"""


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def upsert_news(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Insert new articles (ignore duplicates). Returns number actually inserted."""
    inserted = 0
    for r in rows:
        cur = conn.execute(
            "INSERT OR IGNORE INTO news (id, source, headline, summary, url, published_at) "
            "VALUES (:id, :source, :headline, :summary, :url, :published_at)",
            r,
        )
        if cur.rowcount:
            inserted += 1
            conn.executemany(
                "INSERT OR IGNORE INTO news_ticker (news_id, ticker) VALUES (?, ?)",
                [(r["id"], t) for t in r.get("tickers", [])],
            )
    conn.commit()
    return inserted
