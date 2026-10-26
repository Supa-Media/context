/**
 * The shared parts of Tex's visual answers (`./index.js`): escaping, the two
 * palettes, the page every template sits in, and the photo slot.
 *
 * Every word on a visual is the model's, and so is every address, so nothing
 * it hands over is ever written into the page unescaped: text goes through
 * `esc`, an address through `photoUrl`, a colour or a length is chosen here
 * and never taken from the data. A template cannot be talked into a script,
 * a style of its own or a request the screenshot Worker would not stop anyway.
 */

/** The card is designed at this size and photographed at twice it, so it reads on a phone. */
export const CARD_WIDTH = 600;
export const CARD_HEIGHT = 750;
export const SCALE = 2;

const FONTS =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Inter+Tight:wght@600;700;800" +
  "&family=Fraunces:opsz,wght@9..144,600;9..144,700&family=JetBrains+Mono:wght@500;700&family=Caveat:wght@600;700&display=swap";

export const LIGHT = {
  bg: "#F6F5F1", surface: "#FFFFFF", ink: "#16161A", body: "#3E3E44", muted: "#5F5F66", line: "#E3E1DA", track: "#ECEAE3",
  accent: "#1F5FD1", accentSoft: "#E3ECFB", accentInk: "#16244A", warm: "#B4540A", warmSoft: "#FBEBDD", warmInk: "#5A2C05",
  good: "#1E7B4A", goodSoft: "#E2F0E7", plum: "#7A4BC2", gold: "#C79A1B", grey: "#8B8B95",
};
export const DARK = {
  bg: "#121316", surface: "#1C1D21", ink: "#F1F1F3", body: "#D2D2D8", muted: "#A9A9B3", line: "#2E3036", track: "#2A2C31",
  accent: "#7AA7FF", accentSoft: "#1E2A44", accentInk: "#C9DAFF", warm: "#F0A35C", warmSoft: "#3A2A1C", warmInk: "#F6D2B0",
  good: "#6FD9A3", goodSoft: "#1E3A2B", plum: "#B595F0", gold: "#E8C35A", grey: "#8B8B95",
};

/** Soft fills for photo slots, cycled, so an empty slot still reads as a picture's place. */
export const TONES = ["#D6CBB8", "#C8D2DC", "#D9C9D3", "#C9D3BE", "#E1C9A9", "#CFC6B8"];

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text the model wrote, safe anywhere in the page, and cut to `max`. */
export function esc(value, max = 200) {
  if (value === null || value === undefined) return "";
  const text = String(typeof value === "object" ? "" : value).replace(/\s+/g, " ").trim();
  const cut = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return cut.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** A list the model handed over, at most `max` entries, each an object. */
export function list(value, max) {
  return (Array.isArray(value) ? value : []).filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, max);
}

/** A finite number, or null. "$1,250" and "1.2s" are read as their numbers. */
export function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const n = Number(value.replace(/[^0-9.\-]/g, ""));
  return value.trim() !== "" && Number.isFinite(n) ? n : null;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const pct = (n) => `${clamp(n, 0, 100).toFixed(1)}%`;

/**
 * A picture's address for a CSS `url()`: an https address (the Worker loads it
 * only if the turn read it) or a picture this turn has by name
 * (`picture:N`, `attachment:N`, `earlier-photo:N`, `last-picture`), which
 * `pictureMaker.js` puts in before the page is drawn. Anything else is no picture.
 */
export function photoUrl(value) {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  if (/^(?:attachment|picture|earlier-photo):\d{1,2}$|^last-picture$/.test(ref)) return ref;
  // A photo the gateway downloaded for the card (`./photos.js`), put in as data once the page is built.
  if (/^card-photo:\d{1,2}$/.test(ref)) return ref;
  if (ref.length > 2000 || !/^https:\/\/[^\s"'()<>\\]+$/.test(ref)) return null;
  // The page decodes a character reference in its style attribute before CSS reads it: &#39; would close the url('…').
  if (/&(?:#|[a-z][a-z0-9]*;)/i.test(ref)) return null;
  return ref;
}

/**
 * A slot a photo fills: its tone shows through when there is no photo, or the
 * one named did not load, so a missing picture is a quiet block, never a
 * broken-image icon.
 */
export function photo(value, { height, radius = 14, tone = TONES[0], label = "", extra = "", style = "" } = {}) {
  const url = photoUrl(value);
  const image = url ? `background-image: url('${url}'); background-size: cover; background-position: center;` : "";
  const tag = label ? `<div style="position: absolute; left: 8px; bottom: 8px; font-size: 11px; font-weight: 600; padding: 3px 7px; border-radius: 6px; background: rgba(255,255,255,0.88); color: #16161A">${label}</div>` : "";
  return `<div style="position: relative; height: ${height}px; border-radius: ${radius}px; background-color: ${tone}; ${image} ${style}">${tag}${extra}</div>`;
}

/** The small heading every card opens with: a kicker line and a title. */
export function heading(c, kicker, title, { size = 38, font = "'Inter Tight', Inter, sans-serif", kickerColor = c.muted } = {}) {
  return `<div style="display: flex; flex-direction: column; gap: 8px">
${kicker ? `<div style="font-size: 15px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ${kickerColor}">${esc(kicker, 70)}</div>` : ""}
<div style="font-family: ${font}; font-size: ${size}px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em">${esc(title, 70)}</div>
</div>`;
}

/** The whole page: one fixed card, photographed at `SCALE`. */
export function page(inner, { background, ink, font = "Inter, system-ui, sans-serif", padding = "36px 32px 28px", gap = 20, height = CARD_HEIGHT }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS.replace(/&/g, "&amp;")}">
<style>html,body{margin:0;background:${background}}*{box-sizing:border-box}</style></head>
<body><div style="zoom: ${SCALE}; width: ${CARD_WIDTH}px; height: ${height}px; overflow: hidden; padding: ${padding}; background: ${background}; color: ${ink}; font-family: ${font}; display: flex; flex-direction: column; gap: ${gap}px">
${inner}
</div></body></html>`;
}
