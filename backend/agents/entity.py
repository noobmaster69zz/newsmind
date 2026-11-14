"""Entity agent: map a headline to S&P 500 tickers via a company-name/alias table."""
from __future__ import annotations

import re

# Small seed map; extend with the full S&P 500 list in data/sp500.csv later.
COMPANY_ALIASES: dict[str, list[str]] = {
    "AAPL": ["apple", "iphone", "tim cook"],
    "MSFT": ["microsoft", "azure", "satya nadella"],
    "NVDA": ["nvidia", "jensen huang"],
    "TSLA": ["tesla", "elon musk"],
    "AMZN": ["amazon", "aws"],
    "GOOGL": ["google", "alphabet", "youtube"],
    "META": ["meta platforms", "facebook", "instagram"],
    "JPM": ["jpmorgan", "jp morgan"],
    "XOM": ["exxon", "exxonmobil"],
    "TSM": ["tsmc", "taiwan semiconductor"],
}


def extract_tickers(headline: str) -> list[str]:
    """Return tickers whose alias appears as a whole word/phrase in the headline."""
    text = headline.lower()
    found = []
    for ticker, aliases in COMPANY_ALIASES.items():
        if any(re.search(rf"\b{re.escape(a)}\b", text) for a in aliases):
            found.append(ticker)
    return found
