/**
 * Download messages: the backup read back from the person's bucket into a
 * folder on this Mac, as it is kept (owner, 2026-10-27): the log's JSON-lines
 * objects under `log/` and the pictures and documents under
 * `files/<folder>/<id>`, the same paths they have in the bucket under
 * `.context/messages/imessage/` (`docs/decisions/communications/messages-backup.md`).
 *
 * It reads what the bucket holds, not this Mac's Messages database, so it is
 * the same copy whichever Mac asks, and a Mac that never ran the backup can
 * still take it home. The log comes back a page at a time
 * (`GET /messages/imessage/log`), and each file a live message holds is
 * fetched (`GET /messages/imessage/file/<folder>/<id>`). A file the bucket
 * does not hold (never copied, or taken back by an unsend) is counted, not
 * written.
 *
 * Every read and write is injected; the main process supplies the folder
 * and the gateway (`main/messagesDownload.ts`). The rules of `upload.ts`
 * hold: the credential in a header and nowhere else, only a closed set of
 * codes reported, and nothing of a text in an error.
 */

import { FILE_ID, LIMITS, MESSAGES_BACKUP_FILE_ROUTE, normalizeBackupRecord } from "@context/communications/backup";
import { MESSAGES_BACKUP_LOG_ROUTE, copyPathOf, foldRecords } from "@context/communications/backupLog";
import { digestId } from "./files.ts";
import { classifyStatus, type BackupUploadConfig } from "./upload.ts";

/** Pages of the log read at most: fifty objects each, far past any person's history. */
export const MOST_LOG_PAGES = 2000;

type Refusal = { ok: false; retry: boolean; code: string };
export type LogPageRead = { ok: true; objects: { key: string; text: string }[]; next: string | null } | Refusal;
export type BackupFileRead = { ok: true; bytes: Uint8Array } | { missing: true } | Refusal;

async function authorized(config: BackupUploadConfig, url: string, timeoutMs: number): Promise<Response | Refusal> {
  const token = await config.token();
  if (token === null) return { ok: false, retry: false, code: "reconnect" };
  const timeout = AbortSignal.timeout(config.timeoutMs ?? timeoutMs);
  const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
  try {
    return await (config.fetch ?? fetch)(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal });
  } catch {
    return { ok: false, retry: true, code: "offline" };
  }
}

/** One page of the log after `after`. */
export async function readBackupLogPage(config: BackupUploadConfig, after: string | undefined): Promise<LogPageRead> {
  const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const response = await authorized(config, `${config.baseUrl}${MESSAGES_BACKUP_LOG_ROUTE}${query}`, 60_000);
  if (!(response instanceof Response)) return response;
  if (!response.ok) return { ok: false, ...classifyStatus(response.status) };
  try {
    const answer = (await response.json()) as { ok?: unknown; objects?: unknown; next?: unknown };
    const objects = Array.isArray(answer?.objects) ? answer.objects : null;
    const next = answer?.next === null || typeof answer?.next === "string" ? answer.next : undefined;
    if (answer?.ok !== true || objects === null || next === undefined) return { ok: false, retry: true, code: "unavailable" };
    const kept = objects.filter((object): object is { key: string; text: string } => typeof object?.key === "string" && typeof object?.text === "string");
    return { ok: true, objects: kept, next };
  } catch {
    return { ok: false, retry: true, code: "unavailable" };
  }
}

/** One file's bytes, read no further than the backup's limit. */
export async function readBackupFile(config: BackupUploadConfig, folder: string, id: string): Promise<BackupFileRead> {
  const response = await authorized(config, `${config.baseUrl}${MESSAGES_BACKUP_FILE_ROUTE}/${folder}/${id}`, 120_000);
  if (!(response instanceof Response)) return response;
  if (response.status === 404) return { missing: true };
  if (!response.ok) return { ok: false, ...classifyStatus(response.status) };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LIMITS.fileBytes) return { missing: true };
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > LIMITS.fileBytes ? { missing: true } : { ok: true, bytes };
  } catch {
    return { ok: false, retry: true, code: "offline" };
  }
}

export interface MessagesDownloadDeps {
  readLogPage(after: string | undefined): Promise<LogPageRead>;
  readFile(folder: string, id: string): Promise<BackupFileRead>;
  /** Writes under the chosen folder; `path` is relative and made only of safe segments. */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** Told after each picture, so the page can say how far it is. */
  progress?(done: { pictures: number; of: number }): void;
  /** False once the person cancelled or the app is quitting. */
  stillWanted?(): boolean;
}

export type MessagesDownloadResult =
  | { ok: true; conversations: number; transcripts: number; pictures: number; notCopied: number }
  | { ok: false; code: string };

/** Read the whole backup and write it out. Nothing is written until the log has been read to its end. */
export async function runMessagesDownload(deps: MessagesDownloadDeps): Promise<MessagesDownloadResult> {
  const wanted = () => deps.stillWanted?.() !== false;
  const objects: { path: string; text: string }[] = [];
  const records: unknown[] = [];
  let after: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MOST_LOG_PAGES || !wanted()) return { ok: false, code: wanted() ? "too_long" : "cancelled" };
    const read = await deps.readLogPage(after);
    if (!read.ok) return { ok: false, code: read.code };
    for (const object of read.objects) {
      const path = copyPathOf(object.key);
      // A key that is not a log object's is not copied, wherever it says it goes.
      if (path === null) continue;
      objects.push({ path, text: object.text });
      for (const line of object.text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const record = normalizeBackupRecord(JSON.parse(line));
          if (record !== null) records.push(record);
        } catch {
          // A line that is not a record is copied as it is, and counts for nothing.
        }
      }
    }
    if (read.next === null) break;
    // A page that does not move would be read for ever.
    if (read.next === after) return { ok: false, code: "unavailable" };
    after = read.next;
  }

  const fold = foldRecords(records);
  // Every file a live message holds, at its own path under the backup: `files/<folder>/<id>`.
  const wantedFiles = new Map<string, { folder: string; id: string }>();
  for (const message of fold.messages) {
    if (!Array.isArray(message.files)) continue;
    const folder = digestId(message.id);
    for (const file of message.files as { id?: unknown }[]) {
      if (typeof file.id === "string" && FILE_ID.test(file.id)) wantedFiles.set(`files/${folder}/${file.id}`, { folder, id: file.id });
    }
  }
  let pictures = 0;
  let notCopied = 0;
  let done = 0;
  for (const [path, file] of wantedFiles) {
    if (!wanted()) return { ok: false, code: "cancelled" };
    const read = await deps.readFile(file.folder, file.id);
    done += 1;
    if ("missing" in read) notCopied += 1;
    else if (!read.ok) return { ok: false, code: read.code };
    else {
      await deps.write(path, read.bytes);
      pictures += 1;
    }
    deps.progress?.({ pictures: done, of: wantedFiles.size });
  }

  for (const object of objects) await deps.write(object.path, object.text);
  // `transcripts` is the bridge's name for the files of texts written: here, the log's objects.
  return { ok: true, conversations: fold.chats.size, transcripts: objects.length, pictures, notCopied };
}
