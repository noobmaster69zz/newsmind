# NewsMind

Financial news, charted by the companies it names.

NewsMind pulls the financial news wire, scores the tone of every headline with FinBERT, links each story to the companies it mentions, and draws the result as an interactive mindmap: the story at the centre, sectors on the inner ring, companies on the middle ring, and other stories about those companies as outer stars.

Inspired by [BettaFish](https://github.com/666ghj/BettaFish) (multi-agent sentiment analysis) and [Stock-Prediction](https://github.com/alisonmitchell/Stock-Prediction) (ML price prediction).

> Not financial advice. The site shows who a story names and how its headline reads. It does not yet predict prices.

## How it works

```
Finnhub API ──> ingest pipeline ──> SQLite ──> FinBERT tone ──> export ──> static site
 (general wire    (validate, dedupe,   (news, news_ticker,   (sentiment     (events.json)   (frontend/)
  + 35 company     strip source tags,   sentiment,            table)
  feeds)           tag tickers)         pipeline_runs)
```

| Step | Code | What it does |
|---|---|---|
| Extract | `backend/ingest/pipeline.py` | Pulls the general wire and one feed per tracked company from Finnhub |
| Transform | `backend/ingest/pipeline.py`, `backend/agents/entity.py` | Rejects short or undated items, dedupes by headline hash, drops off-topic items from company feeds, tags tickers by alias |
| Load | `backend/db.py` | Idempotent upserts into SQLite; every run is logged in `pipeline_runs` |
| Score | `backend/agents/sentiment.py` | FinBERT tone per headline, from -1 (negative) to +1 (positive) |
| Export | `backend/export_site_data.py` | Writes the snapshot the site reads |
| Site | `frontend/` | Plain HTML, CSS and JavaScript. No build step |

## Run it

```bash
pip install requests transformers torch pytest
cp .env.example .env            # add your FINNHUB_API_KEY
python -m backend.ingest.pipeline
python -m backend.agents.sentiment
python -m backend.export_site_data
python -m http.server 5178 --directory frontend
```

Then open http://localhost:5178.

Tests: `python -m pytest tests`

## Using the site

- Scroll the wire on the left. The story on the reading line is the one charted on the right.
- Hover a company or an outer star for details. Select a company to filter the wire to it. Select a star to jump to that story.
- Drag the seam between the two halves to resize them.
- Focus mode strips the page down to the headline, the companies and the tone.

## Status

Done: ingest pipeline, SQLite schema, ticker tagging, FinBERT tone, static site.

Next: a Claude impact agent for second-order effects (suppliers, competitors, sectors a story affects without naming), an event-study model that predicts the 1-day and 5-day reaction, a FastAPI layer, and a scheduled ingest.

Built by Gandhi Jaitra Nimeshkumar, AI and Data Engineering at NYP.
