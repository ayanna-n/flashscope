"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";

type SocialPoint = { at: string; messages: number; labeled: number; sentiment: number | null; watchers: number | null };
type PricePoint = { at: string; price: number; volume?: string | null };
type Snapshot = { asOf?: string; points: SocialPoint[]; prices: PricePoint[] };
const colors = { price: "#10ad7e", sentiment: "#9262ef", messages: "#ec8a36", watchers: "#407ce0" };
const labels = { price: "Price", sentiment: "Sentiment", messages: "Message Volume", watchers: "Watchers" };
const series = ["price", "sentiment", "messages", "watchers"] as const;

const hour = 3600000, day = 24 * hour;
const left = 34, right = 682, top = 15, bottom = 211, volumeBottom = 243;
const timeZone = "America/New_York";
const dateTime = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
const date = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
const tradingDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
const theme = { background: "#1b0714", surface: "#301528", border: "#62354f", grid: "#432238", text: "#f5e4ef", muted: "#c3a5b9", selected: "#50243f" };

function easternTime(dateKey: string, hours: number) {
  const utc = Date.parse(`${dateKey}T00:00:00Z`) + hours * hour;
  const offset = (at: number) => {
    const zone = offsetFormat.formatToParts(at).find(part => part.type === "timeZoneName")?.value;
    const match = zone?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * hour + Number(match[3] ?? 0) * 60000) : 0;
  };
  return utc - offset(utc - offset(utc));
}

const chip: CSSProperties = { border: "1px solid", borderRadius: 20, padding: "5px 10px", fontSize: 12, fontWeight: 650, background: "transparent", cursor: "pointer" };

function volumeOf(raw?: string | null) {
  if (!raw?.trim()) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export default function MirrorSocialMetrics({ ticker, refresh, windowMinutes, quoteSnapshot, interval, active }: {
  ticker: string; refresh: number; windowMinutes: number; quoteSnapshot?: PricePoint; interval: string; active: boolean;
}) {
  const clipId = useId();
  const range = interval === "D" ? 30 : interval === "W" ? 90 : interval === "M" ? 365 : 1;
  const gap = (interval === "D" ? 1440 : interval === "W" ? 10080 : interval === "M" ? 43200 : Number(interval)) * 60000;
  const intervalLabel = range === 1 ? (interval === "60" ? "1 hour" : `${interval} min`) : interval === "D" ? "Daily" : interval === "W" ? "Weekly" : "Monthly";
  const priceGap = range === 1 ? Math.max(1800000,gap*2) : gap*1.75;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const [enabled, setEnabled] = useState({ price: true, sentiment: true, messages: true, watchers: true });
  const [showVolume, setShowVolume] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const r = await fetch(`/api/social-metrics?ticker=${encodeURIComponent(ticker)}&window=${windowMinutes}&days=${range}&interval=${interval}`, { cache: "no-store", signal: controller.signal });
        if (!r.ok) throw new Error();
        const data: Snapshot = await r.json();
        if (!controller.signal.aborted) { setSnapshot(data); setError(""); }
      } catch {
        if (!controller.signal.aborted) setError("Unable to refresh chart data.");
      } finally { pending = false; }
    };
    void load();
    const timer = refresh ? setInterval(() => void load(), Math.max(10, refresh) * 1000) : null;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [ticker, refresh, windowMinutes, range, interval, active]);

  const rawPoints = snapshot?.points;
  const observedAt = Date.parse(quoteSnapshot?.at ?? "");
  const asOf = Math.max(Date.parse(snapshot?.asOf ?? rawPoints?.at(-1)?.at ?? "") || 0, observedAt || 0) || Date.now();
  const sessionDate = tradingDate.format(asOf);
  const start = range === 1 ? easternTime(sessionDate, 0) : asOf - range * day;
  const end = range === 1 ? easternTime(sessionDate, 24) : asOf;
  const points = (rawPoints ?? []).filter(p => Date.parse(p.at) >= start && Date.parse(p.at) <= asOf);
  const prices = useMemo(() => {
    const data = (snapshot?.prices ?? []).filter(p => Date.parse(p.at) >= start && Number.isFinite(p.price) && p.price > 0);
    if (quoteSnapshot && quoteSnapshot.price > 0 && Number.isFinite(quoteSnapshot.price) && observedAt >= start &&
        (!data.length || observedAt - Date.parse(data.at(-1)!.at) > 1000)) data.push(quoteSnapshot);
    return data;
  }, [snapshot, start, quoteSnapshot, observedAt]);
  const sampledPrices = useMemo(() => {
    if (range !== 1) return prices;
    const buckets = new Map<number, PricePoint>();
    for(const p of prices) {
      const at = Date.parse(p.at);
      buckets.set(Math.floor((at-start)/gap),p);
    }
    return Array.from(buckets.values());
  }, [prices, start, gap, range]);
  const volumeBars = useMemo(() => {
    if (range !== 1) return [];
    const buckets = new Map<number, { value: number; up: boolean }>();
    for (let i = 1; i < prices.length; i++) {
      const previous = prices[i - 1], current = prices[i];
      const a = volumeOf(previous.volume), b = volumeOf(current.volume);
      const from = Date.parse(previous.at), at = Date.parse(current.at);
      if (a === null || b === null || b <= a || at <= from || at - from > 1800000 || tradingDate.format(from) !== tradingDate.format(at)) continue;
      const bucket = Math.floor((at - start) / gap) * gap + start;
      buckets.set(bucket, { value: (buckets.get(bucket)?.value ?? 0) + b - a, up: current.price >= previous.price });
    }
    return [...buckets].map(([at, bar]) => ({ at, ...bar }));
  }, [prices, gap, start, range]);
  const maxVolume = Math.max(1, ...volumeBars.map(bar => bar.value));
  const priceValues = sampledPrices.map(p => p.price);
  const lo = priceValues.length ? Math.min(...priceValues) : 0;
  const hi = priceValues.length ? Math.max(...priceValues) : 1;
  const pad = Math.max((hi - lo) * .06, hi * .005, .0001);
  const low = Math.max(0, lo - pad), high = hi + pad;
  const digits = Math.min(8, Math.max(hi < 1 ? 4 : 2, Math.ceil(-Math.log10(Math.max((high - low) / 4, 1e-8))) + 1));
  const money = (value: number) => `$${value.toFixed(digits)}`;
  const maxMessages = Math.max(1, ...points.map(p => p.messages));
  const watch = points.flatMap(p => p.watchers === null ? [] : [p.watchers]);
  const minWatch = watch.length ? Math.min(...watch) : 0, maxWatch = watch.length ? Math.max(...watch) : 0;
  const x = (t: number) => left + (t - start) / (end - start) * (right - left);
  const y = (v: number) => bottom - v * (bottom - top);
  const ratio = (key: keyof typeof labels, value: number) => key === "price" ? (value - low) / (high - low)
    : key === "sentiment" ? value / 100 : key === "messages" ? value / maxMessages
    : minWatch === maxWatch ? .5 : (value - minWatch) / (maxWatch - minWatch);
  const path = (key: keyof typeof labels, data: { at: string; value: number | null }[], maxGap: number) => {
    let previous: number | null = null;
    return data.map(p => {
      if (p.value === null) { previous = null; return ""; }
      const t = Date.parse(p.at);
      const cmd = previous !== null && t - previous <= maxGap ? "L" : "M";
      previous = t;
      return `${cmd}${x(t).toFixed(2)},${y(ratio(key, p.value)).toFixed(2)}`;
    }).join(" ");
  };
  const latest = prices.at(-1), lastPoint = points.at(-1);
  const focusAt = hover ?? asOf;
  const hoveredPrice = hover === null ? latest : prices.findLast(p => Date.parse(p.at) <= focusAt && focusAt - Date.parse(p.at) <= priceGap);
  const point = hover === null ? lastPoint : points.findLast(p => Date.parse(p.at) <= focusAt && focusAt - Date.parse(p.at) <= gap);
  const values = { price: hoveredPrice?.price, sentiment: point?.sentiment, messages: point?.messages, watchers: point?.watchers };
  const format = (key: keyof typeof labels, value: number | null | undefined) => value == null ? "—"
    : key === "price" ? money(value) : key === "sentiment" ? `${Math.round(value)}%` : value.toLocaleString();
  const tickTimes = range === 1
    ? [4, 8, 12, 16, 20, 24].map(h => easternTime(sessionDate, h))
    : [0, .25, .5, .75, 1].map(f => start + f * (end - start));
  const legend = ["sentiment", "messages", "watchers"] as const;

  return <section aria-label="Combined price and Stocktwits chart" style={{ width: "100%", minWidth: 0, background: theme.background, color: theme.text, colorScheme: "dark", border: `1px solid ${theme.border}`, borderRadius: 12, boxSizing: "border-box", padding: "9px 12px 12px", overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
      <span style={{ flex: 1, borderTop: `1px solid ${theme.grid}` }} />
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)} style={{ background: "none", border: 0, color: theme.muted, fontSize: 12, cursor: "pointer" }}>{collapsed ? "Show Chart ⌄" : "Hide Chart ⌃"}</button>
      <span style={{ flex: 1, borderTop: `1px solid ${theme.grid}` }} />
    </div>
    {!collapsed && <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {legend.map(key => <button key={key} type="button" aria-pressed={enabled[key]} onClick={() => setEnabled(v => ({ ...v, [key]: !v[key] }))} style={{ ...chip, color: colors[key], opacity: enabled[key] ? 1 : .45 }}>
          {labels[key]} {format(key, values[key])}
        </button>)}
        <details style={{ position: "relative", marginLeft: "auto", zIndex: 2 }}>
          <summary aria-label="Chart settings" title="Chart settings" style={{ cursor: "pointer", color: theme.muted, listStyle: "none", padding: "2px 5px" }}>⚙</summary>
          <div style={{ position: "absolute", right: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, width: 145, fontSize: 12, boxShadow: "0 3px 12px #0002" }}>
            <label><input type="checkbox" checked={enabled.price} onChange={e => setEnabled(v => ({ ...v, price: e.target.checked }))} /> Price</label><br />
            {range === 1 && <label><input type="checkbox" checked={showVolume} onChange={e => setShowVolume(e.target.checked)} /> Share volume</label>}
          </div>
        </details>
      </div>
      {!snapshot && !error && <p role="status" style={{ fontSize: 12 }}>Loading chart…</p>}
      {error && <p role="alert" style={{ color: "#ffabb0", fontSize: 12 }}>{error}</p>}
      <div style={{ position: "relative", marginTop: 5 }}>
        <svg viewBox="0 0 760 270" role="img" aria-label="Price and social metrics on one timeline" style={{ width: "100%", height: "auto", display: "block", aspectRatio: "760 / 270", touchAction: "pan-y" }}
          onPointerMove={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const f = ((e.clientX - rect.left) / rect.width * 760 - left) / (right - left);
            const at = start + f * (end - start);
            setHover(f < 0 || f > 1 || at > asOf ? null : at);
          }} onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}>
          <defs><clipPath id={clipId}><rect x={left} y={top - 3} width={right - left + 4} height={volumeBottom - top + 4} /></clipPath></defs>
          {[0, 25, 50, 75, 100].map(n => <g key={n}>
            <line x1={left} x2={right} y1={y(n / 100)} y2={y(n / 100)} stroke={theme.grid} />
            <text x={left - 5} y={y(n / 100) + 4} textAnchor="end" fill={theme.muted} fontSize="11">{n}</text>
            {enabled.price && latest && <text x={right + 10} y={y(n / 100) + 4} fill={theme.muted} fontSize="11">{money(low + (high - low) * n / 100)}</text>}
          </g>)}
          <g clipPath={`url(#${clipId})`}>
            {showVolume && volumeBars.map(bar => {
              const h = bar.value / maxVolume * 27;
              return <rect key={bar.at} x={x(bar.at)} y={volumeBottom - h} width={Math.max(1, gap / (end - start) * (right - left) * .6)} height={h} fill={bar.up ? "#56c7a5" : "#ed8b91"} opacity=".65"><title>{bar.value.toLocaleString() + " shares observed"}</title></rect>;
            })}
            {series.map(key => enabled[key] && <path key={key} d={path(key, key === "price" ? sampledPrices.map(p => ({ at: p.at, value: p.price })) : points.map(p => ({ at: p.at, value: p[key] })), key === "price" ? priceGap : gap + 1000)} fill="none" stroke={colors[key]} strokeWidth={key === "price" ? 2.2 : 1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
            {legend.map(key => enabled[key] && points.map((p, i) => {
              const value = p[key];
              if (value === null || points[i - 1]?.[key] != null || points[i + 1]?.[key] != null) return null;
              return <circle key={key + p.at} cx={x(Date.parse(p.at))} cy={y(ratio(key, value))} r={2.1} fill={colors[key]} />;
            }))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={top} y2={volumeBottom} stroke="#a6a9b3" strokeDasharray="3 4" />}
          </g>
          {latest && enabled.price && <g>
            <line x1={x(Date.parse(latest.at))} x2={right + 7} y1={y(ratio("price", latest.price))} y2={y(ratio("price", latest.price))} stroke={colors.price} strokeDasharray="2 3" opacity=".6" />
            <circle cx={x(Date.parse(latest.at))} cy={y(ratio("price", latest.price))} r={3.4} fill={colors.price} />
            <rect x={right + 5} y={y(ratio("price", latest.price)) - 9} width={71} height={18} rx={4} fill={colors.price} />
            <text x={right + 40.5} y={y(ratio("price", latest.price)) + 4} textAnchor="middle" fill="white" fontSize="11" fontWeight="700">{money(latest.price)}</text>
          </g>}
          {tickTimes.map((t, i) => <text key={t} x={x(t)} y="262" textAnchor={t === start ? "start" : t === end ? "end" : "middle"} fill={theme.muted} fontSize="11">{range === 1 ? clock.format(t) : date.format(t)}</text>)}
        </svg>
        {hover !== null && <div aria-hidden="true" style={{ pointerEvents: "none", position: "absolute", left: `${x(hover) / 760 * 100}%`, top: "34%", transform: x(hover) > 460 ? "translateX(calc(-100% - 8px))" : "translateX(8px)", background: theme.surface, borderRadius: 9, boxShadow: "0 2px 12px #0002", border: `1px solid ${theme.border}`, padding: "7px 10px", fontSize: 11, lineHeight: 1.45, whiteSpace: "nowrap" }}>
          <strong style={{ fontSize: 15 }}>{format("price", values.price)}</strong>
          <div style={{ color: theme.muted }}>{dateTime.format(hoveredPrice ? Date.parse(hoveredPrice.at) : focusAt)}</div>
          {legend.filter(key => enabled[key]).map(key => <div key={key} style={{ color: colors[key] }}>{labels[key]} {format(key, values[key])}</div>)}
        </div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, borderTop: `1px solid ${theme.grid}`, paddingTop: 6 }}>
        <small style={{color:theme.muted}}>{intervalLabel} interval · {range === 1 ? "Today" : `Last ${range} days`}</small>
        <small style={{ marginLeft: "auto", color: theme.muted }}>ET</small>
      </div>
      {snapshot && prices.length < 2 && <p style={{ fontSize: 12, margin: "8px 0 4px" }}>{prices.length ? "One price snapshot available. A line needs more history." : "No saved price history in this range."}</p>}
      <details style={{ fontSize: 11, color: theme.muted, marginTop: 6 }}>
        <summary style={{ cursor: "pointer" }}>ⓘ Chart data</summary>
        <p>Minute and hour intervals show the current Eastern calendar day. Longer intervals show sampled readings across a longer range. The interval controls spacing between chart readings; the rolling window still controls how many minutes of posts each social reading uses. Price uses Finviz observations at fetch time and may be delayed. Share volume bars show increases between nearby saved volume snapshots on the same date. The social scale shows bullish share of labeled posts over {windowMinutes} minutes, message counts relative to their visible peak, and watchers relative to their visible range. Pills and hover cards show actual counts. Gaps show missing observations. These scores are calculated by FlashScope.</p>
      </details>
    </>}
  </section>;
}
