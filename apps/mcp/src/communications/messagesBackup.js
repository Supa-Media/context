/**
 * `POST /messages/imessage/batch`: the Mac app's Messages backup lands here
 * (`docs/decisions/communications/messages-backup.md`).
 *
 * The Mac sends records (`packages/communications/src/backup.js` is the
 * contract); this keeps them in the person's own bucket under
 * `.context/messages/imessage/` and answers `ok` only once every object of the
 * batch is written, because the Mac moves its cursor on that answer and on
 * nothing else.
 *
 * ## Who may write here
 *
 * The owner of a **personal** workspace, through a grant that holds both
 * `context:write` and `context:private`. Everything is decided from the
 * session alone, before a store is opened, so a refusal says nothing about
 * what any bucket holds. A member, an editor of somebody else's workspace, a
 * shared workspace and a team-tier grant are all refused: one person's texts
 * are never written where another person could be the one who reads them.
 *
 * ## The layout
 *
 * Append-only. Each batch writes one object per group it touches:
 *
 *     .context/messages/imessage/log/<yyyy>/<mm>/<batch>.jsonl   messages and reactions, by the month they were sent
 *     .context/messages/imessage/log/chats/<batch>.jsonl         conversations
 *     .context/messages/imessage/log/people/<batch>.jsonl        names for the handles in them
 *
 * `<batch>` begins with the time it arrived, so a listing is in arrival order,
 * and a reader folds records by `recordKey`, the later one winning. Nothing is
 * read back to write a batch, so two batches can never race each other into a
 * lost update, and a batch sent twice (the Mac retries after a lost answer)
 * changes nothing a fold can see.
 */

import {
  BACKUP_PREFIX,
  LIMITS,
  MESSAGES_BACKUP_FILE_ROUTE,
  MESSAGES_BACKUP_ROUTE,
  monthOf,
  readBackupBatch,
} from "../../../../packages/communications/src/backup.js";
import { SCOPE_PRIVATE, SCOPE_WRITE, hasScope } from "../session.js";
import { json } from "../http/responses.js";
import { projectBatch } from "./textsIndex.js";
import { isGroupSession } from "../agent/groupTurn.js";
import { forgetUnsent } from "./messagesBackupFiles.js";
import { MESSAGES_BACKUP_LOG_ROUTE } from "./messagesBackupRead.js";

export { MESSAGES_BACKUP_ROUTE };

/** The batch route, the log route, or any path under the file route (`messagesBackupFiles.js` parses it). */
export function isMessagesBackupPath(path) {
  return (
    path === MESSAGES_BACKUP_ROUTE ||
    path === MESSAGES_BACKUP_LOG_ROUTE ||
    (typeof path === "string" && path.startsWith(`${MESSAGES_BACKUP_FILE_ROUTE}/`))
  );
}

/** Whether this is a read of the backup by its owner (`messagesBackupRead.js`): a GET of the log or of a file. */
export function isMessagesBackupRead(path, method) {
  return method === "GET" && (path === MESSAGES_BACKUP_LOG_ROUTE || (typeof path === "string" && path.startsWith(`${MESSAGES_BACKUP_FILE_ROUTE}/`)));
}

/** Where every batch object lives. */
export const MESSAGES_BACKUP_LOG = `${BACKUP_PREFIX}log/`;

/**
 * Why this session may not write a backup, or `null` when it may.
 * Read from the session only, so it can run before any store exists.
 */
export function messagesBackupRefusal(session, slug) {
  // The backup always lands in the caller's own personal workspace. A route
  // that took an `@name` would invite a reading in which it lands elsewhere.
  if (slug) return json({ ok: false, error: "not_available" }, 404);
  const allowed =
    session?.workspaceKind === "personal" &&
    session?.role === "owner" &&
    session?.scope === "private" &&
    hasScope(session, SCOPE_WRITE) &&
    hasScope(session, SCOPE_PRIVATE);
  return allowed ? null : json({ ok: false, error: "not_allowed" }, 403);
}

/**
 * Whether this session may read the backup (`tools/texts.js`): the owner of
 * the personal workspace on a private-tier grant, as for writing it, and
 * never Tex answering in a group chat, where the people reading the answer
 * are not the person whose texts these are.
 */
export function textsCleared(session) {
  return (
    session?.workspaceKind === "personal" &&
    session?.role === "owner" &&
    session?.scope === "private" &&
    hasScope(session, SCOPE_PRIVATE) &&
    !isGroupSession(session)
  );
}

function batchId(now) {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${String(now).padStart(13, "0")}-${random}`;
}

/** The group a record is written under: `yyyy/mm`, `chats` or `people`. */
export function groupOf(record) {
  if (record.kind === "chat") return "chats";
  if (record.kind === "person") return "people";
  const month = monthOf(record);
  return month === null ? null : month.replace("-", "/");
}

async function readBody(request) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) return { tooLarge: true };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) return { tooLarge: true };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: undefined };
  }
}

/** Write one batch. The caller has already passed `messagesBackupRefusal`. */
export async function handleMessagesBackup(request, store, { now = Date.now() } = {}) {
  const { body, tooLarge } = await readBody(request);
  if (tooLarge) return json({ ok: false, error: "too_large" }, 413);
  const batch = readBackupBatch(body);
  if (!batch.ok) return json({ ok: false, error: batch.reason }, batch.reason === "too_many" ? 413 : 400);

  const groups = new Map();
  for (const record of batch.records) {
    const group = groupOf(record);
    if (group === null) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(record);
  }

  const id = batchId(now);
  const written = [];
  try {
    // One group after another rather than all at once: a batch spans a few
    // months at most, and a failure part-way leaves the Mac to send the whole
    // batch again, which the fold absorbs.
    for (const [group, records] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = `${MESSAGES_BACKUP_LOG}${group}/${id}.jsonl`;
      await store.put(key, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      written.push([key, records]);
    }
    // After the batch's own objects, whose unsent records stay.
    await forgetUnsent(store, batch.records);
  } catch {
    return json({ ok: false, error: "unavailable" }, 503);
  }
  // The index (`textsIndex.js`) behind the response where the host allows it;
  // what it misses it leaves a marker for, so it never fails or slows the write.
  const projecting = projectBatch(store, written).catch(() => {});
  if (typeof store.defer === "function") store.defer(projecting);
  else await projecting;
  return json({ ok: true, kept: batch.records.length, dropped: batch.dropped });
}
