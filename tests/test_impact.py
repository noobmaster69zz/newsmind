import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import db
from backend.agents.impact import clean_effects, source_hash, story_prompt
from backend.export_site_data import build
from backend.ingest.pipeline import transform
from backend.seed import seed


def effect(ticker, direction="up", confidence="medium"):
    return {"ticker": ticker, "direction": direction, "confidence": confidence, "reason": "because"}


def test_clean_effects_drops_untracked_repeats_and_bad_values():
    out = clean_effects([effect("xom"), effect("XOM"), effect("ZZZZ"), effect("CVX", direction="sideways"),
                         effect("DAL", confidence="certain"), effect("BA")])
    assert [e["ticker"] for e in out] == ["XOM", "BA"]


def test_clean_effects_caps_the_list():
    out = clean_effects([effect(t) for t in ["AAPL", "MSFT", "NVDA", "AMD", "INTC", "TSM"]])
    assert len(out) == 4


def test_source_hash_ignores_order():
    assert source_hash(["a", "b", "c"]) == source_hash(["c", "a", "b"])
    assert source_hash(["a", "b"]) != source_hash(["a", "b", "c"])


def test_story_prompt_says_when_no_company_is_named():
    assert "names: none" in story_prompt("Oil jumps after tankers hit mines", "", [])


def test_snapshot_round_trip_keeps_claude_results(tmp_path):
    """export -> seed into an empty database -> export again gives the same stories and reads."""
    first = db.connect(tmp_path / "a.db")
    rows, _ = transform([{"headline": "Exxon lifts output as oil climbs on Hormuz fears",
                          "datetime": 1700000000, "source": "X", "summary": "", "url": "u"}])
    db.upsert_news(first, rows)
    news_id = rows[0]["id"]
    first.execute("INSERT INTO sentiment VALUES (?,?,?,?)", (news_id, 0.4, "positive", "ProsusAI/finbert"))
    first.execute("INSERT INTO impact (news_id, summary, model) VALUES (?,?,?)", (news_id, "Oil up.", "m"))
    first.execute("INSERT INTO impact_effect VALUES (?,?,?,?,?,?,?,?)",
                  (news_id, "CVX", "up", "medium", "Same input.", "indirect", "oil climbs", "Oil falls back."))
    first.execute("INSERT INTO brief (key, body, source_hash, model) VALUES ('XOM', '{\"brief\": \"b\"}', 'h', 'm')")
    first.commit()
    snapshot = build(first)

    second = db.connect(tmp_path / "b.db")
    assert seed(second, snapshot) == {"stories": 1, "sentiment": 1, "impact": 1, "briefs": 1}
    again = build(second)
    assert again["stories"] == snapshot["stories"]
    assert again["briefs"]["XOM"]["brief"] == "b" and again["briefs"]["XOM"]["hash"] == "h"
    # CVX is not named in the story, but Claude's read links it, so the site must know the company.
    assert "CVX" in again["companies"]


def test_judge_scores_a_call_against_the_market():
    from backend.prices import judge

    stock = [("2026-11-10", 100.0), ("2026-11-11", 100.0), ("2026-11-12", 104.0)]
    market = [("2026-11-10", 100.0), ("2026-11-11", 100.0), ("2026-11-12", 101.0)]
    noon = "2026-11-11T15:00:00+00:00"          # during the session: baseline is the 10 Nov close
    assert judge("up", noon, stock, market)["status"] == "right"
    assert judge("down", noon, stock, market)["status"] == "wrong"
    assert judge("up", noon, stock, market)["excess"] == 3.0
    assert judge("mixed", noon, stock, market)["status"] == "unscored"
    # A stock that only rises with the market is flat, not right.
    assert judge("up", noon, market, market)["status"] == "flat"
    # Published after the last close we have: too early to say.
    assert judge("up", "2026-11-12T22:00:00+00:00", stock, market)["status"] == "early"
