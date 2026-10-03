/**
 * HTML character references, decoded so the sanitizer works on the text a
 * browser would see and then re-escapes it. Only the references people type
 * are named here; any other `&name;` stays literal text, which a browser
 * would show the same way once it is re-escaped as `&amp;name;`.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  star: "☆",
  hearts: "♥",
  check: "✓",
  shy: "\u00ad",
  zwj: "\u200d",
  zwnj: "\u200c",
};

function codePoint(value: number): string {
  if (
    !Number.isFinite(value) ||
    value === 0 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    return "\ufffd";
  }
  return String.fromCodePoint(value);
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));?/g,
    (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
      // A named reference needs its semicolon; `&copy` in a URL query is text.
      if (!whole.endsWith(";")) return whole;
      return NAMED[name!] ?? whole;
    },
  );
}

/** Safe in text and inside a double- or single-quoted attribute alike. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
