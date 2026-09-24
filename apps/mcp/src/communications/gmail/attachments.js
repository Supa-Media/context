import { channelDestinationFolder, isCalendarDate } from "../../../../../packages/communications/src/index.js";
import { decodeBase64UrlToBytes } from "./parsing.js";
import { GmailApiError, GmailHistoryExpiredError, gmailFetch } from "./api.js";

/* -------------------------------------------------------------------------- */
/* Attachments: fetched into the bucket, retained on a timer                  */
/*                                                                            */
/* The owner's decision (2026-09-07), reversing the metadata-only default:    */
/* "sometimes an email says look at the PDF attached, and it should land      */
/* somewhere referenceable in the bucket." See                                */
/* docs/decisions/communications.md for the argument in full; this is the     */
/* implementation of it.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Gmail's own attachment size limit. Declared size (from the message
 * resource this module already fetched) is checked against this BEFORE a
 * fetch is ever attempted — Gmail would refuse a larger attachment on the
 * sending side, so a part reporting more than this is either a Gmail change
 * this constant needs updating for, or a provider anomaly; either way, this
 * module writes nothing rather than guessing.
 */
export const GMAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A raw filename, made safe as the trailing component of a storage key AND
 * as the TARGET half of a `[[path|label]]` wikilink — two different syntaxes
 * this one string has to survive.
 *
 * Four things a hostile filename could do, each closed by one step:
 *
 *  1. **Path traversal / an absolute path** (`../../etc/passwd`,
 *     `/etc/passwd`, `..\\..\\windows`) — closed by taking the basename after
 *     splitting on every `/` and `\`, which is exactly what "no directory
 *     component survives" means; a traversal segment cannot smuggle itself
 *     through as anything but the discarded head of the split.
 *  2. **Control characters and a drive letter** — stripped outright, the
 *     same rule `singleLine` elsewhere in this product applies to text and
 *     `assertSafeKey` applies to keys.
 *  3. **Wikilink syntax** (`[`, `]`, `|`, `#`) — this is the one a plain "safe
 *     storage key" sanitiser would miss, because none of those four
 *     characters are unsafe to a `ContextStore` key. They are unsafe here
 *     because the resulting path is later embedded, VERBATIM, as the target
 *     of `[[path|label]]` in `packages/communications`' rendering — a
 *     filename of `evil]] and [[.context/audit/x` would close that link early and
 *     open a second one the sender chose, in a note presented as the
 *     owner's own. Replacing them with `-` closes it at the source, so the
 *     rendering layer's `defangOutsideFence` (which protects the LABEL half)
 *     and this function (which protects the PATH half) each own one side.
 *  4. **Nothing left** (a filename that was only separators, dots, or
 *     forbidden characters) — falls back to `"attachment"`, never an empty
 *     path segment.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeAttachmentFilename(name) {
  let base = String(name ?? "")
    // Control characters, and the bidi overrides `packages/communications`'
    // `singleLine` already strips from every other sender-chosen field this
    // product renders — a filename embedded (as the wikilink LABEL, already
    // defanged by the caller with `singleLine` + `defangOutsideFence`) and
    // also, via this function, as part of the raw PATH — must not be able to
    // make the raw markdown source read as something other than its actual
    // bytes.
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    // AND the invisible characters `singleLine` does NOT strip, because a
    // storage key is a stricter context than prose. `singleLine` leaves the
    // bidi *marks* (U+200E/U+200F, U+061C) and the zero-width joiners alone, and
    // in a sentence they are at worst confusing. In a key they are worse than
    // that: two attachments named `invoice.pdf` and `inv<U+200F>oice.pdf` are
    // indistinguishable in every listing, in the console, and in the raw
    // Markdown of the wikilink this path becomes, while being two different
    // objects on the customer's storage bill. A filename is a place where
    // "reads as what it is" has to be literal.
    .replace(/[\u00ad\u061c\u200b-\u200f\u2060-\u2064\ufeff\ufff9-\ufffb]/g, "")
    .replace(/^[a-zA-Z]:/, "")
    .split(/[\\/]/)
    .pop();
  base = String(base ?? "").replace(/[[\]|#]/g, "-");
  base = base.replace(/^\.+/, "").trim().slice(0, 150);
  return base || "attachment";
}

/** SHA-256 of `bytes`, as lowercase hex. The content-addressing key for a stored attachment. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Where one attachment's bytes land: under the mailbox's own folder, dated,
 * content-hash-prefixed. The hash prefix is what makes the key unique across
 * two different senders' same-named `invoice.pdf`, and it is checked FIRST —
 * the same file arriving twice, byte for byte, is one key and one write.
 *
 * `attachments/YYYY/MM/DD/` since 2026-09-18, for the reason the day notes
 * beside it are nested: this is the one folder here that grows faster than one
 * entry a day, so a busy mailbox's `attachments/` held thousands of date
 * folders. The day survives as its own level — an attachment is reached from
 * the note that carried it, and keeping the day means the sweep below can go
 * on naming a day without reading a manifest.
 *
 * Forward-only. Files already written under `attachments/YYYY-MM-DD/` stay
 * there, are still served, and are still swept — see `attachmentDateOf`.
 *
 * @param {{mailboxSlug: string, date: string, contentHash: string, filename: string}} options
 */
export function attachmentPath(options) {
  if (!isCalendarDate(options.date)) throw new TypeError(`not a calendar date: ${options.date}`);
  const safeName = sanitizeAttachmentFilename(options.filename);
  const folder = channelDestinationFolder("email", options.mailboxSlug, options.folder);
  if (folder === null) throw new TypeError(`not an email destination folder: ${options.folder}`);
  const [year, month, day] = options.date.split("-");
  return `${folder}/attachments/${year}/${month}/${day}/${options.contentHash}-${safeName}`;
}

/**
 * The day an attachment key says it belongs to, in either shape, or `null`.
 *
 * Both branches are load-bearing rather than defensive: the nested one is what
 * this sync writes now, and the flat one is every file written before
 * 2026-09-18 — which the retention sweep still has to be able to name a date
 * for, or an expired attachment is deleted and the day that referenced it is
 * never re-rendered.
 *
 * @param {string} path
 * @returns {string|null}
 */
export function attachmentDateOf(path) {
  if (typeof path !== "string") return null;
  const nested = /\/attachments\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(path);
  if (nested) {
    const date = `${nested[1]}-${nested[2]}-${nested[3]}`;
    return isCalendarDate(date) ? date : null;
  }
  const flat = /\/attachments\/(\d{4}-\d{2}-\d{2})\//.exec(path);
  if (flat && isCalendarDate(flat[1])) return flat[1];
  return null;
}

/** One attachment's bytes, raw. `assertWritableContentType` in the store never sees Gmail's declared type — see that file's comment. */
export async function getAttachmentBytes({ fetchImpl, accessToken, messageId, attachmentId }) {
  const body = await gmailFetch(
    fetchImpl,
    accessToken,
    `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {},
  );
  return decodeBase64UrlToBytes(body.data);
}

/**
 * The per-mailbox attachment manifest: what this connection has fetched,
 * and what it has since expired. Plumbing — a dot-prefixed FILENAME, per
 * `isPlumbing`'s "any path segment starting with a dot is hidden from every
 * tool" — sitting beside the attachment files it describes rather than in
 * the control plane, because it is bucket bookkeeping about bucket content,
 * not metadata about the connection itself (`docs/decisions/communications.md`
 * argues the boundary the other way for sync cursors, which stay in Convex —
 * this is the complementary case: content the customer owns, described in
 * their own bucket, gone the instant they revoke and disconnect).
 *
 * Two indices in one document:
 *  - `resolved[messageId/attachmentId]` — has THIS attachment been resolved
 *    before, and if so which content hash did it resolve to. Looking this up
 *    is what lets a re-sync skip a fetch entirely for an attachment already
 *    known — expired or not — without ever calling Gmail's `attachments.get`.
 *  - `files[contentHash]` — the actual file inventory: one entry per distinct
 *    byte sequence this connection has ever written, its path, and whether
 *    retention has since expired it. THIS is what `sweepExpiredAttachments`
 *    walks — never a folder listing — which is the "idempotent, and never a
 *    folder walk" property the owner asked for.
 */
export function manifestPath(mailboxSlug, folder) {
  const base = channelDestinationFolder("email", mailboxSlug, folder);
  if (base === null) throw new TypeError(`not an email destination folder: ${folder}`);
  return `${base}/attachments/.manifest.json`;
}

const EMPTY_MANIFEST = Object.freeze({ version: 1, resolved: {}, files: {} });

/** Read the manifest, or an empty one — a missing manifest is a mailbox with nothing fetched yet, not an error. */
export async function readManifest(store, mailboxSlug, folder) {
  const object = await store.get(manifestPath(mailboxSlug, folder));
  if (!object) return { version: 1, resolved: {}, files: {} };
  try {
    const parsed = JSON.parse(await object.text());
    return {
      version: 1,
      resolved: parsed && typeof parsed.resolved === "object" ? parsed.resolved : {},
      files: parsed && typeof parsed.files === "object" ? parsed.files : {},
    };
  } catch {
    // A manifest that fails to parse is treated as empty rather than fatal:
    // the worst case is a re-fetch of everything, which is correct, merely
    // not free — never data loss, and never a sync that refuses to run.
    return { version: 1, resolved: {}, files: {} };
  }
}

export async function writeManifest(store, mailboxSlug, manifest, folder) {
  await store.put(manifestPath(mailboxSlug, folder), JSON.stringify(manifest));
}

/**
 * Resolve every attachment on one day's events: decide, per attachment,
 * whether it is already fetched, needs fetching now, or stays metadata-only
 * — and mutate each event's `attachments[]` in place with a `path` when one
 * exists. Returns the bytes actually written (for the shared per-connection
 * quota) and the updated manifest (the caller persists it once per day, not
 * once per attachment).
 *
 * Every branch below is intentional about which side effect it does NOT
 * have, so read the negatives as carefully as the positives:
 *
 *  - **A never-seen attachment, mode `metadata-only`**: rendered as metadata
 *    only, and `resolved` is NOT written — so flipping the connection back to
 *    `store` later fetches it fresh rather than remembering a decision made
 *    under the old mode.
 *  - **A never-seen attachment, too large or quota-exhausted**: same as
 *    above — not written to `resolved`, so a later pass (more quota, or the
 *    same day resynced after the size cap changes) tries again rather than
 *    remembering a skip forever.
 *  - **An attachment already in `resolved`, whose file is expired**: metadata
 *    only, and Gmail's `attachments.get` is never called — this is "a
 *    re-sync after expiry does not re-fetch," proven by a call-count
 *    assertion in the test, not merely a byte-for-byte one.
 *  - **An attachment already in `resolved`, whose file is live**: `path` is
 *    reused verbatim, again with no fetch.
 *
 * @param {{store, fetchImpl, accessToken, mailboxSlug, folder?: string,
 *          date, events: object[],
 *          attachmentMode: "metadata-only"|"store", retentionDays: number|"forever",
 *          now: string, remainingQuotaBytes: number, manifest: object}} options
 * @returns {Promise<{bytesWritten: number, manifest: object, manifestChanged: boolean}>}
 */
export async function resolveDayAttachments(options) {
  const manifest = options.manifest;
  let bytesWritten = 0;
  let manifestChanged = false;
  let remaining = options.remainingQuotaBytes;

  for (const event of options.events) {
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    for (const attachment of attachments) {
      if (!attachment.attachmentId) continue; // No id, no way to ever fetch it — stays metadata-only.
      const key = `${event.messageId}/${attachment.attachmentId}`;
      const known = manifest.resolved[key];

      if (known) {
        const file = manifest.files[known.contentHash];
        if (file && !file.expired) attachment.path = file.path;
        // Expired (or, defensively, a file entry that has gone missing) —
        // metadata-only, and NOT a single Gmail call was made to learn that.
        continue;
      }

      if (options.attachmentMode !== "store") continue;
      // The DECLARED size decides whether to spend the fetch at all. It is
      // Gmail's own accounting and is usually right, so checking it first is
      // what keeps a 30 MB attachment from being pulled through the Worker
      // only to be thrown away.
      const declaredSize = Number.isFinite(attachment.size) ? attachment.size : 0;
      if (declaredSize > GMAIL_ATTACHMENT_MAX_BYTES) continue;
      if (declaredSize > remaining) continue;

      let bytes;
      try {
        bytes = await getAttachmentBytes({
          fetchImpl: options.fetchImpl,
          accessToken: options.accessToken,
          messageId: event.messageId,
          attachmentId: attachment.attachmentId,
        });
      } catch (error) {
        // An attachment Gmail no longer has (a 404 on `attachments.get`, which
        // happens for a message deleted between listing and fetching) leaves
        // this one attachment metadata-only. It must NOT abort the day: the
        // note describing the message is worth more than the picture in it,
        // and `resolved` is deliberately not written, so a later pass tries
        // again if the attachment comes back.
        // Excluded by type rather than absorbed by inheritance, for the reason
        // `getMessageOrNull` spells out: a history-gap error can only come
        // from `listHistoryPage`, and catching it here would hide a
        // re-widening of `gmailFetch` from every test.
        if (error instanceof GmailHistoryExpiredError) throw error;
        if (error instanceof GmailApiError && error.status === 404) continue;
        // A body that is not decodable base64 (`atob` throws) is the same
        // shape of problem one field over: this one attachment cannot be
        // written, and the note describing the message still can. The rule is
        // the same throughout — an attachment costs the file, never the note.
        if (error instanceof Error && error.name === "InvalidCharacterError") continue;
        throw error;
      }

      // AND THE ACTUAL BYTES DECIDE WHETHER THEY ARE WRITTEN. The check above
      // is an optimisation, not the enforcement: `attachment.size` is absent
      // whenever Gmail omits `body.size` for a part, and `extractBody` maps
      // that to `undefined`, which lands here as a declared size of ZERO —
      // passing both bounds regardless of how large the part really is. Left
      // at that, a part with no declared size fetched and wrote 30 MB into a
      // customer's bucket with the connection's quota at zero, defeating both
      // the 25 MB cap and the quota with a field Gmail simply did not send.
      // So both bounds are re-checked against `bytes.length` BEFORE the write,
      // and — as everywhere else in this loop — a refusal is not recorded in
      // `resolved`, so a later pass with more room tries again rather than
      // remembering a skip forever.
      if (bytes.length > GMAIL_ATTACHMENT_MAX_BYTES) continue;
      if (bytes.length > remaining) continue;

      const contentHash = await sha256Hex(bytes);

      let file = manifest.files[contentHash];
      if (!file || file.expired) {
        const path = attachmentPath({
          mailboxSlug: options.mailboxSlug,
          folder: options.folder,
          date: options.date,
          contentHash,
          filename: attachment.filename,
        });
        await options.store.put(path, bytes, { contentType: "application/octet-stream" });
        file = {
          path,
          size: bytes.length,
          writtenAt: options.now,
          expiresAt:
            options.retentionDays === "forever"
              ? null
              : new Date(Date.parse(options.now) + options.retentionDays * 24 * 60 * 60 * 1000).toISOString(),
          expired: false,
        };
        manifest.files[contentHash] = file;
        remaining -= bytes.length;
        bytesWritten += bytes.length;
      }
      // A cross-message duplicate (the identical bytes, a different message
      // or attachmentId) reuses the existing file with no second write —
      // "the same file arriving twice is one object," the same rule the
      // `.context/assets/images/` store already keeps.
      manifest.resolved[key] = {
        contentHash,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
      };
      manifestChanged = true;
      attachment.path = file.path;
    }
  }

  return { bytesWritten, manifest, manifestChanged };
}

/**
 * Delete every attachment whose retention window has passed. Walks only the
 * manifest's own `files` index — never a folder listing — which is what
 * makes this idempotent: an entry already marked `expired` is skipped, so
 * running the sweep twice in a row (or twice concurrently) deletes nothing
 * a second time and reports nothing a second time.
 *
 * Deliberately does not delete `resolved` entries: a future resync of the
 * message that referenced this hash must still find "yes, this was resolved,
 * and it is gone" rather than treating it as never-seen and trying to fetch
 * it again after `attachments.get` might no longer even have it.
 *
 * @param {{store, mailboxSlug: string, now: string}} options
 * @returns {Promise<{expiredHashes: string[], affectedDates: string[]}>}
 */
export async function sweepExpiredAttachments(options) {
  const manifest = await readManifest(options.store, options.mailboxSlug, options.folder);
  const nowMs = Date.parse(options.now);
  const expiredHashes = [];
  const dates = new Set();

  // The one prefix this sweep is allowed to delete inside. The manifest is a
  // JSON file in a bucket the customer also syncs to Obsidian and rclone, so
  // it is OUR bookkeeping in THEIR storage — which means its contents are read
  // back as data, not as instructions about which objects to delete. Without
  // this line, "deletes only files this sync wrote" is a property of the code
  // that writes the manifest; with it, it is a property of the code that acts
  // on it, and a manifest entry naming `privacy.md` deletes nothing.
  const folder = channelDestinationFolder("email", options.mailboxSlug, options.folder);
  if (folder === null) throw new TypeError(`not an email destination folder: ${options.folder}`);
  const ownPrefix = `${folder}/attachments/`;

  for (const [hash, file] of Object.entries(manifest.files)) {
    if (file.expired) continue;
    if (file.expiresAt === null || file.expiresAt === undefined) continue; // "forever"
    if (Date.parse(file.expiresAt) > nowMs) continue;
    if (typeof file.path !== "string" || !file.path.startsWith(ownPrefix)) continue;
    await options.store.delete(file.path);
    file.expired = true;
    expiredHashes.push(hash);
    const date = attachmentDateOf(file.path);
    if (date !== null) dates.add(date);
  }

  if (expiredHashes.length > 0) await writeManifest(options.store, options.mailboxSlug, manifest, options.folder);
  return { expiredHashes, affectedDates: [...dates] };
}

