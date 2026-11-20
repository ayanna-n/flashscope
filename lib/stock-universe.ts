/** Use Finviz classifications, never a hardcoded ticker exclusion list. */
export function stockScreenerRows<T extends Record<string, string>>(rows: T[]): T[] {
  return rows.filter(row => {
    const industry = (row.Industry ?? "").trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
    return industry !== "exchange traded fund";
  }).sort((left, right) => (left.Ticker ?? "").localeCompare(right.Ticker ?? "", "en", {sensitivity: "base"}));
}
