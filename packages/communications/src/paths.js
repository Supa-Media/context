// Where a communication lands in the customer's own bucket.
//
// NON-NEGOTIABLE, and the reason this is its own module with its own tests:
// tenancy is bucket-level, never prefix-level. No `tenants/<id>/`, no
// `workspaces/<slug>/`, no username and no account id anywhere in a key. One
// workspace is one bucket; a day of mail lives at
// `0-inbox/email/<mailbox>/2026-09-07.md`, full stop. The same bucket is synced
// to Obsidian, so a key carrying a tenant id would be visible nonsense in
// somebody's vault and a migration for every existing brain.
//
// The one prefix that is allowed is `root`: a fixed folder the *customer* chose
// when they connected their bucket, applied here at the adapter boundary and
// nowhere else. It is passed in by the caller; it is never derived from a
// workspace, a user or an account, and this module is given nothing it could
// derive one from.
//
// ## There are no date folders, and that is a decision
//
// `2026-09-07.md` sits directly in its channel folder. `YYYY/MM/` was built
// here for meetings, used, and removed as unusable, and daily bundling
// sharpens that argument rather than reviving it — see
// `docs/decisions/communications.md`, *There are no `YYYY/MM/` folders*.
// Unlike `isMeetingNotePath`, the recogniser below accepts one shape only: no
// bucket anywhere holds a channel-day note, so there is no legacy to migrate,
// and an unreachable branch reads as a supported format to the next person.

import { normalizeRoot } from "../../meetings/src/paths.js";
import {
  CHANNELS,
  CHANNEL_FOLDERS,
  CONTACTS_FOLDER,
  DATE_PATTERN,
  INBOX_FOLDER,
} from "./protocol.js";

export { normalizeRoot };

/**
 * Long enough for a real address, short enough to leave room for the rest of
 * the key inside the gateway's 512-character path limit.
 */
export const MAX_SLUG_LENGTH = 64;

/** What an address that slugifies to nothing becomes. */
export const SLUG_FALLBACK = "mailbox";

/** Combining marks left behind by NFKD, so "é" folds to "e". */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** The shape every slug this module produces has, and the only one it accepts. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `2026-09-07.md`, or `2026-09-07-part-3.md` for a day that split.
 *
 * Part 1 is the plain name — never `-part-1` — so the common case is the name
 * every link already points at and a day that grows past the threshold *adds*
 * files rather than renaming one.
 */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:-part-([2-9]|[1-9]\d+))?\.md$/;

/**
 * An email address as a path segment.
 *
 * `name@example.com` is not one, and the failure modes of pretending otherwise
 * are silent rather than loud:
 *
 *  - **A leading dot is plumbing.** `isPlumbing` in the gateway hides every
 *    dot-prefixed segment from every tool at every tier, the owner's included,
 *    so `.hidden@example.com` would be a mailbox invisible to the person paying
 *    for its storage.
 *  - **`.` and `..` escape the folder**, raw or percent-encoded — the storage
 *    adapter decodes before it compares.
 *  - **Case folds on Dropbox and not on R2**, so two addresses differing only
 *    in case are two folders on one backend and one on another.
 *
 * Producing `[a-z0-9-]` only closes all three by construction rather than by
 * three checks that have to stay in step. The address itself is preserved in
 * the note's frontmatter, so the mapping loses nothing.
 *
 * @param {unknown} address
 * @returns {string}
 */
export function slugifyAddress(address) {
  const text = typeof address === "string" ? address : "";
  const slug = text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    // Before the general rule, so the one character that carries meaning in an
    // address survives as a word rather than as a separator: two mailboxes at
    // `sales@a.example` and `sales.a@example` must not collide.
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    // The slice can land mid-separator.
    .replace(/-+$/g, "");
  return slug || SLUG_FALLBACK;
}

/**
 * FNV-1a 32, over UTF-8 bytes, as eight hex characters.
 *
 * Used only to disambiguate two addresses that slugify alike. It is the same
 * function the search index shards with; see `messageAnchor` in anchors.js for
 * why this family rather than SHA-256.
 */
function shortHash(value) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash = Math.imul(hash ^ byte, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The folder name for one connected mailbox, given the ones already in use.
 *
 * Two different addresses can slugify to the same string (`a.b@example.com`
 * and `a-b@example.com`). The second one connected gets a deterministic hash
 * suffix — **and the choice is made once, at connect time, and recorded**.
 * Recomputing it later against a different `taken` set would rename the folder
 * a person's mail is already in, which is a rename of their mail.
 *
 * @param {unknown} address
 * @param {Iterable<string>} [taken] Slugs already used in this context.
 * @returns {string}
 */
export function chooseMailboxSlug(address, taken = []) {
  const base = slugifyAddress(address);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  const suffixed = `${base.slice(0, MAX_SLUG_LENGTH - 9)}-${shortHash(address)}`;
  return suffixed.replace(/-+/g, "-");
}

/** Is this a string this module would have produced as a folder name? */
export function isMailboxSlug(value) {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_SHAPE.test(value);
}

/**
 * Is this a real calendar date, spelled `YYYY-MM-DD`?
 *
 * A pattern match is not enough: `2026-02-30` and `2026-13-01` match it, and a
 * note filed under either is a day that does not exist, sorted between two
 * that do.
 */
export function isCalendarDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return false;
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

/**
 * The folder one channel's notes go in.
 *
 * `email` takes an account level under it and the other channels do not,
 * because a person has several mailboxes and one iMessage. That asymmetry is
 * expressed once, here.
 *
 * @param {string} channel
 * @param {string} [account] The mailbox slug, for `email`.
 * @returns {string|null} `null` for anything this module will not file into.
 */
export function channelFolder(channel, account) {
  if (!CHANNELS.includes(channel)) return null;
  const base = CHANNEL_FOLDERS[channel];
  if (channel !== "email") return account ? null : base;
  const slug = typeof account === "string" ? account : "";
  if (!isMailboxSlug(slug)) return null;
  return `${base}/${slug}`;
}

/**
 * A customer-chosen channel folder.
 *
 * This is deliberately a folder, not a full object key: a channel day can split
 * into multiple `-part-N` files, and attachments/manifests live beside the day
 * files for email. Letting the caller choose the folder keeps the visible
 * setting honest without making one text field decide several keys.
 *
 * @param {string} channel
 * @param {string|undefined} account
 * @param {unknown} folder
 * @returns {string|null}
 */
export function channelDestinationFolder(channel, account, folder) {
  if (folder === undefined || folder === null || String(folder).trim() === "") {
    return channelFolder(channel, account);
  }
  if (!CHANNELS.includes(channel)) return null;
  if (channel === "email" && !isMailboxSlug(typeof account === "string" ? account : "")) return null;
  if (channel !== "email" && account) return null;
  const normalized = normalizeRoot(folder).replace(/\/$/g, "");
  return normalized || null;
}

/**
 * Where one part of one channel-day lands.
 *
 * @param {{channel: string, account?: string, date: string, part?: number}} day
 * @param {{root?: string, folder?: string}} [options]
 * @returns {string}
 */
export function channelDayNotePath(day, options = {}) {
  if (!day || typeof day !== "object") throw new TypeError("channelDayNotePath needs a day");
  const folder = channelDestinationFolder(day.channel, day.account, options.folder);
  if (folder === null) throw new TypeError(`not a channel this package files into: ${day.channel}`);
  if (!isCalendarDate(day.date)) throw new TypeError(`not a calendar date: ${day.date}`);

  const part = day.part === undefined ? 1 : day.part;
  if (!Number.isInteger(part) || part < 1) throw new TypeError(`not a part number: ${day.part}`);
  const file = part === 1 ? `${day.date}.md` : `${day.date}-part-${part}.md`;

  return `${normalizeRoot(options.root)}${folder}/${file}`;
}

/**
 * What a key says about itself, or `null` if it is not one of ours.
 *
 * This is what a `list_channel_days` is built out of — off the **notes**,
 * never off an index, the way `list_meetings` is. The files are canonical and
 * everything else is a disposable derivative, so there is no second list to
 * fall out of step with the bucket, and a note somebody *moves* stops being
 * listed and stays a note. That is the correct behaviour for a product whose
 * whole claim is that the files are theirs.
 *
 * @param {string} path
 * @param {{root?: string}} [options]
 * @returns {{channel: string, account: string, date: string, part: number}|null}
 */
export function parseChannelDayPath(path, options = {}) {
  if (typeof path !== "string") return null;
  const root = normalizeRoot(options.root);
  if (root && !path.startsWith(root)) return null;
  const key = path.slice(root.length);
  if (!key.startsWith(`${INBOX_FOLDER}/`)) return null;

  const segments = key.split("/");
  // `0-inbox`, the channel, [the mailbox], the file. Anything deeper is a
  // folder somebody made, not a shape this module writes.
  if (segments.length < 3 || segments.length > 4) return null;

  const [, channelSegment, ...rest] = segments;
  const file = rest[rest.length - 1];
  const account = rest.length === 2 ? rest[0] : "";

  const channel = CHANNELS.find((name) => CHANNEL_FOLDERS[name] === `${INBOX_FOLDER}/${channelSegment}`);
  if (channel === undefined) return null;
  // The account level exists for `email` and only for `email`. A three-segment
  // `0-inbox/email/<fingerprint>.md` is a forwarded capture, which is a
  // different note shape in the same folder and is deliberately not one of
  // ours; a four-segment `0-inbox/imessage/x/2026-09-07.md` is somebody's own
  // folder.
  if (channel === "email" ? account === "" : account !== "") return null;
  if (channel === "email" && !isMailboxSlug(account)) return null;

  const match = DAY_FILE.exec(file);
  if (match === null) return null;
  if (!isCalendarDate(match[1])) return null;

  return { channel, account, date: match[1], part: match[2] ? Number(match[2]) : 1 };
}

/**
 * Is this key one this module writes?
 *
 * `parseChannelDayPath(channelDayNotePath(d, o), o)` round-trips for every `d`
 * and `o` this module accepts, and that is the whole contract between the two.
 *
 * @param {string} path
 * @param {{root?: string}} [options]
 * @returns {boolean}
 */
export function isChannelDayNotePath(path, options = {}) {
  return parseChannelDayPath(path, options) !== null;
}

/**
 * A contact's page name.
 *
 * Deliberately not `slugifyAddress`: a contact is named by a person's name,
 * and `-at-` in the middle of one would be nonsense. Same character class out,
 * so every rule the address slug closes is closed here too.
 */
export function contactSlug(name) {
  const text = typeof name === "string" ? name : "";
  const slug = text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "contact";
}

/**
 * Where one contact's page lands.
 *
 * @param {string} slug A value from `contactSlug`.
 * @param {{root?: string}} [options]
 */
export function contactNotePath(slug, options = {}) {
  if (!isMailboxSlug(slug)) throw new TypeError(`not a contact slug: ${slug}`);
  return `${normalizeRoot(options.root)}${CONTACTS_FOLDER}/${slug}.md`;
}

/** Is this key a contact page? Same "built from paths" rule as the days. */
export function isContactNotePath(path, options = {}) {
  if (typeof path !== "string") return false;
  const root = normalizeRoot(options.root);
  if (root && !path.startsWith(root)) return false;
  const key = path.slice(root.length);
  if (!key.startsWith(`${CONTACTS_FOLDER}/`)) return false;
  const rest = key.slice(CONTACTS_FOLDER.length + 1);
  if (!rest.endsWith(".md")) return false;
  return isMailboxSlug(rest.slice(0, -3));
}
