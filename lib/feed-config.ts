import { initializeOptInSettings } from "./settings-initialization";
import { database } from "./db";
import { ensureDatabaseSchema } from "./database-schema";
import { DEFAULT_FEED_CONFIG, validConfigValue, type FeedConfig } from "./feed-preferences";
async function ensureConfig() {
  await initializeOptInSettings();
  await database.query(`CREATE TABLE IF NOT EXISTS feed_config (id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL)`);
  await database.query(`INSERT INTO feed_config(id,data) VALUES (1,$1::jsonb) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(DEFAULT_FEED_CONFIG)]);
}
export async function loadFeedConfig(): Promise<FeedConfig> {
  await ensureConfig();
  const result = await database.query<{data: Record<string,unknown>}>("SELECT data FROM feed_config WHERE id = 1");
  const config = {...DEFAULT_FEED_CONFIG};
  for (const [key,value] of Object.entries(result.rows[0]?.data ?? {})) if (validConfigValue(key,value)) Object.assign(config,{[key]:value});
  return config;
}
export async function saveFeedConfig(key: string, value: unknown) {
  if (!validConfigValue(key,value)) throw new Error("Invalid Config option.");
  await ensureConfig();
  await database.query(`UPDATE feed_config SET data = jsonb_set(data, ARRAY[$1]::text[], $2::jsonb, true) WHERE id = 1`, [key,JSON.stringify(value)]);
  return loadFeedConfig();
}

export async function resetFeedConfig() {
  await ensureConfig();
  await database.query("UPDATE feed_config SET data=$1::jsonb WHERE id=1", [JSON.stringify(DEFAULT_FEED_CONFIG)]);
  return {...DEFAULT_FEED_CONFIG};
}
