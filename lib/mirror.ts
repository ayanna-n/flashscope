import { database } from "./db";
import { ensureDatabaseSchema } from "./database-schema";
import { loadKeywordSettings, type KeywordSettings } from "./settings";

/** How long after an event we look for the "after" price. */
export const HORIZON_MINUTES = 30;
const HISTORY_DAYS = 100;

const BULLISH_CATEGORIES = new Set([
  "Acquisition",
  "Buyback",
  "Contract",
  "Partnership",
  "Approval",
  "Beat",
  "Listing",
  "IPO",
]);
const BEARISH_CATEGORIES = new Set([
  "Investigation",
  "Probe",
  "Delisting",
  "Compliance",
  "Bankruptcy",
  "Miss",
]);

function countHits(text: string, words: string[]) {
  return words.reduce((sum, word) => {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return sum + (word && new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text) ? 1 : 0);
  }, 0);
}

function sign(value: number) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** -1 bearish, 0 neutral, 1 bullish. */
export function scoreNews(headline: string, category: string, keywords: KeywordSettings) {
  const text = headline.toLowerCase();
  let score = 0;
  if (BULLISH_CATEGORIES.has(category)) score += 1;
  if (BEARISH_CATEGORIES.has(category)) score -= 1;
  score += countHits(text, keywords.bullish) - countHits(text, keywords.bearish);
  return sign(score);
}

export function scoreSocial(body: string, label: string, keywords: KeywordSettings) {
  const text = body.toLowerCase();
  const stored = label === "Bullish" ? 1 : label === "Bearish" ? -1 : 0;
  const custom = countHits(text, keywords.bullish) - countHits(text, keywords.bearish);
  return sign(stored * 2 + custom);
}

/* ---------- price snapshots ---------- */

function toNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/[%,$\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function field(record: Record<string, string>, ...names: string[]) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== "") return record[name];
  }
  return "";
}

/** Called by /api/finviz after every fresh screener fetch. Never throws. */
export async function recordPriceSnapshots(records: Record<string, string>[], capturedAt = new Date().toISOString()) {
  if (!process.env.DATABASE_URL) return 0;
  try {
    await ensureDatabaseSchema();
    const rows = records
      .map((record) => ({
        ticker: field(record, "Ticker", "ticker", "Symbol").trim().toUpperCase(),
        company: field(record, "Company", "company"),
        price: toNumber(field(record, "Price", "price")),
        change: toNumber(field(record, "Change", "Change %", "change")),
        volume: field(record, "Volume", "volume"),
        relVolume: toNumber(field(record, "Relative Volume", "Rel Volume", "Rel. Volume")),
        marketCap: field(record, "Market Cap", "MarketCap"),
      }))
      .filter((row) => row.ticker && row.price !== null && row.price > 0);

    if (rows.length === 0) return 0;

    const saved = await database.query(
      `INSERT INTO price_snapshots (ticker, company, price, change_pct, volume, rel_volume, market_cap, captured_at)
       SELECT t.*, $8::timestamptz FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::text[], $6::numeric[], $7::text[]) AS t`,
      [
        rows.map((r) => r.ticker),
        rows.map((r) => r.company),
        rows.map((r) => r.price),
        rows.map((r) => r.change),
        rows.map((r) => r.volume),
        rows.map((r) => r.relVolume),
        rows.map((r) => r.marketCap),
        capturedAt,
      ]
    );
    return saved.rowCount ?? rows.length;
  } catch (error) {
    console.error("Price snapshot failed:", error);
    return 0;
  }
}

/* ---------- mirror sync ---------- */

type MirrorRow = {
  key: string;
  ticker: string;
  kind: "news" | "social";
  source: string;
  author: string | null;
  text: string;
  url: string | null;
  category: string;
  sentiment: number;
  publishedAt: string;
};

async function insertMirrorRows(rows: MirrorRow[]) {
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await database.query(
      `INSERT INTO mirror (event_key, ticker, kind, source, author, text, url, category, sentiment, published_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                            $6::text[], $7::text[], $8::text[], $9::int[], $10::timestamptz[])
       ON CONFLICT (event_key) DO UPDATE SET
         sentiment = EXCLUDED.sentiment, category = EXCLUDED.category,
         text = EXCLUDED.text, url = EXCLUDED.url, author = EXCLUDED.author,
         source = EXCLUDED.source, published_at = EXCLUDED.published_at, synced_at = NOW()`,
      [
        part.map((r) => r.key),
        part.map((r) => r.ticker),
        part.map((r) => r.kind),
        part.map((r) => r.source),
        part.map((r) => r.author),
        part.map((r) => r.text),
        part.map((r) => r.url),
        part.map((r) => r.category),
        part.map((r) => r.sentiment),
        part.map((r) => r.publishedAt),
      ]
    );
  }
}

export type SyncResult = { newsRows: number; socialRows: number; priced: number };

/**
 * Copies every news article and social post (one row per ticker) into the
 * mirror, scores sentiment with the Settings keywords, then attaches the price
 * at the time of the event and the price HORIZON_MINUTES later.
 */
export async function syncMirror(): Promise<SyncResult> {
  await ensureDatabaseSchema();
  const keywords = await loadKeywordSettings();

  const news = await database.query<{
    id: string; headline: string; source: string; published_at: Date;
    url: string; category: string; ticker: string;
  }>(
    `SELECT id::text, headline, source, published_at, url, category, ticker
     FROM news_articles
     WHERE ticker <> 'N/A' AND published_at > NOW() - make_interval(days => $1::int) AND published_at <= NOW()`,
    [HISTORY_DAYS]
  );

  const newsRows: MirrorRow[] = [];
  for (const item of news.rows) {
    const tickers = item.ticker
      .split(/[,\s]+/)
      .map((t) => t.trim().replace(/^\$/, "").toUpperCase().replace(/^(NASDAQ|NYSE|AMEX|NYSEAMERICAN|NYSEARCA):/, ""))
      .filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
    for (const ticker of new Set(tickers)) {
      newsRows.push({
        key: `news:${item.id}:${ticker}`,
        ticker,
        kind: "news",
        source: item.source,
        author: null,
        text: item.headline,
        url: item.url,
        category: item.category,
        sentiment: scoreNews(item.headline, item.category, keywords),
        publishedAt: new Date(item.published_at).toISOString(),
      });
    }
  }

  const social = await database.query<{
    id: string; platform: string; author: string; body: string; url: string | null;
    published_at: Date; tickers: string[]; sentiment: string;
  }>(
    `SELECT id::text, platform, author, body, url, published_at, tickers, sentiment
     FROM social_posts
     WHERE published_at > NOW() - make_interval(days => $1::int) AND published_at <= NOW()
       AND cardinality(tickers) > 0`,
    [HISTORY_DAYS]
  );

  const socialRows: MirrorRow[] = [];
  for (const post of social.rows) {
    const postTickers = new Set(
      post.tickers.map((value) => value.trim().replace(/^\$/, "").toUpperCase()).filter(Boolean)
    );
    for (const ticker of postTickers) {
      socialRows.push({
        key: `social:${post.id}:${ticker}`,
        ticker,
        kind: "social",
        source: post.platform,
        author: post.author,
        text: post.body,
        url: post.url,
        category: "Social",
        sentiment: scoreSocial(post.body, post.sentiment, keywords),
        publishedAt: new Date(post.published_at).toISOString(),
      });
    }
  }

  await insertMirrorRows(newsRows);
  await insertMirrorRows(socialRows);

  // Recompute both sides together. Never retain a pair from an older matching rule.
  // Baseline must be within 15 minutes before publication; outcome within
  // 30–45 minutes after publication. Missing history stays NULL.
  await database.query(
    `WITH pairs AS (
       SELECT m.id, b.price AS before_price, b.captured_at AS before_at,
         b.company, b.volume, b.rel_volume, b.market_cap, b.change_pct,
         a.price AS after_price, a.captured_at AS after_at
       FROM mirror m
       LEFT JOIN LATERAL (
         SELECT * FROM price_snapshots s WHERE s.ticker = m.ticker
           AND s.captured_at <= m.published_at
           AND s.captured_at >= m.published_at - interval '15 minutes'
         ORDER BY s.captured_at DESC, s.id DESC LIMIT 1
       ) b ON TRUE
       LEFT JOIN LATERAL (
         SELECT * FROM price_snapshots s WHERE s.ticker = m.ticker
           AND s.captured_at >= m.published_at + make_interval(mins => $1::int)
           AND s.captured_at <= m.published_at + make_interval(mins => $1::int) + interval '15 minutes'
           AND s.captured_at <= NOW()
         ORDER BY s.captured_at ASC, s.id ASC LIMIT 1
       ) a ON TRUE
       WHERE m.published_at > NOW() - make_interval(days => $2::int)
     )
     UPDATE mirror m SET company = COALESCE(p.company, ''), volume = p.volume,
       rel_volume = p.rel_volume, market_cap = p.market_cap, change_pct = p.change_pct,
       price_at_event = p.before_price, price_at_event_at = p.before_at,
       price_after = CASE WHEN p.before_price > 0 THEN p.after_price END,
       price_after_at = CASE WHEN p.before_price > 0 THEN p.after_at END,
       return_pct = CASE WHEN p.before_price > 0 AND p.after_price IS NOT NULL
         THEN (p.after_price - p.before_price) / p.before_price * 100 END
     FROM pairs p WHERE p.id = m.id`,
    [HORIZON_MINUTES, HISTORY_DAYS]
  );

  await database.query(
    `DELETE FROM price_snapshots WHERE captured_at < NOW() - make_interval(days => $1::int)`,
    [HISTORY_DAYS]
  );

  return {
    newsRows: newsRows.length,
    socialRows: socialRows.length,
    priced: (await database.query<{ count: number }>("SELECT COUNT(return_pct)::int AS count FROM mirror")).rows[0]?.count ?? 0,
  };
}

/* ---------- correlation ---------- */

export function pearson(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export type CorrelationRow = {
  ticker: string;
  events: number;
  news: number;
  newsTotal: number;
  social: number;
  avgSentiment: number;
  avgReturn: number;
  correlation: number | null;
  newsCorrelation: number | null;
  socialCorrelation: number | null;
  hitRate: number | null;
  lastPrice: number | null;
  lowSample: boolean;
};

export type CorrelationPayload = {
  days: number;
  horizonMinutes: number;
  diagnostics: { observationTimes: number; firstSnapshotAt: string | null; lastSnapshotAt: string | null; noTickerHistory: number; noBaseline: number; waitingAfter: number; missingAfter: number };
  overall: { events: number; correlation: number | null; hitRate: number | null };
  rows: CorrelationRow[];
  mirror: {
    totalEvents: number;
    pricedEvents: number;
    tickers: number;
    snapshots: number;
    lastSnapshotAt: string | null;
  };
};

export async function computeCorrelation(days = 7): Promise<CorrelationPayload> {
  await ensureDatabaseSchema();
  const windowDays = Math.min(Math.max(Math.trunc(days) || 7, 1), HISTORY_DAYS);

  const events = await database.query<{
    ticker: string; kind: string; sentiment: number; return_pct: string;
  }>(
    `SELECT ticker, kind, sentiment::int, return_pct::text
     FROM mirror
     WHERE return_pct IS NOT NULL
       AND published_at > NOW() - make_interval(days => $1::int) AND published_at <= NOW()`,
    [windowDays]
  );

  const byTicker = new Map<string, { kind: string; s: number; r: number }[]>();
  for (const row of events.rows) {
    const list = byTicker.get(row.ticker) ?? [];
    list.push({ kind: row.kind, s: row.sentiment, r: Number(row.return_pct) });
    byTicker.set(row.ticker, list);
  }

  const newsCoverage = await database.query<{ticker: string; total: number}>(
    `SELECT ticker, COUNT(*)::int AS total FROM mirror WHERE kind = 'news'
      AND published_at > NOW() - make_interval(days => $1::int) AND published_at <= NOW()
      GROUP BY ticker`, [windowDays]
  );
  const newsTotals = new Map(newsCoverage.rows.map(row => [row.ticker, row.total]));

  const last = await database.query<{ ticker: string; price: string }>(
    `SELECT DISTINCT ON (ticker) ticker, price::text FROM price_snapshots
     ORDER BY ticker, captured_at DESC`
  );
  const lastPrice = new Map(last.rows.map((r) => [r.ticker, Number(r.price)]));

  const hit = (list: { s: number; r: number }[]) => {
    const directional = list.filter((e) => e.s !== 0);
    if (directional.length === 0) return null;
    return directional.filter((e) => sign(e.r) === e.s).length / directional.length;
  };
  const corr = (list: { s: number; r: number }[]) =>
    pearson(list.map((e) => e.s), list.map((e) => e.r));
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  const rows: CorrelationRow[] = [...byTicker.entries()]
    .map(([ticker, list]) => ({
      ticker,
      events: list.length,
      news: list.filter((e) => e.kind === "news").length,
      newsTotal: newsTotals.get(ticker) ?? 0,
      social: list.filter((e) => e.kind === "social").length,
      avgSentiment: mean(list.map((e) => e.s)),
      avgReturn: mean(list.map((e) => e.r)),
      correlation: corr(list),
      newsCorrelation: corr(list.filter((e) => e.kind === "news")),
      socialCorrelation: corr(list.filter((e) => e.kind === "social")),
      hitRate: hit(list),
      lastPrice: lastPrice.get(ticker) ?? null,
      lowSample: list.length < 10,
    }))
    .sort((a, b) => b.events - a.events);

  const all = events.rows.map((e) => ({ s: e.sentiment, r: Number(e.return_pct) }));

  const totals = await database.query<{
    total: number; priced: number; tickers: number;
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(return_pct)::int AS priced,
            COUNT(DISTINCT ticker)::int AS tickers
     FROM mirror`
  );
  const snaps = await database.query<{ count: number; last: Date | null }>(
    `SELECT COUNT(*)::int AS count, MAX(captured_at) AS last FROM price_snapshots`
  );

  const diagnostics = await database.query<{no_history: number; no_baseline: number; waiting: number; missing_after: number}>(
    `WITH coverage AS (
      SELECT m.published_at,
        EXISTS(SELECT 1 FROM price_snapshots s WHERE s.ticker = m.ticker) AS history,
        EXISTS(SELECT 1 FROM price_snapshots s WHERE s.ticker = m.ticker AND s.captured_at BETWEEN m.published_at - interval '15 minutes' AND m.published_at) AS baseline,
        EXISTS(SELECT 1 FROM price_snapshots s WHERE s.ticker = m.ticker AND s.captured_at BETWEEN m.published_at + interval '30 minutes' AND m.published_at + interval '45 minutes' AND s.captured_at <= NOW()) AS outcome
      FROM mirror m WHERE m.published_at > NOW() - make_interval(days => $1::int) AND m.published_at <= NOW()
    ) SELECT
      COUNT(*) FILTER(WHERE NOT history)::int AS no_history,
      COUNT(*) FILTER(WHERE history AND NOT baseline)::int AS no_baseline,
      COUNT(*) FILTER(WHERE baseline AND NOT outcome AND published_at + interval '45 minutes' >= NOW())::int AS waiting,
      COUNT(*) FILTER(WHERE baseline AND NOT outcome AND published_at + interval '45 minutes' < NOW())::int AS missing_after
    FROM coverage`, [windowDays]);
  const times = (await database.query<{n: number; first: Date | null}>("SELECT COUNT(DISTINCT captured_at)::int AS n, MIN(captured_at) AS first FROM price_snapshots")).rows[0];
  const diag = diagnostics.rows[0];
  return {
    diagnostics: { observationTimes: times?.n ?? 0, firstSnapshotAt: times?.first ? new Date(times.first).toISOString() : null,
      lastSnapshotAt: snaps.rows[0]?.last ? new Date(snaps.rows[0].last).toISOString() : null,
      noTickerHistory: diag?.no_history ?? 0, noBaseline: diag?.no_baseline ?? 0, waitingAfter: diag?.waiting ?? 0, missingAfter: diag?.missing_after ?? 0 },
    days: windowDays,
    horizonMinutes: HORIZON_MINUTES,
    overall: { events: all.length, correlation: corr(all), hitRate: hit(all) },
    rows,
    mirror: {
      totalEvents: totals.rows[0]?.total ?? 0,
      pricedEvents: totals.rows[0]?.priced ?? 0,
      tickers: totals.rows[0]?.tickers ?? 0,
      snapshots: snaps.rows[0]?.count ?? 0,
      lastSnapshotAt: snaps.rows[0]?.last ? new Date(snaps.rows[0].last).toISOString() : null,
    },
  };
}
