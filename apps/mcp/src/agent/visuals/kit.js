/**
 * The shared parts of Tex's visual answers (`./index.js`): escaping, the two
 * palettes, the page every template sits in, and the photo slot.
 *
 * The look is Context's own (owner, 2026-10-27: "redesign these card
 * templates in context style"): the app's paper and ink, one indigo accent,
 * Instrument Sans at medium weight, a reading serif for names and notes, and
 * hairline rows rather than boxed tiles. The palettes mirror the app's tokens
 * (`apps/mobile/features/design/tokens/colors.ts`); the serif stands in for
 * the app's Libron, which is not on Google Fonts.
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
  "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600" +
  "&family=JetBrains+Mono:wght@500;600&family=Caveat:wght@600;700&display=swap";

/** The interface voice, and the serif a name or a note is read in. */
export const SANS = "'Instrument Sans', ui-sans-serif, system-ui, sans-serif";
export const SERIF = "'Source Serif 4', Georgia, serif";

export const LIGHT = {
  bg: "#FFFDF9", surface: "#F7F4ED", ink: "#1A1714", body: "#4A443C", muted: "#635C52", line: "rgba(26,23,20,0.09)", track: "#F0ECE3",
  accent: "#2A45CF", accentSoft: "rgba(42,69,207,0.10)", accentInk: "#1F35A3", onAccent: "#FFFFFF",
  warm: "#96600A", warmSoft: "rgba(150,96,10,0.12)", warmInk: "#7A4E08",
  good: "#3E7A4E", goodSoft: "rgba(62,122,78,0.10)", plum: "#6A46B8", gold: "#B08A2E", grey: "#8D857B",
};
export const DARK = {
  bg: "#191715", surface: "#201E1B", ink: "#EDE8E0", body: "#C3BCB2", muted: "#A79F95", line: "rgba(237,232,224,0.10)", track: "#2B2825",
  accent: "#8A9BF2", accentSoft: "rgba(138,155,242,0.14)", accentInk: "#C9D2FA", onAccent: "#100F0E",
  warm: "#DFAC52", warmSoft: "rgba(223,172,82,0.12)", warmInk: "#E9C47E",
  good: "#82C98E", goodSoft: "rgba(130,201,142,0.12)", plum: "#B9A3F2", gold: "#DFAC52", grey: "#8D857B",
};

/** Soft fills for photo slots, cycled, so an empty slot still reads as a picture's place. */
export const TONES = ["#E7DCCB", "#DCD3E0", "#D3DCCB", "#E5D6C3", "#D6DCE3", "#E0D8CC"];

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

/** The words a photo slot of at least `TILE_MIN_HEIGHT` shows when nothing was found for it. */
export const NO_PHOTO = "No photo found";
export const TILE_MIN_HEIGHT = 120;

/**
 * A slot a photo fills. A slot with no photo is a tile with the thing's name
 * and "No photo found", so it says so instead of showing a blank block (Nov Babies, 2026-11-11: Ms.
 * Kim's slot on a karaoke card was blank, the card check held it three
 * times, and it went out blank anyway). A photo sits on the slot's
 * tone, so a transparent logo never shows the tile's words through it. A
 * small slot (an avatar) has no tile, only its tone.
 */
export function photo(value, { height, radius = 14, tone = TONES[0], label = "", extra = "", style = "", name = "" } = {}) {
  const url = photoUrl(value);
  const image = url ? `<div style="position: absolute; inset: 0; border-radius: ${radius}px; background-color: ${tone}; background-image: url('${url}'); background-size: cover; background-position: center"></div>` : "";
  const tag = label && url ? `<div style="position: absolute; left: 8px; bottom: 8px; font-size: 11px; font-weight: 600; padding: 3px 7px; border-radius: 6px; background: rgba(255,253,249,0.92); color: #1A1714">${label}</div>` : "";
  const tile =
    url || height < TILE_MIN_HEIGHT
      ? ""
      : `<div data-no-photo style="position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 12px; text-align: center; color: rgba(26,23,20,0.72)">${name ? `<div style="font-family: ${SERIF}; font-size: ${height >= 250 ? 26 : 20}px; font-weight: 600; line-height: 1.1">${esc(name, 30)}</div>` : ""}<div style="font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.8">${NO_PHOTO}</div></div>`;
  return `<div style="position: relative; overflow: hidden; height: ${height}px; border-radius: ${radius}px; background-color: ${tone}; ${style}">${tile}${image}${tag}${extra}</div>`;
}

/** The small heading every card opens with: a quiet line naming what it is, and a title. */
export function heading(c, kicker, title, { size = 38, font = SANS, kickerColor = c.muted } = {}) {
  return `<div style="display: flex; flex-direction: column; gap: 6px">
${kicker ? `<div style="font-size: 16px; font-weight: 500; color: ${kickerColor}">${esc(kicker, 70)}</div>` : ""}
<div style="font-family: ${font}; font-size: ${Math.round(size * 0.86)}px; line-height: 1.12; font-weight: 600; letter-spacing: -0.015em">${esc(title, 70)}</div>
</div>`;
}

/** The tallest a card that fits its content may grow (the screenshot Worker's limit, at `SCALE`). */
export const FIT_MAX = 1200;

/**
 * The whole page: one fixed card, photographed at `SCALE`. A `fit` card is as
 * tall as what it holds, up to `FIT_MAX`, so a short list has no empty band
 * under it (owner, 2026-10-27); `height` is then only the guess the picture is
 * taken at by a screenshot Worker that can't fit.
 */
export function page(inner, { background, ink, font = SANS, padding = "36px 32px 28px", gap = 20, height = CARD_HEIGHT, fit = false }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS.replace(/&/g, "&amp;")}">
<style>html,body{margin:0;background:${background}}*{box-sizing:border-box}</style></head>
<body><div style="zoom: ${SCALE}; width: ${CARD_WIDTH}px; ${fit ? `max-height: ${FIT_MAX}px` : `height: ${height}px`}; overflow: hidden; padding: ${padding}; background: ${background}; color: ${ink}; font-family: ${font}; display: flex; flex-direction: column; gap: ${gap}px">
${inner}
</div></body></html>`;
}
