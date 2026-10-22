/**
 * Files an email carries that are not a forwarded email's own: files Tex's
 * browser downloaded (`agent/downloads.js`), named by their `download:` ids in
 * `send_email` / `save_email_draft` `attach` (the owner, 2026-10-22: Tex found
 * a Google Voice invoice in the Admin console, then told him to download it
 * and attach it himself).
 *
 * The ids are read from this session's own bucket, so an email can only
 * carry the person's own kept files; the bytes go to the control plane once,
 * to be sent (`apps/convex/functions/lib/personEmailForward.ts` builds the
 * message), and are kept by neither side. The person sees each file's name in
 * the copy they say yes to (`emailGate.js`).
 */

import { isDownloadId, readDownload } from "../agent/downloads.js";

/** Kept equal to `apps/convex/functions/lib/personEmail.ts`, which checks again. */
export const MAX_ATTACHED_FILES = 5;
export const MAX_ATTACHED_BYTES = 10 * 1024 * 1024;

/** `attach` as a list of ids, `{ list }`, or `{ error }` saying what to fix. */
export function readAttach(value) {
  if (value === undefined || value === null) return { list: [] };
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return { error: "attach is a list of download: ids, as a browse download step gave them." };
  const ids = list.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (ids.some((id) => !isDownloadId(id))) {
    return {
      error:
        "attach takes only download: ids, as a browse download step gave them. To send on an email's own attachments, forward that email instead.",
    };
  }
  if (ids.length > MAX_ATTACHED_FILES) return { error: `One email carries at most ${MAX_ATTACHED_FILES} attached files.` };
  if (new Set(ids).size !== ids.length) return { error: "A file is attached twice." };
  return { list: ids };
}

/**
 * The files themselves, `{ files: [{ filename, contentType, data }] }` with
 * `data` as base64, or `{ error }` (gone, or too big together).
 */
export async function attachedFiles(store, ids, { now } = {}) {
  const files = [];
  let total = 0;
  for (const id of ids ?? []) {
    const kept = await readDownload(store, id, now === undefined ? {} : { now });
    if (!kept.file) return { error: kept.error };
    total += kept.file.size;
    if (total > MAX_ATTACHED_BYTES) return { error: `the attached files come to over ${MAX_ATTACHED_BYTES / 1024 / 1024} MB together` };
    files.push({ filename: kept.file.name, contentType: kept.file.type, data: kept.file.data });
  }
  return { files };
}
