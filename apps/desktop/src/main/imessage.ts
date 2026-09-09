/**
 * The Electron half of iMessage import: the real `sqlite3` process, the real
 * gateway grant, a timer, and the status the tray and the console read.
 *
 * Everything that decides *what* to do with a row of `chat.db` lives in
 * `core/imessage/*.ts` and is proven there with no Electron in sight — this
 * file's whole job is to supply those modules their real dependencies (the
 * real database path, the real machine grant, a real clock) and to own the
 * one piece of state that only makes sense on a running app: whether a sync
 * is due, and what the last one found.
 *
 * `docs/decisions/communications.md` and `docs/decisions/desktop.md` carry
 * the argument; this is the wiring.
 */

import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ImessageStatus } from "@context/desktop-bridge";
import type { DesktopSettings } from "../core/settings.ts";
import type { GatewayConnection } from "../core/sync/connection.ts";
import { gatewayBaseFrom } from "../core/sync/connection.ts";
import { attemptChatDbRead, detectFullDiskAccess, type FullDiskAccessStatus } from "../core/imessage/permission.ts";
import { defaultChatDbPath, isAllowedChatDbPath } from "../core/imessage/paths.ts";
import { queryChatDb } from "../core/imessage/sqlite.ts";
import { readNote, writeNote } from "../core/imessage/gatewayNotes.ts";
import { syncImessage, type ImessageSyncDeps } from "../core/imessage/sync.ts";
import type { ImessageCursor } from "../core/imessage/cursor.ts";
import { selectAttachmentsSql, selectMessagesSql, selectParticipantsSql } from "../core/imessage/schema.ts";
import type { MessageWindow } from "../core/imessage/schema.ts";

/** Where the cursor lives and where it is read back from. Kept small so a fake can implement it in a test. */
export interface ImessageCursorStore {
  readImessageCursor(): Promise<ImessageCursor>;
  writeImessageCursor(cursor: ImessageCursor): Promise<void>;
}

/** How often a sync is attempted while import is on. Independent of the meetings drain timer. */
export const IMESSAGE_SYNC_INTERVAL_MS = 5 * 60_000;
/** How long to let SQLite's WAL writes settle before reading the database. */
export const IMESSAGE_CHANGE_DEBOUNCE_MS = 2_000;
/** Bounded deletion repair window for native watcher-triggered passes. */
export const IMESSAGE_WATCH_REFRESH_DAYS = 14;

export interface ImessageWatcher {
  close(): void;
}

export interface ImessageSyncServiceDeps {
  store: ImessageCursorStore;
  connection: GatewayConnection;
  /** Read fresh every time — a settings patch (the toggle) must take effect without a restart. */
  settings: () => Pick<DesktopSettings, "imessageEnabled">;
  now?: () => number;
  /** Pushed after every status change: a permission result, a completed sync, a toggle. */
  onChange?: (status: ImessageStatus) => void;
  /** Overridable for the suite; production never passes this. */
  chatDbPath?: () => string;
  /** Overridable for the suite; production watches ~/Library/Messages. */
  observeChatDb?: (chatDbPath: string, onChange: () => void) => ImessageWatcher;
  /** Overridable for the suite; production waits for SQLite's write burst to settle. */
  changeDebounceMs?: number;
}

const INITIAL_STATUS: ImessageStatus = Object.freeze({
  enabled: false,
  permission: "unknown",
  lastSyncedAt: null,
  lastError: null,
});

/**
 * Owns the timer and the status. `main/index.ts` constructs exactly one of
 * these, wires its `onChange` to `consoleBridge.emitImessage` and to `push()`,
 * and routes the tray's "Import iMessage" toggle and the bridge's
 * `setImessageEnabled` through `settings`'s own `update()` — the same one
 * `detectionEnabled` already goes through — calling `reconfigure()`
 * afterward so this service notices without a restart.
 */
export class ImessageSyncService {
  #deps: ImessageSyncServiceDeps;
  #status: ImessageStatus = { ...INITIAL_STATUS };
  #timer: ReturnType<typeof setInterval> | null = null;
  #watcher: ImessageWatcher | null = null;
  #changeTimer: ReturnType<typeof setTimeout> | null = null;
  #syncing: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  #armed = false;
  #generation = 0;
  #syncRequestedAgain = false;
  #syncRequestedRefreshDates = new Set<string>();

  constructor(deps: ImessageSyncServiceDeps) {
    this.#deps = deps;
  }

  status(): ImessageStatus {
    return { ...this.#status, enabled: this.#deps.settings().imessageEnabled };
  }

  /** Read once at launch, and again every time the toggle changes. */
  reconfigure(): void {
    if (this.#deps.settings().imessageEnabled) {
      this.#arm();
      void this.syncNow();
    } else {
      this.#disarm();
    }
    this.#emit();
  }

  /** For `before-quit`. A timer is not a credential and not a queue — nothing here needs draining. */
  stop(): void {
    this.#disarm();
  }

  #arm(): void {
    if (!this.#armed) {
      this.#armed = true;
      this.#generation += 1;
    }
    if (this.#timer === null) {
      this.#timer = setInterval(() => void this.syncNow(), IMESSAGE_SYNC_INTERVAL_MS);
    }
    if (this.#watcher !== null) return;
    try {
      const chatDbPath = this.#chatDbPath();
      if (!isAllowedChatDbPath(chatDbPath)) return;
      const generation = this.#generation;
      this.#watcher = (this.#deps.observeChatDb ?? observeChatDb)(chatDbPath, () => this.#syncSoon(generation));
    } catch {
      // The foreground pass will classify the missing database or permission
      // state. A failed watcher must not turn the feature into "off".
    }
  }

  #disarm(): void {
    this.#armed = false;
    this.#generation += 1;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#changeTimer !== null) {
      clearTimeout(this.#changeTimer);
      this.#changeTimer = null;
    }
    this.#abortController?.abort();
    this.#abortController = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  #syncSoon(generation: number): void {
    if (!this.#armed || !this.#isCurrent(generation)) return;
    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      if (this.#armed && this.#isCurrent(generation)) void this.syncNow({ refreshDates: recentUtcDates(this.#now(), IMESSAGE_WATCH_REFRESH_DAYS) });
    }, this.#deps.changeDebounceMs ?? IMESSAGE_CHANGE_DEBOUNCE_MS);
  }

  #emit(): void {
    this.#deps.onChange?.(this.status());
  }

  #chatDbPath(): string {
    return this.#deps.chatDbPath?.() ?? defaultChatDbPath();
  }

  #now(): number {
    return (this.#deps.now ?? (() => Date.now()))();
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#generation && this.#deps.settings().imessageEnabled;
  }

  #assertCurrent(generation: number): void {
    if (!this.#isCurrent(generation)) throw new StaleImessageSync();
  }

  /**
   * One attempt: check the permission, and if it holds, run one incremental
   * pass. Safe to call while a previous call is still in flight — the second
   * caller waits on the first rather than racing it, which is what a manual
   * "sync now" pressed while the timer also just fired needs.
   */
  async syncNow(options: { refreshDates?: readonly string[] } = {}): Promise<void> {
    if (this.#syncing !== null) {
      this.#syncRequestedAgain = true;
      for (const date of options.refreshDates ?? []) this.#syncRequestedRefreshDates.add(date);
      return this.#syncing;
    }
    const generation = this.#generation;
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#syncing = this.#drain(generation, options, abortController.signal).finally(() => {
      if (this.#abortController === abortController) this.#abortController = null;
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #drain(generation: number, options: { refreshDates?: readonly string[] }, signal: AbortSignal): Promise<void> {
    let nextOptions = options;
    do {
      this.#syncRequestedAgain = false;
      this.#syncRequestedRefreshDates.clear();
      await this.#run(generation, nextOptions, signal);
      nextOptions = { refreshDates: [...this.#syncRequestedRefreshDates].sort() };
    } while (this.#syncRequestedAgain && this.#isCurrent(generation));
  }

  async #run(generation: number, options: { refreshDates?: readonly string[] }, signal: AbortSignal): Promise<void> {
    if (!this.#isCurrent(generation)) return;

    const path = this.#chatDbPath();
    const permission: FullDiskAccessStatus = await detectFullDiskAccess(() => attemptChatDbRead(path));
    if (!this.#isCurrent(generation)) return;
    const previousPermission = this.#status.permission;
    this.#status = { ...this.#status, permission };
    if (previousPermission !== permission) this.#emit();
    if (permission !== "granted") return;

    const gatewayBaseUrl = this.#deps.connection.baseUrl();
    if (gatewayBaseUrl === null) {
      // Not connected yet. Not an error — the same "queue and wait" answer
      // the meetings outbox gives, restated here as "there is nothing to
      // read into yet".
      return;
    }

    const notesConfig = {
      mcpUrl: `${gatewayBaseFrom(gatewayBaseUrl)}/mcp`,
      token: () => this.#deps.connection.token(),
      scope: () => this.#deps.connection.scope(),
      signal,
    };

    const cursor = await this.#deps.store.readImessageCursor();
    this.#assertCurrent(generation);

    const syncDeps: ImessageSyncDeps = {
      queryMessages: (window: MessageWindow) => queryChatDb(path, selectMessagesSql(window)) as ReturnType<ImessageSyncDeps["queryMessages"]>,
      queryAttachments: (window: MessageWindow) => queryChatDb(path, selectAttachmentsSql(window)) as ReturnType<ImessageSyncDeps["queryAttachments"]>,
      queryParticipants: () => queryChatDb(path, selectParticipantsSql()) as ReturnType<ImessageSyncDeps["queryParticipants"]>,
      readNote: async (notePath) => {
        this.#assertCurrent(generation);
        const result = await readNote(notesConfig, notePath);
        this.#assertCurrent(generation);
        return result;
      },
      writeNote: async (notePath, content, expectedEtag) => {
        this.#assertCurrent(generation);
        const result = await writeNote(notesConfig, notePath, content, expectedEtag);
        this.#assertCurrent(generation);
        return result;
      },
      now: () => new Date(this.#now()).toISOString(),
      mintNonce: () => mintNonce(),
      // No `selfAddresses`: `chat.db` does not reliably carry which handle is
      // this Mac's own — see `docs/decisions/communications.md`. The only
      // effect is cosmetic: an unnamed group's subject can list the owner's
      // own address alongside everyone else's.
    };

    try {
      const report = await syncImessage(syncDeps, cursor, { refreshDates: options.refreshDates });
      this.#assertCurrent(generation);
      await this.#deps.store.writeImessageCursor(report.cursor);
      this.#assertCurrent(generation);
      if (report.days.some((day) => day.status === "written" || day.status === "error")) {
        const failed = report.days.find((day) => day.status === "error");
        this.#status = {
          ...this.#status,
          lastSyncedAt: this.#now(),
          lastError: failed?.message ?? null,
        };
        this.#emit();
      }
    } catch (error) {
      if (error instanceof StaleImessageSync) return;
      // Never the raw error text: it can carry a fragment of a query or a
      // gateway response, and this sentence is the one thing that ever
      // reaches a screen. `sqlite.ts` and `gatewayNotes.ts` already redact
      // their own failures; this is the backstop for anything that still
      // threw past them.
      this.#status = {
        ...this.#status,
        lastSyncedAt: this.#now(),
        lastError: "iMessage import could not complete a sync pass",
      };
      void error;
      this.#emit();
    }
  }
}

class StaleImessageSync extends Error {}

/**
 * A fresh, unguessable fence nonce for a channel-day note that has never been
 * written before. `node:crypto`'s CSPRNG, not `Math.random()` — this is the
 * value that makes `docs/decisions/communications.md`'s untrusted fence
 * unforgeable, and a sender who could predict it could write their own
 * closing marker.
 */
function mintNonce(): string {
  return randomBytes(8).toString("hex");
}

export function observeChatDb(chatDbPath: string, onChange: () => void): ImessageWatcher {
  const directory = dirname(chatDbPath);
  const watcher: FSWatcher = watch(directory, { persistent: false }, (_event, changed) => {
    if (isChatDbChange(chatDbPath, changed)) onChange();
  });
  watcher.on("error", () => onChange());
  return watcher;
}

export function isChatDbChange(chatDbPath: string, changed: string | Buffer | null): boolean {
  const file = basename(chatDbPath);
  const name = changed === null ? "" : String(changed);
  return name === "" || name === file || name === `${file}-wal` || name === `${file}-shm`;
}

function recentUtcDates(now: number, days: number): string[] {
  const dates: string[] = [];
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  for (let index = 0; index < days; index += 1) {
    dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return dates;
}
