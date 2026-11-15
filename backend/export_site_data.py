"""Export a snapshot of the database for the static site (frontend/data/events.json).

The snapshot is also the pipeline's memory between scheduled runs: backend/seed.py
loads it back into an empty database, so stories already scored and already read
by Claude are never processed (or paid for) again.

Run:  python -m backend.export_site_data
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from backend import db, prices
from backend.agents.entity import companies
from backend.agents.impact import MARKET_KEY

OUT = Path(__file__).resolve().parents[1] / "frontend" / "data" / "events.json"
MAX_STORIES = 400  # newest stories kept on the site
CHART_DAYS = 22    # closes kept per ticker for the price charts
ID_LEN = 12        # short ids keep the file small; seed.py rebuilds the full id from the headline


def build(conn) -> dict:
    market = prices.series(conn, prices.MARKET)
    closes = {t: prices.series(conn, t) for t in companies()}
    blank = {"right": 0, "wrong": 0, "flat": 0, "early": 0, "unscored": 0}
    tally = {**blank, "d1": dict(blank), "d5": dict(blank)}
    stories = []
    for r in conn.execute(
        "SELECT n.id, n.source, n.headline, n.summary, n.url, n.published_at, s.score, s.label, "
        "i.summary AS read, i.model AS read_model "
        "FROM news n LEFT JOIN sentiment s ON s.news_id = n.id LEFT JOIN impact i ON i.news_id = n.id "
        "ORDER BY n.published_at DESC LIMIT ?", (MAX_STORIES,)
    ):
        tickers = [t["ticker"] for t in conn.execute(
            "SELECT ticker FROM news_ticker WHERE news_id = ? ORDER BY ticker", (r["id"],))]
        impact = None
        if r["read"] is not None:
            impact = {"summary": r["read"], "model": r["read_model"], "effects": [dict(e) for e in conn.execute(
                "SELECT ticker, direction, confidence, reason, link, evidence, counter FROM impact_effect WHERE news_id = ? "
                "ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, ticker", (r["id"],))]}
            # Check each call against what the stock has done since, relative to the market.
            for effect in impact["effects"]:
                effect["check"] = prices.judge(effect["direction"], r["published_at"],
                                               closes.get(effect["ticker"], []), market)
                tally[effect["check"]["status"]] += 1
                for window in ("d1", "d5"):
                    tally[window][effect["check"].get(window, {"status": "unscored"})["status"]] += 1
        stories.append({
            "id": r["id"][:ID_LEN],
            "source": r["source"],
            "headline": r["headline"],
            "summary": r["summary"],
            "url": r["url"],
            "publishedAt": r["published_at"],
            "tone": None if r["score"] is None else round(r["score"], 3),
            "toneLabel": r["label"],
            "tickers": tickers,
            "impact": impact,
        })

    briefs, digest = {}, None
    for b in conn.execute("SELECT key, body, source_hash, model, created_at FROM brief"):
        entry = {**json.loads(b["body"]), "model": b["model"], "writtenAt": b["created_at"], "hash": b["source_hash"]}
        if b["key"] == MARKET_KEY:
            digest = entry
        else:
            briefs[b["key"]] = entry

    used = {t for s in stories for t in s["tickers"]}
    used |= {e["ticker"] for s in stories if s["impact"] for e in s["impact"]["effects"]}
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "companies": {t: {"name": c["name"], "sector": c["sector"]}
                      for t, c in companies().items() if t in used},
        "market": digest,
        "briefs": briefs,
        "scorecard": tally,
        "prices": {t: [[d, round(c, 2)] for d, c in rows[-CHART_DAYS:]]
                   for t, rows in {**closes, prices.MARKET: market}.items() if rows and (t in used or t == prices.MARKET)},
        "stories": stories,
    }


if __name__ == "__main__":
    data = build(db.connect())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print({
        "stories": len(data["stories"]),
        "tagged": sum(1 for s in data["stories"] if s["tickers"]),
        "read_by_claude": sum(1 for s in data["stories"] if s["impact"]),
        "briefs": len(data["briefs"]),
        "market_digest": bool(data["market"]),
        "scorecard": data["scorecard"],
    })
