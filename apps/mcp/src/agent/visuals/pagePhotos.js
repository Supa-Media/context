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
 * Only a picture the write can store goes in. A search hit or a shot can be
 * an AVIF or an SVG, which a note write refuses, and one such picture refused
 * the whole page: Tex in a WhatsApp group, 2026-10-27 23:56, "the save failed
 * four times", each retry hunting the same picture again. So each picture's
 * bytes are checked the way the write checks them, and one it would refuse,
 * or one past the write's size limit, is left out.
 */

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
 * What a page's picture download asks for: never AVIF, which a note write
 * refuses. Asked for AVIF first (as a card's download does), image CDNs
 * answered with it, the hunt took that as found, and the picture was dropped.
 */
export const PAGE_PICTURE_ACCEPT = "image/webp,image/jpeg,image/png,image/gif;q=0.9";
/** The most options hunted for one page write. */
export const MAX_PAGE_HUNTS = 8;
/**
 * How long the hunt may take, all options side by side. Under the note
 * write's own limit (`turn.js`), so a slow site never makes a saved page
 * look like a failed write that is then retried.
 */
export const PAGE_HUNT_TIMEOUT_MS = 12_000;

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
      wanted.push({ name, query: where ? `${name} ${where.slice(0, 60)}` : name, at: item.to, indent });
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
  const got = await Promise.all(wanted.map((option) => within(huntPicture(option.name, option.query, { ...deps, download }).catch(() => null), timeoutMs)));
  const added = [];
  const lines = [];
  let bytes = 0;
  got.forEach((picture, i) => {
    const stored = picture ? storableImage(picture.data) : null;
    if (!stored || bytes + stored.bytes > MAX_UPLOADED_BYTES_PER_WRITE / 2) return;
    bytes += stored.bytes;
    // The bytes name the type, never the address's header: a shot is labelled JPEG whatever it is.
    const data = `data:${stored.contentType};base64,${picture.data.slice(picture.data.indexOf(",") + 1)}`;
    const name = fileName(wanted[i].name, added.length + 1, stored.contentType);
    added.push({ name, data });
    lines.push({ at: wanted[i].at, text: `\n${wanted[i].indent}  photo: ${name}`, name: wanted[i].name });
  });
  if (added.length === 0) return { args, found: [] };
  // From the end, so each offset still points where it did.
  let next = content;
  for (const line of [...lines].sort((a, b) => b.at - a.at)) next = next.slice(0, line.at) + line.text + next.slice(line.at);
  return { args: { ...args, content: next, images: [...images, ...added] }, found: lines.map((line) => line.name.slice(0, 40)) };
}
