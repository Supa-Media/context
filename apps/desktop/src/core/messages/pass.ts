/**
 * One Messages backup pass: read what has not been sent yet, send it, and
 * move the cursor past exactly what the gateway kept.
 *
 * Every database read and the upload are injected, so this module is a
 * reducer over their answers and the suite drives it with fakes, exactly as
 * `core/imessage/sync.ts` is driven. `main/messagesBackup.ts` supplies the
 * real ones.
 *
 * ## The order of one pass
 *
 *  1. **First look.** A cursor that has never looked takes the current
 *     highest ROWID as both ends: new texts are read forward from there and
 *     the history backward from there. Nothing is sent for this step.
 *  2. **Chats and names**, when either changed since they were last sent, so
 *     the index can name a conversation before its first message lands.
 *  3. **New texts**, forward from `newest`, a page at a time.
 *  4. **Edits and unsends** since `changesAfterNs`.
 *  5. **History**, backward from `oldest`, a few pages a pass, newest first.
 *
 * New texts come before history on purpose: a text from a minute ago is what
 * somebody is about to ask about, and a backfill of ten years must never sit
 * in front of it.
 *
 * Any failed upload ends the pass where it is. Everything before it moved the
 * cursor; nothing after it ran. A refusal the person must fix (signed out,
 * not allowed) is reported with `retry: false` so the caller stops trying
 * every minute.
 */

import type { RawParticipantRow } from "../imessage/schema.ts";
import { personRecords, type AddressBookRow } from "./contacts.ts";
import { historyDone, laterNs, type BackupCursor } from "./cursor.ts";
import type { BackupAttachmentRow, BackupChatRow, BackupMessageRow, BackupWindow } from "./queries.ts";
import { canReadChanges } from "./queries.ts";
import { chatRecords, recordsFromRows, type BackupRecord } from "./records.ts";

export type UploadResult = { ok: true } | { ok: false; retry: boolean; code: string };

export interface BackupPassDeps {
  columns(): Promise<ReadonlySet<string>>;
  maxRowId(): Promise<number>;
  messages(window: BackupWindow): Promise<BackupMessageRow[]>;
  attachmentsInRange(afterRowId: number, throughRowId: number): Promise<BackupAttachmentRow[]>;
  attachmentsForRows(rowIds: readonly number[]): Promise<BackupAttachmentRow[]>;
  chats(): Promise<BackupChatRow[]>;
  participants(): Promise<RawParticipantRow[]>;
  /** Every Contacts row with an address. `[]` when Contacts cannot be read; names are a nicety. */
  addressBook(): Promise<AddressBookRow[]>;
  upload(records: readonly BackupRecord[]): Promise<UploadResult>;
  /** Now, as an Apple-epoch nanosecond digit string. */
  nowNs(): string;
  /** A hex SHA-256 of a string. */
  digest(text: string): string;
  /** Persisted after every step that moved it, so a crash mid-pass keeps what was sent. */
  saveCursor(cursor: BackupCursor): Promise<void>;
  /** Asked between steps; `false` ends the pass quietly (the backup was turned off, the app is quitting). */
  stillWanted(): boolean;
}

export interface BackupPassOptions {
  /** ROWIDs per page. */
  pageRows?: number;
  /** Forward pages per pass. */
  forwardPages?: number;
  /** History pages per pass. */
  historyPages?: number;
  /** Changed rows read per pass. */
  changeLimit?: number;
}

export interface BackupPassReport {
  cursor: BackupCursor;
  /** Records the gateway kept in this pass. */
  sent: number;
  /** Set when an upload failed and the pass ended there. */
  stopped?: { retry: boolean; code: string };
  /** More is waiting: another pass should run soon rather than on the slow timer. */
  more: boolean;
}

export const PASS_DEFAULTS = Object.freeze({ pageRows: 1000, forwardPages: 5, historyPages: 3, changeLimit: 1000 });

class PassStopped extends Error {
  readonly result: { retry: boolean; code: string };

  constructor(result: { retry: boolean; code: string }) {
    super(result.code);
    this.result = result;
  }
}

class PassUnwanted extends Error {}

export async function runBackupPass(deps: BackupPassDeps, start: BackupCursor, options: BackupPassOptions = {}): Promise<BackupPassReport> {
  const pageRows = options.pageRows ?? PASS_DEFAULTS.pageRows;
  const forwardPages = options.forwardPages ?? PASS_DEFAULTS.forwardPages;
  const historyPages = options.historyPages ?? PASS_DEFAULTS.historyPages;
  const changeLimit = options.changeLimit ?? PASS_DEFAULTS.changeLimit;

  let cursor = { ...start };
  let sent = 0;

  const move = async (next: BackupCursor) => {
    cursor = next;
    await deps.saveCursor(cursor);
  };
  const send = async (records: readonly BackupRecord[]) => {
    if (records.length === 0) return;
    const result = await deps.upload(records);
    if (!result.ok) throw new PassStopped({ retry: result.retry, code: result.code });
    sent += records.length;
  };
  const check = () => {
    if (!deps.stillWanted()) throw new PassUnwanted();
  };

  let max = 0;
  let changesWaiting = false;
  try {
    max = await deps.maxRowId();
    check();

    // 1. First look.
    if (cursor.oldest === null) {
      await move({ ...cursor, newest: max, oldest: max + 1, changesAfterNs: deps.nowNs() });
    }

    // 2. Chats and names.
    const [chatRows, participantRows] = await Promise.all([deps.chats(), deps.participants()]);
    check();
    const chats = chatRecords(chatRows, participantRows);
    const chatsDigest = deps.digest(JSON.stringify(chats));
    if (chatsDigest !== cursor.chatsDigest) {
      await send(chats);
      await move({ ...cursor, chatsDigest });
    }
    const handles = new Set(chats.flatMap((chat) => chat.members));
    const people = personRecords(handles, await deps.addressBook());
    check();
    const peopleDigest = deps.digest(JSON.stringify(people));
    if (peopleDigest !== cursor.peopleDigest) {
      await send(people);
      await move({ ...cursor, peopleDigest });
    }

    // 3. New texts.
    for (let page = 0; page < forwardPages && cursor.newest < max; page += 1) {
      check();
      const after = cursor.newest;
      const through = Math.min(max, after + pageRows);
      const window: BackupWindow = { kind: "range", afterRowId: after, throughRowId: through };
      const [rows, files] = await Promise.all([deps.messages(window), deps.attachmentsInRange(after, through)]);
      await send(recordsFromRows(rows, files));
      await move({ ...cursor, newest: through });
    }

    // 4. Edits and unsends.
    const columns = await deps.columns();
    check();
    if (canReadChanges(columns)) {
      const rows = await deps.messages({ kind: "changed", afterNs: cursor.changesAfterNs, limit: changeLimit });
      changesWaiting = rows.length >= changeLimit;
      if (rows.length > 0) {
        const rowIds = rows.map((row) => Number(row.rowid)).filter((id) => Number.isSafeInteger(id) && id > 0);
        const files = rowIds.length > 0 ? await deps.attachmentsForRows(rowIds) : [];
        await send(recordsFromRows(rows, files));
        let latest = cursor.changesAfterNs;
        for (const row of rows) {
          for (const ns of [row.date_edited_ns, row.date_retracted_ns]) {
            if (ns !== null && /^\d{1,20}$/.test(ns)) latest = laterNs(latest, ns);
          }
        }
        await move({ ...cursor, changesAfterNs: latest });
      }
    }

    // 5. History, newest first.
    for (let page = 0; page < historyPages && !historyDone(cursor); page += 1) {
      check();
      const through = (cursor.oldest as number) - 1;
      const after = Math.max(0, through - pageRows);
      const window: BackupWindow = { kind: "range", afterRowId: after, throughRowId: through };
      const [rows, files] = await Promise.all([deps.messages(window), deps.attachmentsInRange(after, through)]);
      await send(recordsFromRows(rows, files));
      await move({ ...cursor, oldest: after + 1 });
    }
  } catch (error) {
    if (error instanceof PassStopped) return { cursor, sent, stopped: error.result, more: false };
    if (error instanceof PassUnwanted) return { cursor, sent, more: false };
    throw error;
  }

  return { cursor, sent, more: cursor.newest < max || changesWaiting || !historyDone(cursor) };
}
