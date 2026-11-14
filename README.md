# NewsMind

AI news-to-stock impact mindmap: ingests financial headlines, scores sentiment (FinBERT), reasons about affected tickers (Claude API), predicts short-term market reaction (event study + backtest) and visualises it as an interactive mindmap (React Flow).

Inspired by [BettaFish](https://github.com/666ghj/BettaFish) (multi-agent sentiment analysis) and [Stock-Prediction](https://github.com/alisonmitchell/Stock-Prediction) (ML price prediction).

> Status: scaffold. Entity + sentiment agents done; ingest, impact agent, predictor, API and frontend are next. Not financial advice.

## Layout
`backend/{ingest,agents,model,api}`, `frontend/`, `notebooks/`, `tests/`, `docs/`.
