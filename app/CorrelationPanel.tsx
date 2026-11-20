"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { fieldValue, pick } from "@/lib/quote-format";
import SnapshotAge from "./SnapshotAge";
import MirrorStocktwits from "./MirrorStocktwits";
import ChangeFilter from "./ChangeFilter";
import TradingViewChart from "./TradingViewChart";
import MirrorSocialMetrics from "./MirrorSocialMetrics";

type Row = {
  ticker: string; events: number; news: number; newsTotal?: number; social: number;
  avgSentiment: number; avgReturn: number; correlation: number | null;
  newsCorrelation: number | null; socialCorrelation: number | null;
  hitRate: number | null; lastPrice: number | null; lowSample: boolean;
};

type Payload = {
  days: number;
  horizonMinutes: number;
  overall: { events: number; correlation: number | null; hitRate: number | null };
  rows: Row[];
  mirror: { totalEvents: number; pricedEvents: number; tickers: number; snapshots: number; lastSnapshotAt: string | null };
  diagnostics?: { observationTimes: number; firstSnapshotAt: string | null; lastSnapshotAt: string | null; noTickerHistory: number; noBaseline: number; waitingAfter: number; missingAfter: number };
  sync?: { newsRows: number; socialRows: number; priced: number };
  error?: string;
};

type MirrorEvent = {
  ticker: string; kind: string; source: string; author: string | null; text: string; url: string | null;
  category: string; sentiment: number; published_at: string;
  price_at_event: number | null; price_after: number | null; return_pct: number | null;
};

type Quote = Record<string, string>;

const panel: CSSProperties = { background: "#35172d", border: "1px solid #713259", borderRadius: 12 };
const inputStyle: CSSProperties = { background: "#210f1c", color: "white", border: "1px solid #713259", borderRadius: 7, padding: "9px 11px" };
const th: CSSProperties = { padding: "11px 13px", textAlign: "left", color: "#fbcfe8", borderBottom: "1px solid #713259", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "11px 13px", borderBottom: "1px solid #592343", whiteSpace: "nowrap" };

const TIMEFRAMES = [["1m","1"],["3m","3"],["5m","5"],["15m","15"],["30m","30"],["1h","60"],["D","D"],["W","W"],["M","M"]] as const;
const HISTORY = [["1", "Last 24 hours"], ["3", "Last 3 days"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 3 months (90 days)"]];
const REFRESH: [string, number][] = [["10s", 10], ["1min", 60], ["Off", 0]];

/* Left and right column of the mirror panel. Each label lists the Finviz export header names it may appear under. */
const LEFT: [string, string[]][] = [
  ["Ticker", ["Ticker"]],
  ["Company", ["Company"]],
  ["Country", ["Country"]],
  ["Industry", ["Industry"]],
  ["Market Cap", ["Market Cap"]],
  ["P/E", ["P/E"]],
  ["Forward P/E", ["Forward P/E"]],
  ["PEG", ["PEG"]],
  ["P/S", ["P/S"]],
  ["P/B", ["P/B"]],
  ["Dividend", ["Dividend Yield", "Dividend"]],
  ["Insider Own", ["Insider Ownership", "Insider Own"]],
  ["Insider Trans", ["Insider Transactions", "Insider Trans"]],
  ["Short Float", ["Short Float", "Float Short"]],
  ["Analyst Recom", ["Analyst Recom", "Analyst Recom."]],
  ["Avg Volume", ["Average Volume", "Avg Volume"]],
];
const RIGHT: [string, string[]][] = [
  ["EPS (TTM)", ["EPS (ttm)", "EPS"]],
  ["EPS this Y", ["EPS growth this year", "EPS this Y"]],
  ["EPS next Y", ["EPS growth next year", "EPS next Y"]],
  ["EPS past 5Y", ["EPS growth past 5 years", "EPS past 5Y"]],
  ["EPS next 5Y", ["EPS growth next 5 years", "EPS next 5Y"]],
  ["EPS Q/Q", ["EPS growth quarter over quarter", "EPS Q/Q"]],
  ["Sales Q/Q", ["Sales growth quarter over quarter", "Sales Q/Q"]],
  ["Inst Own", ["Institutional Ownership", "Inst Own"]],
  ["Inst Trans", ["Institutional Transactions", "Inst Trans"]],
  ["Earnings", ["Earnings Date", "Earnings"]],
  ["Target Price", ["Target Price"]],
  ["52W Range", ["52-Week Range", "52W Range"]],
  ["Price", ["Price"]],
  ["Change", ["Change"]],
  ["Rel Volume", ["Relative Volume", "Rel Volume"]],
  ["Volume", ["Volume"]],
];
const SIGNED = new Set(["EPS this Y", "EPS next Y", "EPS past 5Y", "EPS next 5Y", "EPS Q/Q", "Sales Q/Q", "Change", "Insider Trans", "Inst Trans"]);
const LINKS = new Set(["Company", "Country", "Industry"]);

const fixed = (value: number | null, digits = 2) => (value === null ? "-" : value.toFixed(digits));
const pct = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
const sentimentLabel = (value: number) => (value > 0 ? "Bullish" : value < 0 ? "Bearish" : "Neutral");
const sentimentColor = (value: number) => (value > 0 ? "#86efac" : value < 0 ? "#fda4af" : "#d8b4c8");

function corrColor(value: number | null) {
  if (value === null) return "#9b7b90";
  if (value >= 0.3) return "#86efac";
  if (value <= -0.3) return "#fda4af";
  return "#fde68a";
}

function signColor(value: string) {
  const text = value.trim();
  if (text.startsWith("-")) return "#fda4af";
  if (/^\+?\d/.test(text) && text !== "0.00%") return "#86efac";
  return "white";
}

/** Finviz style date: Sep-02-26 04:10PM */
function formatEventDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...options }).format(date);
  const time = part({ hour: "2-digit", minute: "2-digit", hour12: true }).replace(/\s/g, "");
  return `${part({ month: "short" })}-${part({ day: "2-digit" })}-${part({ year: "2-digit" })} ${time}`;
}

type MirrorStock = { ticker: string; company: string; sector: string; marketCap: string; price: number; change: number; volume: string };
type Props = { rankingKey: string; stocks: MirrorStock[]; rollingWindow: string; newsDate: string; verifiedOnly: boolean; configControls: ReactNode; priceChange: string; onPriceChange: (value: string) => void; onReset: () => void };
type StockSectionProps = { selected: string; rank?: number; stock?: MirrorStock; timeframe: string; chartView: string; refresh: number; days: string; newsDate: string; verifiedOnly: boolean; rollingWindow: string; revision: number };
const chip = (active: boolean): CSSProperties => ({
  background: active ? "#4a203c" : "transparent", color: active ? "white" : "#c9afc0",
  border: active ? "1px solid #f472b6" : "1px solid transparent",
  borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontSize: 14,
});

function StockSection(props: StockSectionProps) {
  const container = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setNear(true); setVisited(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      setNear(entry.isIntersecting);
      if (entry.isIntersecting) setVisited(true);
    }, {rootMargin:"240px 0px"});
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <article ref={container} id={`mirror-stock-${props.selected}`} tabIndex={-1} aria-label={`${props.selected} chart and news`} style={{marginBottom:24,scrollMarginTop:16,contentVisibility:"auto",containIntrinsicSize:"auto 540px"}}>
    {visited ? <StockContent {...props} near={near} /> :
      <div style={{...panel,minHeight:500,padding:16}}><strong>{props.rank ? `#${props.rank} · ` : ""}{props.selected} · {props.stock?.company}</strong></div>}
  </article>;
}

const MIRROR_NEWS_PAGE_SIZE = 5;

function StockContent({selected,rank,stock,timeframe,chartView,refresh,days,newsDate,verifiedOnly,rollingWindow,revision,near}: StockSectionProps & {near:boolean}) {
  const [quote,setQuote] = useState<Quote|null>(null);
  const [quoteNote,setQuoteNote] = useState("");
  const [quoteWarning,setQuoteWarning] = useState(false);
  const [quoteUpdated,setQuoteUpdated] = useState("");
  const [events,setEvents] = useState<MirrorEvent[]>([]);
  const [eventOffset,setEventOffset] = useState(0);
  const [hasMoreEvents,setHasMoreEvents] = useState(false);
  const [eventsLoading,setEventsLoading] = useState(false);
  const [eventError,setEventError] = useState("");
  const eventRequest = useRef<AbortController|null>(null);
  const quoteRetryAt = useRef(0);
  const loadQuote = useCallback(async (signal:AbortSignal) => {
    if (Date.now() < quoteRetryAt.current) return;
    try {
      const response = await fetch(`/api/quote?ticker=${encodeURIComponent(selected)}`,{cache:"no-store",signal});
      const json = await response.json();
      if (signal.aborted) return;
      quoteRetryAt.current = Date.parse(json.retryAt ?? "") || 0;
      if (!response.ok) throw new Error(json.error ?? "Unable to load the quote.");
      setQuote(json.record);
      setQuoteUpdated(json.fetchedAt || "");
      setQuoteWarning(Boolean(json.stale));
      setQuoteNote(json.stale ? (json.warning || "Stale saved quote · provider unavailable") : json.cached ? "Cached snapshot · provider prices may be delayed" : "New snapshot · provider prices may be delayed");
    } catch (caught) {
      if (!signal.aborted) { setQuoteWarning(true); setQuoteNote(caught instanceof Error ? caught.message : "Unable to load the quote."); }
    }
  }, [selected]);
  const compactStocktwits = chartView !== "tradingview";
  const newsDays = ({"Today":1,"Previous 3 days":3,"Previous 7 days":7,"Previous 3 months":90,"Any":100} as Record<string,number>)[newsDate] ?? 3;
  const loadEvents = useCallback(async (offset=0) => {
    eventRequest.current?.abort();
    const controller = new AbortController();
    eventRequest.current = controller;
    setEventsLoading(true);
    try {
      const response = await fetch(`/api/mirror?kind=news&limit=${MIRROR_NEWS_PAGE_SIZE}&ticker=${encodeURIComponent(selected)}&days=${newsDays}&offset=${offset}${newsDate==="Today"?"&today=1":""}${verifiedOnly?"&linked=1":""}`,{cache:"no-store",signal:controller.signal});
      const json = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(json.error ?? "Unable to load news.");
      setEvents(previous => offset ? [...previous,...(json.results ?? [])] : json.results ?? []);
      setEventOffset(offset);
      setHasMoreEvents(json.hasMore === true);
      setEventError("");
    } catch(caught) {
      if (!controller.signal.aborted) setEventError(caught instanceof Error ? caught.message : "Unable to load news.");
    } finally {
      if (!controller.signal.aborted) setEventsLoading(false);
    }
  },[selected,newsDays,newsDate,verifiedOnly]);
  useEffect(() => {
    setEvents([]); setEventOffset(0); setHasMoreEvents(false); setEventError("");
    void loadEvents();
    return () => eventRequest.current?.abort();
  },[loadEvents,revision]);
  useEffect(() => {
    const controller = new AbortController();
    let pending=false;
    const fetchQuote = async () => {
      if (pending) return;
      pending=true;
      try { await loadQuote(controller.signal); } finally { pending=false; }
    };
    if (near) void fetchQuote();
    const timer=near&&refresh ? setInterval(() => void fetchQuote(),Math.max(refresh,60)*1000) : null;
    return () => { controller.abort(); if(timer) clearInterval(timer); };
  },[near,refresh,loadQuote]);
  useEffect(() => {
    if (!near || !refresh || eventOffset) return;
    const timer=setInterval(() => { if (!eventsLoading) void loadEvents(); },refresh*1000);
    return () => clearInterval(timer);
  },[near,refresh,eventOffset,eventsLoading,loadEvents]);
  const price = quote ? pick(quote,["Price"]) : "";
  const change = quote ? pick(quote,["Change"]) : "";
  const snapshot = price && quoteUpdated ? {at:quoteUpdated,price:Number(price.replace(/[$,]/g,""))} : undefined;
  const mirrorRows = (fields: [string, string[]][]) =>
    fields.map(([label, names]) => {
      const value = quote ? fieldValue(quote, label, names) : "";
      const color = LINKS.has(label) || label === "Ticker" ? "#7dd3fc" : SIGNED.has(label) && value ? signColor(value) : "white";
      return (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 14 }}>
          <span style={{ color: "#b995ad" }}>{label}</span>
          <strong style={{ color, textAlign: "right", fontWeight: 600, overflowWrap: "anywhere" }}>{value || "-"}</strong>
        </div>
      );
    });

  return <>
    <div className="correlation-panels">
      <div style={{...panel,padding:14,minWidth:0,overflow:"hidden"}}>
        <div style={{display:"flex",flexWrap:"wrap",gap:14,alignItems:"baseline",marginBottom:10}}>
          {rank && <small style={{color:"#b995ad"}}>#{rank}</small>}
          <h3 style={{fontSize:30,margin:0,color:"#f9a8d4"}}>{selected}</h3>
          {stock && <span style={{color:"#c9afc0"}}>{stock.company}</span>}
          {(price || (stock && stock.price > 0)) && <span>{price ? `$${price.replace(/^\$/,"")}` : `$${stock!.price.toFixed(2)}`}</span>}
          {change && <strong style={{color:signColor(change)}}>{change}</strong>}
        </div>
        {chartView === "tradingview"
          ? near ? <TradingViewChart ticker={selected} interval={timeframe} height={500} /> : <div style={{height:524}} />
          : <MirrorSocialMetrics key={`${timeframe}:${rollingWindow}`} ticker={selected} refresh={refresh} active={near} interval={timeframe} windowMinutes={Number(rollingWindow)} quoteSnapshot={snapshot} />}
      </div>
      <aside style={{...panel,padding:16,minWidth:0}} aria-label={`${selected} Mirror details`}>
        <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:8}}>
          <strong style={{color:"#fbcfe8"}}>Mirror</strong>
          <small style={{color:"#b995ad",textAlign:"right"}}>{quoteUpdated && <>Quote fetched <SnapshotAge fetchedAt={quoteUpdated} /></>}</small>
        </div>
        {quoteNote && <p role="status" style={{color:quoteWarning?"#fde68a":"#c9afc0",fontSize:13,margin:"0 0 8px"}}>{quoteNote}</p>}
        {!quote&&!quoteNote&&<p role="status">Loading quote…</p>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:"0 18px"}}>
          <div>{mirrorRows(LEFT)}</div><div>{mirrorRows(RIGHT)}</div>
        </div>
      </aside>
    </div>
    <div style={{...panel,padding:compactStocktwits?"10px 14px":"0 16px 14px",marginTop:12}}>
      <MirrorStocktwits key={days} compact={compactStocktwits} ticker={selected} days={days} refresh={near ? refresh : 0} />
    </div>
      <section aria-label={`${selected} news`} style={{ ...panel, padding: "6px 16px", margin: "16px 0 28px" }}>
        <div style={{ padding: "12px 0", color: "#fbcfe8", fontWeight: 700, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <span>{selected || "Selected ticker"} news — {events.length} loaded</span>
        </div>
        {events.length === 0 && !eventsLoading && !eventError && (
          <p style={{ color: "#c9afc0" }}>
            No saved news for {selected || "this ticker"} in this period.
          </p>
        )}
        {events.map((event, index) => (
          <div key={`${event.published_at}-${index}`} style={{ display: "flex", gap: 14, padding: "7px 0", borderBottom: "1px solid #592343", fontSize: 14, flexWrap: "wrap" }}>
            <span style={{ color: "#b995ad", whiteSpace: "nowrap", minWidth: 150 }}>{formatEventDate(event.published_at)}</span>
            <span style={{ flex: "1 1 320px" }}>
              {event.url
                ? <a href={event.url} target="_blank" rel="noreferrer" style={{ color: "#7dd3fc", textDecoration: "none" }}>{event.text.slice(0, 200)}</a>
                : event.text.slice(0, 200)}{" "}
              <span style={{ color: "#9b7b90" }}>({event.source})</span>
            </span>
            <span style={{ color: sentimentColor(event.sentiment), minWidth: 70 }}>{sentimentLabel(event.sentiment)}</span>
            <span style={{ color: event.return_pct === null ? "#b995ad" : event.return_pct >= 0 ? "#86efac" : "#fda4af", minWidth: 70, textAlign: "right" }}>
              {event.return_pct === null ? "No price pair" : `${event.return_pct >= 0 ? "+" : ""}${event.return_pct.toFixed(2)}%`}
            </span>
          </div>
        ))}
        {eventError && <p role="alert" style={{color:"#fda4af"}}>{eventError}</p>}
        {eventsLoading && <p role="status" style={{ color: "#c9afc0", padding: 10 }}>Loading news…</p>}
        {hasMoreEvents && <button type="button" aria-label={`Load more news for ${selected}`} disabled={eventsLoading} style={{ ...inputStyle, margin: "12px 0", cursor: "pointer" }} onClick={() => void loadEvents(eventOffset + MIRROR_NEWS_PAGE_SIZE)}>Load more</button>}
          {eventOffset > 0 && <button type="button" style={{...inputStyle, margin: 12, cursor: "pointer"}} onClick={() => { void loadEvents(); }}>Show less</button>}
      </section>

  </>;
}

export default function CorrelationPanel({rankingKey,stocks,rollingWindow,newsDate,verifiedOnly,configControls,priceChange,onPriceChange,onReset}: Props) {
  const [view,setView] = useState<"overview"|"news">("overview");
  const [chartView,setChartView] = useState("tradingview");
  const [timeframe,setTimeframe] = useState("5");
  const [changeOrder,setChangeOrder] = useState<"ticker"|"asc"|"desc">("desc");
  const [refresh,setRefresh] = useState(60);
  const [days,setDays] = useState("7");
  const [typed,setTyped] = useState("");
  const [tickerError,setTickerError] = useState("");
  const [extra,setExtra] = useState("");
  const [target,setTarget] = useState<{ticker:string}|null>(null);
  const [data,setData] = useState<Payload|null>(null);
  const [visibleRows,setVisibleRows] = useState(10);
  const [running,setRunning] = useState(false);
  const [error,setError] = useState("");
  const [revision,setRevision] = useState(0);
  const [overviewPage,setOverviewPage] = useState({key:"",limit:20});
  const [socialPage,setSocialPage] = useState({key:"",limit:10});
  const [pinned,setPinned] = useState<{key:string;stocks:MirrorStock[]}|null>(null);
  const latestDays = useRef(days);
  latestDays.current = days;

  const listKey = `${rankingKey}:${changeOrder}`;
  const overviewLimit = overviewPage.key === listKey ? overviewPage.limit : 20;
  const socialLimit = socialPage.key === listKey ? socialPage.limit : 10;
  const showCorrelation = view === "news" && chartView === "tradingview";
  const changeLabel = changeOrder === "ticker" ? "Change" : changeOrder === "asc" ? "Change % ↑" : "Change % ↓";
  const sortDescription = changeOrder === "ticker" ? "Ticker A–Z" : changeOrder === "asc" ? "Lowest change first" : "Highest change first";
  const ranked = useMemo(() => [...new Map(stocks.filter(stock=>stock.ticker!=="N/A").map(stock=>[stock.ticker,stock])).values()]
    .sort((a,b) => changeOrder === "ticker" ? a.ticker.localeCompare(b.ticker)
      : (Number.isFinite(b.change)?1:0)-(Number.isFinite(a.change)?1:0) || (changeOrder==="asc"?a.change-b.change:b.change-a.change) || a.ticker.localeCompare(b.ticker)),[stocks,changeOrder]);

  // Keep the opening lineup in place while live quotes and ranks update.
  useEffect(() => {
    if (view !== "news" || chartView !== "combined" || !ranked.length) return;
    setPinned(previous => previous?.key === listKey ? previous : {key:listKey,stocks:ranked.slice(0,10)});
  },[view,chartView,listKey,ranked]);

  const overviewStocks = ranked.slice(0,overviewLimit);
  const original = pinned?.key === listKey ? pinned.stocks : ranked.slice(0,10);
  const currentByTicker = new Map(ranked.map(stock=>[stock.ticker,stock]));
  const firstTickers = new Set(original.map(stock=>stock.ticker));
  const socialStocks = [...original.map(stock=>currentByTicker.get(stock.ticker) ?? stock),...ranked.filter(stock=>!firstTickers.has(stock.ticker))];
  const displayed = chartView === "combined" ? socialStocks.slice(0,socialLimit) : ranked.slice(0,10);
  const sections: {selected:string;stock?:MirrorStock;rank?:number}[] = displayed.map((stock,i)=>({selected:stock.ticker,stock,rank:i+1}));
  if (extra && !sections.some(section=>section.selected===extra)) sections.unshift({selected:extra,stock:currentByTicker.get(extra)});
  const historicalTickers = Array.from(new Set(data?.rows.map(row=>row.ticker) ?? [])).filter(ticker=>!stocks.some(stock=>stock.ticker===ticker));

  function toggleChangeOrder() {
    setChangeOrder(order => order === "desc" ? "ticker" : order === "ticker" ? "asc" : "desc");
    setPinned(null);
    setOverviewPage({key:"",limit:20});
    setSocialPage({key:"",limit:10});
    setExtra("");
    setTarget(null);
  }

  function openStock(ticker:string) {
    setExtra(displayed.some(stock=>stock.ticker===ticker) ? "" : ticker);
    setView("news"); setTarget({ticker});
  }
  useEffect(() => {
    if (view!=="news" || !target) return;
    const el=document.getElementById(`mirror-stock-${target.ticker}`);
    el?.focus({preventScroll:true}); el?.scrollIntoView({block:"start"});
  },[view,target]);
  const loadCached=useCallback(async (signal?:AbortSignal) => {
    try {
      const response=await fetch(`/api/correlation?days=${days}`,{cache:"no-store",signal});
      const json=await response.json() as Payload;
      if(!response.ok) throw new Error(json.error ?? "Unable to load correlation.");
      if(!signal?.aborted && latestDays.current===days) { setData(json); setError(""); }
    } catch(caught) {
      if(!signal?.aborted && latestDays.current===days) setError(caught instanceof Error ? caught.message : "Unable to load correlation.");
    }
  },[days]);
  useEffect(() => {
    const controller=new AbortController();
    setVisibleRows(10); void loadCached(controller.signal);
    const timer=showCorrelation && refresh ? setInterval(()=>void loadCached(controller.signal), Math.max(60,refresh)*1000) : null;
    return () => {controller.abort(); if(timer) clearInterval(timer);};
  },[loadCached,refresh,showCorrelation]);
  async function run() {
    setRunning(true);
    try {
      const response=await fetch(`/api/correlation?days=${days}`,{method:"POST"});
      const json=await response.json() as Payload;
      if(!response.ok) throw new Error(json.error ?? "Unable to run correlation.");
      if(latestDays.current===days) {setData(json);setError("");setRevision(v=>v+1);}
    } catch(caught) {setError(caught instanceof Error?caught.message:"Unable to run correlation.");}
    finally {setRunning(false);}
  }
  const stat = (label: string, value: string, color = "#f9a8d4") => (
    <div style={{ ...panel, padding: 16, minWidth: 150, flex: "1 1 150px" }}>
      <small style={{ color: "#9b7b90" }}>{label}</small>
      <div style={{ color, fontSize: 24, fontWeight: 800, marginTop: 6 }}>{value}</div>
    </div>
  );

  return (<section aria-label="Mirror screener">
    <div style={{...panel,padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <button type="button" style={inputStyle} onClick={() => {onReset();setChangeOrder("desc");setExtra("");setTarget(null);setPinned(null);setOverviewPage({key:"",limit:20});setSocialPage({key:"",limit:10});}}>Reset filters</button>
      <button type="button" aria-label={`${changeLabel}: ${sortDescription}. Click to change sort order.`} title={sortDescription} style={inputStyle} onClick={toggleChangeOrder}>
        {changeLabel}
      </button>
      <form style={{marginLeft:"auto"}} onSubmit={event=>{
        event.preventDefault();
        const ticker=typed.trim().replace(/^\$/,"").toUpperCase();
        if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)){setTickerError("Enter a valid ticker.");return;}
        setTickerError("");setTyped("");openStock(ticker);
      }}>
        <input aria-label="Ticker + Enter" value={typed} onChange={event=>setTyped(event.target.value.toUpperCase())} placeholder="Ticker + Enter" style={{...inputStyle,width:132}} />{" "}
        <button style={inputStyle}>Go</button>
      </form>
      {tickerError&&<span role="alert">{tickerError}</span>}
      {configControls}
      <ChangeFilter compact value={priceChange} onChange={onPriceChange} />
      {!!historicalTickers.length&&<details style={{width:"100%"}}>
        <summary>Historical tickers ({historicalTickers.length})</summary>
        <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:8}}>{historicalTickers.map(ticker=><button key={ticker} onClick={()=>openStock(ticker)} style={chip(false)}>{ticker}</button>)}</div>
      </details>}
    </div>

    <nav aria-label="Mirror views" style={{...panel,display:"flex",gap:4,margin:"10px 0",padding:5}}>
      <button type="button" aria-pressed={view==="overview"} style={chip(view==="overview")} onClick={()=>{setView("overview");setTarget(null);}}>Overview</button>
      <button type="button" aria-pressed={view==="news"} style={chip(view==="news")} onClick={()=>{setView("news");setExtra("");setTarget(null);}}>News</button>
    </nav>

    {view==="overview" ? <div style={{...panel,overflowX:"auto",marginBottom:24}}>
      <table className="mirror-overview" style={{width:"100%",borderCollapse:"collapse",minWidth:680}}>
        <caption style={{textAlign:"left",padding:"12px 13px",fontWeight:700}}>Top {overviewStocks.length || 20} stocks {ranked.length>overviewStocks.length && <small style={{color:"#c9afc0"}}>· {ranked.length} matching</small>}</caption>
        <thead><tr>{["No.","Ticker","Company","Sector","Market Cap","Price","Change %","Volume"].map(label=>label==="Change %"
          ? <th scope="col" key={label} style={th} aria-sort={changeOrder==="ticker"?undefined:changeOrder==="asc"?"ascending":"descending"}>
            <button type="button" aria-label={`Change %: ${sortDescription}. Click to change sort order.`} title={sortDescription} style={{...chip(false),padding:0,color:"inherit",fontWeight:"inherit"}} onClick={toggleChangeOrder}>{changeOrder==="ticker"?label:changeLabel}</button>
          </th>
          : <th scope="col" key={label} style={th} aria-sort={label==="Ticker"&&changeOrder==="ticker"?"ascending":undefined}>{label}</th>)}</tr></thead>
        <tbody>{overviewStocks.map((stock,i)=><tr key={stock.ticker}>
          <td style={td}>{i+1}</td><td style={td}><button type="button" aria-label={`Open ${stock.ticker} chart and news`} style={{...chip(false),padding:0,color:"#7dd3fc",fontWeight:700}} onClick={()=>openStock(stock.ticker)}>{stock.ticker}</button></td>
          <td style={{...td,whiteSpace:"normal"}}>{stock.company}</td><td style={{...td,whiteSpace:"normal"}}>{stock.sector}</td><td style={td}>{stock.marketCap}</td>
          <td style={td}>{stock.price>0?`$${stock.price.toFixed(2)}`:"—"}</td><td style={{...td,color:Number.isFinite(stock.change)?signColor(stock.change.toFixed(2)+"%"):"inherit"}}>{Number.isFinite(stock.change)?`${stock.change>0?"+":""}${stock.change.toFixed(2)}%`:"—"}</td><td style={td}>{stock.volume}</td>
        </tr>)}</tbody>
      </table>
      {ranked.length>overviewLimit && <button type="button" style={{...inputStyle,margin:12}} onClick={()=>setOverviewPage({key:listKey,limit:overviewLimit+20})}>Load more stocks</button>}
      {!ranked.length&&<p style={{padding:"0 13px"}}>No ranked stocks to display yet.</p>}
    </div> : <>
      <div style={{...panel,padding:10,marginBottom:14,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <div role="group" aria-label="Chart type" style={{display:"flex",gap:4}}>
          {[["tradingview","TradingView"],["combined","Price + Social"]].map(([value,label])=><button type="button" key={value} aria-pressed={chartView===value} onClick={()=>setChartView(value)} style={chip(chartView===value)}>{label}</button>)}
        </div>
        <div role="group" aria-label="Chart interval" style={{display:"flex",gap:2,flexWrap:"wrap"}}>
          {TIMEFRAMES.map(([label,value])=><button type="button" key={value} aria-pressed={timeframe===value} onClick={()=>setTimeframe(value)} style={chip(timeframe===value)}>{label}</button>)}
        </div>
        <div role="group" aria-label="Chart refresh" style={{marginLeft:"auto",display:"flex",gap:2}}>
          {REFRESH.map(([label,seconds])=><button type="button" key={label} aria-pressed={refresh===seconds} onClick={()=>setRefresh(seconds)} style={chip(refresh===seconds)}>{label}</button>)}
        </div>
        <label>Post history <select aria-label="Stocktwits post history" value={days} onChange={event=>setDays(event.target.value)} style={inputStyle}>{HISTORY.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {sections.length ? sections.map(section=><StockSection key={section.selected} {...section} timeframe={timeframe} chartView={chartView} refresh={refresh} days={days} newsDate={newsDate} verifiedOnly={verifiedOnly} rollingWindow={rollingWindow} revision={revision} />)
        : <p role="status">No ranked stocks to display yet. Enter a ticker to open its chart.</p>}
      {chartView === "combined" && socialStocks.length>socialLimit && <button type="button" style={{...inputStyle,marginBottom:24}} onClick={()=>setSocialPage({key:listKey,limit:socialLimit+10})}>Load more stocks</button>}
    </>}

      {showCorrelation && <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, marginRight: 8 }}>Sentiment Correlation</h2>
        <button onClick={() => void run()} disabled={running} style={{ background: "#db2777", color: "white", border: 0, borderRadius: 7, padding: "11px 22px", fontWeight: 700, cursor: "pointer" }}>
          {running ? "Running..." : "Run Correlation Analysis"}
        </button>
        <select value={days} onChange={(e) => setDays(e.target.value)} style={inputStyle}>
          {HISTORY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {data?.sync && (
          <span style={{ color: "#b995ad", fontSize: 13 }}>
            Mirror synced: {data.sync.newsRows} news + {data.sync.socialRows} social rows, {data.sync.priced} priced in stored mirror
          </span>
        )}
      </div>

      {error && <p style={{ color: "#fda4af" }}>{error}</p>}

      <p style={{ color: "#c9afc0", fontSize: 13, marginBottom: 12 }}>Sentiment is compared with observed prices about 30 minutes later. Missing history stays unmatched.</p>
      <details style={{ ...panel, padding: 16, marginBottom: 16 }}>
        <summary style={{ cursor: "pointer", color: "#fbcfe8" }}>Collection details</summary>
      <p style={{ color: "#c9afc0", fontSize: 13 }}>The updated Railway worker collects prices for tracked tickers and syncs event matches each cycle, even with this page closed. Mirror refresh also observes stocks as you scroll through News. Quotes may be delayed; missing fields stay blank. A 52-week range is shown only when absolute source values are available.</p>
      {data?.diagnostics && <div style={{ paddingTop: 12 }} role="status">
        <strong>Price collection status</strong>
        <p>Distinct observation times: {data.diagnostics.observationTimes}. Last saved: {data.diagnostics.lastSnapshotAt ? new Date(data.diagnostics.lastSnapshotAt).toLocaleString() : "none"}.</p>
        <p>Unmatched events in this period: {data.diagnostics.noTickerHistory} without ticker history; {data.diagnostics.noBaseline} without a recent baseline; {data.diagnostics.waitingAfter} waiting for an outcome; {data.diagnostics.missingAfter} missing the outcome window.</p>
        <p style={{ color: "#c9afc0", marginBottom: 0 }}>A valid pair needs an observation within 15 minutes before publication and one 30–45 minutes afterward. Old missing history cannot be recovered by waiting. Quotes may be delayed. The worker updates matches each cycle. Run Analysis requests an immediate sync.</p>
      </div>}
      </details>
      {data && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            {stat("OVERALL CORRELATION", fixed(data.overall.correlation), corrColor(data.overall.correlation))}
            {stat("DIRECTION HIT RATE", pct(data.overall.hitRate))}
            {stat("PRICED EVENTS", String(data.overall.events))}
            {stat("MIRROR EVENTS", String(data.mirror.totalEvents))}
            {stat("PRICE SNAPSHOTS", String(data.mirror.snapshots))}
          </div>

          {data.overall.events === 0 && (
            <div style={{ ...panel, padding: 20, marginBottom: 16 }}>
              <strong>No priced events yet.</strong>
              <p style={{ color: "#c9afc0", marginBottom: 0 }}>
                Correlation compares each news article or post with the price {data.horizonMinutes} minutes later, so it
                needs price snapshots taken both before and after the event ({data.mirror.snapshots} saved so far). Keep the social
                worker or Auto fetch running, then press Run Correlation Analysis again.
              </p>
            </div>
          )}

          {data.rows.length > 0 && (
            <div style={{ ...panel, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Ticker", "Last price", "Events", "News priced / saved", "Social", "Avg sentiment", `Avg move (${data.horizonMinutes}m)`, "Correlation", "News corr.", "Social corr.", "Hit rate"].map((h) => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.slice(0, visibleRows).map((row) => (
                    <tr key={row.ticker} onClick={() => openStock(row.ticker)} style={{ cursor: "pointer", background: target?.ticker === row.ticker ? "#4a203c" : "transparent" }}>
                      <td style={{ ...td, fontWeight: 800 }}>{row.ticker}{row.lowSample && <small style={{ color: "#9b7b90", marginLeft: 6 }}>low sample</small>}</td>
                      <td style={td}>{row.lastPrice === null ? "-" : `$${row.lastPrice.toFixed(2)}`}</td>
                      <td style={td}>{row.events}</td>
                      <td style={td} title="News with valid price pairs / saved ticker-matched news in this period">{row.news} / {row.newsTotal ?? row.news}</td>
                      <td style={td}>{row.social}</td>
                      <td style={{ ...td, color: sentimentColor(row.avgSentiment) }}>{fixed(row.avgSentiment)}</td>
                      <td style={{ ...td, color: row.avgReturn >= 0 ? "#86efac" : "#fda4af" }}>{row.avgReturn >= 0 ? "+" : ""}{row.avgReturn.toFixed(2)}%</td>
                      <td style={{ ...td, color: corrColor(row.correlation), fontWeight: 700 }}>{row.correlation === null ? (row.events < 3 ? "Need 3+ events" : "No variation") : fixed(row.correlation)}</td>
                      <td style={{ ...td, color: corrColor(row.newsCorrelation) }}>{row.newsCorrelation === null ? (row.news === 0 ? ((row.newsTotal ?? 0) > 0 ? "Missing price pairs" : "No matched news") : row.news < 3 ? "Need 3+ events" : "No variation") : fixed(row.newsCorrelation)}</td>
                      <td style={{ ...td, color: corrColor(row.socialCorrelation) }}>{row.socialCorrelation === null ? (row.social === 0 ? "No priced posts" : row.social < 3 ? "Need 3+ events" : "No variation") : fixed(row.socialCorrelation)}</td>
                      <td style={td}>{pct(row.hitRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows.length > visibleRows && <button style={{ ...inputStyle, margin: 16, cursor: "pointer" }} onClick={() => setVisibleRows((count) => count + 10)}>Load more</button>}
          {visibleRows > 10 && <button type="button" style={{...inputStyle, margin: 12, cursor: "pointer"}} onClick={() => { setVisibleRows(10); }}>Show less</button>}
            </div>
          )}
        </>
      )}
      </>}
    </section>
  );
}
