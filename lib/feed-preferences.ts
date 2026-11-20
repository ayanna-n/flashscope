export const CONFIG_OPTIONS = {
  marketCap: ["Nano (under $50M)", "Micro (under $300M)", "Small (under $2B)", "Any"],
  relativeVolume: ["Over 5", "Over 3", "Over 2", "Any"],
  currentVolume: ["Over 100K", "Over 500K", "Over 1M", "Any"],
  priceChange: ["Any", "Up", ...[1,2,3,4,5,6,7,8,9,10,15,20].map(n => `Up ${n}%`), "Down", ...[1,2,3,4,5,6,7,8,9,10,15,20].map(n => `Down ${n}%`), "Custom"],
  rollingWindow: ["15", "30", "60"],
  newsDate: ["Today", "Previous 3 days", "Previous 7 days", "Previous 3 months", "Any"],
} as const;
export type FeedConfig = { [K in keyof typeof CONFIG_OPTIONS]: string } & { verifiedOnly: boolean; applyNewsKeywords: boolean };
export const DEFAULT_FEED_CONFIG: FeedConfig = { marketCap: "Any", relativeVolume: "Over 5", currentVolume: "Over 100K", priceChange: "Any", rollingWindow: "60", newsDate: "Previous 3 days", verifiedOnly: false, applyNewsKeywords: false };
export function parseChangeRange(value: string): { min: number | null; max: number | null } | null {
  const match = value.match(/^Custom:(-?\d+(?:\.\d+)?)?:(-?\d+(?:\.\d+)?)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const min = match[1] ? Number(match[1]) : null;
  const max = match[2] ? Number(match[2]) : null;
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)) || (min !== null && max !== null && min > max)) return null;
  return { min, max };
}
export function changeLabel(value: string) {
  const range = parseChangeRange(value);
  return range ? `Custom (${range.min === null ? "any" : `${range.min}%`} to ${range.max === null ? "any" : `${range.max}%`})` : value;
}
export function validConfigValue(key: string, value: unknown) {
  if (key === "priceChange" && typeof value === "string" && value.startsWith("Custom")) return parseChangeRange(value) !== null;
  if (key === "verifiedOnly" || key === "applyNewsKeywords") return typeof value === "boolean";
  return Object.prototype.hasOwnProperty.call(CONFIG_OPTIONS, key) && typeof value === "string" && (CONFIG_OPTIONS[key as keyof typeof CONFIG_OPTIONS] as readonly string[]).includes(value);
}
export function matchesKeywords(text: string, keywords: string[]) {
  if (!keywords.length) return true;
  return keywords.some((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
  });
}
function amount(raw: string, bareScale = 1) {
  const cleaned = raw.trim().replace(/[$,%\s,]/g, "");
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return null;
  const scale = match[2] ? ({K:1e3,M:1e6,B:1e9,T:1e12}[match[2].toUpperCase()] ?? 1) : bareScale;
  return Number(match[1]) * scale;
}
export function matchesPriceChange(change: number, selection: string) {
  if (selection === "Any") return true;
  if (!Number.isFinite(change)) return false;
  const range = parseChangeRange(selection);
  if (range) return (range.min === null || change >= range.min) && (range.max === null || change <= range.max);
  if (selection === "Up") return change > 0;
  if (selection === "Down") return change < 0;
  const match = selection.match(/^(Up|Down) (\d+)%$/);
  return !!match && (match[1] === "Up" ? change >= Number(match[2]) : change <= -Number(match[2]));
}
export function changeFilter(selection: string) {
  if (selection === "Up") return "ta_change_u";
  if (selection === "Down") return "ta_change_d";
  const match = selection.match(/^(Up|Down) (\d+)%$/);
  return match ? `ta_change_${match[1] === "Up" ? "u" : "d"}${match[2]}` : undefined;
}
export function matchesStockConfig(stock: { marketCap: string; volume: string; relativeVolume: number | null; change: number }, config: FeedConfig) {
  const cap = amount(stock.marketCap, 1e6), volume = amount(stock.volume);
  const capMax = ({"Nano (under $50M)":50e6,"Micro (under $300M)":300e6,"Small (under $2B)":2e9} as Record<string,number>)[config.marketCap];
  const volumeMin = ({"Over 100K":1e5,"Over 500K":5e5,"Over 1M":1e6} as Record<string,number>)[config.currentVolume];
  const relativeMin = ({"Over 5":5,"Over 3":3,"Over 2":2} as Record<string,number>)[config.relativeVolume];
  return (!capMax || (cap !== null && cap < capMax)) && (!volumeMin || (volume !== null && volume > volumeMin)) &&
    (!relativeMin || (stock.relativeVolume !== null && stock.relativeVolume > relativeMin)) &&
    matchesPriceChange(stock.change, config.priceChange);
}
export function finvizFilters(config: FeedConfig) {
  return [({"Over 100K":"sh_curvol_o100","Over 500K":"sh_curvol_o500","Over 1M":"sh_curvol_o1000"} as Record<string,string>)[config.currentVolume],
    ({"Over 5":"sh_relvol_o5","Over 3":"sh_relvol_o3","Over 2":"sh_relvol_o2"} as Record<string,string>)[config.relativeVolume],
    changeFilter(config.priceChange)].filter(Boolean).join(",");
}
