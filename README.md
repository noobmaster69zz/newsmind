# NewsMind

Financial news, charted by the companies it moves.

**Live site:** https://noobmaster69zz.github.io/newsmind/

[![Tests](https://github.com/noobmaster69zz/newsmind/actions/workflows/tests.yml/badge.svg)](https://github.com/noobmaster69zz/newsmind/actions/workflows/tests.yml)

I'm a student in AI and Data Engineering at Nanyang Polytechnic, and this is my personal project. I wanted to know one thing: when a headline comes out, which companies does it actually touch, including the ones it never mentions? A story about tankers hitting mines in the Strait of Hormuz doesn't name Exxon or Delta, but it matters to both.

NewsMind pulls the news wire, scores how each headline reads, asks Claude which companies a story is likely to affect and why, and draws the whole wire as a 3D point cloud you can explore.

> Not financial advice. Claude's reads are judgements from the text of a headline, not forecasts. The site checks each one against the stock's move since the story, but over a few days of prices that is a sanity check, not proof.

## What you can do on the site

- **Scroll the wire** on the left. The story on the reading line is charted on the right.
- **Read the cloud.** Every point is a story, coloured by tone (cyan positive, maroon negative, grey neutral). Each cluster is a company, and companies in the same sector sit together.
- **Follow the links.** Solid lines go to companies a story names. Dashed lines go to companies Claude expects it to affect without being named.
- **Search** headlines, tickers or company names.
- **Check the calls.** Each company chip shows whether Claude's call has held up so far. Select it for a price chart of the stock against the S&P 500 since the story.
- **Ask Blip.** The small pixel character walking along the bottom opens a panel. Ask what is moving the market, or ask about one of the tracked companies.
- **Drag the seam** between the two halves to resize them, or switch on **Focus mode** to strip the page down.

## How it works

```
Finnhub ──> ingest ──> SQLite ──> FinBERT ──> Claude ──> export ──> static site
             │           │          tone       impact     events.json   (GitHub Pages)
             │           │                     + briefs        │
             └── validate, dedupe, tag ────────────────────────┘
                                       seed: the snapshot is loaded back
                                       at the start of the next run
```

| Stage | File | What it does |
|---|---|---|
| Extract | `backend/ingest/pipeline.py` | Pulls the general wire plus one feed per tracked company from Finnhub |
| Transform | `backend/ingest/pipeline.py`, `backend/agents/entity.py` | Rejects short or undated items, strips source suffixes, dedupes by a hash of the headline, drops off-topic items from company feeds, tags tickers by alias |
| Load | `backend/db.py` | Idempotent upserts into SQLite. Every run is logged in `pipeline_runs` |
| Tone | `backend/agents/sentiment.py` | FinBERT scores each headline from -1 (negative) to +1 (positive) |
| Impact | `backend/agents/impact.py` | Claude returns up to four affected companies per story with a direction, a confidence and a one-line reason, plus a brief per company and a digest of the wire |
| Check | `backend/prices.py` | Pulls daily closes with yfinance and marks each of Claude's calls right, wrong, too close to call or too early, measured against the S&P 500 over the same days |
| Export | `backend/export_site_data.py` | Writes the snapshot the site reads |
| Seed | `backend/seed.py` | Loads the last snapshot into an empty database so nothing is processed twice |
| Site | `frontend/` | Plain HTML, CSS and JavaScript with no build step |

### The database

SQLite, eight tables:

| Table | Holds |
|---|---|
| `news` | One row per story. The primary key is a SHA-256 of the cleaned headline, which is what makes dedupe and re-runs safe |
| `news_ticker` | Which companies a story names (many-to-many) |
| `sentiment` | FinBERT score and label per story |
| `impact` | Claude's one-line summary per story |
| `impact_effect` | One row per company Claude expects a story to move, with `CHECK` constraints on direction and confidence |
| `brief` | Claude's saved write-ups, with a hash of the stories each was written from |
| `price` | Daily closes for tracked tickers and SPY |
| `pipeline_runs` | Fetched, inserted and rejected counts for every ingest |

### Where the Claude API key lives

The key never reaches the website. Anything in `frontend/` is public, so the page only reads Claude's saved answers from `events.json`.

- Locally the key sits in `.env`, which is gitignored.
- On GitHub it is a repository secret, read only by the scheduled workflow.
- Blip looks live, but it is reading saved briefs. That is a deliberate trade: no visitor can spend my credit, and the cost is capped by `NEWSMIND_MAX_CALLS`.

A brief is only rewritten when the set of stories behind it changes, and a story is only read once, so a normal run pays for new headlines only.

## Current snapshot

At the time of writing the site holds 277 stories from Reuters, CNBC, Yahoo and others. 201 of them name at least one of the 35 tracked companies. FinBERT reads 145 as neutral, 75 as negative and 57 as positive. Claude (Haiku 5.5) has read all 277 and written 33 company briefs and one market digest.

## Run it yourself

```bash
pip install -r requirements.txt
cp .env.example .env            # add FINNHUB_API_KEY and ANTHROPIC_API_KEY
python -m backend.seed          # optional: start from the committed snapshot
python -m backend.ingest.pipeline
python -m backend.agents.sentiment
python -m backend.agents.impact
python -m backend.export_site_data
python -m http.server 5178 --directory frontend
```

Then open http://localhost:5178. Without an Anthropic key the impact step skips itself and the rest still works.

Tests: `python -m pytest tests` (13 tests, no network, no API key needed).

## Automation

| Workflow | When | What |
|---|---|---|
| `tests.yml` | Every push and pull request | Runs the unit tests |
| `pages.yml` | Push to `main` that touches `frontend/` | Publishes the site to GitHub Pages |
| `refresh.yml` | Every six hours, or by hand | Seeds, ingests, scores, runs Claude, commits the new snapshot and redeploys |

`refresh.yml` needs two repository secrets: `FINNHUB_API_KEY` and `ANTHROPIC_API_KEY`.

## What I learned

- **Idempotency is a design choice, not a clean-up job.** Hashing the cleaned headline as the primary key meant the pipeline could be re-run safely from day one.
- **Feeds lie about relevance.** Finnhub's company feeds include general market round-ups, so a story from the Boeing feed is only tagged Boeing if its text actually names Boeing.
- **A model's output is data, so validate it.** Claude's reply is constrained by a JSON schema, and then filtered again in code: unknown tickers, repeats and invalid values are dropped before anything is stored.
- **Secrets shape the architecture.** Wanting a clickable assistant on a public page, without exposing a key, is what pushed the design towards saved analysis and a scheduled job.
- **State between runs has to live somewhere.** The scheduled job starts with an empty database, so the exported snapshot doubles as its memory.
- **Animation should run on time, not frames.** Tying movement to elapsed time keeps it the same speed on 60 Hz and 120 Hz screens.

## Limits and what comes next

- The right/wrong check is crude. On the first snapshot Claude was right on 122 calls and wrong on 65, with 27 too close to call, but many stories report a move that has already started, which flatters the score, and the window is only a few trading days. The next step is a proper event study with fixed 1-day and 5-day windows and a larger sample.
- Ticker tagging is alias matching over 35 companies. It misses companies outside the list and can be fooled by ambiguous names.
- FinBERT scores the headline only, not the article.
- The site shows a snapshot, refreshed every six hours, not a live feed.

## Credits

Inspired by [BettaFish](https://github.com/666ghj/BettaFish) for the multi-agent idea and [Stock-Prediction](https://github.com/alisonmitchell/Stock-Prediction) for the modelling direction. The point-cloud chart takes its cue from the particle brain on [mindcorpus.org](https://mindcorpus.org/). News data from [Finnhub](https://finnhub.io/), tone from [FinBERT](https://huggingface.co/ProsusAI/finbert), impact reads from Claude.

Built by Gandhi Jaitra Nimeshkumar.
