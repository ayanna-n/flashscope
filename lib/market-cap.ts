/** Finviz exports unsuffixed market capitalization in millions of dollars. */
export function formatMarketCapitalization(value: string) {
  const raw = value.trim();
  if (!raw || raw === "-" || raw === "N/A") return "N/A";
  const match = raw.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return "N/A";
  const amount = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const dollars = amount * (unit ? ({K: 1e3, M: 1e6, B: 1e9, T: 1e12}[unit] ?? 1) : 1e6);
  const scale = dollars >= 1e12 ? [1e12,"T"] : dollars >= 1e9 ? [1e9,"B"] : dollars >= 1e6 ? [1e6,"M"] : dollars >= 1e3 ? [1e3,"K"] : [1,""];
  return `$${(dollars / Number(scale[0])).toLocaleString("en-US", {maximumFractionDigits: 2})}${scale[1]}`;
}
