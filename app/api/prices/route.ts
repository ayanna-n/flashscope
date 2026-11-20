import { NextRequest, NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { recordPriceSnapshots } from "@/lib/mirror";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const cached = new Map<string, { at: number; payload: object }>();
const pending = new Map<string, Promise<NextResponse>>();
let retryAfter = 0;

export async function GET(request: NextRequest) {
  const tickers = Array.from(new Set((request.nextUrl.searchParams.get("tickers") ?? "").toUpperCase().split(",").map((v) => v.trim()).filter(Boolean))).sort();
  if (!tickers.length || tickers.length > 60 || tickers.some((v) => !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(v))) return NextResponse.json({ error: "Provide 1–60 valid tickers." }, { status: 400 });
  const key = tickers.join(",");
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < 60000) return NextResponse.json({ ...hit.payload, cached: true, saved: 0 });
  const existing = pending.get(key);
  if (existing) return (await existing).clone();
  const job = collect(tickers).finally(() => pending.delete(key));
  pending.set(key, job);
  return (await job).clone();
}

async function collect(tickers: string[]) {
  const token = process.env.FINVIZ_API_TOKEN;
  if (!token) return NextResponse.json({ error: "FINVIZ_API_TOKEN is not configured on the website." }, { status: 503 });
  if (Date.now() < retryAfter) return NextResponse.json({ error: "Price collection is cooling down after a provider rate limit." }, { status: 429 });
  try {
    const params = new URLSearchParams({ v: "152", c: "1,2,3,4,5,6,7,64,65,66,67", t: tickers.join(","), auth: token });
    const response = await fetch(`https://elite.finviz.com/export/screener?${params}`, { cache: "no-store", signal: AbortSignal.timeout(25000) });
    if (!response.ok) {
      if (response.status === 429) retryAfter = Date.now() + 15 * 60000;
      return NextResponse.json({ error: `Price provider returned HTTP ${response.status}.` }, { status: response.status === 429 ? 429 : 502 });
    }
    const rows = parse(await response.text(), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    const requested = new Set(tickers);
    const records = Array.from(new Map(rows.filter((row) => requested.has((row.Ticker ?? "").trim().toUpperCase())).map((row) => [(row.Ticker ?? "").trim().toUpperCase(), row])).values());
    const capturedAt = new Date().toISOString();
    const saved = await recordPriceSnapshots(records, capturedAt);
    if (!saved) return NextResponse.json({ error: "No valid price observations could be saved." }, { status: 502 });
    const payload = { requested: tickers.length, returned: records.length, saved, capturedAt, missing: tickers.filter((ticker) => !records.some((row) => row.Ticker.trim().toUpperCase() === ticker)) };
    if (cached.size > 100) cached.clear();
    cached.set(tickers.join(","), { at: Date.now(), payload });
    return NextResponse.json({ ...payload, cached: false });
  } catch {
    return NextResponse.json({ error: "Unable to collect fresh prices; no substitute observations were created." }, { status: 502 });
  }
}
