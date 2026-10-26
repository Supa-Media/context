/**
 * Copying the pictures and documents of the Messages backup: which files go,
 * where on the Mac they may be read from, and one pass over `attachment`.
 *
 * The owner's pick (2026-10-26): pictures and documents up to 25 MB are
 * copied, videos are not. A file is named in the backup by two digests
 * (`digestId` in the contract): its message's, which is the folder an unsend
 * empties, and Apple's id for the file, so the same file always lands on the
 * same key and a retry overwrites itself.
 *
 * ## The pass
 *
 * Like the texts (`pass.ts`), every read and the upload are injected, and the
 * cursor moves only past what the gateway kept. It runs after the texts, in
 * the same two directions: new files forward from `filesNewest`, then history
 * backward from `filesOldest`, newest first. Each pass sends at most a budget
 * of bytes, so a decade of pictures arrives over many passes and never holds
 * up a text.
 *
 * A file that is not on the Mac is skipped, with one exception: a new one
 * whose message is under half an hour old is usually still downloading, so
 * the forward walk waits there and looks again next pass. History never
 * waits; with Messages in iCloud, old files are often only in the cloud, and
 * this app never asks for them to be downloaded.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { LIMITS, isVideoFile } from "@context/communications/backup";
import { appleEpochNsToIso } from "../imessage/appleTime.ts";
import { filesHistoryDone, type BackupCursor } from "./cursor.ts";
import type { UploadResult } from "./pass.ts";
import type { BackupFileRow } from "./queries.ts";

/** The first 32 hex characters of a SHA-256: the contract's `digestId`, computed as the gateway does. */
export function digestId(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** The id a file record carries, or undefined for a file Apple gave no id. */
export function fileIdOf(attachmentGuid: string | null | undefined): string | undefined {
  return typeof attachmentGuid === "string" && attachmentGuid !== "" ? digestId(attachmentGuid) : undefined;
}

/** The one folder this app reads files from. */
export function attachmentsRoot(home: string = homedir()): string {
  return join(home, "Library", "Messages", "Attachments");
}

/**
 * Where on this Mac a file's bytes are, from `attachment.filename`, or null
 * when that is anywhere but under `~/Library/Messages/Attachments/`. Messages
 * writes the path with a literal `~`; anything else it could hold (another
 * folder, a `..` that climbs out) is refused, and the caller resolves links
 * before reading (`isInsideAttachments`).
 */
export function attachmentPathOf(filename: string | null, home: string = homedir()): string | null {
  if (typeof filename !== "string" || filename === "") return null;
  const expanded = filename.startsWith("~/") ? join(home, filename.slice(2)) : filename;
  const resolved = resolve(expanded);
  return isInsideAttachments(resolved, home) ? resolved : null;
}

/** Whether a resolved path is strictly inside the Attachments folder. */
export function isInsideAttachments(path: string, home: string = homedir()): boolean {
  const root = resolve(attachmentsRoot(home));
  return path.startsWith(`${root}${sep}`);
}

/** The same check after links are followed: a link inside Attachments that points out of it is refused. */
export async function realAttachmentPath(path: string, home: string = homedir()): Promise<string | null> {
  try {
    const [real, root] = await Promise.all([realpath(path), realpath(attachmentsRoot(home))]);
    return real.startsWith(`${root}${sep}`) ? real : null;
  } catch {
    return null;
  }
}

/** Link previews Messages keeps as files of its own: not something anybody sent. */
const NOT_SENT_EXTENSIONS = new Set(["pluginpayloadattachment"]);

/** Whether this file is one the backup copies, from what the database says about it. */
export function wantedFile(row: Pick<BackupFileRow, "filename" | "transfer_name" | "mime_type" | "total_bytes">): boolean {
  const name = (row.transfer_name ?? row.filename ?? "").trim();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (NOT_SENT_EXTENSIONS.has(extension)) return false;
  if (isVideoFile({ type: row.mime_type ?? undefined, name })) return false;
  const declared = row.total_bytes === null ? null : Number(row.total_bytes);
  return !(declared !== null && Number.isFinite(declared) && declared > LIMITS.fileBytes);
}

/** A file read off the Mac: its bytes, or why it was not. */
export type FileRead = { bytes: Uint8Array } | { missing: true } | { tooLarge: true };

export interface FilesPassDeps {
  maxRowId(): Promise<number>;
  files(afterRowId: number, throughRowId: number): Promise<BackupFileRow[]>;
  /** Reads the file at `attachment.filename`, refusing any path `attachmentPathOf` refuses. */
  read(filename: string | null): Promise<FileRead>;
  upload(folder: string, id: string, bytes: Uint8Array): Promise<UploadResult>;
  nowMs(): number;
  saveCursor(cursor: BackupCursor): Promise<void>;
  stillWanted(): boolean;
}

export interface FilesPassOptions {
  /** `attachment` ROWIDs per page. */
  pageRows?: number;
  /** Bytes one pass may send. */
  byteBudget?: number;
  /** How long a new file that is not on the Mac yet is waited for. */
  waitMs?: number;
}

export interface FilesPassReport {
  cursor: BackupCursor;
  /** Files and bytes the gateway kept in this pass. */
  sentFiles: number;
  sentBytes: number;
  stopped?: { retry: boolean; code: string };
  /** More is waiting: another pass should run soon. */
  more: boolean;
}

export const FILES_PASS_DEFAULTS = Object.freeze({ pageRows: 200, byteBudget: 100 * 1024 * 1024, waitMs: 30 * 60_000 });

type Outcome = "done" | "wait" | "budget";

export async function runFilesPass(deps: FilesPassDeps, start: BackupCursor, options: FilesPassOptions = {}): Promise<FilesPassReport> {
  const pageRows = options.pageRows ?? FILES_PASS_DEFAULTS.pageRows;
  const byteBudget = options.byteBudget ?? FILES_PASS_DEFAULTS.byteBudget;
  const waitMs = options.waitMs ?? FILES_PASS_DEFAULTS.waitMs;

  let cursor = { ...start };
  let sentFiles = 0;
  let sentBytes = 0;
  let stopped: { retry: boolean; code: string } | undefined;
  const save = async (next: BackupCursor) => {
    cursor = next;
    await deps.saveCursor(cursor);
  };

  /** One file: `done` to move past it, `wait` to stop before it, `budget` when the pass has sent enough. */
  const copy = async (row: BackupFileRow, forward: boolean): Promise<Outcome | "failed"> => {
    if (!wantedFile(row) || !row.message_guid) return "done";
    const id = fileIdOf(row.attachment_guid);
    if (id === undefined) return "done";
    if (sentBytes >= byteBudget) return "budget";
    const read = await deps.read(row.filename);
    if ("missing" in read) {
      const sent = appleEpochNsToIso(row.date_ns);
      const young = sent !== null && deps.nowMs() - Date.parse(sent) < waitMs;
      return forward && young ? "wait" : "done";
    }
    if ("tooLarge" in read) return "done";
    const result = await deps.upload(digestId(row.message_guid), id, read.bytes);
    // A file the gateway will not keep (too large by its count) is passed over, never retried forever.
    if (!result.ok && result.code === "refused") return "done";
    if (!result.ok) {
      stopped = { retry: result.retry, code: result.code };
      return "failed";
    }
    sentFiles += 1;
    sentBytes += read.bytes.byteLength;
    return "done";
  };

  const max = await deps.maxRowId();
  if (!deps.stillWanted()) return { cursor, sentFiles, sentBytes, more: false };
  if (cursor.filesOldest === null) await save({ ...cursor, filesNewest: max, filesOldest: max + 1 });

  // New files, forward.
  let held = false;
  while (cursor.filesNewest < max) {
    if (!deps.stillWanted()) return { cursor, sentFiles, sentBytes, more: false };
    const through = Math.min(max, cursor.filesNewest + pageRows);
    let reached = cursor.filesNewest;
    let ended: Outcome | "failed" | null = null;
    for (const row of await deps.files(cursor.filesNewest, through)) {
      const outcome = await copy(row, true);
      if (outcome !== "done") {
        ended = outcome;
        break;
      }
      reached = Number(row.rowid);
    }
    const next = ended === null ? through : reached;
    if (next !== cursor.filesNewest || sentBytes > 0) await save({ ...cursor, filesNewest: next, filesBytes: start.filesBytes + sentBytes });
    if (ended === "failed") return { cursor, sentFiles, sentBytes, stopped, more: false };
    if (ended === "wait") {
      held = true;
      break;
    }
    if (ended === "budget") return { cursor, sentFiles, sentBytes, more: true };
  }

  // History, backward, newest first.
  while (!filesHistoryDone(cursor)) {
    if (!deps.stillWanted()) return { cursor, sentFiles, sentBytes, more: false };
    const through = (cursor.filesOldest as number) - 1;
    const after = Math.max(0, through - pageRows);
    const rows = (await deps.files(after, through)).sort((a, b) => Number(b.rowid) - Number(a.rowid));
    let reached = cursor.filesOldest as number;
    let ended: Outcome | "failed" | null = null;
    for (const row of rows) {
      const outcome = await copy(row, false);
      if (outcome !== "done") {
        ended = outcome;
        break;
      }
      reached = Number(row.rowid);
    }
    await save({ ...cursor, filesOldest: ended === null ? after + 1 : reached, filesBytes: start.filesBytes + sentBytes });
    if (ended === "failed") return { cursor, sentFiles, sentBytes, stopped, more: false };
    if (ended === "budget") return { cursor, sentFiles, sentBytes, more: true };
  }

  return { cursor, sentFiles, sentBytes, more: held ? false : cursor.filesNewest < max };
}
