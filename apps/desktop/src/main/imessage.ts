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
import type { ImessageStatus } from "@context/desktop-bridge";
import type { DesktopSettings } from "../core/settings.ts";
import type { GatewayConnection } from "../core/sync/connection.ts";
import { gatewayBaseFrom } from "../core/sync/connection.ts";
import { attemptChatDbRead, detectFullDiskAccess, type FullDiskAccessStatus } from "../core/imessage/permission.ts";
import { defaultChatDbPath } from "../core/imessage/paths.ts";
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
  #syncing: Promise<void> | null = null;

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
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.syncNow(), IMESSAGE_SYNC_INTERVAL_MS);
  }

  #disarm(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #emit(): void {
    this.#deps.onChange?.(this.status());
  }

  #chatDbPath(): string {
    return this.#deps.chatDbPath?.() ?? defaultChatDbPath();
  }

  /**
   * One attempt: check the permission, and if it holds, run one incremental
   * pass. Safe to call while a previous call is still in flight — the second
   * caller waits on the first rather than racing it, which is what a manual
   * "sync now" pressed while the timer also just fired needs.
   */
  async syncNow(): Promise<void> {
    if (this.#syncing !== null) return this.#syncing;
    this.#syncing = this.#run().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #run(): Promise<void> {
    if (!this.#deps.settings().imessageEnabled) return;

    const path = this.#chatDbPath();
    const permission: FullDiskAccessStatus = await detectFullDiskAccess(() => attemptChatDbRead(path));
    this.#status = { ...this.#status, permission };
    this.#emit();
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
    };

    const cursor = await this.#deps.store.readImessageCursor();
    const now = this.#deps.now ?? (() => Date.now());

    const syncDeps: ImessageSyncDeps = {
      queryMessages: (window: MessageWindow) => queryChatDb(path, selectMessagesSql(window)) as ReturnType<ImessageSyncDeps["queryMessages"]>,
      queryAttachments: (window: MessageWindow) => queryChatDb(path, selectAttachmentsSql(window)) as ReturnType<ImessageSyncDeps["queryAttachments"]>,
      queryParticipants: () => queryChatDb(path, selectParticipantsSql()) as ReturnType<ImessageSyncDeps["queryParticipants"]>,
      readNote: (notePath) => readNote(notesConfig, notePath),
      writeNote: (notePath, content, expectedEtag) => writeNote(notesConfig, notePath, content, expectedEtag),
      now: () => new Date(now()).toISOString(),
      mintNonce: () => mintNonce(),
    };

    try {
      const report = await syncImessage(syncDeps, cursor);
      await this.#deps.store.writeImessageCursor(report.cursor);
      const failed = report.days.find((day) => day.status === "error");
      this.#status = {
        ...this.#status,
        lastSyncedAt: now(),
        lastError: failed?.message ?? null,
      };
    } catch (error) {
      // Never the raw error text: it can carry a fragment of a query or a
      // gateway response, and this sentence is the one thing that ever
      // reaches a screen. `sqlite.ts` and `gatewayNotes.ts` already redact
      // their own failures; this is the backstop for anything that still
      // threw past them.
      this.#status = {
        ...this.#status,
        lastSyncedAt: now(),
        lastError: "iMessage import could not complete a sync pass",
      };
      void error;
    }
    this.#emit();
  }
}

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
