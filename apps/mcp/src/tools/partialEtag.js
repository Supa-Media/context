/**
 * A PART OF A NOTE IS NEVER SAVED AS THE WHOLE NOTE.
 *
 * `read_note` can return part of a note (`notes/readPart.js`), and an agent
 * that edits that part and saves it as the note's whole content would delete
 * everything it did not read. So a part's etag carries a mark, `;part`, and:
 *
 *  - every tool sees the bare version, with the mark taken off here, once,
 *    for every call (routed or the gateway's own), so moves, visibility and the
 *    etag-place check treat it as any etag (`etagPlace.js`);
 *  - a whole-note save (`write_note` with `content` and neither `section` nor
 *    `edits`) given a marked etag is refused before it reaches storage, and so
 *    is any item of a batch save given one.
 *
 * The mark alone can be dodged (no etag at all, or one from an earlier whole
 * read of the same version), so `write.js` also refuses a tool's whole-note
 * save that would cut a long note by more than half (`SHRINK_GUARD_CHARS`),
 * unless it says `replace: "whole"`.
 */

export const PARTIAL_ETAG_SUFFIX = ";part";

/** A whole-note save over a stored note at least this long may not cut it by more than half without replace: "whole". */
export const SHRINK_GUARD_CHARS = 16_000;

const ETAG_FIELDS = ["expected_etag", "expected_source_etag", "expected_privacy_etag"];
const ITEM_LISTS = ["moves", "notes"];

/** `;part`, or `;part#<hash>` for a section read: the hash of that section's text, so a section write can land after
 * somebody typed elsewhere in the note (`notes/writePart.js`). */
const PARTIAL = /;part(?:#([0-9a-f]{8}))?$/;

export function isPartialEtag(etag) {
  return typeof etag === "string" && PARTIAL.test(etag.trim());
}

/** The etag a section read hands out: the note's version, marked, with its section's hash. */
export function partialEtag(etag, sectionText = null) {
  return `${etag}${PARTIAL_ETAG_SUFFIX}${typeof sectionText === "string" ? `#${textHash(sectionText)}` : ""}`;
}

/** A short, stable hash of a text (FNV-1a, 32 bits), to tell whether a section changed. Not a secret. */
export function textHash(text) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function strip(etag) {
  return etag.trim().replace(PARTIAL, "");
}

function hashOf(etag) {
  return PARTIAL.exec(etag.trim())?.[1] ?? null;
}

/** A write that names a part to change, so a part's etag is the right one for it. */
function writesPart(args) {
  return args.section !== undefined || args.edits !== undefined;
}

function wholeSaveRefusal(path) {
  const where = typeof path === "string" && path !== "" ? ` ${path}` : "";
  return (
    `refused: that etag is from reading only part of${where || " this note"}, and this would save it as the whole note, ` +
    "deleting everything you did not read. Nothing was changed. Save that part with section (the heading you read) " +
    "or edits ([{ old, new }]), or read the whole note (without outline, section or lines) and save from that."
  );
}

/**
 * `args` with every `;part` mark taken off, and the refusal for a whole-note
 * save made from a part, or null. Never changes the caller's own objects.
 *
 * @returns {{ args: object, refusal: string | null }}
 */
export function takePartialEtags(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { args, refusal: null };
  let marked = false;
  const own = { ...args };
  const saving = name === "write_note" || name === "write_notes";
  for (const field of ETAG_FIELDS) {
    if (!isPartialEtag(own[field])) continue;
    marked = true;
    if (field === "expected_etag" && hashOf(own[field]) !== null) own.expected_part_hash = hashOf(own[field]);
    own[field] = strip(own[field]);
    if (saving && field === "expected_etag" && typeof own.content === "string" && !writesPart(own)) {
      return { args, refusal: wholeSaveRefusal(own.path) };
    }
  }
  for (const list of ITEM_LISTS) {
    if (!Array.isArray(own[list])) continue;
    own[list] = own[list].map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const copy = { ...item };
      for (const field of ETAG_FIELDS) {
        if (!isPartialEtag(copy[field])) continue;
        marked = true;
        copy[field] = strip(copy[field]);
        if (saving && field === "expected_etag" && typeof copy.content === "string" && !writesPart(copy)) copy.__partialWhole = true;
      }
      return copy;
    });
    const whole = own[list].find((item) => item?.__partialWhole === true);
    if (whole) return { args, refusal: wholeSaveRefusal(whole.path) };
  }
  return { args: marked ? own : args, refusal: null };
}

/**
 * The refusal for a tool's whole-note save that would cut a long stored note by
 * more than half, or null. `stored` is the note's plain text as stored.
 */
export function shrinkRefusal(path, stored, content, args) {
  if (typeof stored !== "string" || typeof content !== "string") return null;
  if (args?.replace === "whole") return null;
  if (stored.length < SHRINK_GUARD_CHARS || content.length * 2 >= stored.length) return null;
  return (
    `refused: this save would replace all of ${path} (${stored.length} characters) with ${content.length} characters, ` +
    "losing more than half of it. Nothing was changed. If you read only part of the note, save that part with section " +
    "(the heading you read) or edits ([{ old, new }]). If you really mean to replace the whole note, call it again with replace: \"whole\"."
  );
}
