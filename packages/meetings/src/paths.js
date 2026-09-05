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

/** Meetings land in the inbox, like every other capture, and get filed later. */
export const MEETINGS_FOLDER = "0-inbox/meetings";

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
 * `0-inbox/meetings/YYYY/MM/YYYY-MM-DD-<slug>-<shortId>.md`
 *
 * The date comes from `startedAt` in UTC — never from the reader's clock or
 * locale, so the same session resolves to the same key on every device that
 * syncs the bucket.
 *
 * @param {MeetingSession} session
 * @param {{root?: string}} [options]
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

  return `${normalizeRoot(options.root)}${MEETINGS_FOLDER}/${year}/${month}/${file}`;
}

/**
 * Is this key one of ours? Used by the gateway to answer "list my meetings"
 * without keeping a second index — the files are canonical, everything else is
 * a disposable derivative.
 *
 * @param {string} path
 * @param {{root?: string}} [options]
 * @returns {boolean}
 */
export function isMeetingNotePath(path, options = {}) {
  if (typeof path !== "string") return false;
  const prefix = `${normalizeRoot(options.root)}${MEETINGS_FOLDER}/`;
  if (!path.startsWith(prefix)) return false;
  return /^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-.+\.md$/.test(path.slice(prefix.length));
}
