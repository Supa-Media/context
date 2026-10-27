/**
 * THE PHOTOS ON A CARD ARE REAL, OR THERE IS NO SLOT.
 *
 * Dev2's first card of places (2026-10-26, "dinner options near chelsea")
 * had empty coloured blocks where the dishes should have been: Tex had read
 * Time Out's photos, but the screenshot Worker's browser could not load them,
 * so the card went out with nothing in them, and the redraw left photos off.
 * "Didn't even fill in the dishes, or logos … not really a helpful card."
 *
 * So the gateway now does two things before a card is drawn:
 *
 * - **Fills what the model left out.** A place, option or thing with no
 *   photo gets one from a page the turn read: a picture whose description
 *   names it, else the share picture of a page titled with its name; and a
 *   logo, the site's own mark (`infra/site-shots/src/read.ts`), from a page
 *   titled with its name. Only addresses the turn read are ever used, the
 *   rule `outgoingPictures.vouches` keeps.
 * - **Downloads every photo itself**, and puts it in the page as data. A
 *   photo that will not download (refused, not a picture, too big, too slow)
 *   is taken off the card, so its slot is never drawn empty.
 */

/** Fields that hold a picture, on a card or on one of its items. */
const PICTURE_KEYS = ["photo", "logo"];
/** What a card may show, by its type as the site sends it. */
const PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml"]);
export const MAX_PHOTO_BYTES = 1_500_000;
/** Four places with a photo and a logo each, and an option card's one. */
export const MAX_PHOTOS = 10;
export const PHOTO_TIMEOUT_MS = 6_000;
/** The shortest name worth matching on: "Bar" names half a page. */
const MIN_NAME = 4;

/** A name as it is compared: "Hav & Mar" and "hav and mar" are one. */
function plain(value) {
  return ` ${String(value)
    .toLowerCase()
    .replace(/&(?:amp;)?/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/** Whether `text` names `name`, as whole words. */
export function names(text, name) {
  const wanted = plain(name);
  return wanted.trim().length >= MIN_NAME && plain(text).includes(wanted);
}

/**
 * The pages a turn read, out of its tool results' words: each page's title,
 * its pictures and its logo, as `computer.js` `pageText` writes them.
 */
export function pagesIn(text) {
  const pages = [];
  for (const block of String(text ?? "").split("This is the content of a web page.").slice(1)) {
    const title = /^Title: (.*)$/m.exec(block)?.[1] ?? "";
    const logo = /^Logo \(a logo for draw_visual\): (https:\/\/\S+)$/m.exec(block)?.[1] ?? null;
    const pictures = [];
    const listed = block.split(/^Pictures on the page[^\n]*\n/m)[1] ?? "";
    for (const line of listed.split("\n")) {
      const m = /^- (.*) - (https:\/\/\S+)$/.exec(line);
      if (!m) break;
      pictures.push({ alt: m[1], src: m[2] });
    }
    pages.push({ title, logo, pictures });
  }
  return pages;
}

/** A photo for something by name, from the pages read: one described by its name, else the share picture of its own page. */
export function photoFor(pages, name) {
  for (const page of pages) for (const picture of page.pictures) if (names(picture.alt, name)) return picture.src;
  for (const page of pages) if (names(page.title, name) && page.pictures.length > 0) return page.pictures[0].src;
  return null;
}

/** A logo for something by name: the mark of a page titled with its name. */
export function logoFor(pages, name) {
  for (const page of pages) if (page.logo && names(page.title, name)) return page.logo;
  return null;
}

const blank = (value) => typeof value !== "string" || value.trim() === "";

/**
 * The card's data with photos and logos filled in from the pages read, and
 * the names that got one. A `logo` is filled only where the template has a
 * place for it (`places`); anything the model gave is kept as given.
 */
export function fillPictures(template, data, text) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { data, filled: [] };
  const pages = pagesIn(text);
  if (pages.length === 0) return { data, filled: [] };
  const filled = [];
  const fill = (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || blank(item.name)) return item;
    const out = { ...item };
    if (blank(out.photo)) {
      const found = photoFor(pages, out.name);
      if (found) out.photo = found;
    }
    if (template === "places" && blank(out.logo)) {
      const found = logoFor(pages, out.name);
      if (found) out.logo = found;
    }
    if (out.photo !== item.photo || out.logo !== item.logo) filled.push(String(out.name).slice(0, 40));
    return out;
  };
  const out = fill(data);
  if (Array.isArray(data.items)) out.items = data.items.map(fill);
  return { data: out, filled };
}

/** Every https picture a card names, once each, card first. */
export function pictureAddresses(data) {
  const found = new Set();
  const visit = (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const key of PICTURE_KEYS) if (typeof item[key] === "string" && /^https:\/\//i.test(item[key].trim())) found.add(item[key].trim());
    for (const value of Object.values(item)) if (Array.isArray(value)) value.forEach(visit);
  };
  visit(data);
  return [...found];
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** One picture as a data address, or null when it will not come: refused, not a picture, too big or too slow. */
export async function downloadPhoto(address, fetchImpl = fetch, { headers = {}, cf } = {}) {
  try {
    const response = await fetchImpl(address, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", "user-agent": "Mozilla/5.0 (compatible; ContextTex/1.0; +https://context.lc)", ...headers },
      ...(cf ? { cf } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    if (typeof response.url === "string" && response.url !== "" && !response.url.startsWith("https://")) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!PICTURE_TYPES.has(type)) return null;
    if (Number(response.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return null;
    return `data:${type};base64,${base64(bytes)}`;
  } catch {
    return null;
  }
}

/** The pictures that came, by address: at most `MAX_PHOTOS`, fetched side by side. */
export async function downloadPhotos(addresses, fetchImpl = fetch) {
  const wanted = addresses.slice(0, MAX_PHOTOS);
  const got = await Promise.all(wanted.map((address) => downloadPhoto(address, fetchImpl)));
  return new Map(wanted.map((address, i) => [address, got[i]]).filter(([, data]) => data !== null));
}
