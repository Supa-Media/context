// Where a meeting note lands in the customer's own bucket.
//
// NON-NEGOTIABLE, and the reason this is its own module with its own tests:
// tenancy is bucket-level, never prefix-level. There is no `tenants/<id>/`,
// no `workspaces/<slug>/`, no username anywhere in a key. One workspace is one
// bucket; the note lives at `0-inbox/meetings/...`, full stop. The same bucket
// is synced to Obsidian, so a key that carried a tenant id would be visible
// nonsense in somebody's vault and a migration for every existing brain.
//
// The one prefix that is allowed is `root`: a fixed folder the *customer* chose
// when they connected their bucket, applied here at the adapter boundary and
// nowhere else. It is passed in by the caller; it is never derived from a
// workspace, a user or an account, and this module is given nothing it could
// derive one from.
//
// There is deliberately no transcript path helper. One meeting is one file: the
// transcript is a `## Transcript` section at the end of the note (see note.js).

/** @typedef {import("./protocol.js").MeetingSession} MeetingSession */

/**
 * Where meetings land when nobody chose anywhere else.
 *
 * A **default**, not a home: PARA is a suggestion, and somebody who files
 * meetings under `2-areas/team/` should keep doing that
 * ([meetings](../../../docs/decisions/meetings.md), *A meeting lands at an
 * ordinary path*). A client may name a folder per meeting; this is what a
 * client that names none gets, byte for byte.
 */
export const MEETINGS_FOLDER = "0-inbox/meetings";

/**
 * The longest folder a client may name.
 *
 * The gateway's own `normalizePath` refuses a key over 512 characters, and a
 * meeting filed at a key that function refuses is a note no tool can read,
 * move or share — so the bound exists to keep the *whole* key addressable, not
 * because a long folder is dangerous by itself. 128 leaves ~380 characters for
 * the customer's root, `YYYY/MM/` and a filename, against a real workload of
 * two or three short segments.
 */
export const MAX_FOLDER_LENGTH = 128;

/** Characters that are not text: they reach a listing, an audit row and a UI. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Long enough to stay readable in a file listing, short enough for any OS. */
export const MAX_SLUG_LENGTH = 48;

/** What a title that slugifies to nothing becomes. */
export const SLUG_FALLBACK = "meeting";

/** Combining marks left behind by NFKD, so "e" plus an accent folds to "e". */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * A filename-safe slug: lowercase ASCII, hyphen separated.
 *
 * Accents are folded to their base letter rather than dropped, so a title in
 * French still reads. Anything else — CJK, emoji, punctuation — becomes a
 * separator, and a title made entirely of those falls back rather than
 * producing an empty filename.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function slugifyTitle(title) {
  const text = typeof title === "string" ? title : "";
  const folded = text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    // "&" reads as a word in a meeting title far more often than as punctuation.
    .replace(/&/g, " and ");

  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    // The slice can land mid-separator; a trailing hyphen before the shortId
    // would read as a typo.
    .replace(/-+$/g, "");

  return slug || SLUG_FALLBACK;
}

/**
 * The last 8 characters of a session id: enough to keep two meetings with the
 * same title on the same day apart, short enough that the filename still reads
 * as its title.
 *
 * @param {string} id
 * @returns {string}
 */
export function shortMeetingId(id) {
  return String(id ?? "").slice(-8);
}

/**
 * Normalize the customer's chosen root prefix.
 *
 * Refuses traversal outright. This is the one caller-supplied component of a
 * bucket key in this package, so it is the one place a path could be talked out
 * of the folder it belongs in.
 *
 * @param {unknown} root
 * @returns {string} Either "" or a prefix ending in "/".
 */
export function normalizeRoot(root) {
  if (root === undefined || root === null) return "";
  if (typeof root !== "string") throw new TypeError("root must be a string");
  const trimmed = root.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new TypeError(`root must not traverse: ${root}`);
    if (segment.includes("\\")) throw new TypeError(`root has an illegal segment: ${root}`);
  }
  return `${segments.join("/")}/`;
}

/**
 * The folder a client asked a meeting to be filed into, or `null` if it is not
 * a folder this package will file into.
 *
 * ## Why this delegates to `normalizeRoot` rather than being a third validator
 *
 * `normalizeRoot` is already this package's path validator: it refuses `.`,
 * `..` and backslashes, collapses repeated separators and trims. Those rules
 * are the same rules here, so they are called rather than restated —
 * two implementations of "does this string escape its bucket" is how one of
 * them ends up weaker. `slugifyTitle` is the wrong tool for the same job in
 * the other direction: it *maps* rather than refuses, so `2-areas/team` would
 * come back as `2-areas-team` and the meeting would be filed into a folder
 * nobody named. Silently filing somewhere else is the defect this whole
 * argument exists to close.
 *
 * ## What a folder needs on top of what a root needs
 *
 * A root is chosen once by the customer, in their own binding. A folder
 * arrives on a request, so three refusals are added and each has a reason a
 * root does not have:
 *
 *  - **Dot-prefixed segments.** `isPlumbing` hides every dot-segment from
 *    every tool at every tier, the owner's included, so a meeting filed under
 *    `.meetings/` or `.index/` would be invisible to the person who recorded
 *    it and still on their storage bill.
 *  - **A segment ending in `.md`.** That is a note, not a folder, and a
 *    meeting filed "inside" one is a key that shadows a file.
 *  - **Control characters, and a length bound.** This string reaches a
 *    listing, an audit row and somebody's file browser.
 *
 * The refusal is a `null` and never a thrown message, because `normalizeRoot`'s
 * messages quote what they refused. That is reasonable for a prefix the
 * customer typed into their own binding and wrong for a value a client sent:
 * a refusal that echoes its input is a reflection (see `INVALID_CHUNK_ID` in
 * [meetings](../../../docs/decisions/meetings.md)).
 *
 * @param {unknown} folder  Absent or `null` means "the default".
 * @returns {string|null} A folder with no trailing slash, or `null` if refused.
 */
export function normalizeMeetingFolder(folder) {
  if (folder === undefined || folder === null) return MEETINGS_FOLDER;
  if (typeof folder !== "string") return null;
  if (folder.length > MAX_FOLDER_LENGTH) return null;

  let normalized;
  try {
    normalized = normalizeRoot(folder);
  } catch {
    return null;
  }
  // "" is `normalizeRoot`'s answer for "no prefix at all". As a *root* that
  // means the bucket root, which is right; as a meeting folder it would file
  // meetings beside `index.md` and `privacy.md`, so it is a refusal.
  if (!normalized) return null;

  const segments = normalized.slice(0, -1).split("/");
  for (const segment of segments) {
    if (segment.startsWith(".")) return null;
    if (segment.toLowerCase().endsWith(".md")) return null;
    if (CONTROL_CHARACTERS.test(segment)) return null;
  }
  return segments.join("/");
}

/**
 * `<folder>/YYYY/MM/YYYY-MM-DD-<slug>-<shortId>.md`, defaulting to
 * `0-inbox/meetings/…`.
 *
 * The date comes from `startedAt` in UTC — never from the reader's clock or
 * locale, so the same session resolves to the same key on every device that
 * syncs the bucket.
 *
 * ## The folder replaces the whole default, and the date folders stay
 *
 * `MEETINGS_FOLDER` is one concept — "where meetings are filed" — that happens
 * to be spelled in two segments, so a chosen folder replaces both. Appending
 * `meetings/` under somebody's `2-areas/team` would hand them a folder they did
 * not ask for, and the decision record's own example of a customer who has
 * changed this has no `meetings` segment in it.
 *
 * `YYYY/MM` is not part of that choice and is kept. Those folders "exist for
 * humans and for Obsidian" — a folder that accumulates every meeting a person
 * ever records is unusable in a file browser — and nothing in the gateway
 * parses them to *find* a meeting, so keeping them costs the customer nothing
 * they cannot undo by moving a note.
 *
 * A folder `normalizeMeetingFolder` refuses is a `TypeError` here rather than a
 * silent fallback: the caller is the one that can tell whoever sent it, and a
 * builder that quietly filed somewhere else would be the defect this argument
 * is about. The message names the field and never the value.
 *
 * @param {MeetingSession} session
 * @param {{root?: string, folder?: string}} [options]
 * @returns {string}
 */
export function meetingNotePath(session, options = {}) {
  if (!session || typeof session !== "object") throw new TypeError("meetingNotePath needs a session");
  const started = Date.parse(String(session.startedAt));
  if (!Number.isFinite(started)) throw new TypeError("session.startedAt is not an ISO 8601 timestamp");

  const date = new Date(started);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  const slug = slugifyTitle(session.title);
  const short = shortMeetingId(session.id);
  const file = `${year}-${month}-${day}-${slug}${short ? `-${short}` : ""}.md`;

  const folder = normalizeMeetingFolder(options.folder);
  if (folder === null) throw new TypeError("options.folder is not a folder a meeting can be filed into");

  return `${normalizeRoot(options.root)}${folder}/${year}/${month}/${file}`;
}

/**
 * Is this key the shape this module writes into that folder?
 *
 * Used by the gateway to answer "list my meetings" without keeping a second
 * index — the files are canonical, everything else is a disposable derivative.
 *
 * **It answers about the folder it is given, and `meetingNotePath` must be
 * given the same one**, which is the whole of the contract between these two
 * functions: `isMeetingNotePath(meetingNotePath(s, o), o)` is true for every
 * `o` this module accepts. Before a client could choose a folder there was
 * only one to derive, and the pair agreed by accident; now they agree because
 * they take the same argument and validate it with the same function.
 *
 * It is deliberately **not** a global "is this a meeting" oracle, and cannot
 * become one. Nothing records which folder a meeting was filed into — there is
 * no meetings table, by decision — and a dated note in somebody's own folder is
 * not a meeting. So a meeting filed outside the folder asked about is not
 * recognised, which is exactly what already happens to a meeting its owner
 * *moves*: it stops being listed and stays a note, "which is the correct
 * behaviour for a product whose whole claim is that the files are theirs".
 *
 * @param {string} path
 * @param {{root?: string, folder?: string}} [options]
 * @returns {boolean}
 */
export function isMeetingNotePath(path, options = {}) {
  if (typeof path !== "string") return false;
  const folder = normalizeMeetingFolder(options.folder);
  if (folder === null) return false;
  const prefix = `${normalizeRoot(options.root)}${folder}/`;
  if (!path.startsWith(prefix)) return false;
  return /^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-.+\.md$/.test(path.slice(prefix.length));
}
