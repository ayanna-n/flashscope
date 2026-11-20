import { NextRequest, NextResponse } from "next/server";
import { database } from "@/lib/db";
import { ensureDatabaseSchema } from "@/lib/database-schema";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const ticker = (request.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  const interval = request.nextUrl.searchParams.get("interval");
  const intervalMinutes = new Map([["1",1],["3",3],["5",5],["15",15],["30",30],["60",60],["D",1440],["W",10080],["M",43200]]);
  if (interval !== null && !intervalMinutes.has(interval)) return NextResponse.json({error:"Invalid chart interval."},{status:400});
  const rangeDays = interval === "D" ? 30 : interval === "W" ? 90 : interval === "M" ? 365
    : interval ? 1 : Math.min(90, Math.max(1, Math.trunc(Number(request.nextUrl.searchParams.get("days"))) || 1));
  const stepMinutes = interval ? intervalMinutes.get(interval)! : rangeDays === 1 ? 5 : rangeDays * 15;
  const intraday = !!interval && rangeDays === 1;
  const monthly = interval === "M";
  const minutes = Number(request.nextUrl.searchParams.get("window") ?? 60);
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker) || ![5,15,30,60,120].includes(minutes)) return NextResponse.json({error:"Invalid ticker or rolling window."},{status:400});
  try {
    await ensureDatabaseSchema();
    const asOf = new Date().toISOString();
    const result = await database.query(`
      WITH points AS (
        SELECT generate_series($4::timestamptz,
          CASE WHEN $6::boolean THEN date_trunc('day',$4::timestamptz AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
               ELSE $4::timestamptz-make_interval(days=>$3::int) END,
          CASE WHEN $7::boolean THEN -interval '1 month' ELSE -make_interval(mins=>$5::int) END) AS at
      )
      SELECT points.at,
        COUNT(p.id)::int AS messages,
        COUNT(p.id) FILTER (WHERE p.sentiment IN ('Bullish','Bearish'))::int AS labeled,
        CASE WHEN COUNT(p.id) FILTER (WHERE p.sentiment IN ('Bullish','Bearish')) > 0
          THEN 100.0 * COUNT(p.id) FILTER (WHERE p.sentiment='Bullish') /
          COUNT(p.id) FILTER (WHERE p.sentiment IN ('Bullish','Bearish')) ELSE NULL END AS sentiment,
        (SELECT watchers FROM stocktwits_metric_snapshots w WHERE w.ticker=$1
           AND w.captured_at <= points.at AND w.captured_at > points.at - interval '15 minutes'
           ORDER BY captured_at DESC LIMIT 1) AS watchers
      FROM points LEFT JOIN social_posts p ON p.platform='Stocktwits'
        AND $1=ANY(p.tickers) AND p.published_at > points.at-make_interval(mins=>$2::int)
        AND p.published_at <= points.at
      GROUP BY points.at ORDER BY points.at`, [ticker,minutes,rangeDays,asOf,stepMinutes,intraday,monthly]);
    const pricePeriod = monthly ? "month" : interval === "W" ? "week" : "day";
    const priceBucket = `date_trunc('${pricePeriod}', captured_at AT TIME ZONE 'America/New_York')`;
    const prices = interval && !intraday
      ? await database.query(
        `SELECT * FROM (
          SELECT DISTINCT ON (${priceBucket})
            captured_at AS at, price::float AS price, volume
          FROM price_snapshots
          WHERE ticker=$1 AND captured_at >= $3::timestamptz-make_interval(days=>$2::int) AND captured_at <= $3::timestamptz
          ORDER BY ${priceBucket}, captured_at DESC
        ) AS sampled ORDER BY at`,[ticker,rangeDays,asOf])
      : await database.query(
        `SELECT * FROM (SELECT captured_at AS at, price::float AS price, volume FROM price_snapshots
          WHERE ticker=$1 AND captured_at >= CASE WHEN $4::boolean THEN date_trunc('day',$3::timestamptz AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' ELSE $3::timestamptz-make_interval(days=>$2::int) END
          AND captured_at <= $3::timestamptz ORDER BY captured_at DESC LIMIT 20000) AS recent ORDER BY at`,
        [ticker,rangeDays,asOf,intraday]);
    return NextResponse.json({asOf,prices:prices.rows,rangeDays,ticker,windowMinutes:minutes,points:result.rows.map(r=>({...r,sentiment:r.sentiment===null?null:Number(r.sentiment),watchers:r.watchers===null?null:Number(r.watchers)}))});
  } catch { return NextResponse.json({error:"Unable to load social metrics."},{status:500}); }
}
