// Where a synced channel files its daily notes, and whether a person's typing
// is a folder this package would write into.
//
// ## Why this is here rather than in the control plane
//
// It was in the control plane, as a private `normalizeDestinationFolder` in
// `functions/googleConnect.ts` that threw `ConvexError`. That made the rule
// unreachable from the console, so the field a person types a destination into
// could not tell them anything: no completion, no validation, no preview. The
// first thing that checked was the mutation, which refused *after* Save with a
// message rendered under the field. You typed a path from memory, watched it
// scroll out of a field narrower than the path, pressed Save, and found out.
//
// So the rule moved to where both sides can reach it. The control plane still
// refuses — **the server-side check is the one that matters**, and a client
// that skipped it would be a client that could be edited — but now the console
// can refuse the same way, in the same words, before the round trip. One list
// of rules, one set of messages, one place to change them.
//
// ## The refusal is a value, not a throw
//
// `normalizeRoot` throws and its messages quote what they refused, which is
// right for a prefix somebody typed into their own binding and wrong twice
// over here: a thrown message cannot be rendered under a field while the
// person is still typing, and an echoed input is a reflection. So this answers
// `{ ok: false, code, message }` and the caller decides whether that becomes a
// `ConvexError`, a line under a text field, or a disabled Save button.
//
// The messages are written to be *shown*. They say what to do, not what went
// wrong: "Use a folder, or a pattern ending in /YYYY-MM-DD.md" rather than
// "invalid destination".

import { normalizeRoot } from "../../meetings/src/paths.js";

/**
 * The date token a pattern ends with, and the only one there is.
 *
 * `{date}` is accepted on the way in because bindings made before this module
 * existed carry it, and refusing it would turn an existing, working
 * destination into a validation error on a screen somebody opened to change
 * something else. It is never *produced* — `destinationPattern` writes
 * `YYYY-MM-DD` — so the two spellings converge on the next save rather than
 * living side by side forever.
 */
export const DATE_TOKEN = "YYYY-MM-DD";

/** Both spellings of the trailing day file, anchored to the end. */
const DATE_PATTERN_FILE = /\/(?:YYYY-MM-DD|\{date\})\.md$/;

/**
 * Per segment, not per path.
 *
 * A bucket key has its own overall limit and this is not it: the thing being
 * guarded is one folder name, which ends up in a listing, an audit row and
 * somebody's file browser. 96 is the number the control plane has always used.
 */
export const DESTINATION_SEGMENT_LIMIT = 96;

/**
 * A folder name this module will not file into, whatever else is true of it.
 *
 * Dot-prefixed segments are plumbing — `.audit/`, `.context/` — and hidden
 * from every tool at every tier, so a day note filed under one would be
 * invisible to the person whose mail it is and still on their storage bill.
 * `privacy.md` is the manifest and not a folder at all.
 */
function isReservedSegment(segment) {
  return segment.startsWith(".") || segment === "privacy.md";
}

/**
 * Is this typing a folder a channel can file into?
 *
 * Accepts a bare folder (`2-areas/comms`) or a whole pattern
 * (`2-areas/comms/YYYY-MM-DD.md`) and answers with the folder either way, so a
 * caller never has to strip the day file itself — which is the step that went
 * missing in two places before this function existed.
 *
 * @param {unknown} value
 * @returns {{ ok: true, folder: string } | { ok: false, code: string, message: string }}
 */
export function normalizeDestinationFolder(value) {
  const raw = typeof value === "string" ? value : "";
  const withoutPattern = raw.trim().replace(DATE_PATTERN_FILE, "");

  let normalized;
  try {
    normalized = normalizeRoot(withoutPattern).replace(/\/$/g, "");
  } catch {
    return refuse(
      "DESTINATION_INVALID",
      "Use a folder path inside this context, without '..' or backslashes.",
    );
  }

  if (!normalized) {
    return refuse("DESTINATION_INVALID", "Choose a folder where synced files should land.");
  }

  /*
    After the trailing day file has been stripped, anything still ending in
    `.md` is a note. Filing "inside" a note is a key that shadows a file, which
    a filesystem-backed store cannot represent — the same refusal
    `normalizeMeetingFolder` makes, for the same reason.
  */
  if (normalized.endsWith(".md")) {
    return refuse("DESTINATION_INVALID", "Use a folder, or a pattern ending in /YYYY-MM-DD.md.");
  }

  const segments = normalized.split("/");
  if (segments.some(isReservedSegment)) {
    return refuse("DESTINATION_RESERVED", "That folder is reserved for Context internals.");
  }
  if (segments.some((segment) => segment.length > DESTINATION_SEGMENT_LIMIT)) {
    return refuse(
      "DESTINATION_INVALID",
      `Keep each folder name under ${DESTINATION_SEGMENT_LIMIT} characters.`,
    );
  }

  return { ok: true, folder: normalized };
}

function refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * The stored shape: a folder plus the day file.
 *
 * One spelling, produced in one place, so a binding written today and one
 * written a year ago read the same.
 *
 * @param {string} folder
 * @returns {string}
 */
export function destinationPattern(folder) {
  return `${folder}/${DATE_TOKEN}.md`;
}

/**
 * What a pattern actually writes on a given day.
 *
 * **This is the half the field was missing.** A pattern carrying a date token
 * is a template, and nothing on the settings screen ever showed what the
 * template produces — so somebody typing one had to run it in their head, and
 * the only way to find out they were wrong was to wait for a sync. Rendering
 * today's key beneath the field is the whole of the fix.
 *
 * Takes the date rather than reading the clock, so the caller's timezone is
 * the caller's problem and this stays a pure function a test can pin.
 *
 * @param {unknown} pattern A folder or a full pattern; either is accepted.
 * @param {Date} date
 * @returns {string|null} The key, or `null` if the pattern is not one.
 */
export function resolveDestinationPattern(pattern, date) {
  const result = normalizeDestinationFolder(pattern);
  if (!result.ok) return null;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  /*
    Local date parts, not `toISOString`. The note is named for the day the
    person had, and a meeting at 9pm on the 12th in UTC-7 is not the 13th to
    anybody who was in the room.
  */
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${result.folder}/${year}-${month}-${day}.md`;
}

/**
 * Folder names worth offering while somebody types.
 *
 * The completion the field never had. Given what has been typed and the
 * folders a caller already knows about — in the console that is the tree it
 * has loaded, which is exactly the source the forwarding-address card's
 * quick-picks already use — this answers the ones that could come next.
 *
 * Matching is on the **last segment being typed**, against folders under the
 * same parent. Typing `2-areas/comm` offers `2-areas/communications`, and
 * typing `2-areas/` offers everything directly beneath it: a completion that
 * matched anywhere in the path would offer `1-projects/comms` to somebody who
 * has already committed to `2-areas/`, which is a suggestion that undoes a
 * decision they made two keystrokes ago.
 *
 * Reserved folders are never offered. They would be refused on save, and an
 * autocomplete that suggests a value its own validator rejects is worse than
 * no autocomplete.
 *
 * @param {unknown} value What is in the field right now.
 * @param {Iterable<string>} folders Folder paths, without trailing slashes.
 * @param {number} [limit]
 * @returns {string[]} Whole folder paths, ready to replace the typed value.
 */
export function suggestDestinationFolders(value, folders, limit = 6) {
  const raw = typeof value === "string" ? value : "";
  const typed = raw.trim().replace(DATE_PATTERN_FILE, "").replace(/^\/+/, "");
  const cut = typed.lastIndexOf("/");
  /*
    Both halves are compared case-insensitively, and the parent is the half
    that is easy to forget: matching the stem loosely while comparing the
    parent exactly means `2-AREAS/comm` offers nothing at all, which reads as
    "there are no folders here" rather than as a capitalisation. The test for
    this failed on the first run for exactly that reason.
  */
  const parent = (cut === -1 ? "" : typed.slice(0, cut)).toLowerCase();
  const stem = (cut === -1 ? typed : typed.slice(cut + 1)).toLowerCase();

  const seen = new Set();
  const out = [];
  for (const folder of folders) {
    if (typeof folder !== "string") continue;
    const path = folder.replace(/^\/+|\/+$/g, "");
    if (!path || seen.has(path)) continue;

    const at = path.lastIndexOf("/");
    const folderParent = (at === -1 ? "" : path.slice(0, at)).toLowerCase();
    const name = at === -1 ? path : path.slice(at + 1);
    if (folderParent !== parent) continue;
    if (!name.toLowerCase().startsWith(stem)) continue;
    // Never offer what `normalizeDestinationFolder` would then refuse.
    if (path.split("/").some(isReservedSegment)) continue;
    /*
      An exact match is not a suggestion. Offering the folder somebody has
      finished typing is a chip that does nothing when pressed, and it crowds
      out the siblings that would have moved them along.
    */
    if (name.toLowerCase() === stem) continue;

    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}
