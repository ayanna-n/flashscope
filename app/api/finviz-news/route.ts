import { NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { fetchFinviz, finvizRetryAt, FinvizRateLimitError } from "@/lib/finviz-backoff";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 15 * 60 * 1000;

type NewsRecord = Record<string, string>;

type NewsPayload = {
  results: NewsRecord[];
  count: number;
  fetchedAt: string;
};

class FinvizRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

let cachedPayload: NewsPayload | null = null;
let cacheExpiresAt = 0;
let pendingRequest: Promise<NewsPayload> | null = null;

async function fetchFinvizNews(token: string): Promise<NewsPayload> {
  const views = ["1", "3"];
  const responses = await Promise.all(
    views.map((view) => {
      const parameters = new URLSearchParams({ v: view, auth: token });

      return fetchFinviz(
        `https://elite.finviz.com/export/news?${parameters.toString()}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
          redirect: "follow",
        }
      );
    })
  );

  const failedResponse = responses.find((response) => !response.ok);
  if (failedResponse) {
    throw new FinvizRequestError(
      `Finviz returned status ${failedResponse.status}.`,
      failedResponse.status
    );
  }

  const csvFiles = await Promise.all(
    responses.map((response) => response.text())
  );

  const combined = csvFiles.flatMap(
    (csvText) =>
      parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as NewsRecord[]
  );

  const uniqueResults = Array.from(
    new Map(
      combined.map((record) => [
        record.Url || `${record.Title}-${record.Date}`,
        record,
      ])
    ).values()
  ).sort((a, b) => (b.Date || "").localeCompare(a.Date || ""));

  return {
    results: uniqueResults,
    count: uniqueResults.length,
    fetchedAt: new Date().toISOString(),
  };
}

export async function GET() {
  const token = process.env.FINVIZ_API_TOKEN;

  if (!token) {
    return NextResponse.json(
      { error: "FINVIZ_API_TOKEN is not configured." },
      { status: 500 }
    );
  }

  const now = Date.now();

  if (cachedPayload && now < cacheExpiresAt) {
    return NextResponse.json({
      ...cachedPayload,
      cached: true,
      stale: false,
    });
  }

  const rateLimited = () => {
    const deadline = finvizRetryAt();
    const retryAt = deadline ? new Date(deadline).toISOString() : undefined;
    if (cachedPayload) {
      return NextResponse.json({
        ...cachedPayload,
        cached: true,
        stale: true,
        warning: "Finviz is rate-limiting requests. Showing the last successful news.",
        retryAt,
      });
    }

    return NextResponse.json(
      {
        error: "Finviz is temporarily rate-limiting requests. Please wait before trying again.",
        retryAt,
      },
      { status: 503 }
    );
  };
  if (finvizRetryAt()) return rateLimited();

  try {
    if (!pendingRequest) {
      pendingRequest = fetchFinvizNews(token).finally(() => {
        pendingRequest = null;
      });
    }

    const payload = await pendingRequest;
    cachedPayload = payload;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;

    return NextResponse.json({
      ...payload,
      cached: false,
      stale: false,
    });
  } catch (error) {
    if (error instanceof FinvizRateLimitError) return rateLimited();
    console.error("Finviz news request failed:", error);

    if (cachedPayload) {
      return NextResponse.json({
        ...cachedPayload,
        cached: true,
        stale: true,
        warning: "Finviz is temporarily unavailable. Showing the last successful news.",
      });
    }

    const status = error instanceof FinvizRequestError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Unable to retrieve Finviz news.";

    return NextResponse.json({ error: message }, { status });
  }
}
