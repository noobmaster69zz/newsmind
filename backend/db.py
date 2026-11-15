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

CREATE TABLE IF NOT EXISTS sentiment (
    news_id TEXT PRIMARY KEY REFERENCES news(id),
    score   REAL NOT NULL,              -- P(positive) - P(negative), in [-1, 1]
    label   TEXT NOT NULL,              -- positive | negative | neutral
    model   TEXT NOT NULL
);

-- Claude's read of one story: a one-line summary plus one row per affected company.
CREATE TABLE IF NOT EXISTS impact (
    news_id    TEXT PRIMARY KEY REFERENCES news(id),
    summary    TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS impact_effect (
    news_id    TEXT NOT NULL REFERENCES impact(news_id),
    ticker     TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('up', 'down', 'mixed')),
    confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    reason     TEXT NOT NULL,
    link       TEXT,                    -- direct | indirect
    evidence   TEXT,                    -- the words in the story that support the link
    counter    TEXT,                    -- what would make the call wrong
    PRIMARY KEY (news_id, ticker)
);
CREATE INDEX IF NOT EXISTS idx_impact_effect_ticker ON impact_effect(ticker);

-- Saved write-ups the site's assistant reads back: one per company, plus '_market'.
-- source_hash records which stories a brief was written from, so it is only
-- regenerated (and paid for) when that set of stories changes.
CREATE TABLE IF NOT EXISTS brief (
    key         TEXT PRIMARY KEY,
    body        TEXT NOT NULL,          -- JSON
    source_hash TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily closing prices for tracked tickers and the market (SPY).
CREATE TABLE IF NOT EXISTS price (
    ticker TEXT NOT NULL,
    day    TEXT NOT NULL,               -- YYYY-MM-DD
    close  REAL NOT NULL,
    PRIMARY KEY (ticker, day)
);

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
    # Migration for databases created before the reasoning columns existed.
    have = {r["name"] for r in conn.execute("PRAGMA table_info(impact_effect)")}
    for column in ("link", "evidence", "counter"):
        if column not in have:
            conn.execute(f"ALTER TABLE impact_effect ADD COLUMN {column} TEXT")
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
        inserted += cur.rowcount
        # Always link tickers: the same story can arrive again under another company's feed.
        conn.executemany(
            "INSERT OR IGNORE INTO news_ticker (news_id, ticker) VALUES (?, ?)",
            [(r["id"], t) for t in r.get("tickers", [])],
        )
    conn.commit()
    return inserted
