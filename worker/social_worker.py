"""
FlashScope worker: social posts + GlobeNewswire news.

* Stocktwits: curl_cffi (Python bindings for curl-impersonate) so requests look like Chrome.
* Reddit: public subreddit RSS feeds, polled once per cycle (new posts + new comments).
  Posts are kept only if they mention a tracked ticker ($TICK, or the bare uppercase symbol).

Run:    python worker/social_worker.py            # loop forever
        python worker/social_worker.py --check    # test the feeds, no database needed

Env:    DATABASE_URL               required (except with --check)
        SCRAPE_INTERVAL_SECONDS    120 (2 min) or 300 (5 min, default)
        WATCHLIST                  e.g. "VIVK,DFNS"; if empty, tickers come from APP_URL/api/finviz
        APP_URL                    default http://localhost:3000
        TRACK_SCREENER             1 (default); 0 uses WATCHLIST only
        MAX_TICKERS                default 30; screener tickers get priority
        REDDIT_SUBREDDITS          default pennystocks,wallstreetbets,stocks,StockMarket,Daytrading
        REDDIT_INCLUDE_COMMENTS    1 (default) or 0
        X_FEED_URLS                comma-separated RSS/Atom converter feeds (optional)
        GLOBENEWSWIRE_FEED_URL      optional override of the Public Companies RSS feed
        NEWS_INTERVAL_SECONDS      default 300; minimum 120

Options: --news-only collects only GlobeNewswire; --once runs one cycle and exits.
The worker inherits environment variables; it does not load .env.local itself.
"""
import html
import os
import random
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, quote

from curl_cffi import requests as cffi

INTERVAL = int(os.getenv("SCRAPE_INTERVAL_SECONDS", "300"))
APP_URL = os.getenv("APP_URL", "http://localhost:3000").rstrip("/")
WATCHLIST = [t.strip().upper() for t in os.getenv("WATCHLIST", "").split(",") if t.strip()]
MAX_TICKERS = int(os.getenv("MAX_TICKERS", "30"))
SUBREDDITS = [
    s.strip()
    for s in os.getenv("REDDIT_SUBREDDITS", "pennystocks,wallstreetbets,stocks,StockMarket,Daytrading").split(",")
    if s.strip()
]
INCLUDE_COMMENTS = os.getenv("REDDIT_INCLUDE_COMMENTS", "1") != "0"
X_FEED_URLS = [u.strip() for u in os.getenv("X_FEED_URLS", "").split(",") if u.strip()]
GLOBENEWSWIRE_FEED_URL = os.getenv("GLOBENEWSWIRE_FEED_URL", "").strip() or (
    "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/"
    "GlobeNewswire%20-%20News%20about%20Public%20Companies"
)
NEWS_INTERVAL = max(120, int(os.getenv("NEWS_INTERVAL_SECONDS", "300")))

ATOM = "{http://www.w3.org/2005/Atom}"
BULL = ["moon", "rip", "breakout", "squeeze", "calls", "long", "bull", "buy", "pump", "runner", "earnings beat", "raises guidance", "fda approval", "contract awarded", "share repurchase", "dividend increase", "revenue growth", "debt reduction", "upgraded", "record revenue", "positive trial results", "acquisition completed"]
BEAR = ["dump", "puts", "short", "bear", "sell", "offering", "dilution", "crash", "bag", "rug", "earnings miss", "lowers guidance", "fda rejection", "contract terminated", "bankruptcy", "dividend cut", "revenue decline", "default", "downgraded", "going concern", "failed trial", "delisting notice"]

DDL = """
CREATE TABLE IF NOT EXISTS social_posts (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  tickers TEXT[] NOT NULL DEFAULT '{}',
  sentiment TEXT NOT NULL DEFAULT 'Unanalyzed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS social_posts_published_at_index ON social_posts (published_at DESC);
CREATE TABLE IF NOT EXISTS news_articles (
  id BIGSERIAL PRIMARY KEY,
  headline TEXT NOT NULL,
  source TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  url TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Other',
  ticker TEXT NOT NULL DEFAULT 'N/A',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS news_articles_published_at_index ON news_articles (published_at DESC);
CREATE TABLE IF NOT EXISTS keywords (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(keyword, category)
);
CREATE TABLE IF NOT EXISTS social_accounts (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, handle)
);
"""
INSERT = """
INSERT INTO social_posts (external_id, platform, author, body, url, published_at, tickers, sentiment)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (external_id) DO NOTHING
"""
NEWS_INSERT = """
INSERT INTO news_articles (headline, source, published_at, url, category, ticker)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (url) DO UPDATE SET
  headline = EXCLUDED.headline,
  source = EXCLUDED.source,
  published_at = CASE WHEN news_articles.source = 'Benzinga' AND EXCLUDED.source = 'Benzinga'
    THEN LEAST(news_articles.published_at, EXCLUDED.published_at) ELSE EXCLUDED.published_at END,
  category = EXCLUDED.category,
  ticker = CASE WHEN EXCLUDED.ticker = 'N/A' THEN news_articles.ticker ELSE EXCLUDED.ticker END
WHERE (news_articles.headline, news_articles.source, news_articles.published_at,
       news_articles.category, news_articles.ticker)
  IS DISTINCT FROM
      (EXCLUDED.headline, EXCLUDED.source,
       CASE WHEN news_articles.source = 'Benzinga' AND EXCLUDED.source = 'Benzinga'
         THEN LEAST(news_articles.published_at, EXCLUDED.published_at) ELSE EXCLUDED.published_at END,
       EXCLUDED.category,
       CASE WHEN EXCLUDED.ticker = 'N/A' THEN news_articles.ticker ELSE EXCLUDED.ticker END)
"""

session = cffi.Session(impersonate="chrome")


def log(msg):
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {msg}", flush=True)


# ---------- Settings (Sources / Keywords / Accounts tabs in the web app) ----------
BASE_BULL = list(BULL)
BASE_BEAR = list(BEAR)
BASE_SUBREDDITS = list(SUBREDDITS)
BASE_X_FEED_URLS = list(X_FEED_URLS)
STOCKTWITS_USERS = []


def load_settings(conn):
    """Merge the env defaults with what is saved in Settings. Runs every cycle."""
    global BULL, BEAR, SUBREDDITS, X_FEED_URLS, STOCKTWITS_USERS
    try:
        with conn.cursor() as cur:
            # Keep disabled defaults as explicit removals instead of adding them back.
            for category, words in (("Bullish", BASE_BULL), ("Bearish", BASE_BEAR)):
                for word in words:
                    cur.execute("INSERT INTO keywords (keyword, category, enabled) VALUES (%s, %s, FALSE) ON CONFLICT (keyword, category) DO NOTHING", (word, category))
            cur.execute("SELECT platform, handle, enabled FROM social_accounts")
            accounts = cur.fetchall()
            cur.execute("SELECT keyword, category FROM keywords WHERE enabled")
            keywords = cur.fetchall()
        conn.commit()
    except Exception as ex:
        conn.rollback()
        log(f"settings unavailable, using env defaults: {ex}")
        return

    def merge(base, extra):
        seen, out = set(), []
        for item in list(base) + list(extra):
            if item and item.lower() not in seen:
                seen.add(item.lower())
                out.append(item)
        return out

    BULL = merge([], [k.lower() for k, c in keywords if c == "Bullish"])
    BEAR = merge([], [k.lower() for k, c in keywords if c == "Bearish"])
    def active(platform, base):
        configured = [(h, enabled) for p, h, enabled in accounts if p == platform]
        disabled = {h.lower() for h, enabled in configured if not enabled}
        return merge([h for h in base if h.lower() not in disabled], [h for h, enabled in configured if enabled])

    SUBREDDITS = active("Reddit", BASE_SUBREDDITS)
    # For X the saved value must be an RSS/Atom converter feed URL; plain handles are only stored.
    X_FEED_URLS = [h for h in active("X", BASE_X_FEED_URLS) if h.startswith("http")]
    STOCKTWITS_USERS = active("Stocktwits", [])
    log(f"settings: {len(SUBREDDITS)} subreddits, {len(STOCKTWITS_USERS)} Stocktwits users, "
        f"{len(X_FEED_URLS)} X feeds, {len(BULL)} bullish / {len(BEAR)} bearish keywords")


# ---------- tickers ----------
def get_tickers():
    if WATCHLIST and os.getenv("TRACK_SCREENER", "1") == "0":
        return WATCHLIST[:MAX_TICKERS]

    from urllib.request import urlopen
    import json

    try:
        with urlopen(f"{APP_URL}/api/finviz", timeout=30) as response:
            payload = json.load(response)
        if payload.get("error"):
            raise RuntimeError(payload["error"])
        rows = payload.get("results", [])
    except Exception as ex:
        log(f"Screener tickers unavailable: {ex}; using WATCHLIST fallback")
        if not WATCHLIST:
            raise RuntimeError("Set APP_URL to the running app or provide WATCHLIST") from ex
        return WATCHLIST[:MAX_TICKERS]

    tickers = [
        str(row.get("Ticker") or row.get("ticker") or "").strip().upper()
        for row in rows
    ]
    return [t for t in dict.fromkeys(tickers + WATCHLIST) if t][:MAX_TICKERS]


# ---------- Stocktwits ----------
STOCKTWITS_WATCHERS = {}

def scrape_stocktwits(ticker):
    r = session.get(
        f"https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json",
        headers={"Accept": "application/json"},
        timeout=20,
    )
    if r.status_code == 429:
        raise RuntimeError("rate limited (429)")
    r.raise_for_status()
    rows = []
    payload = r.json()
    symbol = payload.get("symbol") or {}
    watchers = symbol.get("watchlist_count")
    if isinstance(watchers, int) and not isinstance(watchers, bool) and watchers >= 0:
        STOCKTWITS_WATCHERS[ticker] = watchers
    for m in payload.get("messages", []):
        label = ((m.get("entities") or {}).get("sentiment") or {}).get("basic", "")
        sentiment = label if label in ("Bullish", "Bearish") else keyword_sentiment(m["body"])
        symbols = [s["symbol"].upper() for s in m.get("symbols", []) if s.get("symbol")] or [ticker]
        rows.append((
            f"stocktwits:{m['id']}", "Stocktwits",
            (m.get("user") or {}).get("username", "Unknown"),
            m["body"], f"https://stocktwits.com/{quote((m.get('user') or {}).get('username', 'Unknown'), safe='')}/message/{m['id']}",
            m["created_at"], symbols, sentiment,
        ))
    return rows


def scrape_stocktwits_user(handle):
    """Public message stream of one Stocktwits account (Settings > Accounts)."""
    r = session.get(
        f"https://api.stocktwits.com/api/2/streams/user/{handle}.json",
        headers={"Accept": "application/json"},
        timeout=20,
    )
    if r.status_code == 429:
        raise RuntimeError("rate limited (429)")
    r.raise_for_status()
    rows = []
    for m in r.json().get("messages", []):
        symbols = [s["symbol"].upper() for s in m.get("symbols", []) if s.get("symbol")]
        if not symbols:
            continue
        label = ((m.get("entities") or {}).get("sentiment") or {}).get("basic", "")
        sentiment = label if label in ("Bullish", "Bearish") else keyword_sentiment(m["body"])
        rows.append((
            f"stocktwits:{m['id']}", "Stocktwits",
            (m.get("user") or {}).get("username", handle),
            m["body"], f"https://stocktwits.com/{quote((m.get('user') or {}).get('username', 'Unknown'), safe='')}/message/{m['id']}",
            m["created_at"], symbols, sentiment,
        ))
    return rows


# ---------- Reddit RSS ----------
def reddit_feed_urls():
    if not SUBREDDITS:
        return
    combined = "+".join(quote(sub, safe="") for sub in SUBREDDITS)
    yield f"https://www.reddit.com/r/{combined}/new/.rss?limit=100"
    if INCLUDE_COMMENTS:
        yield f"https://www.reddit.com/r/{combined}/comments/.rss?limit=100"


def keyword_sentiment(text):
    t = text.lower()
    def hits(words):
        return sum(bool(re.search(r"(?<![a-z0-9])" + re.escape(w.lower()) + r"(?![a-z0-9])", t)) for w in words if w)
    bull = hits(BULL)
    bear = hits(BEAR)
    return "Bullish" if bull > bear else "Bearish" if bear > bull else "Neutral"


def find_tickers(text, tracked):
    cashtags = {c.upper() for c in re.findall(r"\$([A-Za-z]{1,5})\b", text)}
    found = [t for t in tracked if t in cashtags]
    for t in tracked:  # bare symbol: uppercase only, 3+ letters, to avoid words like "ON" or "ALL"
        if t not in found and len(t) >= 3 and re.search(rf"(?<![A-Za-z$]){re.escape(t)}(?![A-Za-z])", text):
            found.append(t)
    return found


def parse_atom(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    entries = []
    for e in root.iter(f"{ATOM}entry"):
        link = e.find(f"{ATOM}link")
        body = html.unescape(re.sub(r"<[^>]+>", " ", (e.findtext(f"{ATOM}content") or "")))
        entries.append({
            "id": e.findtext(f"{ATOM}id") or "",
            "title": html.unescape(e.findtext(f"{ATOM}title") or ""),
            "author": (e.findtext(f"{ATOM}author/{ATOM}name") or "Unknown").removeprefix("/u/"),
            "url": link.get("href") if link is not None else "",
            "published": e.findtext(f"{ATOM}updated") or e.findtext(f"{ATOM}published") or "",
            "body": re.sub(r"\s+", " ", body).strip(),
        })
    return entries


def parse_rss(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    entries = []
    for item in root.findall(".//item"):
        entries.append({
            "id": item.findtext("guid") or item.findtext("link") or "",
            "title": html.unescape(item.findtext("title") or ""),
            "author": item.findtext("author") or item.findtext("creator") or "Unknown",
            "url": item.findtext("link") or "",
            "published": item.findtext("pubDate") or "",
            "body": html.unescape(re.sub(r"<[^>]+>", " ", item.findtext("description") or "")),
        })
    return entries


def parse_feed(xml_text):
    atom_entries = parse_atom(xml_text)
    return atom_entries if atom_entries else parse_rss(xml_text)


def fetch_feed(url):
    r = session.get(url, headers={"Accept": "application/atom+xml, application/xml, text/xml"}, timeout=20)
    return r.status_code, (parse_feed(r.text) if r.status_code == 200 else [])


def scrape_reddit(tracked):
    rows = []
    for url in reddit_feed_urls():
        try:
            status, entries = fetch_feed(url)
            if status != 200:
                log(f"reddit {url} -> HTTP {status} (feed blocked or rate-limited)")
                continue
            for e in entries:
                text = f"{e['title']} {e['body']}"
                tickers = find_tickers(text, tracked)
                if not tickers or not e["id"] or not e["published"]:
                    continue
                rows.append((
                    f"reddit:{e['id']}", "Reddit", e["author"], text[:1000], e["url"],
                    e["published"], tickers, keyword_sentiment(text),
                ))
        except Exception as ex:
            log(f"reddit {url}: {ex}")
        time.sleep(random.uniform(2, 4))
    return rows


def scrape_x(tracked):
    rows = []
    for url in X_FEED_URLS:
        try:
            status, entries = fetch_feed(url)
            if status != 200:
                log(f"x feed {url} -> HTTP {status}")
                continue
            for e in entries:
                text = re.sub(r"\s+", " ", f"{e['title']} {e['body']}").strip()
                tickers = find_tickers(text, tracked)
                if not tickers or not e["id"] or not e["published"]:
                    continue
                rows.append((
                    f"x:{e['id']}", "X", e["author"], text[:1000], e["url"],
                    e["published"], tickers, keyword_sentiment(text),
                ))
        except Exception as ex:
            log(f"x feed {url}: {ex}")
        time.sleep(random.uniform(2, 4))
    return rows


# ---------- GlobeNewswire ----------
def news_date(value):
    try:
        date = parsedate_to_datetime(value.strip())
    except (TypeError, ValueError, OverflowError):
        try:
            date = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except (TypeError, ValueError, OverflowError):
            return None
    # Do not invent a time zone or replace missing dates with the current time.
    return date.astimezone(timezone.utc) if date.tzinfo is not None else None


def news_tickers(text):
    symbols = re.findall(r"\$([A-Z][A-Z0-9.-]{0,5})\b", text)
    symbols += re.findall(
        r"\b(?:NASDAQ|NYSE|AMEX|OTCQX|OTCQB|TSXV|TSX|CSE)\s*:\s*([A-Z][A-Z0-9.-]{0,5})\b",
        text, re.IGNORECASE,
    )
    return ",".join(dict.fromkeys(s.upper() for s in symbols)) or "N/A"


def news_category(text):
    groups = [
        ("Acquisition", ["acquisition", "acquire", "acquires", "acquired"]),
        ("Buyback", ["buyback", "share repurchase", "repurchase program"]),
        ("Delisting", ["delisting", "delisted"]),
        ("Compliance", ["compliance", "noncompliance"]),
        ("IPO", ["ipo", "initial public offering"]),
        ("Merger", ["merger", "merge"]),
        ("Partnership", ["partnership", "partners with", "collaboration"]),
        ("Beat", ["beats estimates", "tops estimates"]),
        ("Miss", ["misses estimates", "falls short"]),
        ("Earnings", ["earnings", "financial results", "quarter results"]),
        ("Investigation", ["investigation", "investigates", "class action"]),
        ("Probe", ["probe", "inquiry"]),
        ("Bankruptcy", ["bankruptcy", "chapter 11"]),
        ("FDA", ["fda", "food and drug administration"]),
        ("Approval", ["approval", "approved", "clearance"]),
        ("SEC", ["sec filing", "10-k", "10-q", "8-k", "form 6-k"]),
        ("Listing", ["listing", "listed on"]),
        ("Contract", ["contract", "award", "agreement"]),
    ]
    lowered = text.lower()
    return next((name for name, words in groups if any(w in lowered for w in words)), "Other")


def globe_rows(entries):
    rows = {}
    for entry in entries:
        title = re.sub(r"\s+", " ", entry["title"]).strip()
        url = entry["url"].strip()
        date = news_date(entry["published"])
        parsed = urlparse(url)
        if not title or date is None or parsed.scheme not in ("http", "https") or not parsed.hostname:
            continue
        text = f"{title} {entry['body']}"
        rows[url] = (title, "GlobeNewswire", date, url, news_category(text), news_tickers(text))
    return list(rows.values())


def scrape_globenewswire():
    status, entries = fetch_feed(GLOBENEWSWIRE_FEED_URL)
    if status != 200:
        raise RuntimeError(f"GlobeNewswire returned HTTP {status}")
    rows = globe_rows(entries)
    if not rows:
        raise RuntimeError("GlobeNewswire returned no usable dated articles")
    return rows


def collect_news(conn):
    try:
        # Honor the same source switch as the web news collector.
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.news_sources')")
            if cur.fetchone()[0]:
                cur.execute("SELECT enabled, feed_url FROM news_sources WHERE name = 'GlobeNewswire'")
                setting = cur.fetchone()
                if setting and (not setting[0] or setting[1]):
                    conn.commit()
                    log("GlobeNewswire: disabled or custom feed managed by web collector")
                    return
        conn.commit()
        rows = scrape_globenewswire()
        changed = 0
        with conn.cursor() as cur:
            for row in rows:
                cur.execute(NEWS_INSERT, row)
                changed += cur.rowcount
        conn.commit()
        log(f"GlobeNewswire: fetched {len(rows)} articles; saved {changed} new or changed articles")
    except Exception as ex:
        conn.rollback()
        log(f"GlobeNewswire collection failed: {ex}")
        if "--once" in sys.argv:
            raise


# ---------- storage + loop ----------
def save(conn, rows):
    new = 0
    with conn.cursor() as cur:
        for row in rows:
            cur.execute(INSERT, row)
            new += cur.rowcount
    conn.commit()
    return new


def recent_news_price_tickers(conn):
    """Bounded extra coverage for news, independent of screener filters."""
    try:
        with conn.cursor() as cur:
            cur.execute("""SELECT ticker FROM news_articles
                WHERE published_at > NOW() - interval '24 hours'
                  AND published_at <= NOW() AND ticker <> 'N/A'
                ORDER BY published_at DESC, id DESC LIMIT 1000""")
            rows = cur.fetchall()
        conn.commit()
        result = []
        for (raw,) in rows:
            for symbol in re.split(r"[,\s]+", raw or ""):
                symbol = re.sub(r"^(NASDAQ|NYSE|AMEX|NYSEAMERICAN|NYSEARCA):", "", symbol.strip().lstrip("$").upper())
                if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,9}", symbol) and symbol not in result:
                    result.append(symbol)
        return result[:20]
    except Exception:
        conn.rollback()
        log("News price coverage unavailable; retaining screener price collection")
        return []


PRICE_TRACKED = {}


def collect_correlation_prices(tickers):
    """One batch request; retain recently tracked tickers for an outcome window."""
    import json
    from urllib.request import urlopen
    from urllib.parse import urlencode
    now = time.monotonic()
    for ticker in tickers:
        PRICE_TRACKED[ticker] = now
    for ticker, seen in list(PRICE_TRACKED.items()):
        if now - seen > 3600:
            del PRICE_TRACKED[ticker]
    previous = sorted((ticker for ticker in PRICE_TRACKED if ticker not in tickers), key=lambda ticker: PRICE_TRACKED[ticker], reverse=True)
    requested = list(dict.fromkeys(tickers + previous))[:60]
    try:
        with urlopen(f"{APP_URL}/api/prices?{urlencode({'tickers': ','.join(requested)})}", timeout=40) as response:
            data = json.load(response)
        log(f"Correlation prices: saved {data.get('saved', 0)} observations for {len(requested)} requested tickers; cached={data.get('cached', False)}")
        if len(PRICE_TRACKED) > 60:
            log("Correlation prices: 60-ticker collection limit reached; some carried tickers omitted")
    except Exception:
        log("Correlation price collection failed; check website /api/prices and provider access")


def sync_correlation():
    import json
    from urllib.request import Request, urlopen
    try:
        request = Request(f"{APP_URL}/api/correlation?days=7", data=b"", method="POST")
        with urlopen(request, timeout=90) as response:
            data = json.load(response)
        log(f"Correlation sync: {data.get('overall', {}).get('events', 0)} priced events in last 7 days")
    except Exception:
        log("Correlation sync failed; the website Run Analysis button can retry")


def run_once(conn):
    load_settings(conn)
    tickers = get_tickers()
    log(f"{len(tickers)} tracked tickers")
    news_prices = recent_news_price_tickers(conn)
    log(f"Correlation coverage: {len(news_prices)} recent news tickers plus screener/watchlist")
    collect_correlation_prices(list(dict.fromkeys(tickers + news_prices)))
    new = 0
    for ticker in tickers:
        try:
            STOCKTWITS_WATCHERS.pop(ticker, None)
            new += save(conn, scrape_stocktwits(ticker))
            if ticker in STOCKTWITS_WATCHERS:
                with conn.cursor() as cur:
                    cur.execute("""CREATE TABLE IF NOT EXISTS stocktwits_metric_snapshots (
                        ticker TEXT NOT NULL, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        watchers BIGINT NOT NULL CHECK (watchers >= 0), PRIMARY KEY(ticker,captured_at))""")
                    cur.execute("INSERT INTO stocktwits_metric_snapshots(ticker,watchers) VALUES (%s,%s)", (ticker,STOCKTWITS_WATCHERS[ticker]))
                conn.commit()
        except Exception as e:  # one bad ticker shouldn't stop the cycle
            conn.rollback()
            log(f"stocktwits {ticker}: {e}")
        time.sleep(random.uniform(1.5, 3.5))
    for handle in STOCKTWITS_USERS:
        try:
            new += save(conn, scrape_stocktwits_user(handle))
        except Exception as e:
            conn.rollback()
            log(f"stocktwits user {handle}: {e}")
        time.sleep(random.uniform(1.5, 3.5))
    reddit_new = save(conn, scrape_reddit(tickers))
    x_new = save(conn, scrape_x(tickers)) if X_FEED_URLS else 0
    log(f"inserted {new} Stocktwits + {reddit_new} Reddit + {x_new} X posts")
    sync_correlation()


def check():
    log("GlobeNewswire test")
    try:
        log(f"  {len(scrape_globenewswire())} usable articles")
    except Exception as e:
        log(f"  failed: {e}")
    if "--news-only" in sys.argv:
        return
    log("Stocktwits test (AAPL)")
    try:
        log(f"  {len(scrape_stocktwits('AAPL'))} messages")
    except Exception as e:
        log(f"  failed: {e}")
    for url in reddit_feed_urls():
        try:
            status, entries = fetch_feed(url)
            log(f"{url} -> HTTP {status}, {len(entries)} entries")
        except Exception as e:
            log(f"{url} -> {e}")
        time.sleep(random.uniform(2, 4))
    for url in X_FEED_URLS:
        try:
            status, entries = fetch_feed(url)
            log(f"X {url} -> HTTP {status}, {len(entries)} entries")
        except Exception as e:
            log(f"X {url} -> {e}")


def collect_public_news(conn):
    from public_news import fetch_source
    for source in ("AccessWire", "Benzinga"):
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.news_sources')")
                if cur.fetchone()[0]:
                    cur.execute("SELECT enabled, feed_url FROM news_sources WHERE name = %s", (source,))
                    setting = cur.fetchone()
                    if setting and (not setting[0] or setting[1]):
                        conn.commit()
                        log(f"{source}: disabled or custom feed managed by web collector")
                        continue
            conn.commit()
            rows = fetch_source(source)
            if not rows:
                raise RuntimeError("no usable dated articles")
            changed = 0
            with conn.cursor() as cur:
                for row in rows:
                    cur.execute(NEWS_INSERT, (row["title"], source, row["date"], row["url"], news_category(row["title"]), news_tickers(row["title"])))
                    changed += cur.rowcount
            conn.commit()
            newest = max(row["date"] for row in rows).isoformat()
            log(f"{source}: fetched {len(rows)} articles; saved {changed} new or changed; newest {newest}")
        except Exception as error:
            conn.rollback()
            # Public-source requests contain no tokens; never print private DB errors.
            from urllib.error import HTTPError
            reason = f"HTTP {error.code}" if isinstance(error, HTTPError) else "request, parser or database error"
            log(f"{source}: collection failed ({reason}); retaining saved articles")


def refresh_app_news():
    """Collect all configured web news feeds even when no browser is open."""
    import json
    from urllib.request import urlopen
    try:
        with urlopen(f"{APP_URL}/api/news", timeout=90) as response:
            payload = json.load(response)
        if payload.get("error"):
            raise RuntimeError("news endpoint returned an error")
        log(f"Web news: {payload.get('count', 0)} saved articles available")
        for source in ("FDA", "GlobeNewswire", "AccessWire", "Benzinga"):
            dates = [str(row.get("Date", "")) for row in payload.get("results", []) if row.get("Source") == source]
            log(f"{source}: {len(dates)} stored; newest {max(dates) if dates else 'none'}")
    except Exception:
        log("Web news refresh failed; check APP_URL and the website logs")


def main():
    if "--check" in sys.argv:
        return check()
    import psycopg2  # imported here so --check works without a database driver

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn.cursor() as cur:
        cur.execute(DDL)
    conn.commit()
    next_news = 0.0
    news_only = "--news-only" in sys.argv
    try:
        while True:
            started = time.monotonic()
            # News collection does not depend on Finviz or successful social requests.
            if started >= next_news:
                collect_news(conn)
                collect_public_news(conn)
                refresh_app_news()
                next_news = started + NEWS_INTERVAL
            if not news_only:
                try:
                    run_once(conn)
                except Exception as e:
                    conn.rollback()
                    log(f"social cycle failed: {e}")
            if "--once" in sys.argv:
                break
            delay = NEWS_INTERVAL if news_only else INTERVAL
            time.sleep(max(5, delay - (time.monotonic() - started)))
    except KeyboardInterrupt:
        log("Worker stopped")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
