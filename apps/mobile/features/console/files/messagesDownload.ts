/**
 * The Messages backup in a whole-workspace Download as folders, for its
 * owner: the texts as one Markdown file per conversation per month, under
 * `Messages/` (owner, 2026-10-26; `docs/decisions/communications/messages-backup.md`).
 *
 * The server hands back the log a page at a time (`messagesExport.readLogForExport`,
 * an empty page for anyone else), and the transcripts are made here, by the
 * same fold and rendering the Mac app uses. Only the texts: a picture is named
 * where it was sent, and the pictures themselves come with Download messages.
 */

import { normalizeBackupRecord } from "@context/communications/backup";
import { foldRecords, transcriptFiles } from "@context/communications/backupTranscript";
import type { ZipEntry } from "./zip";

/** The folder a whole-workspace archive keeps the texts in. */
export const MESSAGES_FOLDER = "Messages";

/**
 * Pages read at most: fifty log objects each, so far past any person's
 * history. A log longer than that is said to be short rather than left out
 * unsaid.
 */
export const MOST_PAGES = 2000;

export interface LogPage {
  objects: readonly { key: string; text: string }[];
  next: string | null;
}

export interface MessagesOutcome {
  entries: ZipEntry[];
  /** True when the log could not be read to its end, so nothing of it is in the archive. */
  short: boolean;
}

/**
 * `Messages`, or `Messages (backup)` when the person already has something
 * called Messages at the top of the archive, so a transcript never lands in,
 * or over, a folder of their own.
 */
export function messagesFolderFor(paths: readonly string[]): string {
  const taken = (name: string) => paths.some((path) => path.toLowerCase() === name.toLowerCase() || path.toLowerCase().startsWith(`${name.toLowerCase()}/`));
  return taken(MESSAGES_FOLDER) ? `${MESSAGES_FOLDER} (backup)` : MESSAGES_FOLDER;
}

/** Every page of the log, folded and rendered under `folder`; nothing at all when it could not be read to the end. */
export async function collectMessages(
  readPage: (after: string | undefined) => Promise<LogPage>,
  folder: string = MESSAGES_FOLDER,
): Promise<MessagesOutcome> {
  const records: unknown[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; ; page += 1) {
      if (page >= MOST_PAGES) return { entries: [], short: true };
      const answer = await readPage(after);
      for (const object of answer.objects) {
        for (const line of object.text.split("\n")) {
          if (line.trim() === "") continue;
          try {
            const record = normalizeBackupRecord(JSON.parse(line));
            if (record !== null) records.push(record);
          } catch {
            // A line that is not a record is not a text.
          }
        }
      }
      if (answer.next === null) break;
      // A page that does not move would be read for ever: said to be short instead.
      if (answer.next === after) return { entries: [], short: true };
      after = answer.next;
    }
  } catch {
    return { entries: [], short: true };
  }
  const encoder = new TextEncoder();
  const entries = transcriptFiles(foldRecords(records), { links: false }).map((file) => ({
    path: `${folder}/${file.path}`,
    bytes: encoder.encode(file.text),
  }));
  return { entries, short: false };
}
