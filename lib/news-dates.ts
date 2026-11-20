// Dates must belong to the headline itself or its enclosing listing row.
// Never search neighboring rows: their publication dates may differ.
export function headlineDate(text: string): string | null {
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i)
    ?? text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!match) return null;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = /^\d+$/.test(match[1]) ? Number(match[1]) - 1 : months.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString() : null;
}

export function listingDate(title: string, html: string, anchorStart: number, anchorLength: number): string | null {
  const explicit = headlineDate(title);
  if (explicit) return explicit;
  const candidates: string[] = [];
  for (const tag of ["tr", "li", "article"]) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    for (const match of html.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start <= anchorStart && start + match[0].length >= anchorStart + anchorLength) candidates.push(match[0]);
    }
  }
  const row = candidates.sort((a, b) => a.length - b.length)[0];
  if (!row) return null;
  // Only use a row containing one linked item; broad page sections are ambiguous.
  if ((row.match(/<a\b/gi) ?? []).length !== 1) return null;
  const datetime = row.match(/<time\b[^>]*datetime=["'](\d{4}-\d{2}-\d{2})(?:[T\s][^"']*)?["']/i)?.[1];
  if (datetime) {
    const [year, month, day] = datetime.split("-");
    return headlineDate(`${month}/${day}/${year}`);
  }
  return headlineDate(row.replace(/<[^>]*>/g, " "));
}
