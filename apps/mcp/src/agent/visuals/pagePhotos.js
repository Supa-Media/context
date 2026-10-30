/**
 * A PAGE'S OPTIONS SHOW THEIR PICTURES TOO.
 *
 * Every new note Tex makes is a designed page (owner, 2026-10-27, 21:08), and
 * a page's places, vote options, prices and stops each have a photo slot.
 * The page design skill tells Tex to fill them, but a slot left empty showed
 * the thing's initial on a tint, and Tex left them empty. The owner, 21:49:
 * comparisons "need to show screenshots of the things PLEASE".
 *
 * So a page write from a texted turn is read before it is saved: every option
 * in one of those blocks with no `photo:` or `photos:` gets one hunted for
 * the way a card's are (`./hunt.js`: a picture search through the turn's own
 * web tools, else a screenshot of its own page). Each found picture goes in
 * the write's `images` as bytes, and a `photo:` field naming it is added
 * under the option, so the page and its export carry it like any picture the
 * writer attached (`notes/uploadedImages.js` rewrites the field to the stored
 * copy). The page's words are otherwise left exactly as written.
 *
 * Only a picture the write can store goes in. A search hit can be an AVIF or
 * an SVG, which a note write refuses, and one such picture refused the whole
 * page: Tex in a WhatsApp group, 2026-10-27 23:56, "the save failed four
 * times", each retry hunting the same picture again. So a picture is asked
 * for in a stored format first, and one that still comes as AVIF or SVG is
 * opened in the browser and photographed as a JPEG (`storableDownload`); the
 * owner, 2026-10-28: "can't we convert it? cant we screenshot it?". Each
 * picture's bytes are still checked the way the write checks them, as the
 * last guard.
 */

/** What a page's picture is asked for as: only formats a note stores, so a site that would send AVIF sends one of these. */
export const STORABLE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif;q=0.8";

/**
 * `download` for a page's hunt: the picture asked for in a stored format, and
 * one that still comes in a format a note can't store photographed in the
 * browser by `shoot(address)`, which turns whatever it draws into a JPEG.
 * Null when neither gives a storable picture, so the hunt tries its next way.
 */
export function storableDownload(download, shoot) {
  return async (address) => {
    const data = await download(address, { accept: STORABLE_ACCEPT });
    if (data === null || data === undefined) return null;
    if (storableImage(data)) return data;
    const shot = typeof shoot === "function" ? await shoot(address) : null;
    return shot && storableImage(shot) ? shot : null;
  };
}

import { isPagePath, parsePage } from "../../../../../packages/shared/src/pages/parse.cjs";
import { MAX_IMAGES_PER_WRITE, MAX_UPLOADED_BYTES_PER_WRITE, storableImage } from "../../notes/uploadedImages.js";
import { huntPicture, within } from "./hunt.js";

/**
 * The blocks whose options each show a photo (`packages/shared/src/pages/blocks.cjs`).
 * `choose` too: the birthday plan of 2026-10-28 put its three venues in a
 * `choose` block, none was hunted, and the page went out with no picture at all.
 */
export const PICTURED_KINDS = new Set(["places", "vote", "prices", "itinerary", "choose"]);
/**
 * Photos hunted for each place, for its carousel (owner, 2026-10-28: "show
 * more images of the different options"). Every option gets its first
 * picture before any gets a second, within the write's ten.
 */
export const PHOTOS_PER_PLACE = 3;
/** The most options hunted for one page write. */
export const MAX_PAGE_HUNTS = 8;
/**
 * How long the hunt may take, all options side by side. Under the note
 * write's own limit (`turn.js`), so a slow site never makes a saved page
 * look like a failed write that is then retried.
 */
export const PAGE_HUNT_TIMEOUT_MS = 14_000;

/** Every block on the page, wherever it sits (a section, a tab). */
function blocksIn(nodes, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.type === "block") out.push(node);
    for (const value of Object.values(node ?? {})) if (Array.isArray(value) && value.some((child) => child?.type)) blocksIn(value, out);
  }
  return out;
}

/** What an option is called: a stop's words after its time, else its label, else its first part. */
function nameOf(kind, item) {
  const first = item.parts?.[0]?.text?.trim() ?? "";
  if (kind === "itinerary") return first;
  return item.label?.text?.trim() || first;
}

/** The first fact of a choice's words, when it is short enough to be a place: "1 Penn Plaza" of "1 Penn Plaza · heaters". */
function whereIn(text) {
  const first = String(text ?? "").split(/\s[·|•;]\s|,\s/)[0].trim();
  return first.length >= 3 && first.length <= 40 ? first : "";
}

const hasPhoto = (item) => (item.fields ?? []).some((field) => field.key === "photo" || field.key === "photos");

/** A file name for an option's picture: its name in plain letters, numbered so two never clash. */
function fileName(name, n, type) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "option";
  return `${slug}-${n}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`;
}

/**
 * The options on a page that want a picture: in a pictured block, named,
 * with no photo field. Each with where its `photo:` line goes and how deep.
 */
export function unpictured(content) {
  const wanted = [];
  for (const block of blocksIn(parsePage(content).nodes)) {
    if (!PICTURED_KINDS.has(block.kind)) continue;
    for (const item of block.items ?? []) {
      const name = nameOf(block.kind, item);
      if (name.length < 2 || hasPhoto(item)) continue;
      const lineStart = content.lastIndexOf("\n", item.from - 1) + 1;
      const indent = /^[ \t]*/.exec(content.slice(lineStart))[0];
      // A place's address helps the search find this place and not another of its name; a choice's first fact likewise ("1 Penn Plaza").
      const where = block.kind === "places" ? item.parts?.[0]?.text?.trim() ?? "" : block.kind === "choose" && item.label ? whereIn(item.parts?.[0]?.text) : "";
      wanted.push({ name, query: where ? `${name} ${where.slice(0, 60)}` : name, at: item.to, indent, want: block.kind === "places" ? PHOTOS_PER_PLACE : 1 });
    }
  }
  return wanted;
}

/**
 * A `write_note` of a page with its options' missing pictures hunted for and
 * put in, or the arguments as they were. `deps` are `./hunt.js`'s.
 */
export async function withPagePictures(args, deps, { timeoutMs = PAGE_HUNT_TIMEOUT_MS } = {}) {
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  const content = typeof args?.content === "string" ? args.content : "";
  if (!isPagePath(path) || content === "") return { args, found: [] };
  const images = Array.isArray(args.images) ? args.images : [];
  const room = Math.min(MAX_PAGE_HUNTS, MAX_IMAGES_PER_WRITE - images.length);
  if (room <= 0) return { args, found: [] };
  const wanted = unpictured(content).slice(0, room);
  if (wanted.length === 0) return { args, found: [] };
  // A picture the write would refuse counts as none, so the hunt tries the next one (a search's next hit, then a screenshot).
  const download = async (address) => {
    const data = await deps.download(address);
    return data && storableImage(data) ? data : null;
  };
  const got = await Promise.all(wanted.map((option) => within(huntPicture(option.name, option.query, { ...deps, download }, { want: option.want }).catch(() => null), timeoutMs)));
  const added = [];
  const names = wanted.map(() => []);
  let bytes = 0;
  const keep = (i, picture) => {
    const stored = storableImage(picture);
    if (!stored || added.length >= MAX_IMAGES_PER_WRITE - images.length || bytes + stored.bytes > MAX_UPLOADED_BYTES_PER_WRITE / 2) return;
    bytes += stored.bytes;
    // The bytes name the type, never the address's header: a shot is labelled JPEG whatever it is.
    const data = `data:${stored.contentType};base64,${picture.slice(picture.indexOf(",") + 1)}`;
    const name = fileName(wanted[i].name, added.length + 1, stored.contentType);
    added.push({ name, data });
    names[i].push(name);
  };
  // Every option's first picture, then the rest of each one's, so one place's carousel never costs another its photo.
  got.forEach((picture, i) => picture && keep(i, picture.data));
  got.forEach((picture, i) => names[i].length > 0 && (picture.more ?? []).forEach((more) => keep(i, more)));
  const lines = wanted
    .map((option, i) => ({ at: option.at, name: option.name, text: names[i].length === 0 ? "" : `\n${option.indent}  ${names[i].length > 1 ? "photos" : "photo"}: ${names[i].join(", ")}` }))
    .filter((line) => line.text !== "");
  if (added.length === 0) return { args, found: [] };
  // From the end, so each offset still points where it did.
  let next = content;
  for (const line of [...lines].sort((a, b) => b.at - a.at)) next = next.slice(0, line.at) + line.text + next.slice(line.at);
  return { args: { ...args, content: next, images: [...images, ...added] }, found: lines.map((line) => line.name.slice(0, 40)) };
}
