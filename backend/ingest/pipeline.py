"""ETL pipeline: Finnhub news -> validate/dedupe/tag -> SQLite.

Two feeds are pulled each run:
  * the general market wire (macro, politics, world news)
  * the per-company feed for every tracked ticker in backend/data/companies.json

Run:  python -m backend.ingest.pipeline
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

from backend import db
from backend.agents.entity import companies, extract_tickers

log = logging.getLogger("newsmind.ingest")
FINNHUB = "https://finnhub.io/api/v1"
PER_COMPANY_LIMIT = 12  # newest stories kept per ticker, keeps one loud company from flooding the wire
SOURCE_SUFFIX = re.compile(r"\s+[-|]\s+(Reuters|CNBC|Bloomberg|MarketWatch|Yahoo Finance)\s*$", re.I)


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
def _get(path: str, **params) -> list[dict]:
    params["token"] = os.environ["FINNHUB_API_KEY"]
    resp = requests.get(f"{FINNHUB}/{path}", params=params, timeout=15)
    resp.raise_for_status()
    return resp.json()


def extract_general(category: str = "general") -> list[dict]:
    return _get("news", category=category)


def extract_company(ticker: str, days: int = 3) -> list[dict]:
    today = date.today()
    items = _get("company-news", symbol=ticker, **{"from": str(today - timedelta(days=days)), "to": str(today)})
    items.sort(key=lambda i: i.get("datetime") or 0, reverse=True)
    return items[:PER_COMPANY_LIMIT]


# ---------- Transform ----------
def normalise(headline: str) -> str:
    headline = re.sub(r"\s+", " ", headline).strip()
    return SOURCE_SUFFIX.sub("", headline)


def headline_id(headline: str) -> str:
    return hashlib.sha256(normalise(headline).lower().encode()).hexdigest()


def transform(raw: list[dict], feed_ticker: str | None = None) -> tuple[list[dict], int]:
    """Validate, clean, dedupe, tag tickers. Returns (clean_rows, rejected_count).

    feed_ticker: the company feed the batch came from. It is only trusted as a tag
    when the story text itself names that company, because Finnhub's company feeds
    include loosely related market round-ups.
    """
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
        summary = (item.get("summary") or "").strip()
        tickers = extract_tickers(f"{headline}. {summary}")
        if feed_ticker and feed_ticker not in tickers:  # off-topic for this company feed
            rejected += 1
            continue
        clean.append({
            "id": hid,
            "source": item.get("source") or "unknown",
            "headline": headline,
            "summary": summary,
            "url": item.get("url"),
            "published_at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            "tickers": tickers,
        })
    return clean, rejected


# ---------- Load ----------
def run(conn=None, with_companies: bool = True) -> dict:
    load_env()
    conn = conn or db.connect()
    started = datetime.now(timezone.utc).isoformat()
    fetched = inserted = rejected = 0

    feeds: list[tuple[str | None, list[dict]]] = [(None, extract_general())]
    if with_companies:
        for ticker in companies():
            try:
                feeds.append((ticker, extract_company(ticker)))
            except requests.RequestException as exc:  # one bad feed must not sink the run
                log.warning("company feed %s failed: %s", ticker, exc)
            time.sleep(0.25)  # stay well under Finnhub's 60 calls/minute

    for ticker, raw in feeds:
        rows, bad = transform(raw, feed_ticker=ticker)
        fetched += len(raw)
        rejected += bad
        inserted += db.upsert_news(conn, rows)

    conn.execute(
        "INSERT INTO pipeline_runs (started_at, fetched, inserted, rejected) VALUES (?,?,?,?)",
        (started, fetched, inserted, rejected),
    )
    conn.commit()
    stats = {"fetched": fetched, "inserted": inserted, "rejected": rejected}
    log.info("ingest done: %s", stats)
    return stats


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())
