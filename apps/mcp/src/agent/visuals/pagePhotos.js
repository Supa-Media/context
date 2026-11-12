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
 * Blocks whose rows show a photo once they have one, hunted after the
 * options above (owner, 2026-11-10, on a page of new churches and their
 * pastors: "no photos of church logos, no photos of the lead pastors, no
 * buildings, WE NEED TO MAKE VISUAL PAGES"). A person's photo is searched by
 * their name with their role ("Rev. David Lee Senior Pastor, Redeemer
 * Brooklyn"), so the search finds that person and not another of the name; a
 * timeline row only when it names something (two capitalised words, or a
 * `source:`), so "Book the venue" is never searched.
 */
export const ROW_KINDS = new Set(["people", "timeline", "contacts"]);

/** Whether a row's words name a thing: two capitalised words in a row ("Harlem Community Church", "Redeemer Brooklyn"). */
const NAMES_A_THING = /\b[A-Z][\w'’.-]+\s+(?:(?:of|the|and|&)\s+)?[A-Z][\w'’.-]+/;

const hasSource = (item) => (item.fields ?? []).some((field) => ["source", "sources", "link", "url", "site"].includes(field.key));

/**
 * Photos hunted for each place, for its carousel (owner, 2026-10-28: "show
 * more images of the different options"). Every option gets its first
 * picture before any gets a second, within the write's ten.
 */
export const PHOTOS_PER_PLACE = 3;
/** The most options hunted for one page write. */
export const MAX_PAGE_HUNTS = 10;
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

const PHOTO_KEYS = new Set(["photo", "photos"]);
const hasPhoto = (item) => (item.fields ?? []).some((field) => PHOTO_KEYS.has(field.key));

/**
 * Whether a `photo:` name points at a picture the page can show: one attached
 * to this write by that name, one the note already stores (the save names
 * each stored copy `upload-<hash>.<ext>`, `notes/uploadedImages.js`), a page
 * cover's own leaf, a web address, or a path, which this code does not judge.
 * Anything else is a name with nothing behind it.
 *
 * Nov Babies, 2026-11-11: a job wrote `photo: kims-cover.png`,
 * `muses-cover.png`, `pop-cover.png` and attached none of them. Each option
 * read as pictured, so the hunt skipped it, the page showed none, and the
 * write's answer still said pictures were found.
 */
export function heldPicture(name, attached) {
  const value = String(name ?? "").trim().replace(/^<|>$/g, "").replace(/^\.\//, "");
  if (value === "") return false;
  if (attached.has(value)) return true;
  if (/^(?:upload|cover)-[a-z0-9-]+\.[a-z0-9]{2,5}$/i.test(value)) return true;
  return /^https?:\/\//i.test(value) || value.includes("/");
}

/**
 * The page with every photo name that has nothing behind it taken out, so the
 * option it was under is hunted like one with no photo, and a missing picture
 * never shows as a broken one. A line naming only such names goes; one that
 * also names a real picture keeps that one. `dead` names each option and the
 * names it lost, for the write's answer.
 */
export function withoutDeadPhotos(content, attached = new Set()) {
  const edits = [];
  const dead = [];
  for (const block of blocksIn(parsePage(content).nodes)) {
    if (!PICTURED_KINDS.has(block.kind) && !ROW_KINDS.has(block.kind)) continue;
    for (const item of block.items ?? []) {
      const lost = [];
      for (const field of item.fields ?? []) {
        if (!PHOTO_KEYS.has(field.key) || !field.line) continue;
        const names = field.value.text.split(",").map((part) => part.trim()).filter(Boolean);
        const kept = names.filter((name) => heldPicture(name, attached));
        if (kept.length === names.length) continue;
        lost.push(...names.filter((name) => !kept.includes(name)));
        // Its whole line, with the line break before it, or only its value.
        edits.push(kept.length === 0 ? { from: field.line.from - 1, to: field.line.to, text: "" } : { from: field.value.from, to: field.value.to, text: kept.join(", ") });
      }
      const name = PICTURED_KINDS.has(block.kind) ? nameOf(block.kind, item) : item.label?.text?.trim() || item.parts?.[0]?.text?.trim() || "";
      if (lost.length > 0) dead.push({ option: name.slice(0, 40), names: lost });
    }
  }
  let next = content;
  for (const edit of edits.sort((a, b) => b.from - a.from)) next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
  return { content: next, dead };
}

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
  const rows = [];
  for (const block of blocksIn(parsePage(content).nodes)) {
    if (ROW_KINDS.has(block.kind)) {
      for (const item of block.items ?? []) {
        if (hasPhoto(item)) continue;
        const first = item.parts?.[0]?.text?.trim() ?? "";
        const name = block.kind === "timeline" ? first.split(/\s[|·•]\s|[;(]/)[0].trim() : item.label?.text?.trim() || first;
        if (name.length < 2 || !(NAMES_A_THING.test(name) || hasSource(item))) continue;
        const lineStart = content.lastIndexOf("\n", item.from - 1) + 1;
        const indent = /^[ \t]*/.exec(content.slice(lineStart))[0];
        const query = block.kind === "timeline" ? name : `${name} ${first}`.slice(0, 100);
        rows.push({ name, query, at: item.to, indent, want: 1 });
      }
      continue;
    }
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
  // Options first, so a page's places never lose their photos to its people.
  return [...wanted, ...rows];
}

/**
 * A `write_note` of a page with its options' missing pictures hunted for and
 * put in, or the arguments as they were. `deps` are `./hunt.js`'s.
 */
export async function withPagePictures(args, deps, { timeoutMs = PAGE_HUNT_TIMEOUT_MS } = {}) {
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  const content = typeof args?.content === "string" ? args.content : "";
  if (!isPagePath(path) || content === "") return { args, found: [], dead: [] };
  const images = Array.isArray(args.images) ? args.images : [];
  const attached = new Set(images.map((image) => (typeof image?.name === "string" ? image.name.trim() : "")).filter(Boolean));
  const cleaned = withoutDeadPhotos(content, attached);
  const dead = cleaned.dead;
  const base = dead.length === 0 ? args : { ...args, content: cleaned.content };
  const room = Math.min(MAX_PAGE_HUNTS, MAX_IMAGES_PER_WRITE - images.length);
  if (room <= 0) return { args: base, found: [], dead };
  const wanted = unpictured(base.content).slice(0, room);
  if (wanted.length === 0) return { args: base, found: [], dead };
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
  if (added.length === 0) return { args: base, found: [], dead };
  // From the end, so each offset still points where it did.
  let next = base.content;
  for (const line of [...lines].sort((a, b) => b.at - a.at)) next = next.slice(0, line.at) + line.text + next.slice(line.at);
  return { args: { ...base, content: next, images: [...images, ...added] }, found: lines.map((line) => line.name.slice(0, 40)), dead };
}

/**
 * What a page write's answer adds about its pictures, so the writer (and a
 * job's done check, which reads it) knows what is really on the page: a
 * "Pictures found" line only for pictures that went in, and the photo names
 * that had nothing behind them said plainly.
 */
export function pageWriteNotes({ found = [], dead = [], kept = [], dropped = [] } = {}) {
  const notes = [];
  if (kept.length > 0) notes.push(`Photos saved from addresses you read: ${kept.join(", ")}.`);
  if (dropped.length > 0) notes.push(`These photo addresses gave no picture a page can keep, so they were left out: ${dropped.join(", ")}.`);
  if (dead.length > 0) {
    const named = dead.map((entry) => `${entry.option} (${entry.names.join(", ")})`).join("; ");
    notes.push(`These photo names were not attached to the write, so they were taken off the page and pictures were looked for instead: ${named}. Attach a picture in the same write as the name, or leave the field out.`);
  }
  if (found.length > 0) notes.push(`Pictures found and added to the page for: ${found.join(", ")}.`);
  return notes;
}
