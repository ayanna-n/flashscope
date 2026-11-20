// Treat short single-word searches as whole tokens, so SDA does not match Nasdaq.
export function socialSearchPattern(query: string) {
  const value = query.trim().replace(/^\$/, "");
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /^[a-z0-9.-]{1,10}$/i.test(value)
    ? `(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`
    : escaped;
}
export function matchesSocialSearch(text: string, query: string) {
  return new RegExp(socialSearchPattern(query), "i").test(text);
}

// Decode text only. React still escapes the result; never render it as HTML.
export function decodeSocialText(text: string) {
  const named: Record<string, string> = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };
  let result = text;
  for (let pass = 0; pass < 2; pass++) {
    result = result.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (original, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? original;
      const hex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
    });
  }
  return result;
}
