"""Impact agent: asks Claude which tracked companies a story is likely to move, and why.

Three jobs, all saved to SQLite so nothing is paid for twice:
  1. one impact read per story            -> impact + impact_effect tables
  2. one brief per company with stories   -> brief table, key = ticker
  3. one digest of the whole wire         -> brief table, key = '_market'

The website never calls Claude. It reads these saved rows from the exported
snapshot, which is why the API key only ever lives in .env or a CI secret.

The wording sent to Claude is kept out of the repository. It is read, in order, from
the NEWSMIND_PROMPTS environment variable (a CI secret), backend/agents/prompts.json
(gitignored), or the generic backend/agents/prompts.example.json.

Run:  python -m backend.agents.impact
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from functools import lru_cache
from pathlib import Path

from backend.agents.entity import companies

log = logging.getLogger("newsmind.impact")

MODEL = os.environ.get("NEWSMIND_MODEL", "claude-haiku-5-5")
MAX_CALLS = int(os.environ.get("NEWSMIND_MAX_CALLS", "400"))  # ceiling on Claude calls per run
MAX_EFFECTS = 4
MARKET_KEY = "_market"


def _company_table() -> str:
    return "\n".join(f"{t}: {c['name']} ({c['sector']})" for t, c in sorted(companies().items()))


HERE = Path(__file__).resolve().parent


@lru_cache(maxsize=1)
def prompts() -> dict:
    """The prompt wording, from the first source that has it."""
    raw = os.environ.get("NEWSMIND_PROMPTS", "").strip()
    if raw:
        log.info("prompts: from NEWSMIND_PROMPTS")
        return json.loads(raw)
    for name in ("prompts.json", "prompts.example.json"):
        path = HERE / name
        if path.exists():
            log.info("prompts: from %s", name)
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError("No prompts found: add backend/agents/prompts.json or set NEWSMIND_PROMPTS")


def _system() -> str:
    return prompts()["system"].format(companies=_company_table())


def _describe(schema: dict, prefix: str) -> dict:
    """Attach the field descriptions from the prompts file to a bare schema."""
    notes = prompts().get("fields", {})
    out = deepcopy(schema)

    def walk(node: dict, path: str) -> None:
        if path in notes:
            node["description"] = notes[path].format(max_effects=MAX_EFFECTS)
        for key, child in node.get("properties", {}).items():
            walk(child, f"{path}.{key}")
        if isinstance(node.get("items"), dict):
            for key, child in node["items"].get("properties", {}).items():
                walk(child, f"{path}.{key}")

    walk(out, prefix)
    return out


# Shapes only. The words that describe each field live in the prompts file.
STORY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "effects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string"},
                    "direction": {"type": "string", "enum": ["up", "down", "mixed"]},
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                    "reason": {"type": "string"},
                    "link": {"type": "string", "enum": ["direct", "indirect"]},
                    "evidence": {"type": "string"},
                    "counter": {"type": "string"},
                },
                "required": ["ticker", "direction", "confidence", "reason", "link", "evidence", "counter"],
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
        "stance": {"type": "string", "enum": ["positive", "negative", "mixed", "quiet"]},
        "brief": {"type": "string"},
        "drivers": {"type": "array", "items": {"type": "string"}},
        "watch": {"type": "string"},
    },
    "required": ["stance", "brief", "drivers", "watch"],
    "additionalProperties": False,
}

MARKET_SCHEMA = {
    "type": "object",
    "properties": {
        "brief": {"type": "string"},
        "themes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "tickers": {"type": "array", "items": {"type": "string"}},
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
                    "reason": str(e.get("reason", "")).strip(),
                    "link": e.get("link") if e.get("link") in ("direct", "indirect") else None,
                    "evidence": str(e.get("evidence", "")).strip() or None,
                    "counter": str(e.get("counter", "")).strip() or None})
    return out[:MAX_EFFECTS]


def source_hash(story_ids: list[str]) -> str:
    """Fingerprint of the stories a brief was written from."""
    return hashlib.sha256("|".join(sorted(story_ids)).encode()).hexdigest()[:16]


def story_prompt(headline: str, summary: str, tickers: list[str], wording: dict | None = None) -> str:
    template = (wording or prompts())["story"]
    return template.format(headline=headline, summary=summary or "(none)",
                           named=", ".join(tickers) if tickers else "none")


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
    story_schema = _describe(STORY_SCHEMA, "story")
    jobs = [(r["id"], story_prompt(r["headline"], r["summary"], _tickers_of(conn, r["id"]))) for r in rows]

    def run(job):
        news_id, prompt = job
        try:
            return news_id, ask(client, prompt, story_schema)
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
                "INSERT INTO impact_effect (news_id, ticker, direction, confidence, reason, link, evidence, counter) "
                "VALUES (?,?,?,?,?,?,?,?)",
                [(news_id, e["ticker"], e["direction"], e["confidence"], e["reason"], e["link"], e["evidence"],
                  e["counter"]) for e in clean_effects(result["effects"])])
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
        prompt = prompts()["company"].format(name=company["name"], ticker=ticker,
                                             sector=company["sector"], lines=_lines(rows))
        try:
            body = ask(client, prompt, _describe(COMPANY_SCHEMA, "company"))
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
    prompt = prompts()["market"].format(lines=_lines(rows))
    body = ask(client, prompt, _describe(MARKET_SCHEMA, "market"))
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
