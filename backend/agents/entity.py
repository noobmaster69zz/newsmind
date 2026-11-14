"""Entity agent: map a headline to tracked tickers via a company-name/alias table."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

COMPANIES_PATH = Path(__file__).resolve().parents[1] / "data" / "companies.json"


@lru_cache(maxsize=1)
def companies() -> dict[str, dict]:
    """Tracked companies keyed by ticker: {name, sector, aliases}."""
    rows = json.loads(COMPANIES_PATH.read_text(encoding="utf-8"))
    return {r["ticker"]: r for r in rows}


@lru_cache(maxsize=1)
def _patterns() -> list[tuple[str, re.Pattern]]:
    out = []
    for ticker, c in companies().items():
        alt = "|".join(re.escape(a) for a in c["aliases"])
        out.append((ticker, re.compile(rf"\b(?:{alt})\b")))
    return out


def extract_tickers(text: str) -> list[str]:
    """Return sorted tickers whose alias appears as a whole word/phrase in the text."""
    text = text.lower()
    return sorted(t for t, pat in _patterns() if pat.search(text))
