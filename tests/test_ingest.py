import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import db
from backend.ingest.pipeline import transform

RAW = [
    {"headline": "Nvidia surges after record data center revenue", "datetime": 1700000000,
     "source": "X", "summary": "Microsoft also a big buyer.", "url": "u1"},
    {"headline": "Nvidia  surges after record data center revenue", "datetime": 1700000001,
     "source": "Y", "summary": "", "url": "u2"},          # whitespace duplicate
    {"headline": "Short", "datetime": 1700000002},         # too short
    {"headline": "No timestamp on this headline at all", "datetime": None},
]


def test_transform_dedupes_and_rejects():
    rows, rejected = transform(RAW)
    assert len(rows) == 1
    assert rejected == 3
    assert rows[0]["tickers"] == ["MSFT", "NVDA"]


def test_load_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    rows, _ = transform(RAW)
    assert db.upsert_news(conn, rows) == 1
    assert db.upsert_news(conn, rows) == 0  # re-run inserts nothing
    assert conn.execute("SELECT COUNT(*) FROM news_ticker").fetchone()[0] == 2
