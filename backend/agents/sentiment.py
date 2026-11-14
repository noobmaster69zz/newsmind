"""Sentiment agent: FinBERT tone score in [-1, 1] (positive prob - negative prob).

Run over every unscored headline:  python -m backend.agents.sentiment
"""
from __future__ import annotations

from functools import lru_cache

MODEL = "ProsusAI/finbert"


@lru_cache(maxsize=1)
def _pipeline():
    from transformers import pipeline  # imported lazily: heavy dependency

    return pipeline("text-classification", model=MODEL, top_k=None)


def score_to_signed(probs: dict[str, float]) -> float:
    """Convert FinBERT label probabilities into one signed score."""
    return probs.get("positive", 0.0) - probs.get("negative", 0.0)


def score_headlines(headlines: list[str], batch_size: int = 16) -> list[dict]:
    """Score many headlines. Returns [{score, label}] in input order."""
    results = []
    for out in _pipeline()(headlines, batch_size=batch_size, truncation=True):
        probs = {d["label"].lower(): d["score"] for d in out}
        results.append({"score": score_to_signed(probs), "label": max(probs, key=probs.get)})
    return results


def score_headline(headline: str) -> float:
    return score_headlines([headline])[0]["score"]


def score_unscored(conn) -> int:
    """Pipeline step: score every news row that has no sentiment yet. Returns rows scored."""
    rows = conn.execute(
        "SELECT n.id, n.headline FROM news n "
        "LEFT JOIN sentiment s ON s.news_id = n.id WHERE s.news_id IS NULL"
    ).fetchall()
    if not rows:
        return 0
    scored = score_headlines([r["headline"] for r in rows])
    conn.executemany(
        "INSERT OR REPLACE INTO sentiment (news_id, score, label, model) VALUES (?,?,?,?)",
        [(r["id"], s["score"], s["label"], MODEL) for r, s in zip(rows, scored)],
    )
    conn.commit()
    return len(rows)


if __name__ == "__main__":
    from backend import db

    print({"scored": score_unscored(db.connect())})
