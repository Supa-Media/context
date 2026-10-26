/**
 * The Electron half of the Messages backup: the real `sqlite3` reads, the
 * machine's grant, a watcher on `~/Library/Messages`, a timer, and the status
 * the console shows.
 *
 * What a pass reads and sends is decided in `core/messages/*.ts` and proven
 * there without Electron; this file supplies the real dependencies and owns
 * the state that only a running app has: whether a pass is due, and what the
 * last one found. `docs/decisions/communications/messages-backup.md` carries
 * the argument.
 */

import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopSettings } from "../core/settings.ts";
import type { GatewayConnection } from "../core/sync/connection.ts";
import { gatewayBaseFrom } from "../core/sync/connection.ts";
import { APPLE_EPOCH_MS } from "../core/imessage/appleTime.ts";
import { attemptChatDbRead, detectFullDiskAccess, type FullDiskAccessStatus } from "../core/imessage/permission.ts";
import { defaultChatDbPath, isAllowedChatDbPath } from "../core/imessage/paths.ts";
import { queryAddressBook, queryChatDb } from "../core/imessage/sqlite.ts";
import { selectParticipantsSql, type RawParticipantRow } from "../core/imessage/schema.ts";
import {
  ADDRESS_BOOK_FILE,
  addressBookRoot,
  isAllowedAddressBookPath,
  selectEmailNamesSql,
  selectPhoneNamesSql,
  type AddressBookRow,
} from "../core/messages/contacts.ts";
import { historyDone, type BackupCursor } from "../core/messages/cursor.ts";
import { runBackupPass, type BackupPassDeps } from "../core/messages/pass.ts";
import {
  knownColumns,
  selectAccountSql,
  selectAttachmentsForRowsSql,
  selectBackupAttachmentsSql,
  selectBackupMessagesSql,
  selectChatsSql,
  selectMessageColumnsSql,
  selectMessageTotalsSql,
  selectRowsFromSql,
  type BackupAttachmentRow,
  type BackupChatRow,
  type BackupMessageRow,
} from "../core/messages/queries.ts";
import { uploadBackupRecords } from "../core/messages/upload.ts";
import { observeChatDb, type ImessageWatcher } from "./imessage.ts";

export interface BackupCursorStore {
  readBackupCursor(): Promise<BackupCursor>;
  writeBackupCursor(cursor: BackupCursor): Promise<void>;
}

/** What the backup is doing, in the words the console turns into a sentence. */
export type BackupPhase =
  | "off"
  | "needs_permission"
  | "no_messages"
  | "not_connected"
  | "copying"
  | "up_to_date"
  | "stopped";

export interface BackupStatus {
  enabled: boolean;
  phase: BackupPhase;
  permission: FullDiskAccessStatus;
  /** Rows of `chat.db` the backup has reached, and how many there are. Rows, not messages: tapbacks count too. */
  copiedRows: number;
  totalRows: number;
  /** When a pass last kept something. */
  lastCopiedAt: number | null;
  /** Why it stopped, from a closed set (`upload.ts`'s codes), when `phase` is `stopped`. */
  problem: string | null;
  /** The account Messages is signed into, masked: `+1 ••• 4410`, `a••••@example.com`. */
  account: string | null;
}

/** The slow beat while nothing is waiting. The watcher brings new texts sooner. */
export const BACKUP_IDLE_MS = 5 * 60_000;
/** The quick beat while history is still being copied. */
export const BACKUP_BUSY_MS = 20_000;
/** After a retryable failure. */
export const BACKUP_RETRY_MS = 2 * 60_000;
/** Let SQLite's write burst settle before reading. */
export const BACKUP_CHANGE_DEBOUNCE_MS = 2_000;

export interface MessagesBackupDeps {
  store: BackupCursorStore;
  connection: GatewayConnection;
  /** Read fresh every time, so the switch takes effect without a restart. */
  settings: () => Pick<DesktopSettings, "messagesBackup">;
  onChange?: (status: BackupStatus) => void;
  now?: () => number;
  /** Overridable for the suite. */
  chatDbPath?: () => string;
  observeChatDb?: (path: string, onChange: () => void) => ImessageWatcher;
  query?: (path: string, sql: string) => Promise<unknown[]>;
  addressBook?: () => Promise<AddressBookRow[]>;
  fetch?: typeof fetch;
}

const INITIAL: BackupStatus = Object.freeze({
  enabled: false,
  phase: "off",
  permission: "unknown",
  copiedRows: 0,
  totalRows: 0,
  lastCopiedAt: null,
  problem: null,
  account: null,
});

/** `P:+15550104410` → `+1 ••• 4410`; `E:ada@example.com` → `a••@example.com`. Never the whole thing. */
export function maskAccount(login: unknown): string | null {
  if (typeof login !== "string") return null;
  const value = login.replace(/^[EP]:/i, "").trim();
  if (value.includes("@")) {
    const [user, domain] = value.split("@");
    if (!user || !domain) return null;
    return `${user[0]}••@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return null;
  const country = value.startsWith("+") && digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "";
  return `${country}••• ${digits.slice(-4)}`;
}

/** Every Contacts database on this Mac, at the paths `contacts.ts` allows. */
export async function addressBookPaths(root: string = addressBookRoot()): Promise<string[]> {
  const found: string[] = [join(root, ADDRESS_BOOK_FILE)];
  try {
    for (const entry of await readdir(join(root, "Sources"))) found.push(join(root, "Sources", entry, ADDRESS_BOOK_FILE));
  } catch {
    // No Sources folder: the top-level database, if any, is all there is.
  }
  const allowed = found.filter((path) => isAllowedAddressBookPath(path, root));
  const present = await Promise.all(allowed.map((path) => access(path).then(() => true, () => false)));
  return allowed.filter((_, index) => present[index]);
}

async function readAddressBook(): Promise<AddressBookRow[]> {
  const rows: AddressBookRow[] = [];
  for (const path of await addressBookPaths()) {
    for (const sql of [selectPhoneNamesSql(), selectEmailNamesSql()]) {
      try {
        rows.push(...((await queryAddressBook(path, sql)) as AddressBookRow[]));
      } catch {
        // One unreadable source (missing, locked, another schema) costs its names and nothing else.
      }
    }
  }
  return rows;
}

function appleNowNs(now: number): string {
  return (BigInt(Math.max(0, now - APPLE_EPOCH_MS)) * 1_000_000n).toString();
}

export class MessagesBackupService {
  #deps: MessagesBackupDeps;
  #status: BackupStatus = { ...INITIAL };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #watcher: ImessageWatcher | null = null;
  #changeTimer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #generation = 0;
  #columns: ReadonlySet<string> | null = null;
  #abort: AbortController | null = null;

  constructor(deps: MessagesBackupDeps) {
    this.#deps = deps;
  }

  status(): BackupStatus {
    const enabled = this.#deps.settings().messagesBackup;
    return { ...this.#status, enabled, phase: enabled ? this.#status.phase : "off" };
  }

  /** At launch, and after every change to the switch. */
  reconfigure(): void {
    if (this.#deps.settings().messagesBackup) {
      this.#arm();
      void this.runNow();
    } else {
      this.#disarm();
    }
    this.#emit();
  }

  stop(): void {
    this.#disarm();
  }

  #emit(): void {
    this.#deps.onChange?.(this.status());
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #path(): string {
    return this.#deps.chatDbPath?.() ?? defaultChatDbPath();
  }

  #query(sql: string): Promise<unknown[]> {
    return (this.#deps.query ?? queryChatDb)(this.#path(), sql);
  }

  #wanted(generation: number): boolean {
    return generation === this.#generation && this.#deps.settings().messagesBackup;
  }

  #arm(): void {
    this.#generation += 1;
    if (this.#watcher !== null) return;
    try {
      const path = this.#path();
      if (this.#deps.observeChatDb !== undefined) this.#watcher = this.#deps.observeChatDb(path, () => this.#soon());
      else if (isAllowedChatDbPath(path)) this.#watcher = observeChatDb(path, () => this.#soon());
    } catch {
      // The pass reports the missing database or the permission; a watcher that failed is not "off".
    }
  }

  #disarm(): void {
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#timer = null;
    this.#changeTimer = null;
    this.#abort?.abort();
    this.#abort = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  #soon(): void {
    if (!this.#deps.settings().messagesBackup) return;
    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      void this.runNow();
    }, BACKUP_CHANGE_DEBOUNCE_MS);
  }

  #schedule(ms: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (!this.#deps.settings().messagesBackup) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.runNow();
    }, ms);
  }

  #set(patch: Partial<BackupStatus>): void {
    const before = JSON.stringify(this.#status);
    this.#status = { ...this.#status, ...patch };
    if (JSON.stringify(this.#status) !== before) this.#emit();
  }

  /** One pass now, or one more after the pass already running. */
  runNow(): Promise<void> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        await this.#pass(this.#generation);
      } while (this.#again && this.#deps.settings().messagesBackup);
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #pass(generation: number): Promise<void> {
    if (!this.#wanted(generation)) return;
    const path = this.#path();
    const permission = await detectFullDiskAccess(() => attemptChatDbRead(path));
    if (!this.#wanted(generation)) return;
    if (permission !== "granted") {
      this.#set({ permission, phase: permission === "denied" ? "needs_permission" : "no_messages" });
      // Granting Full Disk Access sends no event this app can hear; look again soon.
      this.#schedule(permission === "denied" ? 15_000 : BACKUP_IDLE_MS);
      return;
    }
    this.#set({ permission });

    const base = this.#deps.connection.baseUrl();
    if (base === null) {
      this.#set({ phase: "not_connected" });
      this.#schedule(BACKUP_IDLE_MS);
      return;
    }

    try {
      if (this.#columns === null) this.#columns = knownColumns(await this.#query(selectMessageColumnsSql()));
      if (this.#status.account === null) {
        const rows = (await this.#query(selectAccountSql())) as Array<{ login?: unknown }>;
        this.#set({ account: maskAccount(rows[0]?.login) });
      }
      const columns = this.#columns;
      const abort = new AbortController();
      this.#abort = abort;
      const deps: BackupPassDeps = {
        columns: async () => columns,
        maxRowId: async () => {
          const rows = (await this.#query(selectMessageTotalsSql())) as Array<{ max_rowid?: unknown; rows?: unknown }>;
          const max = Number(rows[0]?.max_rowid ?? 0);
          this.#set({ totalRows: Number(rows[0]?.rows ?? 0) || 0 });
          return Number.isSafeInteger(max) && max >= 0 ? max : 0;
        },
        messages: async (window) => (await this.#query(selectBackupMessagesSql(window, columns))) as BackupMessageRow[],
        attachmentsInRange: async (after, through) =>
          (await this.#query(selectBackupAttachmentsSql(after, through))) as BackupAttachmentRow[],
        attachmentsForRows: async (rowIds) => (await this.#query(selectAttachmentsForRowsSql(rowIds))) as BackupAttachmentRow[],
        chats: async () => (await this.#query(selectChatsSql())) as BackupChatRow[],
        participants: async () => (await this.#query(selectParticipantsSql())) as RawParticipantRow[],
        addressBook: this.#deps.addressBook ?? readAddressBook,
        upload: (records) =>
          uploadBackupRecords(
            { baseUrl: gatewayBaseFrom(base), token: () => this.#deps.connection.token(), fetch: this.#deps.fetch, signal: abort.signal },
            records,
          ),
        nowNs: () => appleNowNs(this.#now()),
        digest: (text) => createHash("sha256").update(text).digest("hex"),
        saveCursor: (cursor) => this.#deps.store.writeBackupCursor(cursor),
        stillWanted: () => this.#wanted(generation),
      };

      const start = await this.#deps.store.readBackupCursor();
      this.#set({ phase: "copying", problem: null });
      const report = await runBackupPass(deps, start);
      if (!this.#wanted(generation)) return;

      const reached = report.cursor.oldest === null ? 0 : await this.#reachedRows(report.cursor);
      this.#set({
        copiedRows: reached,
        ...(report.sent > 0 ? { lastCopiedAt: this.#now() } : {}),
      });
      if (report.stopped) {
        this.#set({ phase: "stopped", problem: report.stopped.code });
        if (report.stopped.retry) this.#schedule(BACKUP_RETRY_MS);
        return;
      }
      this.#set({ phase: report.more || !historyDone(report.cursor) ? "copying" : "up_to_date" });
      this.#schedule(report.more ? BACKUP_BUSY_MS : BACKUP_IDLE_MS);
    } catch {
      // Never the error's text: a failed query can carry a fragment of somebody's messages.
      if (!this.#wanted(generation)) return;
      this.#set({ phase: "stopped", problem: "unreadable" });
      this.#schedule(BACKUP_RETRY_MS);
    } finally {
      this.#abort = null;
    }
  }

  async #reachedRows(cursor: BackupCursor): Promise<number> {
    if (historyDone(cursor)) return this.#status.totalRows;
    const rows = (await this.#query(selectRowsFromSql(cursor.oldest as number))) as Array<{ rows?: unknown }>;
    const count = Number(rows[0]?.rows ?? 0);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }
}
