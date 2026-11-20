import { initializeOptInSettings, restoreAllSettings } from "@/lib/settings-initialization";
import { loadFeedConfig, saveFeedConfig, resetFeedConfig } from "@/lib/feed-config";
import { validConfigValue } from "@/lib/feed-preferences";
import { loadSocialPlatforms } from "@/lib/social-platforms";
import { approvedKeywordCategory } from "@/lib/approved-keywords";
import { NextRequest, NextResponse } from "next/server";
import { database } from "@/lib/db";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import {
  BUILT_IN_SOURCES,
  SOCIAL_PLATFORMS,
  loadSourceSettings,
  seedBuiltInKeywords,
} from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SettingType = "sources" | "keywords" | "accounts" | "platforms" | "config";

function readType(request: NextRequest): SettingType | null {
  const type = request.nextUrl.searchParams.get("type");
  return type === "sources" || type === "keywords" || type === "accounts" || type === "platforms" || type === "config" ? type : null;
}

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function cleanHttpUrl(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function list(type: SettingType) {
  if (type === "config") return loadFeedConfig();
  if (type === "platforms") return loadSocialPlatforms();
  if (type === "sources") return loadSourceSettings();
  if (type === "keywords") {
    await seedBuiltInKeywords();
    const result = await database.query(
      `SELECT id::int, keyword, category, enabled FROM keywords ORDER BY category, keyword`
    );
    return result.rows.filter((row) => approvedKeywordCategory(row.keyword) === row.category);
  }
  const result = await database.query(
    `SELECT id::int, platform, handle, enabled FROM social_accounts ORDER BY platform, handle`
  );
  return result.rows;
}

export async function GET(request: NextRequest) {
  const type = readType(request);
  if (!type) return fail("type must be sources, keywords, accounts or platforms.");
  try {
    await initializeOptInSettings();
    return NextResponse.json({ results: await list(type) });
  } catch (error) {
    console.error("Settings load failed:", error);
    return fail("Unable to load settings.", 500);
  }
}

export async function POST(request: NextRequest) {
  const type = readType(request);
  if (!type) return fail("type must be sources, keywords, accounts or platforms.");

  try {
    await initializeOptInSettings();
    const body = (await request.json()) as Record<string, unknown>;
    if (type === "config" && body.action === "reset-defaults") return NextResponse.json({results: await resetFeedConfig()});
    if (body.action === "restore-all") {
      await restoreAllSettings();
      return NextResponse.json({ restored: true });
    }
    if (type === "platforms" || type === "config") return fail("Use the Settings controls to update this option.");

    if (type === "sources") {
      const name = String(body.name ?? "").trim().slice(0, 80);
      const feedUrl = cleanHttpUrl(body.feed_url);
      if (!name) return fail("Give the source a name.");
      if (feedUrl === null) return fail("Feed URL must start with http:// or https://");
      if (!feedUrl && !BUILT_IN_SOURCES.includes(name)) return fail("Paste the RSS/Atom feed URL for a new source.");
      await database.query(
        `INSERT INTO news_sources (name, feed_url, category)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET feed_url = COALESCE(EXCLUDED.feed_url, news_sources.feed_url), enabled = TRUE`,
        [name, feedUrl || null, String(body.category ?? "All").trim().slice(0, 40) || "All"]
      );
    } else if (type === "keywords") {
      const keyword = String(body.keyword ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      const category = approvedKeywordCategory(keyword);
      if (!category) return fail("Choose a keyword from the approved list.");
      if (body.category !== undefined && body.category !== category) return fail("This keyword's category is preset. Choose it from the approved list.");
      await database.query(
        `INSERT INTO keywords (keyword, category) VALUES ($1, $2)
         ON CONFLICT (keyword, category) DO UPDATE SET enabled = TRUE`,
        [keyword, category]
      );
    } else {
      const platform = String(body.platform ?? "");
      let handle = String(body.handle ?? "").trim().slice(0, 300);
      if (!(SOCIAL_PLATFORMS as readonly string[]).includes(platform)) {
        return fail("Platform must be Stocktwits, Reddit or X.");
      }
      if (platform === "X") {
        const url = cleanHttpUrl(handle);
        if (!url) return fail("For X, enter an RSS/Atom feed URL. A handle alone cannot collect posts.");
        handle = url;
      } else {
        handle = handle.replace(/^@/, "").replace(/^\/?r\//i, "").replace(/[^A-Za-z0-9_.-]/g, "");
      }
      if (!handle) return fail("Enter an account handle (or subreddit name for Reddit).");
      await database.query(
        `INSERT INTO social_accounts (platform, handle) VALUES ($1, $2)
         ON CONFLICT (platform, handle) DO UPDATE SET enabled = TRUE`,
        [platform, handle]
      );
    }

    return NextResponse.json({ results: await list(type) });
  } catch (error) {
    console.error("Settings save failed:", error);
    return fail("Unable to save that setting.", 500);
  }
}

export async function PATCH(request: NextRequest) {
  const type = readType(request);
  if (!type) return fail("type must be sources, keywords, accounts or platforms.");

  try {
    await initializeOptInSettings();
    const body = (await request.json()) as Record<string, unknown>;
    if (type === "config") {
      const key = String(body.key ?? "");
      if (!validConfigValue(key, body.value)) return fail("Invalid Config option.");
      return NextResponse.json({ results: await saveFeedConfig(key, body.value) });
    }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return fail("Missing id.");

    if (type === "platforms") await loadSocialPlatforms();
    const table = type === "sources" ? "news_sources" : type === "keywords" ? "keywords" : type === "platforms" ? "social_platforms" : "social_accounts";

    if (type === "keywords" && body.enabled === true) {
      const existing = await database.query<{ keyword: string; category: string }>("SELECT keyword, category FROM keywords WHERE id = $1", [id]);
      const row = existing.rows[0];
      if (!row || approvedKeywordCategory(row.keyword) !== row.category) return fail("Only approved keywords with their preset category can be restored.");
    }

    if (typeof body.enabled === "boolean") {
      await database.query(`UPDATE ${table} SET enabled = $2 WHERE id = $1`, [id, body.enabled]);
    }

    if (type === "sources" && body.feed_url !== undefined) {
      const feedUrl = cleanHttpUrl(body.feed_url);
      if (feedUrl === null) return fail("Feed URL must start with http:// or https://");
      await database.query(`UPDATE news_sources SET feed_url = $2 WHERE id = $1`, [id, feedUrl || null]);
    }

    return NextResponse.json({ results: await list(type) });
  } catch (error) {
    console.error("Settings update failed:", error);
    return fail("Unable to update that setting.", 500);
  }
}

export async function DELETE(request: NextRequest) {
  const type = readType(request);
  if (!type) return fail("type must be sources, keywords, accounts or platforms.");

  try {
    await initializeOptInSettings();
    if (type === "config") return fail("Config cannot be deleted.");
    const id = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return fail("Missing id.");

    if (type === "platforms") await loadSocialPlatforms();
    const table = type === "sources" ? "news_sources" : type === "keywords" ? "keywords" : type === "platforms" ? "social_platforms" : "social_accounts";
    await database.query(`UPDATE ${table} SET enabled = FALSE WHERE id = $1`, [id]);

    return NextResponse.json({ results: await list(type) });
  } catch (error) {
    console.error("Settings delete failed:", error);
    return fail("Unable to delete that setting.", 500);
  }
}
