"""Load the last exported snapshot back into the database.

The scheduled job starts from an empty database every time (SQLite files are not
committed). Seeding from frontend/data/events.json restores everything already
known, so the run only does work, and only spends Claude credit, on new stories.

Run:  python -m backend.seed
"""
from __future__ import annotations

import json
from pathlib import Path

from backend import db
from backend.agents.impact import MARKET_KEY
from backend.agents.sentiment import MODEL as SENTIMENT_MODEL
from backend.ingest.pipeline import headline_id

SNAPSHOT = Path(__file__).resolve().parents[1] / "frontend" / "data" / "events.json"


def seed(conn, data: dict) -> dict:
    counts = {"stories": 0, "sentiment": 0, "impact": 0, "briefs": 0}
    for s in data.get("stories", []):
        news_id = headline_id(s["headline"])  # the snapshot stores a shortened id
        conn.execute(
            "INSERT OR IGNORE INTO news (id, source, headline, summary, url, published_at) VALUES (?,?,?,?,?,?)",
            (news_id, s["source"], s["headline"], s.get("summary"), s.get("url"), s["publishedAt"]))
        conn.executemany("INSERT OR IGNORE INTO news_ticker (news_id, ticker) VALUES (?,?)",
                         [(news_id, t) for t in s.get("tickers", [])])
        counts["stories"] += 1
        if s.get("tone") is not None:
            conn.execute("INSERT OR IGNORE INTO sentiment (news_id, score, label, model) VALUES (?,?,?,?)",
                         (news_id, s["tone"], s["toneLabel"], SENTIMENT_MODEL))
            counts["sentiment"] += 1
        impact = s.get("impact")
        if impact:
            conn.execute("INSERT OR IGNORE INTO impact (news_id, summary, model) VALUES (?,?,?)",
                         (news_id, impact["summary"], impact.get("model", "unknown")))
            conn.executemany(
                "INSERT OR IGNORE INTO impact_effect (news_id, ticker, direction, confidence, reason) "
                "VALUES (?,?,?,?,?)",
                [(news_id, e["ticker"], e["direction"], e["confidence"], e["reason"]) for e in impact["effects"]])
            counts["impact"] += 1

    saved = dict(data.get("briefs") or {})
    if data.get("market"):
        saved[MARKET_KEY] = data["market"]
    for key, entry in saved.items():
        body = {k: v for k, v in entry.items() if k not in ("model", "writtenAt", "hash")}
        conn.execute(
            "INSERT OR IGNORE INTO brief (key, body, source_hash, model, created_at) VALUES (?,?,?,?,?)",
            (key, json.dumps(body, ensure_ascii=False), entry.get("hash", ""), entry.get("model", "unknown"),
             entry.get("writtenAt", "")))
        counts["briefs"] += 1
    conn.commit()
    return counts


if __name__ == "__main__":
    if not SNAPSHOT.exists():
        print({"seeded": "no snapshot yet"})
    else:
        print(seed(db.connect(), json.loads(SNAPSHOT.read_text(encoding="utf-8"))))
