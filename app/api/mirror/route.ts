import { NextRequest, NextResponse } from "next/server";
import { database } from "@/lib/db";
import { ensureDatabaseSchema } from "@/lib/database-schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Browse the mirror: every news/social event with its ticker, sentiment and price context. */
export async function GET(request: NextRequest) {
  try {
    await ensureDatabaseSchema();
    const ticker = request.nextUrl.searchParams.get("ticker")?.trim().toUpperCase() ?? "";
    const today = request.nextUrl.searchParams.get("today") === "1";
    const linked = request.nextUrl.searchParams.get("linked") === "1";
    const kind = request.nextUrl.searchParams.get("kind")?.trim() ?? "";
    const source = request.nextUrl.searchParams.get("source")?.trim() ?? "";
    const requested = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), 500) : 100;

    const rawDays = Number(request.nextUrl.searchParams.get("days"));
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(100, Math.trunc(rawDays)) : 100;
    const rawOffset = Number(request.nextUrl.searchParams.get("offset"));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(1000000, Math.trunc(rawOffset)) : 0;

    const result = await database.query(
      `SELECT id::text, ticker, company, volume, rel_volume::float, market_cap, change_pct::float, kind, source, author, text, url, category,
              sentiment::int, published_at, price_at_event_at, price_after_at,
              price_at_event::float AS price_at_event,
              price_after::float AS price_after,
              return_pct::float AS return_pct
       FROM mirror
       WHERE ($1::text = '' OR ticker = $1)
         AND ($2::text = '' OR kind = $2)
         AND ($6::text = '' OR LOWER(source) = LOWER($6))
         AND published_at <= NOW()
         AND CASE WHEN $7::boolean
           THEN published_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
           ELSE published_at > NOW() - make_interval(days => $4::int) END
         AND (NOT $8::boolean OR (ticker <> '' AND url ~* '^https?://'))
       ORDER BY published_at DESC, id DESC
       LIMIT $3 OFFSET $5`,
      [ticker, kind, limit + 1, days, offset, source, today, linked]
    );
    return NextResponse.json({ results: result.rows.slice(0, limit), count: Math.min(result.rows.length, limit), hasMore: result.rows.length > limit, offset, days });
  } catch (error) {
    console.error("Mirror load failed:", error);
    return NextResponse.json({ error: "Unable to load the mirror." }, { status: 500 });
  }
}
