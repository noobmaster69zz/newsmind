"""Export a snapshot of the database for the static site (frontend/data/events.json).

Run:  python -m backend.export_site_data
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from backend import db
from backend.agents.entity import companies

OUT = Path(__file__).resolve().parents[1] / "frontend" / "data" / "events.json"


def build(conn) -> dict:
    stories = []
    for r in conn.execute(
        "SELECT n.id, n.source, n.headline, n.summary, n.url, n.published_at, s.score, s.label "
        "FROM news n LEFT JOIN sentiment s ON s.news_id = n.id ORDER BY n.published_at DESC"
    ):
        tickers = [t["ticker"] for t in conn.execute(
            "SELECT ticker FROM news_ticker WHERE news_id = ? ORDER BY ticker", (r["id"],))]
        stories.append({
            "id": r["id"][:12],
            "source": r["source"],
            "headline": r["headline"],
            "summary": r["summary"],
            "url": r["url"],
            "publishedAt": r["published_at"],
            "tone": None if r["score"] is None else round(r["score"], 3),
            "toneLabel": r["label"],
            "tickers": tickers,
        })
    used = {t for s in stories for t in s["tickers"]}
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "companies": {t: {"name": c["name"], "sector": c["sector"]}
                      for t, c in companies().items() if t in used},
        "stories": stories,
    }


if __name__ == "__main__":
    data = build(db.connect())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tagged = sum(1 for s in data["stories"] if s["tickers"])
    print({"stories": len(data["stories"]), "tagged": tagged, "companies": len(data["companies"])})
