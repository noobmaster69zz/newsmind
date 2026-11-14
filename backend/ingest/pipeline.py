"""ETL pipeline: Finnhub news -> validate/dedupe -> SQLite.

Run:  python -m backend.ingest.pipeline
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

from backend import db
from backend.agents.entity import extract_tickers

log = logging.getLogger("newsmind.ingest")
FINNHUB_URL = "https://finnhub.io/api/v1/news"


def load_env(path: Path | None = None) -> None:
    """Minimal .env loader (no extra dependency)."""
    path = path or Path(__file__).resolve().parents[2] / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


# ---------- Extract ----------
def extract(category: str = "general", token: str | None = None) -> list[dict]:
    token = token or os.environ["FINNHUB_API_KEY"]
    resp = requests.get(FINNHUB_URL, params={"category": category, "token": token}, timeout=15)
    resp.raise_for_status()
    return resp.json()


# ---------- Transform ----------
def normalise(headline: str) -> str:
    return re.sub(r"\s+", " ", headline).strip()


def headline_id(headline: str) -> str:
    return hashlib.sha256(normalise(headline).lower().encode()).hexdigest()


def transform(raw: list[dict]) -> tuple[list[dict], int]:
    """Validate, clean, dedupe, tag tickers. Returns (clean_rows, rejected_count)."""
    clean, seen, rejected = [], set(), 0
    for item in raw:
        headline = normalise(item.get("headline") or "")
        ts = item.get("datetime")
        if len(headline) < 15 or not ts:  # data-quality rule
            rejected += 1
            continue
        hid = headline_id(headline)
        if hid in seen:  # in-batch dedupe
            rejected += 1
            continue
        seen.add(hid)
        summary = item.get("summary") or ""
        clean.append({
            "id": hid,
            "source": item.get("source") or "unknown",
            "headline": headline,
            "summary": summary,
            "url": item.get("url"),
            "published_at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            "tickers": extract_tickers(f"{headline}. {summary}"),
        })
    return clean, rejected


# ---------- Load ----------
def run(category: str = "general", conn=None) -> dict:
    load_env()
    conn = conn or db.connect()
    started = datetime.now(timezone.utc).isoformat()
    raw = extract(category)
    rows, rejected = transform(raw)
    inserted = db.upsert_news(conn, rows)
    conn.execute(
        "INSERT INTO pipeline_runs (started_at, fetched, inserted, rejected) VALUES (?,?,?,?)",
        (started, len(raw), inserted, rejected),
    )
    conn.commit()
    stats = {"fetched": len(raw), "inserted": inserted, "rejected": rejected}
    log.info("ingest done: %s", stats)
    return stats


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())
