"""Daily closing prices, and the check of Claude's calls against them.

A call is judged on the stock's move since the story, measured against the S&P 500
(SPY) over the same days, so a stock that rises with the whole market does not
count as Claude being right.

Run:  python -m backend.prices
"""
from __future__ import annotations

from datetime import datetime, timezone

from backend.agents.entity import companies

MARKET = "SPY"
US_CLOSE_UTC_HOUR = 21   # 16:00 New York in winter; close enough for a daily check
FLAT_BAND = 0.5          # percentage points: moves inside this band count as "flat", not right or wrong


def fetch(conn, period: str = "2mo") -> int:
    """Pull daily closes for every tracked ticker plus the market and upsert them."""
    import yfinance as yf  # imported lazily: only this step needs it

    tickers = sorted(companies()) + [MARKET]
    closes = yf.download(tickers, period=period, interval="1d", auto_adjust=True, progress=False)["Close"]
    rows = [(ticker, day.strftime("%Y-%m-%d"), float(value))
            for ticker in closes.columns
            for day, value in closes[ticker].dropna().items()]
    conn.executemany("INSERT OR REPLACE INTO price (ticker, day, close) VALUES (?,?,?)", rows)
    conn.commit()
    return len(rows)


def series(conn, ticker: str) -> list[tuple[str, float]]:
    return [(r["day"], r["close"]) for r in conn.execute(
        "SELECT day, close FROM price WHERE ticker = ? ORDER BY day", (ticker,))]


def baseline_day(published_at: str, days: list[str]) -> str | None:
    """The last close the market had already printed when the story came out."""
    when = datetime.fromisoformat(published_at).astimezone(timezone.utc)
    day = when.strftime("%Y-%m-%d")
    after_close = when.hour >= US_CLOSE_UTC_HOUR
    known = [d for d in days if d < day or (d == day and after_close)]
    return known[-1] if known else None


def judge(direction: str, published_at: str, stock: list[tuple[str, float]],
          market: list[tuple[str, float]]) -> dict:
    """Compare one call with the price move since the story.

    status: right | wrong | flat | early (no trading day since) | unscored (a 'mixed' call or no prices)
    """
    stock_by_day, market_by_day = dict(stock), dict(market)
    days = sorted(set(stock_by_day) & set(market_by_day))
    base = baseline_day(published_at, days)
    if not base:
        return {"status": "unscored"}
    later = [d for d in days if d > base]
    if not later:
        return {"status": "early", "from": base}
    last = later[-1]
    stock_move = (stock_by_day[last] / stock_by_day[base] - 1) * 100
    market_move = (market_by_day[last] / market_by_day[base] - 1) * 100
    excess = stock_move - market_move
    if direction == "mixed":
        status = "unscored"
    elif abs(excess) < FLAT_BAND:
        status = "flat"
    else:
        status = "right" if (excess > 0) == (direction == "up") else "wrong"
    return {"status": status, "from": base, "to": last, "days": len(later),
            "stock": round(stock_move, 2), "market": round(market_move, 2), "excess": round(excess, 2)}


if __name__ == "__main__":
    from backend import db

    print({"price_rows": fetch(db.connect())})
