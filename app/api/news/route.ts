import { GET as getFinvizNews } from "@/app/api/finviz-news/route";
import { headlineDate, listingDate } from "@/lib/news-dates";
import { NextResponse } from "next/server";
import { database } from "@/lib/db";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { loadSourceSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DirectNewsRecord = {
  Title: string;
  Source: string;
  Date: string;
  Url: string;
  Category: string;
  Ticker: string;
};

type NewsPayload = {
  results: DirectNewsRecord[];
  count: number;
  fetchedAt: string;
  connectedSources: string[];
  unavailableSources: string[];
};

type CompanyTicker = {
  ticker: string;
  company: string;
};

type BenzingaArticle = {
  title?: string;
  created?: string;
  updated?: string;
  url?: string;
  body?: string;
  stocks?: Array<{ name?: string; symbol?: string }>;
};

type ReutersHeadline = {
  title?: string;
  storyPath?: string;
  published?: number;
  provider?: { id?: string };
  relatedSymbols?: Array<{ symbol?: string }>;
};

type TradingViewSection = {
  data?: {
    news?: {
      data?: {
        items?: ReutersHeadline[];
      };
    };
  };
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

const APPROVED_SOURCES = [
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

let allowedSourceNames: string[] = [];
let cachedPayload: NewsPayload | null = null;
let cacheExpiresAt = 0;
let pendingRequest: Promise<NewsPayload> | null = null;
let cachedCompanyTickers: CompanyTicker[] = [];
let companyTickersExpireAt = 0;

const sourceHeaders = {
  Accept:
    "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
  "User-Agent":
    process.env.NEWS_USER_AGENT ||
    "FlashScope academic news monitor (contact: replace-with-your-email@example.com)",
};

function decodeEntities(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    quot: '"',
    lt: "<",
    gt: ">",
    nbsp: " ",
  };

  function character(code: number) {
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : "";
  }

  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code: string) =>
      character(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      character(Number.parseInt(code, 16))
    )
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => entities[name.toLowerCase()] ?? match
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(value: string, baseUrl: string) {
  if (!value.trim()) return "";

  try {
    const url = new URL(decodeEntities(value), baseUrl);

    return ["http:", "https:"].includes(url.protocol)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function firstMatch(value: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]);
  }

  return "";
}

function normalizeDate(value: string) {
  if (!value.trim()) return "";

  const parsed = new Date(decodeEntities(value));

  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString();
}

function normalizeCompanyName(value: string) {
  return value
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(
      /\b(?:INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|PLC|LLC|HOLDINGS?|GROUP|SA|NV|AG)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function getCompanyTickers(): Promise<CompanyTicker[]> {
  if (
    cachedCompanyTickers.length > 0 &&
    Date.now() < companyTickersExpireAt
  ) {
    return cachedCompanyTickers;
  }

  try {
    const response = await fetch(
      "https://www.sec.gov/files/company_tickers.json",
      {
        headers: sourceHeaders,
        next: { revalidate: 86400 },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      throw new Error(
        `SEC company ticker directory returned ${response.status}`
      );
    }

    const payload = (await response.json()) as Record<
      string,
      { ticker?: string; title?: string }
    >;

    cachedCompanyTickers = Object.values(payload)
      .map((entry) => ({
        ticker: entry.ticker?.trim().toUpperCase() ?? "",
        company: normalizeCompanyName(entry.title ?? ""),
      }))
      .filter(
        (entry) =>
          entry.ticker.length > 0 &&
          entry.company.length >= 5 &&
          (entry.company.includes(" ") || entry.company.length >= 8)
      )
      .sort((a, b) => b.company.length - a.company.length);

    companyTickersExpireAt = Date.now() + 24 * 60 * 60 * 1000;
  } catch (error) {
    console.error("SEC company ticker lookup failed:", error);
  }

  return cachedCompanyTickers;
}

function extractTicker(text: string) {
  const candidates = [
    ...text.matchAll(/\$([A-Z][A-Z0-9.-]{0,5})\b/g),
    ...text.matchAll(
      /\b(?:NASDAQ|NYSE|AMEX|OTCQX|OTCQB|TSXV|TSX|CSE)\s*:\s*([A-Z][A-Z0-9.-]{0,5})\b/gi
    ),
  ]
    .map((match) => match[1]?.toUpperCase())
    .filter((ticker): ticker is string => Boolean(ticker));

  return Array.from(new Set(candidates)).join(",") || "N/A";
}

function matchCompanyTicker(
  text: string,
  companies: CompanyTicker[]
) {
  const normalizedText = ` ${normalizeCompanyName(text)} `;

  const matches = companies
    .filter(({ company }) =>
      normalizedText.includes(` ${company} `)
    )
    .slice(0, 5)
    .map(({ ticker }) => ticker);

  return Array.from(new Set(matches)).join(",") || "N/A";
}

function addMissingTickers(
  records: DirectNewsRecord[],
  companies: CompanyTicker[]
) {
  return records.map((record) => ({
    ...record,
    Ticker:
      record.Ticker !== "N/A"
        ? record.Ticker
        : matchCompanyTicker(record.Title, companies),
  }));
}

function categorize(value: string) {
  const text = value.toLowerCase();

  const groups: Array<[string, string[]]> = [
    ["Acquisition", ["acquisition", "acquire", "acquires", "acquired"]],
    ["Buyback", ["buyback", "share repurchase", "repurchase program"]],
    ["Delisting", ["delisting", "delisted"]],
    ["Compliance", ["compliance", "noncompliance"]],
    ["IPO", ["ipo", "initial public offering"]],
    ["Merger", ["merger", "merge"]],
    ["Partnership", ["partnership", "partners with", "collaboration"]],
    ["Beat", ["beats estimates", "tops estimates"]],
    ["Miss", ["misses estimates", "falls short"]],
    ["Earnings", ["earnings", "financial results", "quarter results"]],
    ["Investigation", ["investigation", "investigates", "class action"]],
    ["Probe", ["probe", "inquiry"]],
    ["Bankruptcy", ["bankruptcy", "chapter 11"]],
    ["FDA", ["fda", "food and drug administration"]],
    ["Approval", ["approval", "approved", "clearance"]],
    ["SEC", ["sec filing", "10-k", "10-q", "8-k", "form 6-k"]],
    ["Listing", ["listing", "listed on"]],
    ["Contract", ["contract", "award", "agreement"]],
  ];

  return (
    groups.find(([, words]) =>
      words.some((word) => text.includes(word))
    )?.[0] ?? "Other"
  );
}

function parseXmlFeed(
  xml: string,
  source: string,
  baseUrl: string
): DirectNewsRecord[] {
  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) ??
    xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ??
    [];

  return blocks
    .map((block): DirectNewsRecord | null => {
      const title = firstMatch(block, [
        /<title[^>]*>([\s\S]*?)<\/title>/i,
      ]);

      const date = firstMatch(block, [
        /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i,
        /<published[^>]*>([\s\S]*?)<\/published>/i,
        /<updated[^>]*>([\s\S]*?)<\/updated>/i,
        /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i,
      ]);

      const description = firstMatch(block, [
        /<description[^>]*>([\s\S]*?)<\/description>/i,
        /<summary[^>]*>([\s\S]*?)<\/summary>/i,
        /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i,
        /<content[^>]*>([\s\S]*?)<\/content>/i,
      ]);

      const link = firstMatch(block, [
        /<link[^>]+href=["']([^"']+)["'][^>]*\/?\s*>/i,
        /<link[^>]*>([\s\S]*?)<\/link>/i,
        /<guid[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i,
      ]);

      const url = absoluteUrl(link, baseUrl);
      const publishedAt = normalizeDate(date);

      if (!title || !url || !publishedAt) return null;

      const searchable = `${title} ${description}`;

      return {
        Title: title,
        Source: source,
        Date: publishedAt,
        Url: url,
        Category: source === "SEC" ? "SEC" : categorize(searchable),
        Ticker: extractTicker(searchable),
      };
    })
    .filter((item): item is DirectNewsRecord => item !== null);
}

async function fetchAuthorizedXmlSource(
  source: string,
  url: string,
  token?: string
) {
  const response = await fetch(url, {
    headers: {
      ...sourceHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${source} returned ${response.status}`);
  }

  return parseXmlFeed(await response.text(), source, url);
}

async function fetchBenzingaNews(
  token: string
): Promise<DirectNewsRecord[]> {
  const parameters = new URLSearchParams({
    token,
    pageSize: "100",
    displayOutput: "full",
  });

  const response = await fetch(
    `https://api.benzinga.com/api/v2/news?${parameters.toString()}`,
    {
      headers: { ...sourceHeaders, Accept: "application/json" },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    throw new Error(`Benzinga returned ${response.status}`);
  }

  const payload = (await response.json()) as
    | BenzingaArticle[]
    | { news?: BenzingaArticle[] };

  const articles = Array.isArray(payload)
    ? payload
    : payload.news ?? [];

  return articles
    .map((article): DirectNewsRecord | null => {
      const title = decodeEntities(article.title ?? "");
      const url = absoluteUrl(
        article.url ?? "",
        "https://www.benzinga.com"
      );

      const publishedAt = normalizeDate(
        article.created ?? article.updated ?? ""
      );

      if (!title || !url || !publishedAt) return null;

      const tickers = (article.stocks ?? [])
        .map((stock) => stock.name ?? stock.symbol ?? "")
        .filter(Boolean)
        .join(",")
        .toUpperCase();

      const searchable = `${title} ${article.body ?? ""}`;

      return {
        Title: title,
        Source: "Benzinga",
        Date: publishedAt,
        Url: url,
        Category: categorize(searchable),
        Ticker: tickers || extractTicker(searchable),
      };
    })
    .filter((item): item is DirectNewsRecord => item !== null);
}

function parseDatedListing(
  html: string,
  source: string,
  baseUrl: string,
  requiredPath: RegExp
) {
  const results: DirectNewsRecord[] = [];

  const anchors = html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  );

  for (const match of anchors) {
    const href = decodeEntities(match[1]);
    const title = decodeEntities(match[2]);

    if (!requiredPath.test(href) || title.length < 18) continue;

    const location = match.index ?? 0;

    const url = absoluteUrl(href, baseUrl);
    const publishedAt = listingDate(title, html, location, match[0].length);

    if (!url || !publishedAt) continue;

    results.push({
      Title: title,
      Source: source,
      Date: publishedAt,
      Url: url,
      Category: source === "FDA" ? "FDA" : categorize(title),
      Ticker: extractTicker(title),
    });
  }

  return results;
}

async function fetchHtmlSource(
  source: string,
  url: string,
  requiredPath: RegExp
) {
  const response = await fetch(url, {
    headers: sourceHeaders,
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${source} returned ${response.status}`);
  }

  return parseDatedListing(
    await response.text(),
    source,
    url,
    requiredPath
  );
}

// ACCESS timestamps have no timezone in the supplied newsroom page.
// Store the publication day at UTC midnight, not an exact time.
// The updated page.tsx displays these as date-only.
async function fetchAccessNewswire(): Promise<DirectNewsRecord[]> {
  const baseUrl = "https://www.accessnewswire.com/newsroom";

  const response = await fetch(baseUrl, {
    headers: { Accept: "text/html", "User-Agent": process.env.NEWS_USER_AGENT || "FlashScope news monitor" },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`AccessWire returned ${response.status}`);
  }

  const html = await response.text();

  const cards =
    html.match(
      /<article\b[^>]*class=["'][^"']*\bnr-card\b[^"']*["'][^>]*>[\s\S]*?<\/article>/gi
    ) ?? [];

  const months = [
    "january", "february", "march", "april",
    "may", "june", "july", "august",
    "september", "october", "november", "december",
  ];

  const results: DirectNewsRecord[] = [];

  for (const card of cards) {
    const heading = card.match(
      /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i
    );

    const dateText = firstMatch(card, [
      /<p\b[^>]*class=["'][^"']*\bnr-card-meta\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    ]);

    const summary = firstMatch(card, [
      /<p\b[^>]*class=["'][^"']*\bnr-card-summary\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    ]);

    if (!heading) continue;

    const title = decodeEntities(heading[2]);
    const url = absoluteUrl(heading[1], baseUrl);

    const dateParts = dateText.match(
      /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/
    );

    if (!title || !url || !dateParts) continue;

    const month = months.indexOf(dateParts[1].toLowerCase());
    if (month < 0) continue;

    const publishedDay = new Date(
      Date.UTC(
        Number(dateParts[3]),
        month,
        Number(dateParts[2])
      )
    ).toISOString();

    const searchable = `${title} ${summary}`;

    results.push({
      Title: title,
      Source: "AccessWire",
      Date: publishedDay,
      Url: url,
      Category: categorize(searchable),
      Ticker: extractTicker(searchable),
    });
  }

  if (results.length === 0) {
    throw new Error("AccessWire returned no recognizable news cards.");
  }

  return results;
}

// Reads public Reuters headline metadata embedded in TradingView HTML.
// Full article content may require a subscription.
async function fetchTradingViewReuters(): Promise<DirectNewsRecord[]> {
  const baseUrl =
    "https://www.tradingview.com/news/top-providers/reuters/";

  const response = await fetch(baseUrl, {
    headers: sourceHeaders,
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `TradingView/Reuters returned ${response.status}`
    );
  }

  const html = await response.text();
  const results: DirectNewsRecord[] = [];

  const scripts = html.matchAll(
    /<script\b[^>]*type=["']application\/prs\.init-data\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const script of scripts) {
    let payload: Record<string, TradingViewSection>;

    try {
      payload = JSON.parse(script[1]) as Record<
        string,
        TradingViewSection
      >;
    } catch {
      continue;
    }

    if (!payload || typeof payload !== "object") continue;

    for (const section of Object.values(payload)) {
      const articles = section?.data?.news?.data?.items;

      if (!Array.isArray(articles)) continue;

      for (const article of articles) {
        if (article.provider?.id !== "reuters") continue;

        const title = decodeEntities(article.title ?? "");
        const url = absoluteUrl(
          article.storyPath ?? "",
          baseUrl
        );
        const timestamp = article.published;

        if (
          !title ||
          !url ||
          typeof timestamp !== "number" ||
          !Number.isFinite(timestamp)
        ) {
          continue;
        }

        const publishedAt = new Date(timestamp * 1000);

        if (Number.isNaN(publishedAt.getTime())) continue;

        const symbols = (article.relatedSymbols ?? [])
          .map((item) => item.symbol?.trim().toUpperCase() ?? "")
          .filter(Boolean)
          .map((symbol) =>
            symbol.replace(/^(NASDAQ|NYSE|AMEX):/, "")
          );

        results.push({
          Title: title,
          Source: "TradingView/Reuters",
          Date: publishedAt.toISOString(),
          Url: url,
          Category: categorize(title),
          Ticker:
            Array.from(new Set(symbols)).join(",") ||
            extractTicker(title),
        });
      }
    }
  }

  const uniqueResults = Array.from(
    new Map(results.map((item) => [item.Url, item])).values()
  );

  if (uniqueResults.length === 0 && allowedSourceNames.length > 0 && !process.env.DATABASE_URL) {
    throw new Error(
      "TradingView/Reuters returned no recognizable dated headlines."
    );
  }

  return uniqueResults;
}

async function buildPayload(): Promise<NewsPayload> {
  const companyTickersPromise = getCompanyTickers();

  // Settings > Sources: turn built-in sources off, or add/override RSS feeds.
  const sourceSettings = process.env.DATABASE_URL ? await loadSourceSettings() : [];
  const disabledSources = new Set(
    sourceSettings.filter((item) => !item.enabled).map((item) => item.name)
  );
  const settingsFeeds = sourceSettings.filter(
    (item) => item.enabled && item.feed_url?.trim()
  );
  const overriddenSources = new Set(settingsFeeds.map((item) => item.name));
  const skipSource = (name: string) =>
    disabledSources.has(name) || overriddenSources.has(name);
  allowedSourceNames = [
    ...APPROVED_SOURCES.filter((name) => !disabledSources.has(name)),
    ...settingsFeeds
      .map((item) => item.name)
      .filter((name) => !APPROVED_SOURCES.includes(name)),
  ];

  const builtInRequests: Array<{
    source: string;
    request: () => Promise<DirectNewsRecord[]>;
  }> = [
    {
      source: "PR Newswire",
      request: () => fetchAuthorizedXmlSource(
        "PR Newswire",
        "https://www.prnewswire.com/rss/news-releases-list.rss"
      ),
    },
    {
      source: "SEC",
      request: () => fetchAuthorizedXmlSource(
        "SEC",
        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&owner=include&count=100&output=atom"
      ),
    },
    {
      source: "FDA",
      request: async () => {
        try {
          const items = await fetchAuthorizedXmlSource("FDA", "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml");
          if (items.length) return items;
        } catch { /* Fall back to the official dated announcement listing. */ }
        return fetchHtmlSource(
        "FDA",
        "https://www.fda.gov/news-events/fda-newsroom/press-announcements",
        /\/news-events\/(?:fda-newsroom\/)?press-announcements\//i
      );
      },
    },
    {
      source: "GlobeNewswire",
      request: () => fetchAuthorizedXmlSource(
        "GlobeNewswire",
        "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies"
      ),
    },
  ];

  const requests = builtInRequests.filter(({ source }) => !skipSource(source));

  const configuredFeeds = [
    {
      source: "AccessWire",
      url: process.env.ACCESSWIRE_FEED_URL,
      token: process.env.ACCESSWIRE_API_TOKEN,
    },
    {
      source: "MT Newswires",
      url: process.env.MT_NEWSWIRES_FEED_URL,
      token: process.env.MT_NEWSWIRES_API_TOKEN,
    },
    {
      source: "Dow Jones Newswires",
      url: process.env.DOW_JONES_FEED_URL,
      token: process.env.DOW_JONES_API_TOKEN,
    },
    {
      source: "TradingView/Reuters",
      url:
        process.env.TRADINGVIEW_REUTERS_FEED_URL ||
        process.env.REUTERS_FEED_URL,
      token: process.env.REUTERS_API_TOKEN,
    },
    {
      source: "Benzinga",
      url: process.env.BENZINGA_FEED_URL,
      token: undefined,
    },
  ];

  if (!process.env.ACCESSWIRE_FEED_URL?.trim() && !skipSource("AccessWire")) {
    requests.push({
      source: "AccessWire",
      request: () => fetchAccessNewswire(),
    });
  }

  if (
    !process.env.TRADINGVIEW_REUTERS_FEED_URL?.trim() &&
    !process.env.REUTERS_FEED_URL?.trim() &&
    !skipSource("TradingView/Reuters")
  ) {
    requests.push({
      source: "TradingView/Reuters",
      request: () => fetchTradingViewReuters(),
    });
  }

  configuredFeeds.forEach(({ source, url, token }) => {
    if (url?.trim() && !skipSource(source)) {
      requests.push({
        source,
        request: () => fetchAuthorizedXmlSource(
          source,
          url.trim(),
          token
        ),
      });
    }
  });

  settingsFeeds.forEach(({ name, feed_url }) => {
    requests.push({
      source: name,
      request: () => fetchAuthorizedXmlSource(name, (feed_url as string).trim()),
    });
  });

  if (!process.env.BENZINGA_API_TOKEN?.trim() && !process.env.BENZINGA_FEED_URL?.trim() && !skipSource("Benzinga")) {
    requests.push({ source: "Benzinga", request: () => fetchAuthorizedXmlSource("Benzinga", "https://www.benzinga.com/feed") });
  }

  if (process.env.BENZINGA_API_TOKEN?.trim() && !skipSource("Benzinga")) {
    requests.push({
      source: "Benzinga",
      request: () => fetchBenzingaNews(
        process.env.BENZINGA_API_TOKEN!.trim()
      ),
    });
  }

  const settled = await Promise.allSettled(
    requests.map(({ request }) => request())
  );

  const connectedSources = new Set<string>();

  const configuredSources = new Set(
    requests.map(({ source }) => source)
  );

  const unavailableSources = new Set(
    APPROVED_SOURCES.filter(
      (source) =>
        !configuredSources.has(source) && !disabledSources.has(source)
    )
  );

  const combined: DirectNewsRecord[] = [];

  settled.forEach((result, index) => {
    const source = requests[index].source;

    if (
      result.status === "fulfilled" &&
      result.value.length > 0
    ) {
      connectedSources.add(source);
      combined.push(...result.value);
    } else {
      unavailableSources.add(source);

      if (result.status === "rejected") {
        console.error(
          `${source} news request failed:`,
          result.reason
        );
      } else {
        console.error(
          `${source} returned no usable dated articles.`
        );
      }
    }
  });

  // Finviz exports can contain these publishers even when their direct feed fails.
  if (process.env.FINVIZ_API_TOKEN?.trim()) {
    try {
      const response = await getFinvizNews();
      const payload = await response.json();
      const aliases: Record<string, string> = { benzinga: "Benzinga", globenewswire: "GlobeNewswire", accesswire: "AccessWire", accessnewswire: "AccessWire", fda: "FDA" };
      const supplemented = new Set<string>();
      if (response.ok && !payload.stale) for (const row of payload.results ?? []) {
        const source = aliases[String(row.Source ?? "").toLowerCase().replace(/[^a-z]/g, "")];
        if (!source || connectedSources.has(source) || skipSource(source)) continue;
        const title = decodeEntities(String(row.Title ?? ""));
        const url = absoluteUrl(String(row.Url ?? ""), "https://finviz.com");
        const date = normalizeDate(String(row.Date ?? ""));
        if (!title || !url || !date) continue;
        combined.push({ Title: title, Source: source, Date: date, Url: url, Category: categorize(title), Ticker: String(row.Ticker ?? "").trim() || extractTicker(title) });
        supplemented.add(source);
      }
      for (const source of supplemented) connectedSources.add(source);
    } catch {
      console.error("Supplemental news export unavailable; retaining saved articles.");
    }
  }

  for (const source of connectedSources) {
    unavailableSources.delete(source);
  }

  const companyTickers = await companyTickersPromise;

  const uniqueResults = addMissingTickers(
    Array.from(
      new Map(
        combined.map((item) => [item.Url, item])
      ).values()
    ),
    companyTickers
  )
    .sort(
      (a, b) =>
        new Date(b.Date).getTime() -
        new Date(a.Date).getTime()
    );

  if (uniqueResults.length === 0 && allowedSourceNames.length > 0 && !process.env.DATABASE_URL) {
    throw new Error(
      "No approved source returned usable dated articles."
    );
  }

  return {
    results: uniqueResults,
    count: uniqueResults.length,
    fetchedAt: new Date().toISOString(),
    connectedSources: Array.from(connectedSources),
    unavailableSources: Array.from(unavailableSources),
  };
}

async function storeAndLoadNews(
  payload: NewsPayload
): Promise<NewsPayload> {
  if (!process.env.DATABASE_URL) return payload;

  try {
    await ensureDatabaseSchema();

    const client = await database.connect();

    try {
      await client.query("BEGIN");

      for (const item of payload.results) {
        await client.query(
          `
          INSERT INTO news_articles (
            headline,
            source,
            published_at,
            url,
            category,
            ticker
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (url) DO UPDATE SET
            headline = EXCLUDED.headline,
            source = EXCLUDED.source,
            published_at = CASE WHEN news_articles.source = 'Benzinga' AND EXCLUDED.source = 'Benzinga'
              THEN LEAST(news_articles.published_at, EXCLUDED.published_at)
              ELSE EXCLUDED.published_at END,
            category = EXCLUDED.category,
            ticker = EXCLUDED.ticker
          `,
          [
            item.Title,
            item.Source,
            item.Date,
            item.Url,
            item.Category,
            item.Ticker,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const storedNews = await database.query<{
      headline: string;
      source: string;
      published_at: Date | string;
      url: string;
      category: string;
      ticker: string;
    }>(
      `
      SELECT
        headline,
        source,
        published_at,
        url,
        category,
        ticker
      FROM news_articles
      WHERE source = ANY($1::text[])
      ORDER BY published_at DESC
      `,
      [allowedSourceNames]
    );

    const results: DirectNewsRecord[] = storedNews.rows.map(
      (item) => ({
        Title: item.headline,
        Source: item.source,
        Date: (item.source === "FDA" ? headlineDate(item.headline) : null) ?? new Date(item.published_at).toISOString(),
        Url: item.url,
        Category: item.category,
        Ticker: item.ticker,
      })
    );

    return {
      ...payload,
      results,
      count: results.length,
    };
  } catch (error) {
    console.error("News database update failed:", error);
    return payload;
  }
}

export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!refresh && cachedPayload && Date.now() < cacheExpiresAt) {
    return NextResponse.json({
      ...cachedPayload,
      cached: true,
      stale: false,
    });
  }

  try {
    if (!pendingRequest) {
      pendingRequest = buildPayload()
        .then(storeAndLoadNews)
        .finally(() => {
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
    console.error("Direct news request failed:", error);

    if (cachedPayload) {
      return NextResponse.json({
        ...cachedPayload,
        cached: true,
        stale: true,
        warning:
          "Direct sources are temporarily unavailable. Showing the last successful results.",
      });
    }

    return NextResponse.json(
      {
        error:
          "Unable to retrieve news directly from the approved sources.",
      },
      { status: 502 }
    );
  }
}