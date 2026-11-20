"use client";

import { useEffect, useState } from "react";
import { CONFIG_OPTIONS, parseChangeRange } from "@/lib/feed-preferences";

const field = {background: "#210f1c", color: "white", border: "1px solid #713259", borderRadius: 7, padding: "9px 11px"};
export default function ChangeFilter({ value, onChange, compact = false }: { value: string; onChange: (value: string) => void; compact?: boolean }) {
  const [custom, setCustom] = useState(value.startsWith("Custom:"));
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const range = parseChangeRange(value);
    setCustom(!!range);
    setMin(range?.min?.toString() ?? ""); setMax(range?.max?.toString() ?? ""); setError("");
  }, [value]);
  return <div style={{flexShrink: 0}}>
    <label style={{display: compact ? "flex" : "block", alignItems: "center", gap: 8}}>Change<select aria-label="Change" style={{...field, display: "block", marginTop: compact ? 0 : 7, minWidth: 160, width: compact ? 160 : "100%"}} value={custom ? "Custom" : value} onChange={event => {
      setError("");
      if (event.target.value === "Custom") setCustom(true);
      else { setCustom(false); onChange(event.target.value); }
    }}>{CONFIG_OPTIONS.priceChange.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
    {custom && <form style={{display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8}} onSubmit={event => {
      event.preventDefault();
      const encoded = `Custom:${min.trim()}:${max.trim()}`;
      if (!parseChangeRange(encoded)) { setError("Enter at least one bound; minimum must not exceed maximum."); return; }
      setError(""); onChange(encoded);
    }}>
      <input aria-label="Minimum change percent" placeholder="Min %" type="number" step="any" value={min} onChange={event => setMin(event.target.value)} style={{...field, width: 105}} />
      <input aria-label="Maximum change percent" placeholder="Max %" type="number" step="any" value={max} onChange={event => setMax(event.target.value)} style={{...field, width: 105}} />
      <button type="submit" style={{...field, cursor: "pointer"}}>Apply</button>
    </form>}
    {error && <p role="alert" style={{color: "#fda4af", fontSize: 13}}>{error}</p>}
  </div>;
}
