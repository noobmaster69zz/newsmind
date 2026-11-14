"""Sentiment agent: FinBERT score in [-1, 1] (positive prob - negative prob)."""
from __future__ import annotations

from functools import lru_cache


@lru_cache(maxsize=1)
def _pipeline():
    from transformers import pipeline  # imported lazily: heavy dependency

    return pipeline("text-classification", model="ProsusAI/finbert", top_k=None)


def score_to_signed(probs: dict[str, float]) -> float:
    """Convert FinBERT label probabilities into one signed score."""
    return probs.get("positive", 0.0) - probs.get("negative", 0.0)


def score_headline(headline: str) -> float:
    out = _pipeline()([headline])[0]
    return score_to_signed({d["label"].lower(): d["score"] for d in out})
