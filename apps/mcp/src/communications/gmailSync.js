// Gmail sync: turning a connected mailbox's messages into channel-day notes.
//
// ## Why this syncs one CALENDAR DAY at a time, rather than one PAGE
//
// A channel-day note is a full regeneration of everything that happened on
// one day (`docs/decisions/communications.md`), and `planChannelDay` is a
// pure function of the day's *complete* ordered event list. Gmail's
// `messages.list` pages are not day-aligned — a page boundary can land in the
// middle of a day — so grouping by page and writing whatever a page happens
// to contain would sometimes write a day from a partial set: correct today,
// wrong the moment that day's messages are spread across two pages.
//
// So the unit of work here is **one day**: list every message Gmail has for
// that day (scoped to the connection's folders), fetch each in full, render,
// write. That is what makes re-running a day idempotent — the day is always
// regenerated from the same live query, so the same underlying mailbox state
// produces byte-identical notes — and what makes "regenerate only the
// affected days" a precise instruction rather than an approximation: backfill
// touches every day in its window, and an incremental pass touches exactly
// the days a changed message landed on.
//
// ## What this does NOT do
//
// It does not delete a note for a message Gmail later deletes: v1 is a
// read-only mirror of what arrived, "a record of what was received, not a
// statement by the owner" (`packages/communications/src/note.js`), and a
// message once captured stays captured even if the sender or the owner later
// deletes it at Gmail. Reconciling deletions is future work, named here so it
// is a decision rather than an oversight.
//
// Everything below either does one `fetch` against Gmail's documented REST
// API or one call against a `ContextStore` (see `src/store/index.js`). Both
// are injected, which is what makes this file testable against a fixture
// Gmail server and an in-memory store rather than the real internet.

import { isCalendarDate, planChannelDay } from "../../../../packages/communications/src/index.js";

/** Where every Gmail REST call in this file goes. */
export const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";

/** The Gmail system labels a folder name maps to. Spam and Trash are never here. */
export const FOLDER_LABEL_IDS = Object.freeze({ inbox: "INBOX", sent: "SENT" });

/* -------------------------------------------------------------------------- */
/* MIME parsing — pure                                                        */
/* -------------------------------------------------------------------------- */

/** Gmail's body encoding: base64url, no padding. */
export function decodeBase64UrlToBytes(data) {
  if (typeof data !== "string" || data.length === 0) return new Uint8Array(0);
  const padded = data.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(data.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Gmail's body encoding, decoded as text. Never used on an attachment: those are arbitrary binary, not UTF-8. */
export function decodeBase64UrlToUtf8(data) {
  return new TextDecoder("utf-8", { fatal: false }).decode(decodeBase64UrlToBytes(data));
}

/** A header value by name, case-insensitively — RFC 5322 header names are case-insensitive. */
export function headerValue(headers, name) {
  const lower = String(name).toLowerCase();
  const found = (Array.isArray(headers) ? headers : []).find(
    (header) => String(header?.name ?? "").toLowerCase() === lower,
  );
  return found ? String(found.value ?? "") : "";
}

/**
 * `"Ada Lovelace" <ada@example.com>, bob@example.com` → two entries.
 *
 * Deliberately simple: it does not handle a comma inside a quoted display
 * name (`"Smith, Ada" <ada@example.com>`), which is rare enough in practice
 * that a full RFC 5322 parser is not worth carrying here. A display name is
 * `defangOutsideFence`d wherever it is rendered regardless, so a parse that
 * gets the split wrong produces an odd-looking name, never an injection.
 */
export function parseAddressList(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*?)<([^<>]+)>$/.exec(part);
      if (match) {
        const name = match[1].trim().replace(/^"(.*)"$/, "$1");
        return { name: name || undefined, address: match[2].trim() };
      }
      return { address: part };
    });
}

/** Every leaf part of a (possibly nested) MIME tree, depth first. */
function* walkParts(payload) {
  if (!payload) return;
  const children = Array.isArray(payload.parts) ? payload.parts : [];
  if (children.length === 0) {
    yield payload;
    return;
  }
  for (const child of children) yield* walkParts(child);
}

/** Very small HTML→text fallback: drop tags, decode the handful of entities mail actually uses. */
function stripHtml(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The normalized body and attachment metadata for one message.
 *
 * Every part with a `filename` contributes its name, type, declared size and
 * `attachmentId` — the id Gmail's `attachments.get` needs to fetch the bytes.
 * The id is metadata about the message, not the bytes themselves: carrying it
 * here costs nothing and is what lets `resolveDayAttachments` decide, per the
 * connection's own `attachmentMode`, whether to spend a fetch on it — see
 * that function for where the metadata-only-vs-store choice is actually
 * made. An inline image is an attachment by this same rule: Gmail gives it a
 * `filename` and a `body.attachmentId` exactly like a "real" attachment, and
 * this module does not special-case it — "inline images count as
 * attachments" per the owner's brief.
 */
export function extractBody(payload) {
  let text = "";
  let html = "";
  const attachments = [];
  for (const part of walkParts(payload)) {
    const filename = String(part?.filename ?? "").trim();
    if (filename) {
      attachments.push({
        filename,
        contentType: String(part?.mimeType ?? "application/octet-stream"),
        size: Number.isFinite(part?.body?.size) ? part.body.size : undefined,
        attachmentId: typeof part?.body?.attachmentId === "string" ? part.body.attachmentId : undefined,
      });
      continue;
    }
    const mimeType = String(part?.mimeType ?? "");
    const data = part?.body?.data;
    if (mimeType === "text/plain" && !text) text = decodeBase64UrlToUtf8(data);
    else if (mimeType === "text/html" && !html) html = decodeBase64UrlToUtf8(data);
  }
  return { text: text || (html ? stripHtml(html) : ""), attachments };
}

/**
 * One Gmail message resource (`format=full`) → one `CommunicationEvent`.
 *
 * `account` carries the **mailbox slug**, not the address — the same
 * convention `packages/communications`' own fixtures use, because it is what
 * both `messageAnchor`/`threadKey` (stability across mailboxes) and
 * `channelDayNotePath` (the folder) key off. The address itself travels
 * separately as `address`, for the frontmatter line a person reads.
 *
 * @param {object} message A Gmail `Message` resource.
 * @param {{mailboxSlug: string}} options
 * @returns {import("../../../../packages/communications/src/protocol.js").CommunicationEvent}
 */
export function gmailMessageToEvent(message, options) {
  const headers = message?.payload?.headers ?? [];
  const { text, attachments } = extractBody(message?.payload);
  const internalDate = Number(message?.internalDate);
  const sentAt = Number.isFinite(internalDate) ? new Date(internalDate).toISOString() : new Date(0).toISOString();
  const from = parseAddressList(headerValue(headers, "From"))[0] ?? {};
  return {
    channel: "email",
    account: options.mailboxSlug,
    messageId: String(message?.id ?? ""),
    threadId: String(message?.threadId ?? ""),
    sentAt,
    subject: headerValue(headers, "Subject"),
    from,
    to: parseAddressList(headerValue(headers, "To")),
    body: text,
    attachments,
  };
}

/** `YYYY-MM-DD` from an event's `sentAt`. */
export function dateKeyOf(event) {
  return String(event?.sentAt ?? "").slice(0, 10);
}

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
 *     filename of `evil]] and [[.audit/x` would close that link early and
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
 * @param {{mailboxSlug: string, date: string, contentHash: string, filename: string}} options
 */
export function attachmentPath(options) {
  if (!isCalendarDate(options.date)) throw new TypeError(`not a calendar date: ${options.date}`);
  const safeName = sanitizeAttachmentFilename(options.filename);
  return `0-inbox/email/${options.mailboxSlug}/attachments/${options.date}/${options.contentHash}-${safeName}`;
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
export function manifestPath(mailboxSlug) {
  return `0-inbox/email/${mailboxSlug}/attachments/.manifest.json`;
}

const EMPTY_MANIFEST = Object.freeze({ version: 1, resolved: {}, files: {} });

/** Read the manifest, or an empty one — a missing manifest is a mailbox with nothing fetched yet, not an error. */
export async function readManifest(store, mailboxSlug) {
  const object = await store.get(manifestPath(mailboxSlug));
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

export async function writeManifest(store, mailboxSlug, manifest) {
  await store.put(manifestPath(mailboxSlug), JSON.stringify(manifest));
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
 * @param {{store, fetchImpl, accessToken, mailboxSlug, date, events: object[],
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
      const declaredSize = Number.isFinite(attachment.size) ? attachment.size : 0;
      if (declaredSize > GMAIL_ATTACHMENT_MAX_BYTES) continue;
      if (declaredSize > remaining) continue;

      const bytes = await getAttachmentBytes({
        fetchImpl: options.fetchImpl,
        accessToken: options.accessToken,
        messageId: event.messageId,
        attachmentId: attachment.attachmentId,
      });
      const contentHash = await sha256Hex(bytes);

      let file = manifest.files[contentHash];
      if (!file || file.expired) {
        const path = attachmentPath({
          mailboxSlug: options.mailboxSlug,
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
      // `.images/` store already keeps.
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
  const manifest = await readManifest(options.store, options.mailboxSlug);
  const nowMs = Date.parse(options.now);
  const expiredHashes = [];
  const dates = new Set();

  for (const [hash, file] of Object.entries(manifest.files)) {
    if (file.expired) continue;
    if (file.expiresAt === null || file.expiresAt === undefined) continue; // "forever"
    if (Date.parse(file.expiresAt) > nowMs) continue;
    await options.store.delete(file.path);
    file.expired = true;
    expiredHashes.push(hash);
    const dateMatch = /\/attachments\/(\d{4}-\d{2}-\d{2})\//.exec(file.path);
    if (dateMatch) dates.add(dateMatch[1]);
  }

  if (expiredHashes.length > 0) await writeManifest(options.store, options.mailboxSlug, manifest);
  return { expiredHashes, affectedDates: [...dates] };
}

/* -------------------------------------------------------------------------- */
/* Gmail search query — pure                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `q` parameter for `messages.list`, scoped to the connection's folders
 * and, optionally, one calendar day.
 *
 * `-in:spam -in:trash` is written even though `in:inbox`/`in:sent` already
 * exclude both: Spam and Trash are excluded **unconditionally** in v1
 * (`docs/decisions/communications.md`), so this is asserted in the query
 * itself rather than left as something the folder list merely does not
 * mention.
 *
 * @param {{folders: Array<"inbox"|"sent">, date?: string}} options
 */
export function buildDayQuery(options) {
  const folders = Array.isArray(options?.folders) && options.folders.length ? options.folders : ["inbox", "sent"];
  const folderTerm = folders.map((folder) => `in:${folder}`).join(" OR ");
  const terms = [folders.length > 1 ? `(${folderTerm})` : folderTerm, "-in:spam", "-in:trash"];
  if (options?.date) {
    if (!isCalendarDate(options.date)) throw new TypeError(`not a calendar date: ${options.date}`);
    const start = Math.floor(Date.parse(`${options.date}T00:00:00.000Z`) / 1000);
    const end = start + 24 * 60 * 60;
    terms.push(`after:${start}`, `before:${end}`);
  }
  return terms.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Gmail REST calls — the only I/O in this file                               */
/* -------------------------------------------------------------------------- */

/** A Gmail API call that failed, classified just enough for the caller to react. */
export class GmailApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
  }
}

/** `history.list` answered 404: the cursor is too old and a full reconcile is needed. */
export class GmailHistoryExpiredError extends GmailApiError {
  constructor() {
    super(404, "Gmail's history cursor has expired; a full reconcile is required.");
    this.name = "GmailHistoryExpiredError";
  }
}

async function gmailFetch(fetchImpl, accessToken, path, params) {
  const url = new URL(`${GMAIL_API_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 404) throw new GmailHistoryExpiredError();
    // Never includes the response body: it could echo the query string, and
    // the query string never carries a secret, but the access token rides in
    // the header of the *request* this failed response is answering — a
    // provider error page that happened to reflect request context is not
    // where any of it should end up in a log.
    throw new GmailApiError(response.status, `Gmail answered ${path} with ${response.status}`);
  }
  return response.json();
}

/** One page of message ids matching `query`. */
export async function listMessageIds({ fetchImpl, accessToken, query, pageToken, maxResults = 100 }) {
  const body = await gmailFetch(fetchImpl, accessToken, "/gmail/v1/users/me/messages", {
    q: query,
    pageToken,
    maxResults,
  });
  return {
    ids: (body.messages ?? []).map((entry) => String(entry.id)),
    nextPageToken: body.nextPageToken,
    resultSizeEstimate: Number.isFinite(body.resultSizeEstimate) ? body.resultSizeEstimate : 0,
  };
}

/** Every message id matching `query`, fully paginated. Bounded so a runaway query cannot loop forever. */
export async function listAllMessageIds({ fetchImpl, accessToken, query, maxPages = 50 }) {
  const ids = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listMessageIds({ fetchImpl, accessToken, query, pageToken });
    ids.push(...result.ids);
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return ids;
}

/** One message, in full — the only shape that carries a body and headers. */
export async function getMessage({ fetchImpl, accessToken, id }) {
  return gmailFetch(fetchImpl, accessToken, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
    format: "full",
  });
}

/** The mailbox's current `historyId` — the cursor a fresh backfill or reconcile starts from. */
export async function getProfileHistoryId({ fetchImpl, accessToken }) {
  const body = await gmailFetch(fetchImpl, accessToken, "/gmail/v1/users/me/profile", {});
  return String(body.historyId ?? "");
}

/**
 * One page of `history.list`. Throws `GmailHistoryExpiredError` on a 404,
 * which is Gmail's documented signal that `startHistoryId` is too old — the
 * gap `docs/decisions/communications.md` names, whose only correct answer is
 * a full reconcile.
 */
export async function listHistoryPage({ fetchImpl, accessToken, startHistoryId, pageToken }) {
  const body = await gmailFetch(fetchImpl, accessToken, "/gmail/v1/users/me/history", {
    startHistoryId,
    historyTypes: "messageAdded",
    pageToken,
  });
  const ids = new Set();
  for (const record of body.history ?? []) {
    for (const added of record.messagesAdded ?? []) {
      if (added?.message?.id) ids.add(String(added.message.id));
    }
  }
  return { messageIds: ids, nextPageToken: body.nextPageToken, historyId: body.historyId };
}

/** Every message id added since `startHistoryId`, and the historyId to resume from next time. */
export async function listAllHistory({ fetchImpl, accessToken, startHistoryId, maxPages = 50 }) {
  const messageIds = new Set();
  let pageToken;
  let historyId = startHistoryId;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listHistoryPage({ fetchImpl, accessToken, startHistoryId, pageToken });
    for (const id of result.messageIds) messageIds.add(id);
    if (result.historyId) historyId = result.historyId;
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return { messageIds, historyId };
}

/* -------------------------------------------------------------------------- */
/* Rendering one day — pure, given its events                                 */
/* -------------------------------------------------------------------------- */

/**
 * The `updated` frontmatter value for a day, when the caller does not pin one.
 *
 * **Deterministic in the message set, not in wall-clock time.** The latest
 * message's own `sentAt` is stable across any number of reruns as long as the
 * day's mail has not changed, and it advances exactly when a new message
 * does land — which is what makes re-syncing an untouched day byte-identical
 * rather than merely content-identical modulo a timestamp that ticks forward
 * on every pass. `renderChannelDayNote`'s own default (`new Date().toISOString()`)
 * is right for a note a person is editing right now; it is wrong for a value
 * this module recomputes on a schedule against the same underlying mail.
 */
function latestSentAt(events) {
  let latest = 0;
  for (const event of events) {
    const at = Date.parse(String(event?.sentAt ?? ""));
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return new Date(latest).toISOString();
}

/**
 * Every part of one channel-day, ready to write.
 *
 * A day with zero events writes nothing — "one channel-day note per active
 * day" (`docs/decisions/communications.md`) means an inactive day is not a
 * file at all, not an empty one.
 *
 * @param {{mailboxSlug: string, address: string, date: string,
 *          events: object[], nonce: string, now?: string, root?: string}} options
 * @returns {import("../../../../packages/communications/src/protocol.js").ChannelDayPart[]}
 */
export function renderDay(options) {
  if (!options.events.length) return [];
  return planChannelDay(
    {
      channel: "email",
      account: options.mailboxSlug,
      address: options.address,
      date: options.date,
      events: options.events,
      nonce: options.nonce,
      now: options.now ?? latestSentAt(options.events),
      origin: "gmail-sync",
    },
    { root: options.root },
  );
}

/* -------------------------------------------------------------------------- */
/* Writing a day's parts through the storage adapter                          */
/* -------------------------------------------------------------------------- */

/**
 * Write one rendered part, conditional on the etag this call read.
 *
 * A day is fully regenerated from the same query every time it is touched, so
 * the common case — nothing changed since the last pass — writes the same
 * bytes over the same etag and is a no-op the store can no-op on its own; the
 * conditional write exists for the case that matters, two sync passes racing
 * on the same day, so the loser retries against the winner's etag rather than
 * clobbering it. `maxAttempts` bounds that retry rather than looping forever
 * against a store that never settles.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {import("../../../../packages/communications/src/protocol.js").ChannelDayPart} part
 * @returns {Promise<{path: string, bytes: number, wrote: boolean}>}
 */
export async function writeDayPart(store, part, maxAttempts = 3) {
  const bytes = new TextEncoder().encode(part.text).length;
  if (!store.capabilities?.conditionalWrite) {
    await store.put(part.path, part.text);
    return { path: part.path, bytes, wrote: true };
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = await store.get(part.path);
    if (existing && (await existing.text()) === part.text) {
      // Already exactly this. Nothing to write, nothing to race.
      return { path: part.path, bytes, wrote: false };
    }
    const result = existing
      ? await store.put(part.path, part.text, { onlyIf: { etagMatches: existing.etag } })
      : await store.put(part.path, part.text);
    if (result) return { path: part.path, bytes, wrote: true };
    // `null` means the precondition failed — someone else wrote first.
    // Loop and re-read; the content is a pure function of Gmail's state, so
    // converging on the current etag is always possible.
  }
  throw new Error(`writeDayPart: gave up after ${maxAttempts} attempts on ${part.path}`);
}

/**
 * Regenerate and write one day, quota-bound — note text AND, when
 * `fetchImpl`/`accessToken` are supplied, any attachments this day's
 * messages reference.
 *
 * Attachment resolution runs FIRST, against the same `remainingQuotaBytes`
 * the note text then shares: a day whose attachments consumed the whole
 * budget writes no attachment past that point and still writes the note
 * text describing them (metadata-only, per `resolveDayAttachments`'s own
 * quota check) — the note is never skipped because a picture was too big.
 *
 * `fetchImpl`/`accessToken` are optional and gate the whole feature: a
 * caller that omits them (every test that predates attachment fetching,
 * and any future caller that only wants deterministic rendering) gets
 * exactly the old metadata-only behaviour, because `resolveDayAttachments`
 * is never invoked at all.
 *
 * @param {{store: import("../store/index.js").ContextStore, mailboxSlug: string,
 *          address: string, date: string, events: object[], nonce: string,
 *          now?: string, root?: string, remainingQuotaBytes: number,
 *          fetchImpl?: FetchLike, accessToken?: string,
 *          attachmentMode?: "metadata-only"|"store",
 *          attachmentRetentionDays?: number|"forever"}} options
 * @returns {Promise<{bytesWritten: number, partsWritten: number, quotaExceeded: boolean}>}
 */
export async function syncOneDay(options) {
  let remaining = options.remainingQuotaBytes;
  let bytesWritten = 0;

  if (options.fetchImpl && options.accessToken) {
    // Wall-clock, deliberately never `options.now`: retention math ("N days
    // from when this was written") is about real elapsed time, unlike the
    // note's own `updated` field, which `renderDay` keys to the latest
    // message's timestamp so that re-rendering an unchanged day is
    // byte-identical. Conflating the two would make `attachmentRetentionDays`
    // count from whatever `now` a caller happened to pass for rendering,
    // which for a backfill can be far in the past.
    const resolutionNow = new Date().toISOString();
    const manifest = await readManifest(options.store, options.mailboxSlug);
    const resolved = await resolveDayAttachments({
      store: options.store,
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      mailboxSlug: options.mailboxSlug,
      date: options.date,
      events: options.events,
      attachmentMode: options.attachmentMode ?? "metadata-only",
      retentionDays: options.attachmentRetentionDays ?? DEFAULT_ATTACHMENT_RETENTION_DAYS,
      now: resolutionNow,
      remainingQuotaBytes: remaining,
      manifest,
    });
    bytesWritten += resolved.bytesWritten;
    remaining -= resolved.bytesWritten;
    if (resolved.manifestChanged) await writeManifest(options.store, options.mailboxSlug, resolved.manifest);
  }

  // `options.now` travels through UNCHANGED — see `renderDay`'s own default
  // (the latest event's `sentAt`) for why this function must never invent a
  // wall-clock fallback here: doing so would override that determinism for
  // every caller that goes through `syncOneDay`, which is every caller.
  const parts = renderDay(options);
  let partsWritten = 0;
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part.text).length;
    if (bytes > remaining) {
      // Quota-bound, per connection: stop before writing past what the
      // estimator showed, rather than writing partway into a day and calling
      // it done. A day skipped this way is picked up by the next pass once
      // the connection's usage has room again.
      return { bytesWritten, partsWritten, quotaExceeded: true };
    }
    const result = await writeDayPart(options.store, part);
    if (result.wrote) {
      bytesWritten += result.bytes;
      remaining -= result.bytes;
    }
    partsWritten += 1;
  }
  return { bytesWritten, partsWritten, quotaExceeded: false };
}

/** How long a fetched attachment stays before `sweepExpiredAttachments` deletes it, absent a connection-level choice. */
const DEFAULT_ATTACHMENT_RETENTION_DAYS = 90;

/* -------------------------------------------------------------------------- */
/* Orchestration: backfill and incremental sync                               */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` for every day in `[start, end]` inclusive, oldest first. */
export function dateRange(startDate, endDate) {
  const out = [];
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Fetch and render one calendar day, end to end, from Gmail's live state.
 *
 * This is the unit both backfill and incremental reconcile call: it is what
 * makes re-running any day — the same day twice in a backfill, or a day named
 * again by history — idempotent. The day is never assembled from a partial
 * page; it is always the complete, current query result for that date.
 */
export async function syncDayFromGmail(options) {
  const query = buildDayQuery({ folders: options.folders, date: options.date });
  const ids = await listAllMessageIds({ fetchImpl: options.fetchImpl, accessToken: options.accessToken, query });
  const events = [];
  for (const id of ids) {
    const message = await getMessage({ fetchImpl: options.fetchImpl, accessToken: options.accessToken, id });
    events.push(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug }));
  }
  return syncOneDay({
    store: options.store,
    mailboxSlug: options.mailboxSlug,
    address: options.address,
    date: options.date,
    events,
    nonce: options.nonce,
    now: options.now,
    root: options.root,
    remainingQuotaBytes: options.remainingQuotaBytes,
    fetchImpl: options.fetchImpl,
    accessToken: options.accessToken,
    attachmentMode: options.attachmentMode,
    attachmentRetentionDays: options.attachmentRetentionDays,
  });
}

/**
 * Backfill: every day in the connection's window, oldest to newest so a
 * quota ceiling is hit on the *most recent* history rather than the oldest —
 * arguable either way, but "the mail from this week" is the one a person
 * checks first once a mailbox is freshly connected, so it is written last is
 * wrong; newest-first backfill is left as a documented choice for the
 * scheduler that paginates this across many invocations, not decided here.
 *
 * @param {{store, fetchImpl, accessToken, mailboxSlug, address, folders,
 *          startDate: string, endDate: string, nonce: string, now?: string,
 *          root?: string, quotaBytes: number, bytesAlreadyUsed?: number}} options
 * @returns {Promise<{daysProcessed: number, daysWithMail: number, bytesWritten: number, quotaExceeded: boolean}>}
 */
export async function runBackfill(options) {
  const dates = dateRange(options.startDate, options.endDate);
  let bytesWritten = 0;
  let daysWithMail = 0;
  let daysProcessed = 0;
  let quotaExceeded = false;
  const used = options.bytesAlreadyUsed ?? 0;

  for (const date of dates) {
    const remaining = options.quotaBytes - used - bytesWritten;
    if (remaining <= 0) {
      quotaExceeded = true;
      break;
    }
    const result = await syncDayFromGmail({
      store: options.store,
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      mailboxSlug: options.mailboxSlug,
      address: options.address,
      folders: options.folders,
      date,
      nonce: options.nonce,
      now: options.now,
      root: options.root,
      remainingQuotaBytes: remaining,
      attachmentMode: options.attachmentMode,
      attachmentRetentionDays: options.attachmentRetentionDays,
    });
    daysProcessed += 1;
    bytesWritten += result.bytesWritten;
    if (result.partsWritten > 0) daysWithMail += 1;
    if (result.quotaExceeded) {
      quotaExceeded = true;
      break;
    }
  }
  return { daysProcessed, daysWithMail, bytesWritten, quotaExceeded };
}

/**
 * Incremental sync: `history.list` from the connection's cursor, regenerate
 * every day a changed message landed on, advance the cursor.
 *
 * `gapDetected` is Gmail's 404 on an expired `startHistoryId` — the caller
 * (the control-plane sync job) responds by calling `runBackfill` over the
 * connection's window again, which regenerates every day from live state and
 * is therefore a correct reconcile regardless of what was missed.
 *
 * @returns {Promise<{gapDetected: boolean, daysTouched: string[], bytesWritten: number,
 *                     quotaExceeded: boolean, historyId?: string}>}
 */
export async function runIncrementalSync(options) {
  let history;
  try {
    history = await listAllHistory({
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      startHistoryId: options.startHistoryId,
    });
  } catch (error) {
    if (error instanceof GmailHistoryExpiredError) {
      return { gapDetected: true, daysTouched: [], bytesWritten: 0, quotaExceeded: false };
    }
    throw error;
  }

  if (history.messageIds.size === 0) {
    return { gapDetected: false, daysTouched: [], bytesWritten: 0, quotaExceeded: false, historyId: history.historyId };
  }

  // Which days changed. Fetching each changed message once here — rather than
  // relying on `syncDayFromGmail`'s own re-fetch — is the cheap way to learn
  // dates; `syncDayFromGmail` still re-lists and re-fetches the day's FULL set
  // afterwards, because a day's note must reflect everything on it, not only
  // the messages history happened to name.
  const affectedDates = new Set();
  for (const id of history.messageIds) {
    const message = await getMessage({ fetchImpl: options.fetchImpl, accessToken: options.accessToken, id });
    affectedDates.add(dateKeyOf(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug })));
  }

  let bytesWritten = 0;
  let quotaExceeded = false;
  const daysTouched = [];
  const used = options.bytesAlreadyUsed ?? 0;
  for (const date of [...affectedDates].sort()) {
    const remaining = options.quotaBytes - used - bytesWritten;
    if (remaining <= 0) {
      quotaExceeded = true;
      break;
    }
    const result = await syncDayFromGmail({
      store: options.store,
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      mailboxSlug: options.mailboxSlug,
      address: options.address,
      folders: options.folders,
      date,
      nonce: options.nonce,
      now: options.now,
      root: options.root,
      remainingQuotaBytes: remaining,
      attachmentMode: options.attachmentMode,
      attachmentRetentionDays: options.attachmentRetentionDays,
    });
    daysTouched.push(date);
    bytesWritten += result.bytesWritten;
    if (result.quotaExceeded) {
      quotaExceeded = true;
      break;
    }
  }
  return { gapDetected: false, daysTouched, bytesWritten, quotaExceeded, historyId: history.historyId };
}
