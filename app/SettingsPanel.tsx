"use client";

import { APPROVED_KEYWORDS, approvedKeywordCategory } from "@/lib/approved-keywords";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

type Tab = "Sources" | "Keywords" | "Accounts" | "Config";
type Kind = "sources" | "keywords" | "platforms";
type SourceRow = { id: number; name: string; feed_url: string | null; enabled: boolean; builtIn: boolean };
type KeywordRow = { id: number; keyword: string; category: string; enabled: boolean };
const panel: CSSProperties = { background: "#35172d", border: "1px solid #713259", borderRadius: 12, overflow: "hidden" };
const input: CSSProperties = { background: "#210f1c", color: "white", border: "1px solid #713259", borderRadius: 7, padding: "10px 12px", minWidth: 0 };
const action: CSSProperties = { background: "#db2777", color: "white", border: 0, borderRadius: 7, padding: "9px 15px", cursor: "pointer", fontSize: 20, lineHeight: 1.2, minWidth: 42 };
const muted: CSSProperties = { color: "#c9afc0", fontSize: 13 };
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #592343" };
const formStyle: CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 };
const endpoint = (type: Kind) => `/api/settings?type=${type}`;

export default function SettingsPanel({ config, keywordControls, onSettingsChange }: { config?: ReactNode; keywordControls?: ReactNode; onSettingsChange?: () => void }) {
  const [tab, setTab] = useState<Tab>("Sources");
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [keywords, setKeywords] = useState<KeywordRow[]>([]);
  const [platformSettings, setPlatformSettings] = useState<{id: number; platform: string; enabled: boolean}[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [keyword, setKeyword] = useState("");
  const category = approvedKeywordCategory(keyword) ?? "Any";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const results = await Promise.allSettled((["sources", "keywords", "platforms"] as Kind[]).map(async (type) => {
      const response = await fetch(endpoint(type), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load settings.");
      if (type === "sources") setSources(data.results ?? []);
      if (type === "keywords") setKeywords(data.results ?? []);
      if (type === "platforms") setPlatformSettings(data.results ?? []);
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason instanceof Error ? failure.reason.message : "Unable to load settings.");
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(type: Kind, method: "POST" | "PATCH", body: object) {
    setBusy(true);
    try {
      const response = await fetch(endpoint(type), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save setting.");
      if (type === "sources") setSources(data.results ?? []);
      if (type === "keywords") setKeywords(data.results ?? []);
      if (type === "platforms") setPlatformSettings(data.results ?? []);
      setError("");
      onSettingsChange?.();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Network error. Try again.");
      return false;
    } finally { setBusy(false); }
  }

  function toggle(type: Kind, row: { id: number; enabled: boolean }, label: string) {
    const description = `${row.enabled ? "Remove" : "Restore"} ${label}`;
    return <button type="button" disabled={busy || loading} style={{ ...action, background: row.enabled ? "transparent" : "#4a203c", border: "1px solid #713259", opacity: busy ? 0.5 : 1 }} title={description} aria-label={description} onClick={() => void send(type, "PATCH", { id: row.id, enabled: !row.enabled })}>{row.enabled ? "×" : "+"}</button>;
  }

  function sourceRow(row: SourceRow) {
    return <div key={row.id} style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}><strong>{row.name}</strong>{row.feed_url && <div style={{ ...muted, overflowWrap: "anywhere", marginTop: 4 }}>{row.feed_url}</div>}</div>
      {toggle("sources", row, row.name)}
    </div>;
  }
  function keywordRow(row: KeywordRow) {
    return <div key={row.id} style={rowStyle}><strong style={{ flex: 1 }}>{row.keyword}</strong><span style={{ ...muted, color: row.category === "Bullish" ? "#86efac" : row.category === "Bearish" ? "#fda4af" : "#d8b4c8" }}>{row.category}</span>{toggle("keywords", row, row.keyword)}</div>;
  }

  return <section style={panel}>
    <div style={{ display: "flex", flexWrap: "wrap", background: "#251225", borderBottom: "1px solid #713259" }}>
      {(["Sources", "Keywords", "Accounts", ...(config ? ["Config"] : [])] as Tab[]).map((name) => <button key={name} type="button" onClick={() => setTab(name)} style={{ background: tab === name ? "#4a203c" : "transparent", color: "white", border: 0, borderBottom: `2px solid ${tab === name ? "#f472b6" : "transparent"}`, padding: "14px 20px", cursor: "pointer", fontSize: 15 }}>{name}</button>)}
    </div>
    <div style={{ padding: 24 }}>
      {error && <p role="alert" style={{ color: "#fda4af" }}>{error} <button type="button" style={input} onClick={() => void load()}>Retry</button></p>}
      {loading && <p role="status" style={muted}>Loading settings…</p>}
      {tab === "Sources" && <>
        <form style={formStyle} onSubmit={async (event) => { event.preventDefault(); let name = sourceName.trim(); if (!name) { try { name = new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { /* API will explain the missing name. */ } } if (await send("sources", "POST", { name, feed_url: sourceUrl })) { setSourceName(""); setSourceUrl(""); } }}>
          <input aria-label="Source name" placeholder="Source name" value={sourceName} onChange={(event) => setSourceName(event.target.value)} style={{ ...input, flex: "1 1 180px" }} />
          <input aria-label="Source RSS feed URL" placeholder="RSS feed URL for a new source" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} style={{ ...input, flex: "2 1 280px" }} />
          <button disabled={busy || loading} style={action} aria-label="Add source" title="Add source">+</button>
        </form>
        {sources.filter((row) => row.enabled).map(sourceRow)}
        {sources.some((row) => !row.enabled) && <><h3 style={{ marginBottom: 0 }}>Available sources</h3>{sources.filter((row) => !row.enabled).map(sourceRow)}</>}
      </>}
      {tab === "Keywords" && <>
        {keywordControls}
        <form style={formStyle} onSubmit={async (event) => { event.preventDefault(); if (await send("keywords", "POST", { keyword, category })) setKeyword(""); }}>
          <select required aria-label="Approved keyword or phrase" value={keyword} onChange={(event) => setKeyword(event.target.value)} style={{ ...input, flex: "1 1 240px" }}>
            <option value="" disabled>Choose an approved keyword</option>
            {Object.entries(APPROVED_KEYWORDS).map(([group, words]) => <optgroup key={group} label={group}>{words.map((word) => <option key={word} value={word}>{word}</option>)}</optgroup>)}
          </select>
          <select aria-label="Keyword sentiment (preset)" title="Category is assigned by the approved keyword list" value={category} disabled style={input}><option>Any</option><option>Bullish</option><option>Neutral</option><option>Bearish</option></select>
          <button disabled={busy || loading} style={action} aria-label="Add keyword" title="Add keyword">+</button>
        </form>
        {keywords.filter((row) => row.enabled).map(keywordRow)}
        {keywords.some((row) => !row.enabled) && <><h3 style={{ marginBottom: 0 }}>Available keywords</h3>{keywords.filter((row) => !row.enabled).map(keywordRow)}</>}
      </>}
      {tab === "Accounts" && <>
        {platformSettings.filter((row) => row.enabled).map((row) => <div key={row.id} style={rowStyle}><strong style={{ flex: 1 }}>{row.platform}</strong>{toggle("platforms", row, row.platform)}</div>)}
        {platformSettings.some((row) => !row.enabled) && <><h3 style={{ marginTop: 18 }}>Available socials</h3>{platformSettings.filter((row) => !row.enabled).map((row) => <div key={row.id} style={rowStyle}><strong style={{ flex: 1 }}>{row.platform}</strong>{toggle("platforms", row, row.platform)}</div>)}</>}

      </>}
      {tab === "Config" && config}
    </div>
  </section>;
}
