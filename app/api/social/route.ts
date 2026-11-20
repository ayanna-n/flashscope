import { decodeSocialText, socialSearchPattern } from "@/lib/social-text";
import { loadEnabledFeedKeywords } from "@/lib/settings";
import { loadSocialPlatforms } from "@/lib/social-platforms";
import { NextRequest, NextResponse } from "next/server";
import { database } from "@/lib/db";
import { ensureDatabaseSchema } from "@/lib/database-schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RawSocialPost = Record<string, unknown>;

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function normalizePlatform(value: string) {
  const platform = value.toLowerCase();
  if (platform.includes("stocktwit")) return "Stocktwits";
  if (platform.includes("reddit")) return "Reddit";
  if (platform === "x" || platform.includes("twitter")) return "X";
  return value || "Unknown";
}

function normalizeSentiment(value: string) {
  const sentiment = value.toLowerCase();
  if (sentiment.includes("bull") || sentiment === "positive") return "Bullish";
  if (sentiment.includes("bear") || sentiment === "negative") return "Bearish";
  return "Neutral";
}

export async function GET(request: NextRequest) {
  try {
    await ensureDatabaseSchema();

    const requestedPlatform = request.nextUrl.searchParams.get("platform")?.trim() ?? "";
    const requestedTicker = request.nextUrl.searchParams.get("ticker")?.trim().toUpperCase() ?? "";
    const limitParam = request.nextUrl.searchParams.get("limit");
    const requestedLimit = limitParam?.trim() ? Number(limitParam) : NaN;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 2000)
      : 500;

    const countsParam = request.nextUrl.searchParams.get("counts");
    if (countsParam !== null) {
      const minutes = Math.min(Math.max(Math.trunc(Number(countsParam)) || 60, 1), 10080);
      const counted = await database.query<{ ticker: string; count: number }>(
        `SELECT UPPER(REGEXP_REPLACE(TRIM(t), '^[$]', '')) AS ticker, COUNT(DISTINCT id)::int AS count
         FROM social_posts, unnest(tickers) AS t
         WHERE published_at > NOW() - make_interval(mins => $1::int)
           AND published_at <= NOW()
         GROUP BY UPPER(REGEXP_REPLACE(TRIM(t), '^[$]', ''))`,
        [minutes]
      );
      return NextResponse.json({
        counts: Object.fromEntries(counted.rows.map((r) => [r.ticker, r.count])),
        minutes,
      });
    }

    const platforms = await loadSocialPlatforms();
    const enabledKeywords = await loadEnabledFeedKeywords();
    const enabledPlatforms = platforms.filter((row) => row.enabled).map((row) => row.platform);
    const rawDays = Number(request.nextUrl.searchParams.get("days"));
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(3650, Math.trunc(rawDays)) : 0;
    const rawOffset = Number(request.nextUrl.searchParams.get("offset"));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(1000000, Math.trunc(rawOffset)) : 0;
    const search = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
    const sentiment = request.nextUrl.searchParams.get("sentiment") ?? "";
    const platform = requestedPlatform ? normalizePlatform(requestedPlatform) : "";

    const query = await database.query<{ row: RawSocialPost }>(
      `SELECT to_jsonb(social_posts) AS row
       FROM social_posts
       WHERE ($2::text = '' OR $2::text = ANY(tickers))
         AND platform = ANY($8::text[])
         AND (cardinality($9::text[]) = 0 OR EXISTS (
           SELECT 1 FROM unnest($9::text[]) kw WHERE LOWER(CONCAT_WS(' ',body,author,array_to_string(tickers,','))) ~ ('(^|[^a-z0-9])' || kw || '($|[^a-z0-9])')
         ))
         AND ($3::text = '' OR LOWER(platform) = LOWER($3))
         AND ($4::int = 0 OR published_at >= NOW() - make_interval(days => $4::int))
         AND published_at <= NOW()
         AND ($5::text = '' OR CONCAT_WS(' ', body, author, array_to_string(tickers, ',')) ~* $5)
         AND ($6::text = '' OR (CASE WHEN LOWER(sentiment) LIKE '%bull%' OR LOWER(sentiment) = 'positive' THEN 'Bullish'
               WHEN LOWER(sentiment) LIKE '%bear%' OR LOWER(sentiment) = 'negative' THEN 'Bearish' ELSE 'Neutral' END) = $6)
       ORDER BY published_at DESC, id DESC
       LIMIT $1 OFFSET $7`,
      [limit + 1, requestedTicker, platform, days, socialSearchPattern(search), sentiment, offset, enabledPlatforms, enabledKeywords]
    );

    const results = query.rows.slice(0, limit)
      .map(({ row }, index) => {
        const platform = normalizePlatform(textValue(row.platform, row.source));
        const username = textValue(row.username, row.author, row.account_name, row.account_handle, "Unknown");
        const storedUrl = textValue(row.url, row.link);
        const stocktwitsId = textValue(row.external_id).match(/^stocktwits:(\d+)$/)?.[1]
          ?? storedUrl.match(/^https?:\/\/(?:www\.)?stocktwits\.com\/(?:[^/]+\/)?message\/(\d+)(?:[/?#]|$)/i)?.[1];
        const url = platform === "Stocktwits" && stocktwitsId && username !== "Unknown"
          ? `https://stocktwits.com/${encodeURIComponent(username.replace(/^@/, ""))}/message/${stocktwitsId}`
          : storedUrl;
        return {
          id: textValue(row.id, row.external_id, `${platform}-${index}`),
          platform,
          username: textValue(
            row.username,
            row.author,
            row.account_name,
            row.account_handle,
            "Unknown"
          ),
          ticker: (
            Array.isArray(row.tickers) && row.tickers.length > 0
              ? row.tickers.join(",")
              : textValue(row.ticker, row.symbol, "N/A")
          ).toUpperCase(),
          body: decodeSocialText(textValue(row.body, row.content, row.text, row.message)),
          url,
          sentiment: normalizeSentiment(textValue(row.sentiment, "Neutral")),
          publishedAt: textValue(row.published_at, row.created_at, new Date().toISOString()),
        };
      })
      .filter((post) => post.body)
      .filter(
        (post) =>
          !requestedPlatform ||
          post.platform.toLowerCase() === normalizePlatform(requestedPlatform).toLowerCase()
      )
      .filter(
        (post) =>
          !requestedTicker ||
          post.ticker.split(/[,\s]+/).some((ticker) => ticker === requestedTicker)
      )
      .sort(
        (a, b) =>
          new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      );

    return NextResponse.json({
      results,
      platforms,
      count: results.length,
      hasMore: query.rows.length > limit,
      offset,
      days,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Stored social posts request failed:", error);
    return NextResponse.json(
      { error: "Unable to load stored social posts." },
      { status: 500 }
    );
  }
}
