"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import { CONFIG_OPTIONS, changeLabel, DEFAULT_FEED_CONFIG, matchesKeywords, matchesStockConfig, type FeedConfig } from "@/lib/feed-preferences";
import { formatMarketCapitalization } from "@/lib/market-cap";
import { matchesSocialSearch, decodeSocialText } from "@/lib/social-text";
import CollectionInfo from "./CollectionInfo";
import SnapshotAge from "./SnapshotAge";
import TradingViewChart from "./TradingViewChart";
import SelectedXPosts from "./SelectedXPosts";
import SettingsPanel from "./SettingsPanel";
import ChangeFilter from "./ChangeFilter";
import CorrelationPanel from "./CorrelationPanel";

type Section = "News" | "Screener" | "Social" | "Charts" | "Momentum" | "Mirror" | "Settings";

type NewsItem = {
  headline: string;
  source: string;
  time: string;
  verified: boolean;
  category: string;
};

type Stock = {
  ticker: string;
  company: string;
  sector: string;
  marketCap: string;
  price: number;
  change: number;
  volume: string;
  relativeVolume: number | null;
  messageCount: number;
  priceHistory: number[];
  news: NewsItem[];
};

type ApprovedEvent = {
  company: string;
  ticker: string;
  headline: string;
  source: string;
  category: string;
  sentiment: "Bullish" | "Bearish" | "Neutral";
  url: string;
};

type FinvizRecord = Record<string, string>;

type FinvizResponse = {
  results?: FinvizRecord[];
  count?: number;
  fetchedAt?: string;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
  error?: string;
};

type FinvizNewsRecord = {
  Title?: string;
  Source?: string;
  Date?: string;
  Url?: string;
  Category?: string;
  Ticker?: string;
};

type FinvizNewsResponse = {
  results?: FinvizNewsRecord[];
  count?: number;
  fetchedAt?: string;
  unavailableSources?: string[];
  stale?: boolean;
  error?: string;
};

type LiveNewsItem = {
  headline: string;
  source: string;
  date: string;
  url: string;
  category: string;
  ticker: string;
};

type SocialPost = {
  id: string;
  platform: string;
  username: string;
  ticker: string;
  body: string;
  url: string;
  sentiment: string;
  publishedAt: string;
};

type SocialResponse = {
  platforms?: { platform: string; enabled: boolean }[];
  hasMore?: boolean;
  results?: SocialPost[];
  count?: number;
  error?: string;
};

const approvedSources = [
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

const categoryKeywords: Record<string, string[]> = {
  Acquisition: ["acquisition", "acquire", "acquires", "acquired"],
  Buyback: ["buyback", "share repurchase", "repurchase program"],
  Contract: ["contract", "awarded", "agreement"],
  Listing: ["listing", "listed on", "uplisting"],
  Delisting: ["delisting", "delisted"],
  Compliance: ["compliance", "noncompliance", "regains compliance"],
  IPO: ["ipo", "initial public offering"],
  Merger: ["merger", "merge", "combination"],
  Partnership: ["partnership", "partners with", "collaboration"],
  Earnings: ["earnings", "financial results", "quarterly results"],
  Beat: ["beats estimates", "tops estimates", "exceeds expectations"],
  Miss: ["misses estimates", "falls short", "below expectations"],
  Investigation: ["investigation", "investigates", "class action"],
  Probe: ["probe", "inquiry"],
  FDA: ["fda", "food and drug administration"],
  Approval: ["approval", "approved", "clearance"],
  SEC: ["sec filing", "10-k", "10-q", "8-k", "form 6-k"],
  Bankruptcy: ["bankruptcy", "chapter 11"],
};

const sampleStocks: Stock[] = [
  {
    ticker: "VIVK",
    company: "Vivakor Inc.",
    sector: "Energy",
    marketCap: "$1.94M",
    price: 2.91,
    change: 11.54,
    volume: "1.2M",
    relativeVolume: 6.4,
    messageCount: 18,
    priceHistory: [2.25, 2.31, 2.4, 2.36, 2.55, 2.63, 2.75, 2.91],
    news: [
      { headline: "Vivakor announces new company development", source: "GlobeNewswire", time: "4:01 PM", verified: true, category: "Partnership" },
      { headline: "Trading volume increases following company update", source: "Benzinga", time: "3:48 PM", verified: true, category: "Other" },
    ],
  },
  {
    ticker: "DFNS",
    company: "T3 Defense Inc.",
    sector: "Industrials",
    marketCap: "$4.40M",
    price: 4.35,
    change: 8.21,
    volume: "3.6M",
    relativeVolume: 5.8,
    messageCount: 12,
    priceHistory: [3.74, 3.82, 3.91, 4.02, 3.96, 4.13, 4.24, 4.35],
    news: [
      { headline: "T3 Defense reports a new government contract", source: "PR Newswire", time: "3:55 PM", verified: true, category: "Contract" },
      { headline: "Defense company experiences increased trading activity", source: "Benzinga", time: "3:21 PM", verified: true, category: "Other" },
    ],
  },
  {
    ticker: "VBIO",
    company: "Valion Bio Inc.",
    sector: "Healthcare",
    marketCap: "$1.23M",
    price: 0.3,
    change: 3.85,
    volume: "6.2M",
    relativeVolume: 5.3,
    messageCount: 9,
    priceHistory: [0.24, 0.25, 0.24, 0.26, 0.27, 0.28, 0.29, 0.3],
    news: [
      { headline: "Valion Bio provides clinical research update", source: "AccessWire", time: "3:42 PM", verified: true, category: "FDA" },
      { headline: "Biotechnology stock gains on increased volume", source: "Benzinga", time: "3:10 PM", verified: false, category: "Other" },
    ],
  },
];

const approvedEvents: ApprovedEvent[] = [
  { company: "TruBridge Inc.", ticker: "TBRG", headline: "Rosen Law Firm Encourages TruBridge Investors to Inquire About Securities Class Action Investigation", source: "PR Newswire", category: "Investigation", sentiment: "Bearish", url: "https://www.prnewswire.com/news-releases/rosen-law-firm-encourages-trubridge-inc-investors-to-inquire-about-securities-class-action-investigation--tbrg-302826831.html" },
  { company: "Barclays PLC", ticker: "BCS", headline: "Rosen Law Firm Encourages Barclays Investors to Inquire About Securities Class Action Investigation", source: "PR Newswire", category: "Investigation", sentiment: "Bearish", url: "https://www.prnewswire.com/news-releases/rosen-law-firm-encourages-barclays-plc-investors-to-inquire-about-securities-class-action-investigation--bcs-302826821.html" },
  { company: "America First Federal Credit Union / Meadows Bank", ticker: "N/A", headline: "America First Federal Credit Union and Meadows Bank Consummate Transaction", source: "PR Newswire", category: "Acquisition", sentiment: "Bullish", url: "https://www.prnewswire.com/news-releases/america-first-federal-credit-union-and-meadows-bank-consummate-transaction-302823070.html" },
  { company: "SK Telecom", ticker: "N/A", headline: "SK Telecom Pursues 15GW AI Data Center Buildout", source: "PR Newswire", category: "Contract", sentiment: "Bullish", url: "https://www.prnewswire.com/news-releases/sk-telecom-pursues-15gw-ai-data-center-buildout-aiming-to-become-asias-ai-infrastructure-hub-302817963.html" },
  { company: "Freighter Group", ticker: "N/A", headline: "Wagga Trucks Expands as an Authorized Dealer for Volvo, UD and Mack", source: "PR Newswire", category: "Partnership", sentiment: "Neutral", url: "https://www.prnewswire.com/news-releases/wagga-trucks-set-to-expand-to-the-canberra-region-as-authorised-dealer-for-volvo-ud--mack-along-with-freighter-group-trailers-302817895.html" },
  { company: "PepsiCo Inc.", ticker: "PEP", headline: "PepsiCo Inc. 10-Q Filing", source: "SEC", category: "SEC", sentiment: "Neutral", url: "https://www.sec.gov/Archives/edgar/data/77476/000007747625000053/pep-20250906.htm" },
  { company: "Chipotle Mexican Grill", ticker: "N/A", headline: "Chipotle Mexican Grill Inc. 8-K Filing", source: "SEC", category: "SEC", sentiment: "Neutral", url: "https://www.sec.gov/Archives/edgar/data/1058090/000105809026000024/0001058090-26-000024-index.htm" },
  { company: "Home Federal Bancorp", ticker: "N/A", headline: "Home Federal Bancorp of Louisiana 8-K Filing", source: "SEC", category: "SEC", sentiment: "Neutral", url: "https://www.sec.gov/Archives/edgar/data/1500375/000092708926000080/hfbil20260429_8k.htm" },
  { company: "Mission Produce Inc.", ticker: "N/A", headline: "Mission Produce Inc. 8-K Filing", source: "SEC", category: "SEC", sentiment: "Neutral", url: "https://www.sec.gov/Archives/edgar/data/1802974/000119312526188794/d35852d8k.htm" },
];

const navItems: { name: Section; icon: string }[] = [
  { name: "News", icon: "▤" },
  { name: "Screener", icon: "⌕" },
  { name: "Social", icon: "●" },
  { name: "Charts", icon: "▥" },
  { name: "Momentum", icon: "↗" },
  { name: "Mirror", icon: "🔗" },
  { name: "Settings", icon: "⚙" },
];

const panel: CSSProperties = { background: "#35172d", border: "1px solid #713259", borderRadius: 12 };
const inputStyle: CSSProperties = { background: "#210f1c", color: "white", border: "1px solid #713259", borderRadius: 7, padding: "9px 11px" };
const th: CSSProperties = { padding: "13px", textAlign: "left", color: "#fbcfe8", borderBottom: "1px solid #713259", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "13px", borderBottom: "1px solid #592343", whiteSpace: "nowrap" };

function formatNewsDate(value: string, source: string) {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return "Date unavailable";

  // The direct ACCESS parser stores a publication day at UTC midnight,
  // not a verified publication time. Keep that day in UTC when displaying it.
  const dateOnlyAccess =
    /accesswire|access newswire|^FDA$/i.test(source) &&
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;

  if (dateOnlyAccess) {
    return `${date.toLocaleDateString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })} (time unavailable)`;
  }

  return date.toLocaleString();
}

const DEFAULT_MIRROR_CONFIG: FeedConfig = {...DEFAULT_FEED_CONFIG, priceChange:"Up"};
const CHART_FEED_PAGE_SIZE = 5;
const CHART_STOCK_PAGE_SIZE = 10;

export default function Home() {
  const [activeSection, setActiveSection] = useState<Section>("News");
  useEffect(() => {
    if (window.location.hash === "#mirror") setActiveSection("Mirror");
    if (window.location.hash === "#charts") setActiveSection("Charts");
  }, []);
  function openSection(section:Section, ticker = "") {
    if (section === "Charts") {
      setChartSort("gainers");
      setChartSearch("");
      setChartStocksVisible(CHART_STOCK_PAGE_SIZE);
      setSelectedTicker(ticker);
    }
    setActiveSection(section);
    if (section === "Mirror") window.history.replaceState(null,"","#mirror");
    else if (section === "Charts") window.history.replaceState(null,"","#charts");
    else if (["#mirror", "#charts"].includes(window.location.hash)) window.history.replaceState(null,"",window.location.pathname + window.location.search);
  }
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [chartStocksVisible, setChartStocksVisible] = useState(CHART_STOCK_PAGE_SIZE);
  const [screenerStocksVisible, setScreenerStocksVisible] = useState(10);
  const [chartSearch, setChartSearch] = useState("");
  const [chartSort, setChartSort] = useState("gainers");
  const [screenerSearch, setScreenerSearch] = useState("");
  const [screenerSort, setScreenerSort] = useState("ticker");
  const [mirrorConfig, setMirrorConfig] = useState<FeedConfig>(DEFAULT_MIRROR_CONFIG);
  const [mirrorAutoFetch, setMirrorAutoFetch] = useState(true);
  const [mirrorResult, setMirrorResult] = useState<{key:string;stocks:Stock[]}>({key:"",stocks:[]});
  const mirrorRankingKey = JSON.stringify([mirrorConfig.marketCap,mirrorConfig.relativeVolume,mirrorConfig.currentVolume,mirrorConfig.priceChange]);
  const mirrorStocks = mirrorResult.key === mirrorRankingKey ? mirrorResult.stocks : [];
  const [mirrorStatus, setMirrorStatus] = useState("");
  const [momentumMode, setMomentumMode] = useState<"gainers" | "decliners">("gainers");
  const [liveNews, setLiveNews] = useState<LiveNewsItem[]>([]);
  const [newsVisible, setNewsVisible] = useState(100);
  const [selectedTicker, setSelectedTicker] = useState("");
  const [message, setMessage] = useState("Press Fetch to load live Finviz screener results");
  const [isFetching, setIsFetching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const [priceStatus, setPriceStatus] = useState("Awaiting price snapshot");
  const [refreshInterval, setRefreshInterval] = useState("1 minute");
  const [autoFetch, setAutoFetch] = useState(true);
  const [fetchPreferencesLoaded, setFetchPreferencesLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("flashscope.fetch-preferences.v1") ?? "null");
      if (saved && typeof saved === "object") {
        // A full reload restores the one-minute starting interval.
      }
    } catch {
      // Storage may be unavailable or contain invalid data; keep the defaults.
    }
    setFetchPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    if (!fetchPreferencesLoaded) return;
    try {
      window.localStorage.setItem("flashscope.fetch-preferences.v1", JSON.stringify({ autoFetch, refreshInterval }));
    } catch {
      // Fetching still works when the browser blocks preference storage.
    }
  }, [autoFetch, refreshInterval, fetchPreferencesLoaded]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [rollingWindow, setRollingWindow] = useState("60");
  const [marketCap, setMarketCap] = useState("Any");
  const [relativeVolume, setRelativeVolume] = useState("Over 5");
  const [currentVolume, setCurrentVolume] = useState("Over 100K");
  const [applyNewsKeywords, setApplyNewsKeywords] = useState(false);
  const [newsDate, setNewsDate] = useState("Previous 3 days");
  const [priceChange, setPriceChange] = useState("Any");
  const [selectedSource, setSelectedSource] = useState("All sources");
  const [selectedCategory, setSelectedCategory] = useState("All categories");
  const [searchTerm, setSearchTerm] = useState("");
  const [excludedTerm, setExcludedTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [includeKeywords, setIncludeKeywords] = useState<string[]>([]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);
  const [socialSearch, setSocialSearch] = useState("");
  const [visibleSocialPlatforms, setVisibleSocialPlatforms] = useState(["Stocktwits", "Reddit", "X"]);
  const [socialDays, setSocialDays] = useState("7");
  const [socialOffset, setSocialOffset] = useState(0);
  const [socialHasMore, setSocialHasMore] = useState(false);
  const socialRequest = useRef(0);
  const latestCounts = useRef<Record<string, number>>({});
  const [socialSentiment, setSocialSentiment] = useState("All sentiments");
  const [countStatus, setCountStatus] = useState("Waiting for social counts...");
  const [socialPosts, setSocialPosts] = useState<SocialPost[]>([]);
  const [isLoadingSocial, setIsLoadingSocial] = useState(false);
  const [socialMessage, setSocialMessage] = useState("Loading stored social posts...");
  const [chartPosts, setChartPosts] = useState({ticker:"", posts:[] as SocialPost[], offset:0, hasMore:false, loading:false, error:""});
  const chartPostRequest = useRef<AbortController|null>(null);
  const [chartNewsVisible, setChartNewsVisible] = useState(CHART_FEED_PAGE_SIZE);
  const [selectedSocialPlatform, setSelectedSocialPlatform] = useState("All platforms");

  const [enabledFeedKeywords, setEnabledFeedKeywords] = useState<string[]>([]);
  const [enabledNewsSources, setEnabledNewsSources] = useState<string[] | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  function applyConfig(config: FeedConfig) {
    setApplyNewsKeywords(config.applyNewsKeywords);
    setMarketCap(config.marketCap); setRelativeVolume(config.relativeVolume);
    setCurrentVolume(config.currentVolume); setPriceChange(config.priceChange);
    setRollingWindow(config.rollingWindow); setNewsDate(config.newsDate); setVerifiedOnly(config.verifiedOnly);
  }
  async function loadLinkedSettings() {
    try {
      const data = await Promise.all(["sources", "keywords", "config"].map(async (type) => {
        const response = await fetch(`/api/settings?type=${type}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load Settings.");
        return body.results;
      }));
      const sourceNames: string[] = data[0].filter((row: {enabled: boolean}) => row.enabled).map((row: {name: string}) => row.name);
      setEnabledNewsSources(sourceNames);
      if (selectedSource !== "All sources" && !sourceNames.includes(selectedSource)) setSelectedSource("All sources");
      setEnabledFeedKeywords(data[1].filter((row: {enabled: boolean}) => row.enabled).map((row: {keyword: string}) => row.keyword));
      applyConfig({...DEFAULT_FEED_CONFIG, ...data[2]});
      setConfigLoaded(true);
    } catch {
      setMessage("Unable to load saved Settings. Retry Fetch or reload the page.");
    }
  }
  async function saveConfig(key: string, value: string | boolean) {
    try {
      const response = await fetch("/api/settings?type=config", {method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({key,value})});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save Config.");
      applyConfig(body.results);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Unable to save Config."); }
  }
  const pageSettingsReset = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (!pageSettingsReset.current) {
      pageSettingsReset.current = (async () => {
        const response = await fetch("/api/settings?type=sources", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({action: "restore-all"}),
        });
        if (!response.ok) throw new Error("Unable to restore Settings.");
        const reset = await fetch("/api/settings?type=config", {
          method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"reset-defaults"})
        });
        if(!reset.ok) throw new Error("Unable to reset Config defaults.");
      })();
    }
    void pageSettingsReset.current.then(() => loadLinkedSettings()).catch(() => {
      setMessage("Unable to restore Settings. Reload the page to retry.");
    });
  }, []);
  useEffect(() => {
    if (configLoaded) void loadResults(true);
  }, [configLoaded, marketCap, relativeVolume, currentVolume, priceChange]);



  const filteredStocks = useMemo(() => {
    const config: FeedConfig = {marketCap,relativeVolume,currentVolume,priceChange,rollingWindow,newsDate,verifiedOnly,applyNewsKeywords};
    return stocks.filter((stock) => matchesStockConfig(stock,config));
  }, [stocks,marketCap,relativeVolume,currentVolume,priceChange,rollingWindow,newsDate,verifiedOnly]);
  const screenerMatches = useMemo(() => {
    const query = screenerSearch.trim().replace(/^\$/, "").toLowerCase();
    return filteredStocks.filter(stock => !query || [stock.ticker, stock.company, stock.sector].some(value => value.toLowerCase().includes(query)))
      .sort((a, b) => screenerSort === "gainers" ? b.change - a.change || a.ticker.localeCompare(b.ticker) : screenerSort === "decliners" ? a.change - b.change || a.ticker.localeCompare(b.ticker) : a.ticker.localeCompare(b.ticker));
  }, [filteredStocks, screenerSearch, screenerSort]);
  const chartMatches = useMemo(() => {
    const query = chartSearch.trim().replace(/^\$/, "").toLowerCase();
    return filteredStocks.filter(stock => query
      ? [stock.ticker, stock.company, stock.sector].some(value => value.toLowerCase().includes(query))
      : chartSort !== "gainers" || stock.change > 0)
      .sort((a, b) => chartSort === "gainers" ? b.change - a.change || a.ticker.localeCompare(b.ticker) : chartSort === "decliners" ? a.change - b.change || a.ticker.localeCompare(b.ticker) : a.ticker.localeCompare(b.ticker));
  }, [filteredStocks, chartSearch, chartSort]);
  useEffect(() => { setChartStocksVisible(CHART_STOCK_PAGE_SIZE); }, [chartSearch, chartSort]);
  useEffect(() => { setScreenerStocksVisible(10); }, [screenerSearch, screenerSort]);
  const matchingStockKey = filteredStocks.map(stock => stock.ticker).join(",");
  useEffect(() => {
    setChartStocksVisible(CHART_STOCK_PAGE_SIZE);
    setScreenerStocksVisible(10);
  }, [matchingStockKey]);
  const chartStock = filteredStocks.find((stock) => stock.ticker === selectedTicker) ?? chartMatches[0];
  const selectedStock = chartStock ?? sampleStocks[0];
  const chartTicker = chartStock?.ticker;
  useEffect(() => { setChartNewsVisible(CHART_FEED_PAGE_SIZE); }, [activeSection, selectedStock.ticker]);

  const filteredNews = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    const excluded = excludedTerm.trim().toLowerCase();

    const days =
      newsDate === "Today"
        ? 1
        : newsDate === "Previous 3 days"
          ? 3
          : newsDate === "Previous 7 days"
            ? 7
            : Infinity;

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoff = newsDate === "Previous 3 months" ? threeMonthsAgo.getTime() :
    days === Infinity
      ? 0
      : Date.now() - days * 24 * 60 * 60 * 1000;
    

    return liveNews.filter((item) => {
      const searchableText = `${item.ticker} ${item.headline} ${item.source} ${item.category}`.toLowerCase();
      const itemTime = new Date(item.date.replace(" ", "T")).getTime();
      const matchesDate =newsDate === "Any" || (Number.isFinite(itemTime) && itemTime >= cutoff);
      const activeIncludeKeywords = [
        ...includeKeywords,
        ...(search ? [search] : []),
      ];
      const activeExcludeKeywords = [
        ...excludeKeywords,
        ...(excluded ? [excluded] : []),
      ];
      const matchesSearch =
        activeIncludeKeywords.length === 0 ||
        activeIncludeKeywords.every((keyword) =>
          searchableText.includes(keyword.toLowerCase())
        );
      const isExcluded = activeExcludeKeywords.some((keyword) =>
        searchableText.includes(keyword.toLowerCase())
      );
      const matchesSource =
        selectedSource === "All sources" || item.source === selectedSource;
      const matchesCategory =
        selectedCategory === "All categories" || item.category === selectedCategory;
      return matchesDate && matchesSearch && !isExcluded && matchesSource && matchesCategory &&
        (enabledNewsSources === null || enabledNewsSources.includes(item.source)) &&
        (!applyNewsKeywords || matchesKeywords(`${item.ticker} ${item.headline}`, enabledFeedKeywords)) &&
        (!verifiedOnly || (item.ticker !== "N/A" && /^https?:/.test(item.url)));
    });
  }, [liveNews, searchTerm, excludedTerm, includeKeywords, excludeKeywords, selectedSource, selectedCategory, newsDate, enabledNewsSources, enabledFeedKeywords, verifiedOnly, applyNewsKeywords]);

  const availableNewsSources = useMemo(
    () => Array.from(new Set<string>(liveNews.filter((item) => enabledNewsSources === null || enabledNewsSources.includes(item.source)).map((item) => item.source))).sort(),
    [liveNews, enabledNewsSources]
  );

  const filteredSocialPosts = useMemo(
    () =>
      socialPosts.filter(
        (post) =>
          selectedSocialPlatform === "All platforms" ||
          post.platform === selectedSocialPlatform
      ).filter((post) =>
        matchesSocialSearch(`${post.ticker} ${post.body} ${post.username} ${post.platform}`, socialSearch)
      ).filter((post) => matchesKeywords(`${post.ticker} ${post.body} ${post.username}`, enabledFeedKeywords)).filter((post) => socialSentiment === "All sentiments" || post.sentiment === socialSentiment),
    [socialPosts, selectedSocialPlatform, socialSearch, socialSentiment, enabledFeedKeywords]
  );
  const selectedStockNews = useMemo(() => {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(
          /\b(incorporated|corporation|company|holdings|holding|group|limited|inc|corp|co|ltd|plc|llc|adr|us)\b/g,
          ""
        )
        .replace(/\s+/g, " ")
        .trim();

    const ticker = selectedStock.ticker.trim().toLowerCase();
    const company = normalize(selectedStock.company);
    const genericCompanyWords = new Set([
      "technology",
      "technologies",
      "innovation",
      "energy",
      "pharmaceutical",
      "pharmaceuticals",
      "biologic",
      "biologics",
      "financial",
      "capital",
      "international",
      "global",
      "industries",
      "industrial",
      "systems",
      "services",
      "health",
      "medical",
    ]);
    const companyWords = company
      .split(" ")
      .filter(
        (word) => word.length >= 4 && !genericCompanyWords.has(word)
      );

    return filteredNews
      .filter((item) => {
        const headline = normalize(item.headline);
        const articleTickers = item.ticker
          .toLowerCase()
          .split(/[\s,;|/]+/)
          .map((value) => value.trim())
          .filter(Boolean);

        const tickerMatch =
          ticker !== "n/a" &&
          (articleTickers.includes(ticker) ||
            new RegExp(
              `\\b${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
              "i"
            ).test(item.headline));

        const fullCompanyMatch =
          company.length >= 4 && headline.includes(company);

        const companyWordMatch =
          companyWords.length >= 2
            ? companyWords.slice(0, 2).every((word) => headline.includes(word))
            : false;

        return tickerMatch || fullCompanyMatch || companyWordMatch;
      });
  }, [filteredNews, selectedStock]);

  const displayedNews = verifiedOnly ? selectedStock.news.filter((item) => item.verified) : selectedStock.news;
  const maximumPrice = Math.max(...selectedStock.priceHistory, 1);

  function readField(record: FinvizRecord, ...names: string[]) {
    for (const name of names) {
      if (record[name] !== undefined && record[name] !== "") return record[name];
    }
    return "";
  }

  function parseNumber(value: string) {
    const number = Number(value.replace(/[$,%+]/g, "").replace(/,/g, ""));
    return Number.isFinite(number) ? number : 0;
  }

  function formatVolume(value: string) {
    const cleanedValue = value.replace(/,/g, "").trim();
    const number = Number(cleanedValue);

    if (!Number.isFinite(number)) return value;
    if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
    if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
    return number.toLocaleString();
  }

  const formatMarketCap = formatMarketCapitalization;

  function cleanText(value: string) {
    return value
      .replace(/â€™|â€˜/g, "'")
      .replace(/â€œ|â€/g, '"')
      .replace(/â€“|â€”/g, "—")
      .replace(/â€¦/g, "…");
  }

  function categorizeHeadline(headline: string) {
    const text = headline.toLowerCase();
    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some((keyword) => text.includes(keyword))) return category;
    }
    return "Other";
  }

  function normalizeSource(source: string) {
    const lowered = source.toLowerCase();
    if (lowered.includes("reuters") || lowered.includes("tradingview")) return "TradingView/Reuters";
    if (lowered.includes("globe")) return "GlobeNewswire";
    if (lowered.includes("pr newswire")) return "PR Newswire";
    if (lowered.includes("accesswire")) return "AccessWire";
    if (lowered.includes("mt newswire")) return "MT Newswires";
    if (lowered.includes("dow jones")) return "Dow Jones Newswires";
    if (lowered === "sec" || lowered.includes("sec.gov")) return "SEC";
    if (lowered === "fda" || lowered.includes("fda.gov")) return "FDA";
    if (lowered.includes("benzinga")) return "Benzinga";
    return source;
  }

  function convertFinvizStock(record: FinvizRecord): Stock {
    const ticker = readField(record, "Ticker", "ticker", "Symbol", "symbol") || "N/A";
    const price = parseNumber(readField(record, "Price", "price"));
    const change = parseNumber(readField(record, "Change", "Change %", "change"));
    const volume = readField(record, "Volume", "volume") || "N/A";
    const rawRelativeVolume = readField(record, "Relative Volume", "Rel Volume", "Rel. Volume", "Rel Volume.", "relativeVolume");
    const parsedRelativeVolume = Number(rawRelativeVolume.replace(/,/g, "").trim());
    const relativeVolume = rawRelativeVolume.trim() && Number.isFinite(parsedRelativeVolume)
      ? parsedRelativeVolume : null;

    return {
      ticker,
      company: readField(record, "Company", "company") || ticker,
      sector: readField(record, "Sector", "sector") || "N/A",
      marketCap: readField(record, "Market Cap", "MarketCap", "marketCap") || "N/A",
      price,
      change,
      volume,
      relativeVolume,
      messageCount: 0,
      priceHistory: Array(8).fill(price || 1),
      news: [],
    };
  }

  function convertFinvizNews(record: FinvizNewsRecord): LiveNewsItem | null {
    const headline = cleanText(record.Title?.trim() ?? "");
    const source = normalizeSource(record.Source?.trim() ?? "");
    const date = record.Date?.trim() ?? "";
    const url = record.Url?.trim() ?? "";

    if (!headline || !source || !date || !url) {
      return null;
    }

    return {
      headline,
      source,
      date,
      url,
      category: categorizeHeadline(headline),
      ticker: record.Ticker?.trim() || "N/A",
    };
  }

  useEffect(() => {
    if(activeSection !== "Mirror") return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const params = new URLSearchParams({scope:"mirror", marketCap:mirrorConfig.marketCap, relativeVolume:mirrorConfig.relativeVolume, currentVolume:mirrorConfig.currentVolume, priceChange:mirrorConfig.priceChange});
        const response = await fetch(`/api/finviz?${params}`, {cache:"no-store", signal:controller.signal});
        const data = await response.json() as FinvizResponse;
        if(!response.ok) throw new Error(data.error || "Unable to load Mirror stocks.");
        if(!controller.signal.aborted) { setMirrorResult({key:mirrorRankingKey,stocks:(data.results ?? []).map(convertFinvizStock)}); setMirrorStatus(`Mirror: ${data.results?.length ?? 0} matching stocks`); }
      } catch(error) { if(!controller.signal.aborted) setMirrorStatus(error instanceof Error ? error.message : "Unable to load Mirror stocks."); }
    };
    setMirrorStatus("Loading Mirror stocks..."); void load();
    const timer = mirrorAutoFetch ? setInterval(() => void load(), 60000) : null;
    return () => {controller.abort(); if(timer) clearInterval(timer);};
  }, [activeSection, mirrorConfig.marketCap, mirrorConfig.relativeVolume, mirrorConfig.currentVolume, mirrorConfig.priceChange, mirrorAutoFetch, mirrorRankingKey]);

  const momentumStocks = useMemo(() => filteredStocks
    .filter((stock) => Number.isFinite(stock.change) && (momentumMode === "gainers" ? stock.change > 0 : stock.change < 0))
    .slice()
    .sort((a, b) => (momentumMode === "gainers" ? b.change - a.change : a.change - b.change) || a.ticker.localeCompare(b.ticker))
    .slice(0, 10), [filteredStocks, momentumMode]);

  async function loadResults(automatic = false) {
    await loadLinkedSettings();
    setIsFetching(true);
    setMessage("Fetching live screener and approved-source news...");

    try {
      const [stockResponse, newsResponse] = await Promise.all([
        fetch("/api/finviz", { cache: "no-store" }),
        fetch(`/api/news${automatic ? "" : "?refresh=1"}`, { cache: "no-store" }),
      ]);
      const data = (await stockResponse.json()) as FinvizResponse;
      const newsData = (await newsResponse.json()) as FinvizNewsResponse;

      if (!newsResponse.ok) {
        throw new Error(newsData.error || `News request failed with status ${newsResponse.status}`);
      }

      const liveStocks = stockResponse.ok
        ? (data.results ?? []).map(convertFinvizStock)
        : stocks;
      const newsItems = (newsData.results ?? [])
        .map(convertFinvizNews)
        .filter((item): item is LiveNewsItem => item !== null);
      setStocks(liveStocks.map(stock => ({...stock, messageCount: latestCounts.current[stock.ticker.trim().toUpperCase()] ?? stock.messageCount})));
      setLiveNews(newsItems);



      const fetchedTime = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
      setLastUpdated(data.fetchedAt ? fetchedTime.toISOString() : "");
      setPriceStatus(!stockResponse.ok ? "Price update failed · previous snapshot" : data.stale ? "Stale price snapshot · provider unavailable" : data.cached ? "Cached Finviz snapshot · up to 1 min cache" : "New Finviz snapshot · feed delay not verified");
      setMessage(
        stockResponse.ok
          ? `${liveStocks.length} stocks and ${newsItems.length} news articles fetched${automatic ? " automatically" : ""}`
          : `${newsItems.length} news articles fetched. Screener temporarily unavailable: ${data.error || `status ${stockResponse.status}`}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setMessage(`Unable to load Finviz data: ${errorMessage}`);
    } finally {
      setIsFetching(false);
    }
  }

  const stockTickerKey = stocks.map((stock) => stock.ticker).join(",");
  useEffect(() => {
    let cancelled = false;
    async function refreshCounts() {
      try {
        const response = await fetch(`/api/social?counts=${Number(rollingWindow) || 60}`, { cache: "no-store" });
        const data = await response.json() as { counts?: Record<string, number>; error?: string };
        if (!response.ok || !data.counts) throw new Error(data.error || "Counts unavailable");
        if (cancelled) return;
        const counts = data.counts;
        latestCounts.current = counts;
        setStocks((current) => current.map((stock) => ({
          ...stock, messageCount: counts[stock.ticker.trim().toUpperCase()] ?? 0,
        })));
        setCountStatus(`Counts updated ${new Date().toLocaleTimeString()}. Zero means no saved posts in this window; the worker must track these tickers.`);
      } catch {
        if (!cancelled) setCountStatus("Social counts unavailable. Check the database connection; displayed counts may be outdated.");
      }
    }
    void refreshCounts();
    const timer = window.setInterval(() => void refreshCounts(), 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [rollingWindow, stockTickerKey]);

  function handleFetch() {
    void loadResults();
  }

  const socialKeywordKey = JSON.stringify(enabledFeedKeywords);
  const socialDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSocialPosts = useCallback(async (offset = 0) => {
    if (socialDebounce.current) { clearTimeout(socialDebounce.current); socialDebounce.current = null; }
    const requestId = ++socialRequest.current;
    setIsLoadingSocial(true);
    setSocialMessage("Loading stored social posts...");

    try {
      const params = new URLSearchParams({ days: socialDays, limit: "100", offset: String(offset), q: socialSearch });
      if (selectedSocialPlatform !== "All platforms") params.set("platform", selectedSocialPlatform);
      if (socialSentiment !== "All sentiments") params.set("sentiment", socialSentiment);
      const response = await fetch(`/api/social?${params}`, { cache: "no-store" });
      const data = (await response.json()) as SocialResponse;
      if (requestId !== socialRequest.current) return;

      if (!response.ok) {
        throw new Error(data.error || `Social request failed with status ${response.status}`);
      }

      if (data.platforms) {
        const enabled = data.platforms.filter((row) => row.enabled).map((row) => row.platform);
        setVisibleSocialPlatforms(enabled);
        if (selectedSocialPlatform !== "All platforms" && !enabled.includes(selectedSocialPlatform)) setSelectedSocialPlatform("All platforms");
      }
      const posts = data.results ?? [];
      setSocialPosts((previous) => offset ? [...previous, ...posts] : posts);
      setSocialOffset(offset);
      setSocialHasMore(data.hasMore === true);
      setSocialMessage(
        posts.length > 0
          ? `Saved posts • updated ${new Date().toLocaleTimeString()}`
          : data.platforms?.every((row) => !row.enabled) ? "Enable a social platform in Settings → Accounts." : "No matching saved posts in this history period."
      );
    } catch (error) {
      if (requestId !== socialRequest.current) return;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setSocialMessage(`Unable to load social posts: ${errorMessage}`);
    } finally {
      if (requestId === socialRequest.current) setIsLoadingSocial(false);
    }
  }, [socialDays, selectedSocialPlatform, socialSearch, socialSentiment]);

  useEffect(() => {
    socialRequest.current += 1;
    if (activeSection !== "Social") return;
    setSocialPosts([]);
    setSocialOffset(0);
    setSocialHasMore(false);
    setIsLoadingSocial(true);
    setSocialMessage("Searching saved social posts...");
    socialDebounce.current = setTimeout(() => void loadSocialPosts(), 250);
    return () => {
      if (socialDebounce.current) clearTimeout(socialDebounce.current);
      socialDebounce.current = null;
      socialRequest.current += 1;
    };
  }, [activeSection, loadSocialPosts, socialKeywordKey]);

  const loadChartPosts = useCallback(async (offset = 0) => {
    if (chartPostRequest.current) return;
    const ticker = chartTicker;
    if (!ticker) return;
    const controller = new AbortController();
    chartPostRequest.current = controller;
    setChartPosts(previous => offset && previous.ticker === ticker
      ? {...previous, loading:true, error:""}
      : {ticker, posts:[], offset:0, hasMore:false, loading:true, error:""});
    try {
      const params = new URLSearchParams({ticker, platform:"Stocktwits", limit:String(CHART_FEED_PAGE_SIZE), offset:String(offset)});
      const response = await fetch(`/api/social?${params}`, {cache:"no-store", signal:controller.signal});
      if (!response.ok) throw new Error("Unable to load Stocktwits posts.");
      const data = await response.json() as SocialResponse;
      if (controller.signal.aborted) return;
      setChartPosts(previous => {
        const posts = offset && previous.ticker === ticker ? previous.posts : [];
        const seen = new Set(posts.map(post => post.id));
        return {ticker, posts:[...posts, ...(data.results ?? []).filter(post => !seen.has(post.id))],
          offset:offset + CHART_FEED_PAGE_SIZE, hasMore:data.hasMore === true, loading:false, error:""};
      });
    } catch {
      if (!controller.signal.aborted) setChartPosts(previous => ({...previous, loading:false, error:"Unable to load Stocktwits posts."}));
    } finally {
      if (chartPostRequest.current === controller) chartPostRequest.current = null;
    }
  }, [chartTicker]);

  useEffect(() => {
    if (activeSection !== "Charts" || !chartTicker) return;
    void loadChartPosts();
    return () => {
      chartPostRequest.current?.abort();
      chartPostRequest.current = null;
    };
  }, [activeSection, chartTicker, loadChartPosts]);

  useEffect(() => {
    if (!autoFetch || !configLoaded) return;
    const intervals: Record<string, number> = { "1 minute": 60000, "5 minutes": 300000, "15 minutes": 900000 };
    const timer = window.setInterval(() => void loadResults(true), intervals[refreshInterval] ?? 60000);
    return () => window.clearInterval(timer);
  }, [autoFetch, refreshInterval, configLoaded, marketCap, relativeVolume, currentVolume, priceChange]);

  function saveKeyword(type: "include" | "exclude") {
    const value = (type === "include" ? searchTerm : excludedTerm).trim();
    if (!value) return;

    if (type === "include") {
      setIncludeKeywords((current) =>
        current.some((keyword) => keyword.toLowerCase() === value.toLowerCase())
          ? current
          : [...current, value]
      );
      setSearchTerm("");
    } else {
      setExcludeKeywords((current) =>
        current.some((keyword) => keyword.toLowerCase() === value.toLowerCase())
          ? current
          : [...current, value]
      );
      setExcludedTerm("");
    }
  }

  const keywordTagStyle: CSSProperties = {
    border: "1px solid #a84f82",
    borderRadius: 999,
    background: "#4a203c",
    color: "#fbcfe8",
    padding: "6px 10px",
    cursor: "pointer",
  };

  const renderFilterBar = () => (
    <div style={{ marginBottom: 18 }}>
      <button
        type="button"
        onClick={() => setShowFilters((current) => !current)}
        style={{ ...inputStyle, cursor: "pointer", padding: "10px 16px", marginBottom: showFilters ? 12 : 0 }}
      >
        {showFilters ? "− Hide Filters" : "+ Add Filter"}
      </button>

      {showFilters && (
        <div style={{ ...panel, padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveKeyword("include");
                }
              }}
              placeholder="Include keyword, ticker or headline"
              style={inputStyle}
            />
            {activeSection === "News" && (
              <input
                value={excludedTerm}
                onChange={(event) => setExcludedTerm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveKeyword("exclude");
                  }
                }}
                placeholder="Exclude keyword"
                style={inputStyle}
              />
            )}
            <select value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)} style={inputStyle}>
              {["All sources", ...approvedSources, ...Array.from(new Set<string>(liveNews.map((item) => item.source))).filter((name) => !approvedSources.includes(name))].map((source) => <option key={source}>{source}</option>)}
            </select>
            <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)} style={inputStyle}>
              {["All categories", "Acquisition", "Buyback", "Contract", "Listing", "Delisting", "Compliance", "IPO", "Merger", "Partnership", "Earnings", "Beat", "Miss", "Investigation", "Probe", "FDA", "Approval", "SEC", "Bankruptcy", "Other"].map((category) => <option key={category}>{category}</option>)}
            </select>
          </div>

          {(includeKeywords.length > 0 || excludeKeywords.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              {includeKeywords.map((keyword) => (
                <button
                  key={`include-${keyword}`}
                  type="button"
                  onClick={() => setIncludeKeywords((current) => current.filter((item) => item !== keyword))}
                  style={keywordTagStyle}
                  title="Remove this filter"
                >
                  Include: {keyword} ×
                </button>
              ))}
              {excludeKeywords.map((keyword) => (
                <button
                  key={`exclude-${keyword}`}
                  type="button"
                  onClick={() => setExcludeKeywords((current) => current.filter((item) => item !== keyword))}
                  style={{ ...keywordTagStyle, borderColor: "#ef4444", color: "#fecaca" }}
                  title="Remove this filter"
                >
                  Exclude: {keyword} ×
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <main style={{ minHeight: "100vh", background: "#170a14", color: "white", fontFamily: "Arial, sans-serif" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(210px, 250px) 1fr", minHeight: "100vh" }}>
        <aside style={{ background: "#251225", borderRight: "1px solid #713259", padding: "26px 14px", display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
          <div style={{ padding: "0 14px 24px" }}>
            <div style={{ color: "#f472b6", fontSize: 24, fontWeight: 800 }}>⚡ FlashScope</div>
            <div style={{ color: "#b995ad", marginTop: 6, fontSize: 13 }}>Company intelligence</div>
          </div>
          <nav style={{ display: "grid", gap: 7 }}>
            {navItems.map((item) => (
              <button key={item.name} onClick={() => openSection(item.name)} style={{ border: 0, borderLeft: activeSection === item.name ? "3px solid #f472b6" : "3px solid transparent", background: activeSection === item.name ? "#4a203c" : "transparent", color: activeSection === item.name ? "white" : "#c9afc0", padding: "13px 16px", textAlign: "left", fontSize: 15, cursor: "pointer" }}>
                <span style={{ display: "inline-block", width: 27 }}>{item.icon}</span>{item.name}
              </button>
            ))}
          </nav>
          <div style={{ marginTop: "auto", padding: 14, color: "#9b7b90", fontSize: 12 }}>Live Finviz dashboard<br />Market and stock news</div>
        </aside>

        <div style={{ minWidth: 0 }}>
          <header style={{ minHeight: 70, borderBottom: "1px solid #713259", background: "#251225", padding: "12px clamp(18px, 3vw, 34px)", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <button onClick={handleFetch} disabled={isFetching} style={{ background: "#db2777", color: "white", border: 0, borderRadius: 7, padding: "11px 22px", fontWeight: 700, cursor: "pointer" }}>{isFetching ? "Fetching..." : "Fetch"}</button>
            <select value={refreshInterval} onChange={(event) => setRefreshInterval(event.target.value)} style={inputStyle}><option>1 minute</option><option>5 minutes</option><option>15 minutes</option></select>
            <button onClick={() => setAutoFetch((value) => !value)} style={{ ...inputStyle, cursor: "pointer", background: autoFetch ? "#6b2352" : "#210f1c" }}>Auto {autoFetch ? "On" : "Off"}</button>
            <span style={{ marginLeft: "auto", color: "#d8b4c8", fontSize: 14 }}>● {stocks.length} matching stocks</span>
          </header>

          <div style={{ padding: "clamp(20px, 3vw, 36px)", maxWidth: 1300, margin: "0 auto" }}>
            <div style={{ marginBottom: 24 }}>
              {activeSection !== "Settings" && <p style={{ margin: 0, color: "#f472b6", fontWeight: 700, letterSpacing: 1 }}>COMPANY & REGULATORY EVENTS</p>}
              <h1 style={{ margin: "7px 0", fontSize: 34 }}>{activeSection}</h1>
              {(activeSection !== "Settings" || message.startsWith("Unable")) && <p style={{ margin: 0, color: "#c9afc0" }}>{message}</p>}
              {activeSection !== "Settings" && <p role="status" style={{margin:"6px 0",fontSize:12,color:"#fbcfe8"}}>{activeSection === "Mirror" ? "Mirror uses its own price snapshot · see quote timestamp below" : priceStatus}</p>}
              {activeSection !== "Settings" && lastUpdated && <p style={{ margin: "6px 0 0", color: "#9b7b90", fontSize: 12 }}>Snapshot fetched: <SnapshotAge fetchedAt={lastUpdated} /></p>}
            </div>

            {activeSection === "News" && (
              <section>
                {renderFilterBar()}
                <label style={{ display: "block", marginTop: 12 }}>News history: <select style={inputStyle} value={newsDate} onChange={(event) => { void saveConfig("newsDate", event.target.value); setNewsVisible(100); }}>
                  {["Today", "Previous 3 days", "Previous 7 days", "Previous 3 months", "Any"].map((value) => <option key={value}>{value}</option>)}
                </select></label>
                <div style={{ ...panel, marginTop: 18, overflow: "hidden" }}>
                  <div style={{ padding: "16px 18px", borderBottom: "1px solid #713259", display: "flex", justifyContent: "space-between" }}><strong>Direct Source News — {newsDate}</strong><span style={{ color: "#c9afc0" }}>{filteredNews.length} articles</span></div>
                  {enabledNewsSources?.length === 0 ? <p style={{ padding: 20 }}>Enable a source in Settings → Sources to show news.</p> : liveNews.length === 0 ? <p style={{ padding: 20 }}>Press Fetch to load the direct-source news feed.</p> : filteredNews.length === 0 ? <p style={{ padding: 20 }}>No live articles match the approved sources and current filters.</p> : filteredNews.slice(0, newsVisible).map((item, index) => (
                    <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noopener noreferrer" style={{ display: "grid", gridTemplateColumns: "160px 170px 180px minmax(300px, 1fr) 110px", gap: 12, alignItems: "center", padding: "15px 18px", borderBottom: "1px solid #592343", color: "white", textDecoration: "none" }}>
                      <span style={{ color: "#b995ad", fontSize: 13 }}>{formatNewsDate(item.date, item.source)}</span>
                      <span style={{ color: "#fbcfe8", fontWeight: 700, overflowWrap:"anywhere" }}>{item.ticker}</span>
                      <span style={{ color: "#f9a8d4", fontWeight: 700 }}>{item.source}</span>
                      <span><strong>{item.headline}</strong><br /><span style={{ color: "#c9afc0", fontSize: 12 }}>Open article ↗</span></span>
                      <span style={{ color: "#f472b6", textAlign: "right" }}>{item.category}</span>
                    </a>
                  ))}
                  {filteredNews.length > newsVisible && <button style={{ ...inputStyle, margin: 18 }} onClick={() => setNewsVisible((count) => count + 100)}>Show 100 more ({filteredNews.length - newsVisible} remaining)</button>}
                  {newsVisible > 100 && <button type="button" style={{...inputStyle, margin: 18, cursor: "pointer"}} onClick={() => { setNewsVisible(100); }}>Show less</button>}
                </div>
              </section>
            )}

            {activeSection === "Social" && (
              <section>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 18,
                  }}
                >
                  <p style={{ margin: 0, color: "#c9afc0" }}>{socialMessage}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <select aria-label="Social post history" value={socialDays} onChange={(event) => setSocialDays(event.target.value)} style={inputStyle}>
                      {[["1", "Last 24 hours"], ["3", "Last 3 days"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 3 months (90 days)"], ["0", "All saved posts"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <input aria-label="Search social posts" placeholder="Search ticker, keyword or author"
                      value={socialSearch} onChange={(event) => setSocialSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSocialPosts(); } }} style={inputStyle} />
                    <select aria-label="Filter social sentiment" value={socialSentiment}
                      onChange={(event) => setSocialSentiment(event.target.value)} style={inputStyle}>
                      {["All sentiments", "Bullish", "Bearish", "Neutral"].map((value) => <option key={value}>{value}</option>)}
                    </select>
                    <select
                      value={selectedSocialPlatform}
                      onChange={(event) => setSelectedSocialPlatform(event.target.value)}
                      style={inputStyle}
                    >
                      <option>All platforms</option>
                      {visibleSocialPlatforms.map((name) => <option key={name}>{name}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => void loadSocialPosts()}
                      disabled={isLoadingSocial}
                      style={{ ...inputStyle, cursor: "pointer" }}
                    >
                      {isLoadingSocial ? "Loading..." : "Reload Social"}
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 14,
                    marginBottom: 18,
                  }}
                >
                  {visibleSocialPlatforms.map((platform) => {
                    if (platform === "Reddit") return (
                      <a key={platform}
                        href="https://www.reddit.com/r/pennystocks+wallstreetbets+stocks+StockMarket+Daytrading/new/"
                        target="_blank" rel="noopener noreferrer"
                        style={{ ...panel, padding: 18, textAlign: "left", color: "white", textDecoration: "none", display: "block" }}>
                        <strong style={{ color: "#f9a8d4", fontSize: 17 }}>Open Reddit ↗</strong>
                        <div style={{ marginTop: 7, color: "#c9afc0" }}>Browse five subreddits</div>
                      </a>
                    );
                    const count = socialPosts.filter((post) => post.platform === platform).length;
                    const active = selectedSocialPlatform === platform;
                    return (
                      <button
                        key={platform}
                        type="button"
                        onClick={() => setSelectedSocialPlatform(active ? "All platforms" : platform)}
                        style={{
                          ...panel,
                          padding: 18,
                          textAlign: "left",
                          color: "white",
                          cursor: "pointer",
                          borderColor: active ? "#f472b6" : "#713259",
                        }}
                      >
                        <strong style={{ color: "#f9a8d4", fontSize: 17 }}>{platform}</strong>
                        <div style={{ marginTop: 7, color: "#c9afc0" }}>
                          {count} stored {count === 1 ? "post" : "posts"}
                          {platform === "X" && <div style={{ marginTop: 5 }}>50 selected links below</div>}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {visibleSocialPlatforms.includes("X") && (selectedSocialPlatform === "All platforms" || selectedSocialPlatform === "X") && (
                  <SelectedXPosts search={socialSearch} sentiment={socialSentiment} keywords={enabledFeedKeywords} />
                )}

                <div style={{ ...panel, overflow: "hidden" }}>
                  <div
                    style={{
                      padding: "16px 18px",
                      borderBottom: "1px solid #713259",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <strong>{selectedSocialPlatform} Social Feed</strong>
                    <span style={{ color: "#c9afc0" }}>{filteredSocialPosts.length} posts</span>
                  </div>

                  {filteredSocialPosts.length === 0 ? (
                    <div style={{ padding: 28, textAlign: "center" }}>
                      <p style={{ marginTop: 0, fontWeight: 700 }}>No posts match the current filters.</p>
                      <p style={{ marginBottom: 0, color: "#c9afc0" }}>
                        Try another search or platform. If no posts are stored, start the social worker and reload. Search covers saved posts in the selected history period.
                      </p>
                    </div>
                  ) : (
                    filteredSocialPosts.map((post) => {
                      const sentimentColor =
                        post.sentiment === "Bullish"
                          ? "#4ade80"
                          : post.sentiment === "Bearish"
                            ? "#f87171"
                            : "#f9a8d4";
                      return (
                        <article
                          key={post.id}
                          style={{ padding: 18, borderBottom: "1px solid #592343" }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: 10,
                              marginBottom: 10,
                            }}
                          >
                            <strong style={{ color: "#f472b6" }}>{post.platform}</strong>
                            <span style={{ color: "#c9afc0" }}>@{post.username}</span>
                            {post.ticker !== "N/A" && (
                              <span style={keywordTagStyle}>${post.ticker}</span>
                            )}
                            <span style={{ marginLeft: "auto", color: sentimentColor, fontWeight: 700 }}>
                              {post.sentiment}
                            </span>
                          </div>
                          <p style={{ margin: "0 0 10px", lineHeight: 1.5 }}>{post.body}</p>
                          <small style={{ color: "#9b7b90" }}>
                            {new Date(post.publishedAt).toLocaleString()}
                            {post.url && (
                              <>
                                {" · "}
                                <a
                                  href={post.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: "#f9a8d4" }}
                                >
                                  Open post ↗
                                </a>
                              </>
                            )}
                          </small>
                        </article>
                      );
                    })
                  )}
                  {socialHasMore && <button disabled={isLoadingSocial} style={{ ...inputStyle, margin: 18, cursor: "pointer" }} onClick={() => void loadSocialPosts(socialOffset + 100)}>{isLoadingSocial ? "Loading…" : "Show older posts"}</button>}
                  {socialOffset > 0 && <button type="button" style={{...inputStyle, margin: 18, cursor: "pointer"}} onClick={() => { void loadSocialPosts(0); }}>Show less</button>}
                </div>
              </section>
            )}

            {activeSection === "Screener" && (
              <section>
                <div style={{...panel, padding: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center"}}>
                  <input aria-label="Search screener stocks" placeholder="Search ticker, company or sector" value={screenerSearch} onChange={event => setScreenerSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} style={{...inputStyle, flex: "1 1 240px"}} />
                  {screenerSearch && <button type="button" style={inputStyle} onClick={() => setScreenerSearch("")}>Clear search</button>}
                  <label>Sort <select aria-label="Sort screener stocks" value={screenerSort} onChange={event => setScreenerSort(event.target.value)} style={inputStyle}>
                    <option value="ticker">Ticker A–Z</option><option value="gainers">Biggest gainers</option><option value="decliners">Biggest decliners</option>
                  </select></label>
                </div>
                <CollectionInfo windowMinutes={rollingWindow} status={countStatus} />
                <div style={{ overflowX: "auto", marginTop: 18 }}>
                  <table className="screener-table" style={{ width: "100%", borderCollapse: "collapse", ...panel }}>
                    <colgroup>{[8,24,11,9,10,10,8,9,11].map((width,i)=><col key={i} style={{width:`${width}%`}} />)}</colgroup><thead><tr style={{ background: "#4a203c" }}>{["Ticker", "Company / Sector", "Mkt Cap", "Price", "Change", "Volume", "Rel Vol", "Msgs", "Msgs/min"].map((heading) => <th key={heading} style={th} aria-sort={heading === "Change" ? (screenerSort === "decliners" ? "ascending" : screenerSort === "gainers" ? "descending" : "none") : undefined}>{heading === "Change" ? <button type="button" style={{background:"none",border:0,color:"inherit",font:"inherit",cursor:"pointer"}} onClick={() => setScreenerSort(value => value === "decliners" ? "gainers" : value === "gainers" ? "ticker" : "decliners")}>Change{screenerSort === "decliners" ? " ↑" : screenerSort === "gainers" ? " ↓" : ""}</button> : heading}</th>)}</tr></thead>
                    <tbody>{screenerMatches.length === 0 ? <tr><td colSpan={9} style={{ ...td, textAlign: "center", color: "#c9afc0" }}>{stocks.length === 0 ? "Press Fetch to load live screener results." : "No live stocks match your search."}</td></tr> : screenerMatches.slice(0, screenerStocksVisible).map((stock) => (
                      <tr key={stock.ticker} onClick={() => openSection("Charts", stock.ticker)} style={{ cursor: "pointer" }}>
                        <td style={{ ...td, color: "#f9a8d4", fontWeight: 700 }}>{stock.ticker}</td><td style={td} title={stock.company}><span className="company-name">{stock.company}</span><small className="company-sector">{stock.sector}</small></td><td style={td}>{formatMarketCap(stock.marketCap)}</td><td style={td}>${stock.price.toFixed(2)}</td><td style={{ ...td, color: stock.change >= 0 ? "#4ade80" : "#f87171", fontWeight: 700 }}>{stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%</td><td style={td} title={Number(stock.volume).toLocaleString()}>{formatVolume(stock.volume)}</td><td style={td}>{stock.relativeVolume === null ? "N/A" : stock.relativeVolume.toFixed(1)}</td><td style={td}>{stock.messageCount}</td><td style={{ ...td, color: "#f9a8d4", fontWeight: 700 }}>{(stock.messageCount / Number(rollingWindow)).toFixed(2)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div style={{display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginTop: 12}}>
                  <span style={{color: "#c9afc0"}}>Showing {Math.min(screenerStocksVisible, screenerMatches.length)} of {screenerMatches.length} matching stocks</span>
                  {screenerMatches.length > screenerStocksVisible && <button type="button" aria-label="Load more screener stocks" style={{...inputStyle, cursor: "pointer"}} onClick={() => setScreenerStocksVisible(count => count + 10)}>Load more ({screenerMatches.length - screenerStocksVisible} remaining)</button>}
                  {screenerStocksVisible > 10 && <button type="button" style={{...inputStyle, margin: 18, cursor: "pointer"}} onClick={() => { setScreenerStocksVisible(10); }}>Show less</button>}
                </div>
              </section>
            )}

            {activeSection === "Charts" && (
              filteredStocks.length === 0 ? <section role="status" style={{ ...panel, padding: 24 }}>{!configLoaded || isFetching ? "Loading chart stocks…" : "No stocks match the current Config filters."}</section> :
              <section>
                {stocks.length === 0 ? (
                  <div
                    style={{
                      ...panel,
                      padding: 28,
                      color: "#c9afc0",
                      textAlign: "center",
                    }}
                  >
                    Press Fetch to load live stock chart data.
                  </div>
                ) : (
                  <>
                <div style={{...panel, padding: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center"}}>
                  <input aria-label="Search chart stocks" placeholder="Search ticker, company or sector" value={chartSearch} onChange={event => setChartSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); const query = chartSearch.trim().replace(/^\$/, "").toUpperCase(); const match = chartMatches.find(stock => stock.ticker.toUpperCase() === query) ?? chartMatches[0]; if (match) setSelectedTicker(match.ticker); } }} style={{...inputStyle, flex: "1 1 240px"}} />
                  {chartSearch && <button type="button" style={inputStyle} onClick={() => setChartSearch("")}>Clear search</button>}
                  <label>Sort <select aria-label="Sort chart stocks" value={chartSort} onChange={event => setChartSort(event.target.value)} style={inputStyle}>
                    <option value="ticker">Ticker A–Z</option><option value="gainers">Biggest gainers</option><option value="decliners">Biggest decliners</option>
                  </select></label>
                </div>
                <div
                  style={{display: "flex",flexWrap: "wrap",gap: 10,marginBottom: 18,}}
                >
                  {chartMatches.length === 0 && <span style={{color: "#c9afc0"}}>{!chartSearch.trim() && chartSort === "gainers" ? "No gainers match the current filters." : "No stocks match your search."}</span>}
                  {chartMatches.slice(0, chartStocksVisible).map(
                    (stock) => (
                      <button
                        key={stock.ticker}
                        onClick={() => setSelectedTicker(stock.ticker)}
                        style={{
                          ...inputStyle,
                          cursor: "pointer",
                          borderColor:
                            chartTicker === stock.ticker ? "#f472b6" : "#713259",
                        }}
                      >
                        {stock.ticker}
                      </button>
                    )
                  )}
                </div>

                <div style={{display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 18}}>
                  <span style={{color: "#c9afc0"}}>Showing {Math.min(chartStocksVisible, chartMatches.length)} of {chartMatches.length} matching stocks</span>
                  {chartMatches.length > chartStocksVisible && <button type="button" aria-label="Load more chart stocks" style={{...inputStyle, cursor: "pointer"}} onClick={() => setChartStocksVisible(count => count + CHART_STOCK_PAGE_SIZE)}>Load more ({chartMatches.length - chartStocksVisible} remaining)</button>}
                  {chartStocksVisible > CHART_STOCK_PAGE_SIZE && <button type="button" style={{...inputStyle, margin: 18, cursor: "pointer"}} onClick={() => setChartStocksVisible(CHART_STOCK_PAGE_SIZE)}>Show less</button>}
                </div>
                {chartStock && <div style={{ display: "grid", gap: 18 }}>
                  <div
                    style={{
                      ...panel,
                      padding: 22,
                      minHeight: 690,
                      overflow: "hidden",
                    }}
                  >
                    <p
                      style={{
                        color: "#f472b6",
                        fontWeight: 700,
                        marginTop: 0,
                        marginBottom: 6,
                      }}
                    >
                      SELECTED STOCK
                    </p>

                    <h2 style={{ margin: "0 0 6px" }}>
                      {selectedStock.ticker} — {selectedStock.company}
                    </h2>

                    <p style={{ marginTop: 0, marginBottom: 18, fontSize: 20 }}>
                      ${selectedStock.price.toFixed(2)}{" "}
                      <span
                        style={{
                          color: selectedStock.change >= 0 ? "#4ade80" : "#f87171",
                          fontWeight: 700,
                        }}
                      >
                        {selectedStock.change >= 0 ? "+" : ""}
                        {selectedStock.change.toFixed(2)}%
                      </span>
                    </p>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(150px, 1fr))",
                        gap: 12,
                        marginBottom: 20,
                      }}
                    >
                      <div
                        style={{
                          background: "#210f1c",
                          border: "1px solid #713259",
                          borderRadius: 8,
                          padding: 14,
                        }}
                      >
                        <small style={{ color: "#9b7b90" }}>TICKER</small>
                        <p style={{ margin: "6px 0 0", fontWeight: 700 }}>
                          {selectedStock.ticker}
                        </p>
                      </div>

                      <div
                        style={{
                          background: "#210f1c",
                            border: "1px solid #713259",
                            borderRadius: 8,
                            padding: 14,
                        }}
                      >
                        <small style={{ color: "#9b7b90" }}>SECTOR</small>
                        <p style={{ margin: "6px 0 0", fontWeight: 700 }}>
                          {selectedStock.sector || "N/A"}
                        </p>
                      </div>

                      <div
                        style={{
                          background: "#210f1c",
                          border: "1px solid #713259",
                          borderRadius: 8,
                          padding: 14,
                        }}
                      >
                        <small style={{ color: "#9b7b90" }}>MARKET CAP</small>
                        <p style={{ margin: "6px 0 0", fontWeight: 700 }}>
                          {formatMarketCap(selectedStock.marketCap)}
                        </p>
                      </div>

                      <div
                        style={{
                          background: "#210f1c",
                          border: "1px solid #713259",
                          borderRadius: 8,
                          padding: 14,
                        }}
                      >
                        <small style={{ color: "#9b7b90" }}>VOLUME</small>
                        <p style={{ margin: "6px 0 0", fontWeight: 700 }}>
                          {formatVolume(selectedStock.volume)}
                        </p>
                      </div>
                    </div>

                    <TradingViewChart ticker={selectedStock.ticker} />
                  </div>

                  <div style={{ ...panel, padding: 22 }}>
                    <h2 style={{ marginTop: 0 }}>Social Chatter</h2>
                    {chartPosts.ticker !== selectedStock.ticker || (chartPosts.loading && !chartPosts.posts.length) ? <p role="status" style={{ color: "#c9afc0" }}>Loading Stocktwits posts for {selectedStock.ticker}…</p> : !chartPosts.posts.length && !chartPosts.error ? (
                      <p style={{ color: "#c9afc0" }}>No saved Stocktwits posts for this ticker yet.</p>
                    ) : (
                      chartPosts.posts.map((post) => (
                        <article key={post.id} style={{ padding: "12px 0", borderBottom: "1px solid #713259" }}>
                          <span style={{ color: post.sentiment === "Bullish" ? "#4ade80" : post.sentiment === "Bearish" ? "#f87171" : "#c9afc0", fontSize: 12, fontWeight: 700 }}>
                            {post.platform} · {post.sentiment}
                          </span>
                          <p style={{ margin: "6px 0", overflowWrap: "anywhere" }}>
                            {post.url ? <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ color: "white" }}>{decodeSocialText(post.body).slice(0, 240)}</a> : decodeSocialText(post.body).slice(0, 240)}
                          </p>
                          <small style={{ color: "#b995ad" }}>{post.username} · {new Date(post.publishedAt).toLocaleString()}</small>
                        </article>
                      ))
                    )}
                    {chartPosts.ticker === selectedStock.ticker && chartPosts.error && <p role="alert">{chartPosts.error}</p>}
                    {chartPosts.ticker === selectedStock.ticker && (chartPosts.hasMore || chartPosts.error) && (
                      <button type="button" aria-label={chartPosts.error ? "Retry loading Stocktwits posts" : "Load more Stocktwits posts"} disabled={chartPosts.loading}
                        style={{...inputStyle, marginTop:12}} onClick={() => void loadChartPosts(chartPosts.offset)}>
                        {chartPosts.loading ? "Loading…" : chartPosts.error ? "Retry" : "Load more"}
                      </button>
                    )}
                  </div>

                  <div style={{ ...panel, padding: 22 }}>
                    <h2 style={{ marginTop: 0 }}>Related News</h2>

                    {stocks.length > 0 ? (
                      selectedStockNews.length === 0 ? (
                        <p style={{ color: "#c9afc0" }}>
                          No recent Finviz headline mentions this ticker or company.
                        </p>
                      ) : (
                        selectedStockNews.slice(0, chartNewsVisible).map((item, index) => (
                          <article
                            key={`${item.url}-${index}`}
                            style={{
                              padding: "14px 0",
                              borderBottom: "1px solid #713259",
                            }}
                          >
                            <span
                              style={{
                                color: "#f472b6",
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                            >
                              {item.category}
                            </span>

                            <p>
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: "white" }}
                              >
                                {item.headline}
                              </a>
                            </p>

                            <small style={{ color: "#b995ad" }}>
                              {item.source} ·{" "}
                              {formatNewsDate(item.date, item.source)}
                            </small>
                          </article>
                        ))
                      )
                    ) : (
                      displayedNews.slice(0, chartNewsVisible).map((item, index) => (
                        <article
                          key={index}
                          style={{
                            padding: "14px 0",
                            borderBottom: "1px solid #713259",
                          }}
                        >
                          <span
                            style={{
                              color: item.verified ? "#f472b6" : "#c9afc0",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            {item.verified ? "VERIFIED" : "UNVERIFIED"} ·{" "}
                            {item.category}
                          </span>

                          <p>{item.headline}</p>

                          <small style={{ color: "#b995ad" }}>
                            {item.source} · {item.time}
                          </small>
                        </article>
                      ))
                    )}
                    {(stocks.length > 0 ? selectedStockNews.length : displayedNews.length) > chartNewsVisible && (
                      <button type="button" aria-label="Load more related news" style={{...inputStyle, marginTop:12}}
                        onClick={() => setChartNewsVisible(count => count + CHART_FEED_PAGE_SIZE)}>Load more</button>
                    )}
                  </div>
                </div>}
                  </>
                )}
              </section>
            )}

{activeSection === "Momentum" && (
  <section>
    <div
      style={{
        ...panel,
        padding: 16,
        marginBottom: 18,
        color: "#4ade80",
        fontWeight: 700,
      }}
    >
      ● Live Finviz Momentum Scanner
      <div role="group" aria-label="Momentum ranking" style={{display: "flex", gap: 8, marginTop: 12}}>
        {(["gainers", "decliners"] as const).map((mode) => <button key={mode} type="button"
          aria-pressed={momentumMode === mode} onClick={() => setMomentumMode(mode)}
          style={{...inputStyle, cursor: "pointer", background: momentumMode === mode ? "#6b2352" : "#210f1c", borderColor: momentumMode === mode ? "#f472b6" : "#713259"}}>
          {mode === "gainers" ? "Gainers" : "Decliners"}
        </button>)}
      </div>
    </div>
    {momentumStocks.length === 0 && <p role="status" style={{...panel, padding: 18}}>
      No {momentumMode} match the current Config filters. Check the Change filter in Settings; choose Any to include both directions.
    </p>}

    <div
      style={{
        ...panel,
        padding: 16,
        marginBottom: 18,
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span style={{ color: "#b995ad" }}>
        MIN VOL: <strong style={{ color: "white" }}>{currentVolume}</strong>
      </span>

      <span style={{ color: "#b995ad" }}>
        REL VOL: <strong style={{ color: "white" }}>{relativeVolume}</strong>
      </span>

      <span style={{ color: "#b995ad" }}>
        CHANGE: <strong style={{ color: "white" }}>{changeLabel(priceChange)}</strong>
      </span>

      <span style={{ color: "#b995ad" }}>
        TOP: <strong style={{ color: "white" }}>10</strong>
      </span>
    </div>

    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        marginBottom: 18,
      }}
    >
      {momentumStocks
        .map((stock) => (
          <button
            key={stock.ticker}
            onClick={() => openSection("Charts", stock.ticker)}
            style={{
              ...inputStyle,
              minWidth: 95,
              padding: "10px 14px",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <strong style={{ color: "#f9a8d4" }}>{stock.ticker}</strong>
            <br />
            <span
              style={{
                color: stock.change >= 0 ? "#4ade80" : "#fb7185",
                fontWeight: 700,
              }}
            >
              {stock.change >= 0 ? "+" : ""}
              {stock.change.toFixed(2)}%
            </span>
          </button>
        ))}
    </div>

    <div
      style={{
        ...panel,
        padding: 18,
        marginBottom: 18,
        color: "#c9afc0",
      }}
    >
      <span>Click a stock to open its chart.</span>
      <CollectionInfo windowMinutes={rollingWindow} status={countStatus} />
    </div>

    <div style={{ display: "grid", gap: 12 }}>
      {momentumStocks
        .map((stock, index) => (
          <button
            key={stock.ticker}
            onClick={() => openSection("Charts", stock.ticker)}
            style={{
              ...panel,
              padding: 20,
              display: "grid",
              gridTemplateColumns:
                "45px minmax(180px, 1fr) repeat(5, minmax(90px, 120px)) 30px",
              gap: 16,
              alignItems: "center",
              color: "white",
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "#6b2352",
                display: "grid",
                placeItems: "center",
                color: "#f9a8d4",
              }}
            >
              {index + 1}
            </span>

            <span>
              <strong style={{ color: "#f9a8d4", fontSize: 18 }}>
                {stock.ticker}
              </strong>
              <br />
              <small style={{ color: "#b995ad" }}>{stock.company}</small>
            </span>

            <span>
              <small style={{ color: "#9b7b90" }}>PRICE</small>
              <br />
              <strong>${stock.price.toFixed(2)}</strong>
            </span>

            <span>
              <small style={{ color: "#9b7b90" }}>CHANGE</small>
              <br />
              <strong
                style={{
                  color: stock.change >= 0 ? "#4ade80" : "#fb7185",
                }}
              >
                {stock.change >= 0 ? "+" : ""}
                {stock.change.toFixed(2)}%
              </strong>
            </span>

            <span>
              <small style={{ color: "#9b7b90" }}>VOLUME</small>
              <br />
              <strong>
                {formatVolume(stock.volume)}
              </strong>
            </span>

            <span>
              <small style={{ color: "#9b7b90" }}>MESSAGES</small>
              <br />
              <strong>{stock.messageCount}</strong>
            </span>

            <span>
              <small style={{ color: "#9b7b90" }}>DENSITY</small>
              <br />
              <strong style={{ color: "#f9a8d4" }}>
                {(stock.messageCount / Number(rollingWindow)).toFixed(2)}/min
              </strong>
            </span>

            <span style={{ color: "#f472b6", fontSize: 20 }}>›</span>
          </button>
        ))}
    </div>
  </section>
)}

            {activeSection === "Mirror" && <><p role="status">{mirrorStatus}</p><CorrelationPanel rankingKey={mirrorRankingKey} stocks={mirrorStocks} verifiedOnly={mirrorConfig.verifiedOnly} rollingWindow={mirrorConfig.rollingWindow} newsDate={mirrorConfig.newsDate} priceChange={mirrorConfig.priceChange} onPriceChange={(value) => setMirrorConfig(config => ({...config, priceChange:value}))} onReset={() => {setMirrorConfig(DEFAULT_MIRROR_CONFIG);setMirrorAutoFetch(true);}} configControls={<div style={{width: "100%", borderTop: "1px solid #713259", paddingTop: 12}}>
                <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12}}>
                  {([
                    ["Market capitalization", "marketCap", mirrorConfig.marketCap],
                    ["Relative volume", "relativeVolume", mirrorConfig.relativeVolume],
                    ["Current volume", "currentVolume", mirrorConfig.currentVolume],
                    ["Rolling window", "rollingWindow", mirrorConfig.rollingWindow],
                    ["News date", "newsDate", mirrorConfig.newsDate],
                  ] as const).map(([label, key, value]) => <label key={key} style={{color: "#c9afc0", fontSize: 14}}>{label}
                    <select aria-label={label} value={value} onChange={event => setMirrorConfig(config => ({...config, [key]:event.target.value}))} style={{...inputStyle, display: "block", width: "100%", marginTop: 7}}>
                      {CONFIG_OPTIONS[key].map(option => <option key={option} value={option}>{key === "rollingWindow" ? `${option} minutes` : option}</option>)}
                    </select>
                  </label>)}
                </div>
                <div style={{display: "flex", flexWrap: "wrap", gap: 18, marginTop: 12, color: "#c9afc0", fontSize: 14}}>
                  <label><input type="checkbox" checked={mirrorConfig.verifiedOnly} onChange={event => setMirrorConfig(config => ({...config, verifiedOnly:event.target.checked}))} /> Ticker-linked news only</label>
                  <label><input type="checkbox" checked={mirrorAutoFetch} onChange={event => setMirrorAutoFetch(event.target.checked)} /> Enable automatic fetching</label>
                </div>
              </div>} /></>}

            {activeSection === "Settings" && (
              <SettingsPanel
                keywordControls={<div style={{marginBottom: 20}}>
                  <label style={{display: "block", color: "#fbcfe8"}}><input type="checkbox" checked={applyNewsKeywords} onChange={event => { void saveConfig("applyNewsKeywords", event.target.checked); setNewsVisible(100); }} /> Apply Settings keywords</label>
                </div>}
                onSettingsChange={() => { void loadResults(); }}
                config={(
                  <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 18 }}>
                  {[
                    ["Rolling window", rollingWindow, (value: string) => void saveConfig("rollingWindow", value), ["15", "30", "60"]],
                    ["Market capitalization", marketCap, (value: string) => void saveConfig("marketCap", value), ["Nano (under $50M)", "Micro (under $300M)", "Small (under $2B)", "Any"]],
                    ["Relative volume", relativeVolume, (value: string) => void saveConfig("relativeVolume", value), ["Over 5", "Over 3", "Over 2", "Any"]],
                    ["Current volume", currentVolume, (value: string) => void saveConfig("currentVolume", value), ["Over 100K", "Over 500K", "Over 1M", "Any"]],
                    ["News date", newsDate, (value: string) => void saveConfig("newsDate", value), ["Today", "Previous 3 days", "Previous 7 days", "Previous 3 months", "Any"]],
                  ].map(([label, value, setter, options]) => (
                    <label key={label as string}>{label as string}<select value={value as string} onChange={(event) => (setter as (value: string) => void)(event.target.value)} style={{ ...inputStyle, display: "block", width: "100%", marginTop: 7 }}>{(options as string[]).map((option) => <option key={option} value={option}>{label === "Rolling window" ? `${option} minutes` : option}</option>)}</select></label>
                  ))}
                  <ChangeFilter value={priceChange} onChange={value => void saveConfig("priceChange", value)} />
                </div>
                <label style={{ display: "block", marginTop: 24 }}><input type="checkbox" checked={verifiedOnly} onChange={(event) => void saveConfig("verifiedOnly", event.target.checked)} /> Ticker-linked news only</label>
                <label style={{ display: "block", marginTop: 13 }}><input type="checkbox" checked={autoFetch} onChange={(event) => setAutoFetch(event.target.checked)} /> Enable automatic fetching</label>
              </div>
                )}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
