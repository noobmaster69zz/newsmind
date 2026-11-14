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


def test_transform_strips_source_suffix():
    rows, _ = transform([{"headline": "Oil climbs as tankers hit mines in Hormuz - Reuters",
                          "datetime": 1700000000}])
    assert rows[0]["headline"] == "Oil climbs as tankers hit mines in Hormuz"


def test_company_feed_rejects_off_topic_stories():
    raw = [{"headline": "Stocks drift lower ahead of inflation data", "datetime": 1700000000},
           {"headline": "Boeing wins order for 50 jets from Gulf carrier", "datetime": 1700000001}]
    rows, rejected = transform(raw, feed_ticker="BA")
    assert [r["tickers"] for r in rows] == [["BA"]]
    assert rejected == 1


def test_load_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    rows, _ = transform(RAW)
    assert db.upsert_news(conn, rows) == 1
    assert db.upsert_news(conn, rows) == 0  # re-run inserts nothing
    assert conn.execute("SELECT COUNT(*) FROM news_ticker").fetchone()[0] == 2
