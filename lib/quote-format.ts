export type Quote = Record<string, string>;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function pick(record: Quote, names: string[]) {
  for (const name of names) {
    const key = Object.keys(record).find((key) => normalize(key) === normalize(name));
    if (key && record[key] !== undefined && record[key] !== "") return record[key];
  }
  return "";
}
function numeric(s: string) {
  if (!s.trim() || s === "-") return null;
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
export function fieldValue(record: Quote, label: string, names: string[]) {
  const raw = pick(record, names);
  if (label === "52W Range") {
    if (raw && !raw.includes("%")) return raw;
    const low = pick(record, ["52-Week Low", "52W Low"]), high = pick(record, ["52-Week High", "52W High"]);
    const l = numeric(low), h = numeric(high);
    if (l === null || h === null) return "";
    // Percentage distances may be based on a different quote timestamp. Do not
    // reconstruct absolute highs/lows from mixed observations.
    if (low.includes("%") || high.includes("%")) return "";
    if (!low.includes("%") && !high.includes("%") && l >= 0 && h >= l) return `$${l.toFixed(2)} – $${h.toFixed(2)}`;
    return "";
  }
  if (!raw || raw === "-") return raw;
  if (label === "Market Cap" || label === "Avg Volume") {
    if (/[KMBT]$/i.test(raw.trim())) return raw;
    const n = numeric(raw.replace(/,/g, ""));
    return n === null ? raw : `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}${label === "Market Cap" ? "M" : "K"}`;
  }
  if (label === "Volume") {
    const n = numeric(raw.replace(/,/g, ""));
    return n === null ? raw : n.toLocaleString("en-US");
  }
  return raw;
}
export function matchingQuote(records: Quote[], ticker: string) {
  return records.find((r) => (r.Ticker ?? "").trim().toUpperCase() === ticker) ?? null;
}
