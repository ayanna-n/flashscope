import { matchingQuote } from "@/lib/quote-format";
import { recordPriceSnapshots } from "@/lib/mirror";
import { NextRequest, NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { database } from "@/lib/db";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { fetchFinviz, finvizRetryAt, FinvizRateLimitError } from "@/lib/finviz-backoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_MS = 2 * 60 * 1000;

type Quote = Record<string, string>;

const cache = new Map<string, { at: number; record: Quote }>();

// Every Finviz custom-export column we can ask for. The export names each column
// in its header row, so the panel is built from those names, not from the ids.
const WIDE_COLUMNS = Array.from({ length: 90 }, (_, i) => i + 1).join(",");
const SAFE_COLUMNS = Array.from({ length: 70 }, (_, i) => i + 1).join(",");

class QuoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function fetchQuote(ticker: string, token: string, columns: string) {
  const parameters = new URLSearchParams({ v: "152", t: ticker, c: columns, auth: token });
  const response = await fetchFinviz(`https://elite.finviz.com/export/screener?${parameters.toString()}`, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new QuoteError(`Finviz returned status ${response.status}.`, response.status);

  const records = parse(await response.text(), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Quote[];

  return matchingQuote(records, ticker);
}

async function loadStored(ticker: string) {
  try {
    await ensureDatabaseSchema();
    const result = await database.query<{ data: Quote; updated_at: Date }>(
      `SELECT data, updated_at FROM ticker_mirror WHERE ticker = $1`,
      [ticker]
    );
    const row = result.rows[0];
    return row && matchingQuote([row.data], ticker) ? row : null;
  } catch {
    return null;
  }
}

async function store(ticker: string, record: Quote) {
  if (!process.env.DATABASE_URL) return;
  try {
    await ensureDatabaseSchema();
    await database.query(
      `INSERT INTO ticker_mirror (ticker, data, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (ticker) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [ticker, JSON.stringify(record)]
    );
  } catch (error) {
    console.error("Quote mirror save failed:", error);
  }
}

async function getQuote(request: NextRequest) {
  const ticker = (request.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return NextResponse.json({ error: "Enter a valid ticker." }, { status: 400 });
  }

  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ ticker, record: hit.record, fetchedAt: new Date(hit.at).toISOString(), stale: false, cached: true });
  }

  const stored = await loadStored(ticker);
  if (stored && Date.now() - stored.updated_at.getTime() < CACHE_MS) {
    cache.set(ticker, { at: stored.updated_at.getTime(), record: stored.data });
    return NextResponse.json({ ticker, record: stored.data, fetchedAt: stored.updated_at.toISOString(), stale: false, cached: true });
  }

  const serveStored = (warning: string, status = 502, retryAt?: string) => {
    if (!stored && !hit) return NextResponse.json({ error: warning, retryAt }, { status });
    return NextResponse.json({
      ticker,
      record: stored?.data ?? hit!.record,
      fetchedAt: new Date(stored?.updated_at ?? hit!.at).toISOString(),
      stale: true,
      warning: `${warning} Showing the last saved quote.`,
      retryAt,
    });
  };
  const rateLimited = () => {
    const retryAt = finvizRetryAt();
    return serveStored("Finviz is rate-limiting requests.", 503, retryAt ? new Date(retryAt).toISOString() : undefined);
  };

  const token = process.env.FINVIZ_API_TOKEN;
  if (!token) return serveStored("FINVIZ_API_TOKEN is not configured.", 500);
  if (finvizRetryAt()) return rateLimited();

  try {
    let record: Quote | null;
    try {
      record = await fetchQuote(ticker, token, WIDE_COLUMNS);
    } catch (error) {
      if (error instanceof FinvizRateLimitError || !(error instanceof QuoteError) || ![400, 422].includes(error.status)) throw error;
      record = await fetchQuote(ticker, token, SAFE_COLUMNS);
    }
    if (!record) return serveStored(`Finviz has no quote for ${ticker}.`, 404);

    await store(ticker, record);
    await recordPriceSnapshots([record], new Date().toISOString());
    cache.set(ticker, { at: Date.now(), record });
    return NextResponse.json({ ticker, record, fetchedAt: new Date().toISOString(), stale: false, cached: false });
  } catch (error) {
    if (error instanceof FinvizRateLimitError) return rateLimited();
    console.error("Quote request failed:", error);
    return serveStored("Finviz is temporarily unavailable.");
  }
}

// Share concurrent reads of one ticker, including its one snapshot write.
const pending = new Map<string, Promise<NextResponse>>();
export async function GET(request: NextRequest) {
  const key = (request.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  let job = pending.get(key);
  if (!job) {
    job = getQuote(request).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return (await job).clone();
}
