import { database } from "./db";

let schemaPromise: Promise<void> | null = null;

export function ensureDatabaseSchema() {
  if (!schemaPromise) {
    schemaPromise = createDatabaseTables().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  return schemaPromise;
}

async function createDatabaseTables() {
  await database.query(`
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

    CREATE TABLE IF NOT EXISTS news_sources (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      feed_url TEXT,
      category TEXT NOT NULL DEFAULT 'All',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    CREATE TABLE IF NOT EXISTS stocktwits_metric_snapshots (
      ticker TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      watchers BIGINT NOT NULL CHECK (watchers >= 0),
      PRIMARY KEY (ticker, captured_at)
    );

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

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id BIGSERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      price NUMERIC NOT NULL,
      change_pct NUMERIC,
      volume TEXT,
      rel_volume NUMERIC,
      market_cap TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- The mirror: one row per news article or social post per ticker, with the
    -- price context and sentiment next to it so correlation reads a single table.
    CREATE TABLE IF NOT EXISTS mirror (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      ticker TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      author TEXT,
      text TEXT NOT NULL,
      url TEXT,
      category TEXT NOT NULL DEFAULT 'Other',
      sentiment SMALLINT NOT NULL DEFAULT 0,
      published_at TIMESTAMPTZ NOT NULL,
      price_at_event NUMERIC,
      price_after NUMERIC,
      price_after_at TIMESTAMPTZ,
      return_pct NUMERIC,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Latest full Finviz quote (valuation, ownership, EPS, ...) per ticker: the mirror panel.
    CREATE TABLE IF NOT EXISTS ticker_mirror (
      ticker TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS price_snapshots_ticker_time_index
      ON price_snapshots (ticker, captured_at DESC);

    CREATE INDEX IF NOT EXISTS mirror_ticker_time_index
      ON mirror (ticker, published_at DESC);

    CREATE INDEX IF NOT EXISTS news_articles_published_at_index
      ON news_articles (published_at DESC);

    CREATE INDEX IF NOT EXISTS news_articles_source_index
      ON news_articles (source);

    CREATE INDEX IF NOT EXISTS social_posts_published_at_index
      ON social_posts (published_at DESC);
  `);
}