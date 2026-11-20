import { DEFAULT_FEED_CONFIG } from "./feed-preferences";
import { database } from "./db";
import { ensureDatabaseSchema } from "./database-schema";
import { approvedKeywordEntries } from "./approved-keywords";
let pending: Promise<void> | null = null;
/** News and social platforms start enabled; keywords remain opt-in. */
export function initializeOptInSettings() {
  if (!pending) pending = initialize().catch((error) => { pending = null; throw error; });
  return pending;
}
async function initialize() {
  await ensureDatabaseSchema();
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73190421)");
    await client.query("CREATE TABLE IF NOT EXISTS settings_migrations (name text PRIMARY KEY)");
    await client.query("CREATE TABLE IF NOT EXISTS social_platforms (id BIGSERIAL PRIMARY KEY, platform TEXT NOT NULL UNIQUE, enabled BOOLEAN NOT NULL DEFAULT TRUE)");
    await client.query("ALTER TABLE social_platforms ALTER COLUMN enabled SET DEFAULT TRUE");
    await client.query("CREATE TABLE IF NOT EXISTS feed_config (id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL)");
    await client.query("INSERT INTO feed_config(id,data) VALUES (1,$1::jsonb) ON CONFLICT(id) DO NOTHING", [JSON.stringify(DEFAULT_FEED_CONFIG)]);
    const migration = await client.query("INSERT INTO settings_migrations(name) VALUES ('all-news-socials-opt-in-keywords-v5') ON CONFLICT DO NOTHING RETURNING name");
    if (migration.rows.length) {
      await client.query("UPDATE news_sources SET enabled = TRUE");
      await client.query(`UPDATE keywords k SET enabled = FALSE WHERE EXISTS (
        SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS a(keyword text,category text)
        WHERE a.keyword=k.keyword AND a.category=k.category
      )`, [JSON.stringify(approvedKeywordEntries)]);
      await client.query("UPDATE social_platforms SET enabled = TRUE");
      await client.query("UPDATE social_accounts SET enabled = FALSE");
      await client.query(`INSERT INTO keywords(keyword,category,enabled)
        SELECT keyword,category,FALSE FROM jsonb_to_recordset($1::jsonb) AS a(keyword text,category text)
        ON CONFLICT(keyword,category) DO NOTHING`, [JSON.stringify(approvedKeywordEntries)]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Explicit full-page reset; never called by polling or individual controls. */
export async function restoreAllSettings() {
  await initializeOptInSettings();
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73190421)");
    await client.query("UPDATE news_sources SET enabled = TRUE");
    await client.query(`UPDATE keywords k SET enabled = FALSE WHERE EXISTS (
      SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS a(keyword text,category text)
      WHERE a.keyword=k.keyword AND a.category=k.category
    )`, [JSON.stringify(approvedKeywordEntries)]);
    await client.query("UPDATE social_platforms SET enabled = TRUE");
    await client.query("UPDATE social_accounts SET enabled = FALSE");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
