"""Impact agent: asks Claude which tracked companies a story is likely to move, and why.

Three jobs, all saved to SQLite so nothing is paid for twice:
  1. one impact read per story            -> impact + impact_effect tables
  2. one brief per company with stories   -> brief table, key = ticker
  3. one digest of the whole wire         -> brief table, key = '_market'

The website never calls Claude. It reads these saved rows from the exported
snapshot, which is why the API key only ever lives in .env or a CI secret.

Run:  python -m backend.agents.impact
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from backend.agents.entity import companies

log = logging.getLogger("newsmind.impact")

MODEL = os.environ.get("NEWSMIND_MODEL", "claude-haiku-5-5")
MAX_CALLS = int(os.environ.get("NEWSMIND_MAX_CALLS", "400"))  # ceiling on Claude calls per run
MAX_EFFECTS = 4
MARKET_KEY = "_market"


def _company_table() -> str:
    return "\n".join(f"{t}: {c['name']} ({c['sector']})" for t, c in sorted(companies().items()))


def _system() -> str:
    return (
        "You analyse financial news for a student project that maps stories to the companies "
        "they affect. You are given one input at a time and reply in the requested JSON shape.\n\n"
        "Rules:\n"
        "- Only use these tracked companies, by ticker:\n" + _company_table() + "\n"
        "- Reason only from the text you are given plus well-known, durable facts about how "
        "these companies make money (suppliers, competitors, input costs, regulation). Do not "
        "invent events, numbers or quotes.\n"
        "- 'direction' is your judgement of the likely short-term pressure on the share price "
        "from this news alone: up, down, or mixed. It is an opinion, not a forecast.\n"
        "- Be calibrated. Use 'high' confidence only when the link is direct and obvious. If the "
        "story has no credible effect on any tracked company, return an empty list.\n"
        "- Write plainly for a reader who is not a finance specialist. No hype, no advice."
    )


STORY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One sentence: what happened and why a market would care."},
        "effects": {
            "type": "array",
            "description": f"At most {MAX_EFFECTS} tracked companies, most affected first. Include companies "
                           "the story does not name when there is a clear channel to them.",
            "items": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string"},
                    "direction": {"type": "string", "enum": ["up", "down", "mixed"]},
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                    "reason": {"type": "string", "description": "One short sentence naming the channel."},
                },
                "required": ["ticker", "direction", "confidence", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "effects"],
    "additionalProperties": False,
}

COMPANY_SCHEMA = {
    "type": "object",
    "properties": {
        "stance": {"type": "string", "enum": ["positive", "negative", "mixed", "quiet"],
                   "description": "Overall read of the coverage. 'quiet' when little of it matters."},
        "brief": {"type": "string", "description": "Two or three sentences on what the recent coverage says."},
        "drivers": {"type": "array", "items": {"type": "string"},
                    "description": "Up to three short phrases naming what is driving the coverage."},
        "watch": {"type": "string", "description": "One sentence on what to watch next, grounded in the headlines."},
    },
    "required": ["stance", "brief", "drivers", "watch"],
    "additionalProperties": False,
}

MARKET_SCHEMA = {
    "type": "object",
    "properties": {
        "brief": {"type": "string", "description": "Three or four sentences on what is moving the wire right now."},
        "themes": {
            "type": "array",
            "description": "Up to four themes running through the headlines.",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Three to six words."},
                    "detail": {"type": "string", "description": "One sentence."},
                    "tickers": {"type": "array", "items": {"type": "string"},
                                "description": "Tracked tickers this theme touches, if any."},
                },
                "required": ["title", "detail", "tickers"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["brief", "themes"],
    "additionalProperties": False,
}


# ---------- Pure helpers (unit tested, no network) ----------
def clean_effects(effects: list[dict]) -> list[dict]:
    """Keep only tracked tickers, drop repeats, cap the list."""
    tracked, seen, out = companies(), set(), []
    for e in effects:
        ticker = str(e.get("ticker", "")).upper().strip()
        if ticker not in tracked or ticker in seen:
            continue
        if e.get("direction") not in ("up", "down", "mixed") or e.get("confidence") not in ("low", "medium", "high"):
            continue
        seen.add(ticker)
        out.append({"ticker": ticker, "direction": e["direction"], "confidence": e["confidence"],
                    "reason": str(e.get("reason", "")).strip()})
    return out[:MAX_EFFECTS]


def source_hash(story_ids: list[str]) -> str:
    """Fingerprint of the stories a brief was written from."""
    return hashlib.sha256("|".join(sorted(story_ids)).encode()).hexdigest()[:16]


def story_prompt(headline: str, summary: str, tickers: list[str]) -> str:
    named = ", ".join(tickers) if tickers else "none"
    return (f"Story headline: {headline}\n"
            f"Wire summary: {summary or '(none)'}\n"
            f"Tracked companies the text names: {named}\n\n"
            "Which tracked companies is this likely to affect, in which direction, and through what channel?")


def _lines(rows) -> str:
    return "\n".join(
        f"- [{r['published_at'][:10]}] {r['headline']}"
        + (f" (tone {r['score']:+.2f})" if r["score"] is not None else "")
        for r in rows)


# ---------- Claude ----------
def _client():
    import anthropic  # imported lazily so tests and the site export never need the SDK

    return anthropic.Anthropic()


def ask(client, prompt: str, schema: dict, max_tokens: int = 4000) -> dict | None:
    """One structured request. Returns the parsed JSON, or None if Claude declined or ran out of room."""
    response = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=_system(),
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    if response.stop_reason != "end_turn":
        log.warning("skipped: stop_reason=%s", response.stop_reason)
        return None
    text = next((b.text for b in response.content if b.type == "text"), None)
    return json.loads(text) if text else None


def _tickers_of(conn, news_id: str) -> list[str]:
    return [r["ticker"] for r in conn.execute(
        "SELECT ticker FROM news_ticker WHERE news_id = ? ORDER BY ticker", (news_id,))]


# ---------- Jobs ----------
def read_stories(conn, client, budget: int) -> int:
    """Job 1: an impact read for every story that has none yet, newest first."""
    rows = conn.execute(
        "SELECT n.id, n.headline, n.summary FROM news n LEFT JOIN impact i ON i.news_id = n.id "
        "WHERE i.news_id IS NULL ORDER BY n.published_at DESC LIMIT ?", (budget,)).fetchall()
    if not rows:
        return 0
    jobs = [(r["id"], story_prompt(r["headline"], r["summary"], _tickers_of(conn, r["id"]))) for r in rows]

    def run(job):
        news_id, prompt = job
        try:
            return news_id, ask(client, prompt, STORY_SCHEMA)
        except Exception as exc:  # one failed story must not sink the run; it is retried next time
            log.warning("story %s failed: %s", news_id[:12], exc)
            return news_id, None

    done = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for news_id, result in pool.map(run, jobs):
            if not result:
                continue
            conn.execute("INSERT OR REPLACE INTO impact (news_id, summary, model) VALUES (?,?,?)",
                         (news_id, result["summary"].strip(), MODEL))
            conn.execute("DELETE FROM impact_effect WHERE news_id = ?", (news_id,))
            conn.executemany(
                "INSERT INTO impact_effect (news_id, ticker, direction, confidence, reason) VALUES (?,?,?,?,?)",
                [(news_id, e["ticker"], e["direction"], e["confidence"], e["reason"])
                 for e in clean_effects(result["effects"])])
            conn.commit()
            done += 1
    return done


def _save_brief(conn, key: str, body: dict, digest: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO brief (key, body, source_hash, model, created_at) VALUES (?,?,?,?,datetime('now'))",
        (key, json.dumps(body, ensure_ascii=False), digest, MODEL))
    conn.commit()


def _stale(conn, key: str, digest: str) -> bool:
    row = conn.execute("SELECT source_hash FROM brief WHERE key = ?", (key,)).fetchone()
    return row is None or row["source_hash"] != digest


def write_company_briefs(conn, client, budget: int) -> int:
    """Job 2: a brief per company, rewritten only when its set of stories has changed."""
    done = 0
    for ticker, company in sorted(companies().items()):
        if done >= budget:
            break
        rows = conn.execute(
            "SELECT n.id, n.headline, n.published_at, s.score FROM news n "
            "JOIN news_ticker t ON t.news_id = n.id LEFT JOIN sentiment s ON s.news_id = n.id "
            "WHERE t.ticker = ? ORDER BY n.published_at DESC LIMIT 15", (ticker,)).fetchall()
        if not rows:
            continue
        digest = source_hash([r["id"] for r in rows])
        if not _stale(conn, ticker, digest):
            continue
        prompt = (f"Company: {company['name']} ({ticker}), sector: {company['sector']}.\n"
                  f"Its most recent headlines on the wire, newest first, with a FinBERT tone score "
                  f"from -1 (negative) to +1 (positive):\n{_lines(rows)}\n\n"
                  "Write a short brief on what this coverage says about the company.")
        try:
            body = ask(client, prompt, COMPANY_SCHEMA)
        except Exception as exc:
            log.warning("brief %s failed: %s", ticker, exc)
            continue
        if body:
            body["drivers"] = [d.strip() for d in body["drivers"] if d.strip()][:3]
            body["stories"] = len(rows)
            _save_brief(conn, ticker, body, digest)
            done += 1
    return done


def write_market_digest(conn, client) -> int:
    """Job 3: one digest of the newest headlines across the whole wire."""
    rows = conn.execute(
        "SELECT n.id, n.headline, n.published_at, s.score FROM news n "
        "LEFT JOIN sentiment s ON s.news_id = n.id ORDER BY n.published_at DESC LIMIT 60").fetchall()
    if not rows:
        return 0
    digest = source_hash([r["id"] for r in rows])
    if not _stale(conn, MARKET_KEY, digest):
        return 0
    prompt = ("The newest headlines on the wire, newest first, with a FinBERT tone score from "
              f"-1 (negative) to +1 (positive):\n{_lines(rows)}\n\n"
              "Summarise what is moving the market right now and the main themes.")
    body = ask(client, prompt, MARKET_SCHEMA)
    if not body:
        return 0
    tracked = companies()
    for theme in body["themes"]:
        theme["tickers"] = [t for t in dict.fromkeys(x.upper() for x in theme["tickers"]) if t in tracked][:5]
    body["themes"] = body["themes"][:4]
    body["stories"] = len(rows)
    _save_brief(conn, MARKET_KEY, body, digest)
    return 1


def run(conn=None) -> dict:
    from backend import db
    from backend.ingest.pipeline import load_env

    load_env()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log.warning("ANTHROPIC_API_KEY is not set: skipping the Claude step")
        return {"skipped": "no ANTHROPIC_API_KEY"}
    conn = conn or db.connect()
    client = _client()
    stories = read_stories(conn, client, MAX_CALLS)
    briefs = write_company_briefs(conn, client, max(0, MAX_CALLS - stories))
    market = write_market_digest(conn, client)
    stats = {"model": MODEL, "stories_read": stories, "company_briefs": briefs, "market_digest": market}
    log.info("impact done: %s", stats)
    return stats


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())
