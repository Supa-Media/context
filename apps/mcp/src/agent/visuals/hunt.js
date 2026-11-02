/**
 * A COMPARISON SHOWS EACH THING. THE GATEWAY GOES AND GETS THE PICTURE.
 *
 * Dev2, 2026-10-27: "it's super important that when Tex is showing
 * comparisons, for food, locations, countries etc, that we are visual, we
 * need to show screenshots of the things PLEASE, Tex needs to stop quitting
 * so soon, it has a whole computer."
 *
 * Until now a card's photos came only from what the model had read (and,
 * from `./photos.js`, what the gateway could match by name in it). A model in
 * a hurry read no pages and searched no pictures, so options went out as
 * names on a blank card. Telling it to "search and draw again" in the draw
 * result was a note it could ignore, and did.
 *
 * So, after the photos the turn read are downloaded, every option still
 * without one is hunted here, side by side, before the card is drawn:
 *
 * 1. **A picture search** for its name (with the business, or where the
 *    places are), through the turn's own web tools, so it is counted against
 *    the turn's searches and its results are read like any other. The first
 *    picture that downloads goes on the card, one described by the name
 *    first.
 * 2. **A screenshot of its own page**, when no picture came: a search result
 *    the turn already has whose title names it, else one more web search,
 *    photographed by the screenshot Worker at desktop width.
 *
 * Only what is still missing after both is left off, and the draw result
 * names it, so the model can open that thing's page itself.
 */

import { names, pagesIn } from "./photos.js";

/** The cards that set things side by side, and so need each one shown. */
export const HUNTED_TEMPLATES = new Set(["option", "gallery", "versus", "places", "compare"]);
/** The most things hunted for one card: a places card's six. */
export const MAX_HUNTED = 6;
/** Pictures from one search tried before the next way. */
const TRIES_PER_SEARCH = 3;
/** How long one thing's hunt may take, both ways, before the card is drawn without it. */
export const HUNT_TIMEOUT_MS = 24_000;

const blank = (value) => typeof value !== "string" || value.trim() === "";
const RESULT_LINE = /^\d+\. (.*) - (https:\/\/\S+)$/;

/** The things on a card that each want a picture: an option card is itself one. */
function thingsOf(template, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  if (template === "option") return [data];
  return Array.isArray(data.items) ? data.items.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}

/** What a picture search for one thing says besides its name: the business, the kind, or where the places are. */
function queryFor(template, data, item) {
  const name = String(item.name).trim().slice(0, 80);
  const extra = [item.source, template === "option" ? null : data.source, item.cuisine, template === "places" ? data.near : null]
    .filter((part) => typeof part === "string" && part.trim() !== "" && !names(name, part))
    .map((part) => part.trim().slice(0, 40));
  return [name, ...extra.slice(0, 1)].join(" ");
}

/** Whether a thing still needs a picture: it has a name, and no photo the card will show. */
function wants(item, shown) {
  if (blank(item.name)) return false;
  if (blank(item.photo)) return true;
  const photo = item.photo.trim();
  // A picture this turn drew, made or was sent stays; a web address shows only if it downloaded.
  return /^https:/i.test(photo) && !shown(photo);
}

/** A search result the turn read whose title names this thing: its own page, to photograph. */
export function pageNamed(text, name) {
  for (const line of String(text ?? "").split("\n")) {
    const m = RESULT_LINE.exec(line.trim());
    if (m && names(m[1], name)) return m[2];
  }
  return null;
}

/** The first result of a web search's words, one titled with the name first. */
function firstResult(text, name) {
  const results = String(text ?? "")
    .split("\n")
    .map((line) => RESULT_LINE.exec(line.trim()))
    .filter(Boolean);
  return (results.find((m) => names(m[1], name)) ?? results[0])?.[2] ?? null;
}

const words = (result) => (Array.isArray(result?.content) ? result.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "");

/** The pictures a picture search found, those described by the name first, each with its smaller copy. */
function picturesFound(text, name, limit = TRIES_PER_SEARCH) {
  const found = pagesIn(text).flatMap((page) => page.pictures);
  const spares = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^- .* - (https:\/\/\S+) \(smaller copy: (https:\/\/\S+)\)$/.exec(line);
    if (m) spares.set(m[1], m[2]);
  }
  const named = found.filter((picture) => names(picture.alt, name));
  const rest = found.filter((picture) => !named.includes(picture));
  return [...named, ...rest].slice(0, limit).map((picture) => ({ src: picture.src, spare: spares.get(picture.src) ?? null }));
}

export function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * One thing's picture, by its name and the words to search: searched, else its page photographed. `web(name, args)`
 * is the turn's web tools; `download(address)` a data address or null;
 * `shoot(url)` a data address of the page or null; `read()` the turn's words.
 * `want` above 1 also returns up to that many more of the same search's
 * pictures in `more`, for a page's carousel (`./pagePhotos.js`).
 */
export async function huntPicture(name, query, { web, download, shoot, read }, { want = 1 } = {}) {
  if (typeof web === "function") {
    const searched = await Promise.resolve(web("search_web", { query, pictures: true })).catch(() => null);
    if (searched && searched.isError !== true) {
      const found = picturesFound(words(searched), name, Math.max(TRIES_PER_SEARCH, want * 2));
      const fetch = async (picture) => (await download(picture.src)) ?? (picture.spare ? await download(picture.spare) : null);
      for (let k = 0; k < Math.min(found.length, TRIES_PER_SEARCH); k += 1) {
        const got = await fetch(found[k]);
        if (!got) continue;
        const rest = want > 1 ? await Promise.all(found.slice(k + 1).map((picture) => fetch(picture).catch(() => null))) : [];
        const more = [...new Set(rest.filter((data) => data && data !== got))].slice(0, want - 1);
        return { how: "searched", address: found[k].src, data: got, more };
      }
    }
  }
  if (typeof shoot !== "function") return null;
  let page = pageNamed(read(), name);
  if (page === null && typeof web === "function") {
    const searched = await Promise.resolve(web("search_web", { query })).catch(() => null);
    if (searched && searched.isError !== true) page = firstResult(words(searched), name);
  }
  if (page === null) return null;
  const shot = await shoot(page);
  return shot ? { how: "screenshot", address: page, data: shot } : null;
}

/**
 * The card's things that still had no picture, hunted for side by side.
 * `shown(address)` is whether a web photo already downloaded. Returns the
 * data with each found picture named by a key the caller maps to its bytes
 * (`hunted:N`), those bytes by key, and which things came which way.
 */
export async function huntPhotos(template, data, { shown = () => false, web = null, download, shoot = null, read = () => "", timeoutMs = HUNT_TIMEOUT_MS } = {}) {
  const none = { data, pictures: new Map(), searched: [], screenshots: [], missing: [] };
  if (!HUNTED_TEMPLATES.has(template) || typeof download !== "function") return none;
  const wanted = thingsOf(template, data).filter((item) => wants(item, shown)).slice(0, MAX_HUNTED);
  if (wanted.length === 0) return none;
  const found = await Promise.all(wanted.map((item) => within(huntPicture(String(item.name).trim(), queryFor(template, data, item), { web, download, shoot, read }).catch(() => null), timeoutMs)));
  const byItem = new Map();
  const pictures = new Map();
  const searched = [];
  const screenshots = [];
  const missing = [];
  wanted.forEach((item, i) => {
    const label = String(item.name).trim().slice(0, 40);
    const got = found[i];
    if (!got) return void missing.push(label);
    const key = `hunted:${pictures.size + 1}`;
    pictures.set(key, got.data);
    byItem.set(item, key);
    (got.how === "searched" ? searched : screenshots).push(label);
  });
  const fill = (item) => (byItem.has(item) ? { ...item, photo: byItem.get(item) } : item);
  const out = template === "option" ? fill(data) : { ...data, items: data.items.map(fill) };
  return { data: out, pictures, searched, screenshots, missing };
}

/** The screenshot Worker's photograph of a public page at desktop width, as a data address, or null. */
export function shooterFor(shots, { timeoutMs = 20_000 } = {}) {
  if (typeof shots?.fetch !== "function") return null;
  return async (url) => {
    try {
      const response = await shots.fetch("https://site-shots/shoot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, sizes: ["desktop"] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => null);
      const jpeg = response.ok && Array.isArray(body?.shots) ? body.shots[0]?.jpeg : null;
      return typeof jpeg === "string" && jpeg.length > 0 ? `data:image/jpeg;base64,${jpeg}` : null;
    } catch {
      return null;
    }
  };
}
