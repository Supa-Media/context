/**
 * The Messages backup's pictures and documents, and what an unsend takes back
 * (`docs/decisions/communications/messages-backup.md`).
 *
 * ## A file
 *
 * `POST /messages/imessage/file/<folder>/<id>` carries one file's bytes, up to
 * `LIMITS.fileBytes`. It lands at `.context/messages/imessage/files/<folder>/<id>`,
 * where `folder` names the message and `id` the file, both digests the Mac
 * computed (`digestId` in the contract). The same file always lands on the
 * same key, so a retry overwrites itself and nothing is ever kept twice.
 *
 * Every file is stored as `application/octet-stream`, whatever it is: its type
 * was chosen by whoever sent it, and the record keeps that as text
 * (`store/contentTypes.js` argues the rule for mail attachments). Which files
 * are sent (no videos, nothing over the limit) is the Mac's setting to keep;
 * the gateway holds the size limit, which no setting moves.
 *
 * Who may post one is decided exactly as for a batch, by
 * `messagesBackupRefusal`, before a store is opened.
 *
 * ## An unsend
 *
 * Apple lets a sender take a text back for two minutes. By then the backup has
 * usually copied it: its words sit in an earlier batch's object, and its files
 * under its folder. The owner's pick is that an unsent message keeps nothing,
 * so a batch that carries one also
 *
 *  - deletes every file under that message's folder, and
 *  - rewrites the log objects of that month that arrived from an hour before
 *    the message was sent onwards, dropping its earlier lines. (A copy cannot
 *    arrive before the text was sent; the hour is for a Mac clock that is off.)
 *
 * Both run before the batch is answered `ok`, so a failure is a refusal the
 * Mac sends again, and both are idempotent. The rewrite keeps every other line
 * as it was, and an object is replaced only on the version it was read at
 * where the bucket can promise that.
 */

import {
  BACKUP_PREFIX,
  LIMITS,
  digestId,
  fileKeyOf,
  filesFolderKeyOf,
} from "../../../../packages/communications/src/backup.js";
import { ATTACHMENT_CONTENT_TYPE } from "../store/contentTypes.js";
import { json } from "../http/responses.js";

const LOG = `${BACKUP_PREFIX}log/`;

/** How long before a message was sent a batch carrying it may have arrived: a Mac's clock can be wrong. */
export const UNSEND_LOOKBACK_MS = 60 * 60 * 1000;
/** Log objects one unsend may read. The batches of the hours after a text are far fewer. */
export const UNSEND_MOST_OBJECTS = 500;

/** The body, or `tooLarge`, read no further than the limit whatever the request claims. */
async function readCapped(request, most) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > most) return { tooLarge: true };
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > most) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes };
}

/** Keep one file. The caller has already passed `messagesBackupRefusal` and parsed the route. */
export async function handleMessagesBackupFile(request, store, { folder, id }) {
  const { bytes, tooLarge } = await readCapped(request, LIMITS.fileBytes);
  if (tooLarge) return json({ ok: false, error: "too_large" }, 413);
  if (bytes.byteLength === 0) return json({ ok: false, error: "empty" }, 400);
  try {
    await store.put(fileKeyOf(folder, id), bytes, { contentType: ATTACHMENT_CONTENT_TYPE });
  } catch {
    return json({ ok: false, error: "unavailable" }, 503);
  }
  return json({ ok: true, bytes: bytes.byteLength });
}

async function readText(object) {
  if (!object) return null;
  if (typeof object.text === "function") return await object.text();
  return typeof object.body === "string" ? object.body : null;
}

/** Keys under a prefix, page after page by the last key seen, at most `most`. */
async function listAll(store, { prefix, startAfter }, most) {
  const keys = [];
  let after = startAfter;
  while (keys.length < most) {
    const page = await store.list({ prefix, limit: Math.min(1000, most - keys.length), ...(after ? { startAfter: after } : {}) });
    const objects = page?.objects ?? [];
    keys.push(...objects.map((object) => object.key));
    const last = page?.resumeAfter ?? objects.at(-1)?.key;
    if (!page?.truncated || !last || last === after) break;
    after = last;
  }
  return keys;
}

/** The earlier copies of these messages, and nothing else, out of one log object. Null when it holds none. */
export function withoutEarlierCopies(text, ids) {
  let changed = false;
  const kept = [];
  for (const line of String(text).split("\n")) {
    if (line) {
      try {
        const record = JSON.parse(line);
        if (record?.kind === "message" && ids.has(record.id) && record.unsent !== true) {
          changed = true;
          continue;
        }
      } catch {
        // Not a record: kept as it was.
      }
    }
    kept.push(line);
  }
  return changed ? kept.join("\n") : null;
}

async function scrub(store, key, ids) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const object = await store.get(key);
    const text = await readText(object);
    if (text === null) return;
    const next = withoutEarlierCopies(text, ids);
    if (next === null) return;
    // Written as the batch wrote it (`messagesBackup.js`), on the version read.
    // A bucket that cannot hold a write to a version (B2, Wasabi) is written plainly:
    // a log object is never appended to, so only another unsend could race this one.
    const conditional = object?.etag && store.capabilities?.conditionalWrite === true;
    const written = await store.put(key, next, conditional ? { onlyIf: { etagMatches: object.etag } } : undefined);
    if (written !== null) return;
  }
  throw new Error("a log object kept changing while an unsend was applied");
}

/**
 * Take back what the backup kept of every unsent message in `records`: its
 * files, and its words in earlier batches. Throws when that could not be
 * finished, so the batch is refused and sent again.
 */
export async function forgetUnsent(store, records) {
  const unsent = records.filter((record) => record.kind === "message" && record.unsent === true);
  if (unsent.length === 0) return;

  for (const record of unsent) {
    const folder = filesFolderKeyOf(await digestId(record.id));
    for (const key of await listAll(store, { prefix: folder }, LIMITS.files * 4)) await store.delete(key);
  }

  const byMonth = new Map();
  for (const record of unsent) {
    const month = record.at.slice(0, 7).replace("-", "/");
    const entry = byMonth.get(month) ?? { ids: new Set(), from: Infinity };
    entry.ids.add(record.id);
    entry.from = Math.min(entry.from, Date.parse(record.at) - UNSEND_LOOKBACK_MS);
    byMonth.set(month, entry);
  }
  for (const [month, { ids, from }] of byMonth) {
    const prefix = `${LOG}${month}/`;
    const startAfter = `${prefix}${String(Math.max(0, from)).padStart(13, "0")}`;
    for (const key of await listAll(store, { prefix, startAfter }, UNSEND_MOST_OBJECTS)) await scrub(store, key, ids);
  }
}
