"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { decodeSocialText } from "@/lib/social-text";

const PAGE_SIZE = 5;
type Post = { id?: string; text: string; author: string | null; url: string | null; published_at: string; sentiment: number };
export default function MirrorStocktwits({ ticker, days, refresh, compact = false }: { ticker: string; days: string; refresh: number; compact?: boolean }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const request = useRef<AbortController|null>(null);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failedOffset, setFailedOffset] = useState(0);
  const [error, setError] = useState("");
  const load = useCallback(async (start = 0) => {
    if (!ticker || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const signal = controller.signal;
    setLoading(true);
    try {
      const response = await fetch(`/api/mirror?source=Stocktwits&kind=social&ticker=${encodeURIComponent(ticker)}&days=${days}&limit=${PAGE_SIZE}&offset=${start}`, { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load Stocktwits.");
      if (signal?.aborted) return;
      setPosts(previous => start ? [...previous, ...(body.results ?? [])] : body.results ?? []);
      setOffset(start); setMore(body.hasMore === true); setError("");
    } catch (caught) {
      if (!signal?.aborted) { setFailedOffset(start); setError(caught instanceof Error ? caught.message : "Unable to load Stocktwits."); }
    } finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }, [ticker, days]);
  useEffect(() => {
    void load();
    return () => { request.current?.abort(); request.current = null; };
  }, [load]);
  useEffect(() => {
    if (!refresh || offset) return;
    const timer = setInterval(() => void load(), refresh * 1000);
    return () => clearInterval(timer);
  }, [refresh, offset, load]);
  return <section style={compact ? {} : {borderTop: "1px solid #713259", marginTop: 16, paddingTop: 14}} aria-label={`${ticker} Stocktwits`}>
    <strong style={{color: "#fbcfe8"}}>Stocktwits · {ticker || "Choose a ticker"}</strong>
    <div style={{marginTop: 10}}>
      {posts.map((post, index) => {
        const id = post.url?.match(/\/message\/(\d+)/)?.[1];
        const url = id && post.author && post.author !== "Unknown" ? `https://stocktwits.com/${encodeURIComponent(post.author.replace(/^@/, ""))}/message/${id}` : post.url;
        return <article key={post.id ?? `${post.published_at}-${index}`} style={{borderBottom: "1px solid #592343", padding: compact ? "6px 0" : "10px 0", fontSize: 13}}>
          <div style={{color: "#b995ad",display:compact?"flex":"block",gap:8,flexWrap:"wrap",fontSize:compact?12:13}}>
            <span>{post.author || "Stocktwits"} · {new Date(post.published_at).toLocaleString("en-US", {timeZone: "America/New_York"})}</span>
            {compact && <span style={{color:post.sentiment>0?"#86efac":post.sentiment<0?"#fda4af":"#d8b4c8"}}>{post.sentiment>0?"Bullish":post.sentiment<0?"Bearish":"Neutral"}</span>}
          </div>
          <p style={{margin: compact ? "3px 0 0" : "7px 0", overflowWrap: "anywhere"}}>{url ? <a href={url} target="_blank" rel="noreferrer" style={{color: "#7dd3fc"}}>{decodeSocialText(post.text)}</a> : decodeSocialText(post.text)}</p>
          {!compact && <span style={{color: post.sentiment > 0 ? "#86efac" : post.sentiment < 0 ? "#fda4af" : "#d8b4c8"}}>{post.sentiment > 0 ? "Bullish" : post.sentiment < 0 ? "Bearish" : "Neutral"}</span>}
        </article>;
      })}
      {!posts.length && !loading && !error && <p style={{color: "#c9afc0"}}>No saved Stocktwits posts in this period.</p>}
      {loading && <p role="status">Loading Stocktwits…</p>}
      {error && <p role="alert" style={{color: "#fda4af"}}>{error} <button onClick={() => void load(failedOffset)}>Retry</button></p>}
      {more && <button disabled={loading} onClick={() => void load(offset + PAGE_SIZE)} style={{background: "#4a203c", color: "white", border: "1px solid #713259", borderRadius: 6, padding: "8px 12px", marginTop: 10}}>Load more</button>}
      {offset > 0 && <button disabled={loading} onClick={() => void load(0)} style={{background: "#4a203c", color: "white", border: "1px solid #713259", borderRadius: 6, padding: "8px 12px", marginTop: 10, marginLeft: 8}}>Show less</button>}
    </div>
  </section>;
}
