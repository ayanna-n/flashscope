import { initializeOptInSettings } from "./settings-initialization";
import { approvedKeywordEntries, approvedKeywordCategory } from "./approved-keywords";
import { database } from "./db";
import { ensureDatabaseSchema } from "./database-schema";

export const BUILT_IN_SOURCES = [
  "PR Newswire",
  "GlobeNewswire",
  "AccessWire",
  "MT Newswires",
  "Dow Jones Newswires",
  "SEC",
  "FDA",
  "Benzinga",
  "TradingView/Reuters",
];

export const SOCIAL_PLATFORMS = ["Stocktwits", "Reddit", "X"] as const;
export const KEYWORD_CATEGORIES = ["Any", "Bullish", "Neutral", "Bearish"] as const;

export { APPROVED_KEYWORDS as DEFAULT_KEYWORDS } from "./approved-keywords";

export async function seedBuiltInKeywords() {
  await initializeOptInSettings();
  const entries = approvedKeywordEntries;
  await database.query(
    `INSERT INTO keywords (keyword, category, enabled)
     SELECT keyword, category, FALSE FROM jsonb_to_recordset($1::jsonb) AS items(keyword text, category text)
     ON CONFLICT (keyword, category) DO NOTHING`,
    [JSON.stringify(entries)]
  );
  await database.query(
    `UPDATE keywords k SET enabled = FALSE WHERE enabled = TRUE AND NOT EXISTS (
       SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS a(keyword text, category text)
       WHERE a.keyword = k.keyword AND a.category = k.category
     )`, [JSON.stringify(entries)]
  );
}

export type SourceSetting = {
  id: number;
  name: string;
  feed_url: string | null;
  category: string;
  enabled: boolean;
  status: string;
  builtIn: boolean;
};

export async function seedBuiltInSources() {
  await initializeOptInSettings();
  await database.query(
    `INSERT INTO news_sources (name, category, enabled)
     SELECT unnest($1::text[]), 'All', TRUE
     ON CONFLICT (name) DO NOTHING`,
    [BUILT_IN_SOURCES]
  );
}

export async function loadSourceSettings(): Promise<SourceSetting[]> {
  try {
    await seedBuiltInSources();
    const result = await database.query<Omit<SourceSetting, "builtIn">>(
      `SELECT id::int, name, feed_url, category, enabled, status
       FROM news_sources
       ORDER BY created_at, id`
    );
    return result.rows.map((row) => ({
      ...row,
      builtIn: BUILT_IN_SOURCES.includes(row.name),
      status: !row.enabled ? "Disabled" : row.feed_url ? "Feed configured; checked on news refresh" :
        ((row.name === "MT Newswires" && !process.env.MT_NEWSWIRES_FEED_URL) ||
         (row.name === "Dow Jones Newswires" && !process.env.DOW_JONES_FEED_URL) ||
         (row.name === "Benzinga" && !process.env.BENZINGA_FEED_URL && !process.env.BENZINGA_API_TOKEN))
          ? "Feed access required" : "Built-in collector; availability checked on refresh",
    }));
  } catch (error) {
    console.error("Unable to load source settings:", error);
    throw error;
  }
}

export type KeywordSettings = { bullish: string[]; bearish: string[] };

export async function loadKeywordSettings(): Promise<KeywordSettings> {
  try {
    await seedBuiltInKeywords();
    const result = await database.query<{ keyword: string; category: string }>(
      `SELECT keyword, category FROM keywords WHERE enabled = TRUE`
    );
    const pick = (category: string) =>
      result.rows
        .filter((row) => row.category === category && approvedKeywordCategory(row.keyword) === row.category)
        .map((row) => row.keyword.toLowerCase());
    return { bullish: pick("Bullish"), bearish: pick("Bearish") };
  } catch (error) {
    console.error("Unable to load keyword settings:", error);
    return { bullish: [], bearish: [] };
  }
}

export async function loadEnabledFeedKeywords() {
  await seedBuiltInKeywords();
  const result = await database.query<{keyword: string; category: string}>("SELECT keyword, category FROM keywords WHERE enabled = TRUE");
  return result.rows.filter((row) => approvedKeywordCategory(row.keyword) === row.category).map((row) => row.keyword);
}
