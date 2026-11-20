import { initializeOptInSettings } from "./settings-initialization";
import { database } from "./db";
import { ensureDatabaseSchema } from "./database-schema";

export type SocialPlatformSetting = { id: number; platform: string; enabled: boolean };
export async function loadSocialPlatforms(): Promise<SocialPlatformSetting[]> {
  await initializeOptInSettings();
  await database.query(`CREATE TABLE IF NOT EXISTS social_platforms (
    id BIGSERIAL PRIMARY KEY, platform TEXT NOT NULL UNIQUE, enabled BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  await database.query(`INSERT INTO social_platforms (platform, enabled) SELECT unnest($1::text[]), TRUE
    ON CONFLICT (platform) DO NOTHING`, [["Stocktwits", "Reddit", "X"]]);
  const result = await database.query<SocialPlatformSetting>(`SELECT id::int, platform, enabled FROM social_platforms
    WHERE platform = ANY($1::text[]) ORDER BY id`, [["Stocktwits", "Reddit", "X"]]);
  return result.rows;
}
