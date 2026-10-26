/**
 * The Messages backup read back by its owner, for the Mac app's Download
 * messages (`docs/decisions/communications/messages-backup.md`).
 *
 *  - `GET /messages/imessage/log?after=<key>` answers one page of the log,
 *    `{ ok, objects: [{ key, text }], next }`, by the pager the console's
 *    Download as folders uses (`packages/communications/src/backupLog.js`).
 *  - `GET /messages/imessage/file/<folder>/<id>` answers one file's bytes.
 *
 * Who may read is who may write, decided by `messagesBackupRefusal` before a
 * store is opened: the owner of the personal workspace on a private-tier
 * grant, never by `@name`. A file is answered as an attachment of no type a
 * browser runs, as it was stored.
 */

import { fileKeyOf } from "../../../../packages/communications/src/backup.js";
import { readLogPage } from "../../../../packages/communications/src/backupLog.js";
import { ATTACHMENT_CONTENT_TYPE } from "../store/contentTypes.js";
import { json } from "../http/responses.js";

export const MESSAGES_BACKUP_LOG_ROUTE = "/messages/imessage/log";

/** One page of the log. */
export async function handleMessagesBackupLog(request, store) {
  const after = new URL(request.url).searchParams.get("after") ?? undefined;
  try {
    const page = await readLogPage(store, after === "" ? undefined : after);
    return json({ ok: true, ...page });
  } catch {
    return json({ ok: false, error: "unavailable" }, 503);
  }
}

/** One file's bytes, or 404 when the backup does not hold it (never copied, or taken back by an unsend). */
export async function handleMessagesBackupFileRead(store, { folder, id }) {
  let object;
  try {
    object = await store.get(fileKeyOf(folder, id));
  } catch {
    return json({ ok: false, error: "unavailable" }, 503);
  }
  if (!object) return json({ ok: false, error: "not_found" }, 404);
  const bytes = await object.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": ATTACHMENT_CONTENT_TYPE,
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
