"use client";

import { matchesKeywords } from "@/lib/feed-preferences";
import { matchesSocialSearch } from "@/lib/social-text";
import Script from "next/script";
import { useEffect, useMemo, useRef, useState } from "react";
import posts from "./selected-x-posts.json";

type Selection = (typeof posts)[number];
type XWindow = Window & { twttr?: { widgets: { createTweet: (id: string, container: HTMLElement, options: Record<string, unknown>) => Promise<HTMLElement | undefined> } } };
const buttonStyle = { background: "#4a203c", border: "1px solid #a5497c", borderRadius: 10, padding: "10px 16px", color: "#f9a8d4", cursor: "pointer" };

function EmbeddedPost({ post, ready }: { post: Selection; ready: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const host = container.current;
    const widgets = (window as XWindow).twttr?.widgets;
    if (!ready || !host || !widgets) return;
    let active = true;
    // A separate target prevents a late response from touching a remounted card.
    const target = document.createElement("div");
    host.replaceChildren(target);
    const timeout = window.setTimeout(() => { if (active) setUnavailable(true); }, 15000);
    widgets.createTweet(post.id, target, { theme: "dark", dnt: true, conversation: "none", align: "center" })
      .then((element) => { if (active) { window.clearTimeout(timeout); setUnavailable(!element); } })
      .catch(() => { if (active) { window.clearTimeout(timeout); setUnavailable(true); } });
    return () => { active = false; window.clearTimeout(timeout); target.remove(); };
  }, [post.id, ready]);
  return <article style={{ padding: 16, border: "1px solid #713259", borderRadius: 12, minWidth: 0 }}>
    <div style={{ color: "#f9a8d4", fontWeight: 700 }}>@{post.author}</div>
    <p style={{ color: "#c9afc0", margin: "8px 0" }}>{post.topic}</p>
    <div ref={container} />
    {unavailable && <p style={{ color: "#c9afc0" }} role="status">Preview unavailable. Open the original post below.</p>}
    <a href={`https://x.com/${post.author}/status/${post.id}`} target="_blank" rel="noopener noreferrer" style={{ color: "#f9a8d4" }}>Open original on X ↗</a>
  </article>;
}

export default function SelectedXPosts({ search, sentiment, keywords = [] }: { search: string; sentiment: string; keywords?: string[] }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [limit, setLimit] = useState(10);
  const filtered = useMemo(() => posts.filter((post) => matchesSocialSearch(`${post.author} ${post.topic}`, search) && matchesKeywords(`${post.author} ${post.topic}`,keywords)), [search, keywords]);
  // A new search gets its own pagination without changing the stored feed.
  const [previousSearch, setPreviousSearch] = useState(search);
  if (previousSearch !== search) { setPreviousSearch(search); setLimit(10); }
  return <section aria-label="Selected X Posts" style={{ marginBottom: 20, padding: 18, background: "#2c1427", border: "1px solid #713259", borderRadius: 14 }}>
    <Script id="x-post-widgets" src="https://platform.twitter.com/widgets.js" strategy="afterInteractive" onReady={() => setReady(true)} onError={() => setFailed(true)} />
    <h2 style={{ marginTop: 0, color: "#f9a8d4" }}>Selected X Posts</h2>
    <p style={{ color: "#c9afc0" }}>50 manually selected links · October 19–22, 2026. These posts do not update automatically or contribute to message counts and density.</p>
    <p style={{ color: "#c9afc0", fontSize: 13 }}>Search and enabled keywords match topics, tickers and authors. X displays the embedded text. Sentiment is unassigned.</p>
    {failed && <p role="status">X previews could not load. You can still open each original post.</p>}
    {sentiment !== "All sentiments" ? <p>Choose “All sentiments” to browse the selected X posts.</p> : <>
      <p role="status" style={{ color: "#c9afc0" }}>Showing {Math.min(limit, filtered.length)} of {filtered.length} matching selections</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 14 }}>
        {filtered.slice(0, limit).map((post) => <EmbeddedPost key={post.id} post={post} ready={ready} />)}
      </div>
      {filtered.length === 0 && <p>No selected X posts match this search.</p>}
      {limit < filtered.length && <button type="button" style={{ ...buttonStyle, marginTop: 16 }} onClick={() => setLimit((value) => value + 10)}>Load 10 more</button>}
      {limit > 10 && <button type="button" style={{...buttonStyle, marginTop: 16, marginLeft: 8}} onClick={() => setLimit(10)}>Show less</button>}
    </>}
  </section>;
}
