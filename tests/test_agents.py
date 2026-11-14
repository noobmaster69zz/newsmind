import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.agents.entity import extract_tickers
from backend.agents.sentiment import score_to_signed


def test_extract_tickers_finds_multiple():
    assert extract_tickers("Nvidia surges as Microsoft expands Azure") == ["MSFT", "NVDA"]


def test_extract_tickers_whole_word_only():
    assert extract_tickers("Pineapple prices rise") == []


def test_score_to_signed():
    assert score_to_signed({"positive": 0.8, "negative": 0.1, "neutral": 0.1}) == pytest.approx(0.7)
