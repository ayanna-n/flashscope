export const APPROVED_KEYWORDS = {
  Any: ["acquisition", "merger", "partnership", "ipo", "reverse split", "stock split", "sec filing", "listing"],
  Neutral: ["earnings call", "annual meeting", "investor presentation", "quarterly report", "conference call", "webcast", "company update", "financial results"],
  Bullish: ["moon", "rip", "breakout", "squeeze", "calls", "long", "bull", "buy", "pump", "runner", "earnings beat", "raises guidance", "fda approval", "contract awarded", "share repurchase", "dividend increase", "revenue growth", "debt reduction", "upgraded", "record revenue", "positive trial results", "acquisition completed"],
  Bearish: ["dump", "puts", "short", "bear", "sell", "offering", "dilution", "crash", "bag", "rug", "earnings miss", "lowers guidance", "fda rejection", "contract terminated", "bankruptcy", "dividend cut", "revenue decline", "default", "downgraded", "going concern", "failed trial", "delisting notice"],
} as const;


export type KeywordCategory = keyof typeof APPROVED_KEYWORDS;
export function approvedKeywordCategory(value: string): KeywordCategory | null {
  const keyword = value.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [category, words] of Object.entries(APPROVED_KEYWORDS)) {
    if ((words as readonly string[]).includes(keyword)) return category as KeywordCategory;
  }
  return null;
}
export const approvedKeywordEntries = Object.entries(APPROVED_KEYWORDS).flatMap(([category, words]) => words.map((keyword) => ({ keyword, category })));
