import * as Y from "yjs";
import { scopedKeyFor, type CacheScope } from "../../offline/keys";
import { openStore } from "../../offline/store";
import { createSharedDoc, fromBase64, toBase64, type SharedDoc } from "../presence/sharedDoc";
import { applyTextDiff } from "./textEdits";
import { DRAFT_WAIT_MS, documentIdOf, holdsDocument, type Recovery } from "./offlineDraft";

export { textEdits } from "./textEdits";

export type DurableStatus =
  | "loading"
  | "offline"
  | "storing"
  | "local"
  | "syncing"
  | "saved"
  | "error"
  | "unavailable"
  | "revoked";

export interface DurableCollaboration {
  mode: "durable";
  ready: boolean;
  status: DurableStatus;
  pending: number;
  etag: string | null;
  documentId: string | null;
  text: string;
  revision: string;
  recovery?: Recovery;
  legacyAdopted?: { path: string; text: string; baseEtag: string };
  /**
   * Not ready, and taking typing anyway: an offline draft over the version on
   * screen (`offlineDraft.ts`). The editor is editable as plain text, and binds
   * to the shared document once `ready`.
   */
  drafting?: boolean;
  /** Apply a local Yjs update received from a native guest replica. */
  onUpdate: (documentId: string, update: string) => boolean;
  onChange: (text: string) => void;
  onVersionedChange: (text: string, baseSnapshot: string) => string | void;
  repair: () => void;
  message?: string;
  shared: SharedDoc | null;
  subscribeLiveUpdates?: (listener: (frame: LiveUpdate) => void) => () => void;
  receiveLiveUpdate?: (documentId: string, update: string) => boolean;
}

export interface LiveUpdate { documentId: string; update: string }

export interface CollaborationResponse {
  documentId: string;
  update: string;
  text: string;
  etag: string;
  applied?: boolean;
  pendingDependencies?: boolean;
}

export interface CollaborationTransport {
  /**
   * A bearer for the gateway. `rejected` names a token the gateway just
   * refused, so the shared cache replaces it once rather than on every call.
   */
  mint: (rejected?: string) => Promise<string>;
  request: (token: string, body: { path: string; documentId?: string; update?: string; replacement?: { expectedEtag: string; text: string } }) => Promise<CollaborationResponse>;
}

export interface DurableControllerOptions {
  workspaceId: string;
  path: string;
  scope: CacheScope;
  initialText: string;
  /**
   * What the editor is showing now, and the version it is: a draft typed
   * before the first read is merged against it. Asked when typing starts, not
   * when the note opens, since a cached copy can be replaced by the bucket's
   * newer one in between, and a draft based on the older version would undo
   * whatever changed since.
   */
  base?: () => { text: string; etag: string | null };
  /** How long the first read may take before typing is taken as a draft; `DRAFT_WAIT_MS`. */
  draftWaitMs?: number;
  legacyDraft?: { baseline: string; desired: string; baseEtag?: string | null };
  transport: CollaborationTransport;
  onText: (text: string) => void;
  onState: (state: { status: DurableStatus; pending: number; etag: string | null; documentId: string | null; ready: boolean; drafting: boolean; text: string; recovery?: Recovery; legacyAdopted?: { path: string; text: string; baseEtag: string } }) => void;
  online?: () => boolean;
  store?: ReturnType<typeof openStore>;
  now?: () => number;
  canWrite?: () => boolean;
  /**
   * The note at this path is a different document from the one this device
   * holds, and the record has been replaced; build a fresh controller. See
   * `adoptGeneration`.
   */
  onRestart?: () => void;
}

interface Persisted {
  version: 1;
  documentId: string | null;
  etag: string | null;
  snapshot: string;
  pending: { id: string; update: string }[];
  recovery?: Recovery;
}

const RETRIES = [500, 1500, 5000];

function validRecord(value: unknown): value is Persisted {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<Persisted>;
  return (
    row.version === 1 &&
    (row.documentId === null || typeof row.documentId === "string") &&
    (row.etag === null || typeof row.etag === "string") &&
    typeof row.snapshot === "string" &&
    Array.isArray(row.pending) &&
    row.pending.every((one) => one && typeof one.id === "string" && typeof one.update === "string")
    && (row.recovery === undefined || (typeof row.recovery === "object" && typeof row.recovery.baseline === "string" && typeof row.recovery.desired === "string"))
  );
}

function emptyRecord(): Persisted {
  return { version: 1, documentId: null, etag: null, snapshot: "", pending: [] };
}

/**
 * A small durable client for one note. It stores the CRDT identity and update
 * queue, never a competing full-file draft. Each HTTP write mints a fresh
 * grant, and a response can only settle the updates included in that request.
 */
/**
 * Whether carrying `draft` onto `note` loses none of the note's words. Only its
 * opening heading may be replaced, since that is the title a person retitles.
 */
export function keepsEveryWord(draft: string, note: string): boolean {
  const body = note.replace(/^\s*#[^\n]*(\n|$)/, "").trim();
  return body === "" || draft.includes(body);
}

/** The longest a rename may keep a note's typing from being sent. */
const HOLD_LIMIT_MS = 30_000;

export class DurableCollaborationController {
  private options: DurableControllerOptions;
  private readonly store: ReturnType<typeof openStore>;
  private key: string;
  private readonly now: () => number;
  private readonly doc: SharedDoc;
  private record = emptyRecord();
  private readyState = false;
  /** Whether this note may take typing before it is ready; see `offlineDraft.ts`. */
  private draftable = false;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the document holds anything from the server or the device's record, so a save keeps it. */
  private seeded = false;
  private statusState: DurableStatus = "loading";
  private persistChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private repairTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** A rename of this note is on its way; see `hold`. */
  private held = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where the note is now, which `retarget` catches the writes up to. */
  private target: string;
  private flushing = false;
  private persistFailed = false;
  private reading: Promise<void> | null = null;
  private readAgain = false;
  private readonly liveListeners = new Set<(frame: LiveUpdate) => void>();

  constructor(options: DurableControllerOptions) {
    this.options = options;
    this.store = options.store ?? openStore();
    this.key = scopedKeyFor("collaboration", options.scope, options.workspaceId, options.path);
    this.now = options.now ?? Date.now;
    this.doc = createSharedDoc({ onLocalUpdateBytes: (update) => this.localUpdate(update) });
    this.target = options.path;
    this.doc.notePath = () => this.target;
  }

  get state(): DurableCollaboration {
    return {
      mode: "durable",
      ready: this.readyState,
      status: this.statusState,
      pending: this.pendingCount(),
      etag: this.record.etag,
      documentId: this.record.documentId,
      text: this.shownText(),
      revision: this.doc.snapshot(),
      drafting: this.drafting(),
      ...(this.record.recovery === undefined ? {} : { recovery: this.record.recovery }),
      onUpdate: (documentId, update) => this.applyLocalUpdate(documentId, update),
      shared: this.doc,
      onChange: (text) => this.change(text),
      onVersionedChange: (text, base) => this.changeFromSnapshot(base, text),
      repair: () => void this.readRemote(),
      subscribeLiveUpdates: (listener) => this.subscribeLiveUpdates(listener),
      receiveLiveUpdate: (documentId, update) => this.receiveLiveUpdate(documentId, update),
    };
  }

  /** The note this controller writes to. */
  get path(): string {
    return this.options.path;
  }

  /**
   * Stop talking to the gateway while this note is being renamed.
   *
   * Typing goes on: it lands in the document and the queue as always, and is
   * kept on the device. It is not sent, and the note is not read, while the
   * gateway is moving it — a write or a read caught by the move is refused,
   * and a refused write used to end the queue in an error nothing retried.
   * `retarget` (the rename landed) or `release` (it was refused) sends it.
   */
  hold(): void {
    this.held = true;
    // A rename that never says how it ended must not keep this note's typing
    // on the device for good.
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.release(), HOLD_LIMIT_MS);
  }

  release(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!this.held) return;
    this.held = false;
    // Straight away: what was typed during the rename has waited long enough.
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.scheduleFlush(0);
  }

  /**
   * The same note, at its new name: the same document, the same queue, the
   * same editor binding, now sent to `path`.
   *
   * **This is the fix for "I rename and start typing … it deletes everything
   * I typed already"** (owner, 2026-10-14). Rebuilding the controller for the
   * new path threw away what had not been sent yet, under the old path's
   * key, and the new one's first read put the bucket's older text over the
   * editor. The gateway moves a note's document with it (same id, same
   * history), so nothing about the document changes but where it is written.
   */
  /**
   * Say the new name now, before `retarget` moves the writes there.
   *
   * Called while the hook renders, because the editor decides whether to stay
   * in this room in its own effect, and a child's effects run before the
   * hook's: by then the document has to answer to the name the editor has.
   * Only a field: idempotent, and nothing is sent.
   */
  follow(path: string): void {
    this.target = path;
  }

  retarget(path: string): void {
    this.target = path;
    if (this.stopped || path === this.options.path) {
      this.release();
      return;
    }
    const from = this.key;
    this.options = { ...this.options, path };
    this.key = scopedKeyFor("collaboration", this.options.scope, this.options.workspaceId, path);
    void this.persist().then((saved) => {
      if (saved) return this.store.remove(from).catch(() => {});
    });
    this.release();
    this.scheduleFlush(0);
  }

  changeForHook(text: string): void {
    this.change(text);
  }

  changeVersionedForHook(text: string, base: string): string | void {
    return this.changeFromSnapshot(base, text);
  }

  /**
   * Accept an update produced by the native WebView's Y.Doc. The document ID
   * is part of the message because a WebView can outlive a note navigation;
   * applying an update from the previous note would otherwise merge private
   * edits into the next generation. A non-remote origin sends it through the
   * same durable queue as web edits.
   */
  applyLocalUpdate(documentId: string, update: string): boolean {
    if (this.stopped || !this.readyState || this.statusState === "revoked") return false;
    if (this.record.documentId === null || documentId !== this.record.documentId) {
      this.emit("error");
      return false;
    }
    try {
      Y.applyUpdate(this.doc.doc, fromBase64(update), "native-local");
      return true;
    } catch {
      this.emit("error");
      return false;
    }
  }

  repairForHook(): void {
    if (this.record.recovery !== undefined) void this.replaceRecovery();
    else void this.readRemote();
  }

  /** A live receipt is not a bucket acknowledgment. Keep it recoverable locally. */
  receiveLiveUpdate(documentId: string, update: string): boolean {
    if (this.stopped || !this.readyState || this.statusState === "revoked" ||
        this.statusState === "unavailable" || documentId !== this.record.documentId) return false;
    try {
      const bytes = fromBase64(update);
      Y.decodeUpdate(bytes);
      const before = this.doc.snapshot();
      Y.applyUpdate(this.doc.doc, bytes, Symbol("live-remote"));
      if (before === this.doc.snapshot()) return true;
      // A writable peer can finish persisting an operation if its original
      // author closes. The same Yjs identities make those retries idempotent.
      // Read-only peers retain it but never publish it to the bucket.
      this.record.pending.push({ id: this.id(), update });
      const persisted = this.persist();
      this.emit("storing");
      this.options.onText(this.doc.markdown());
      void persisted.then((ok) => {
        if (ok && !this.stopped && this.statusState !== "revoked") this.emit("local");
      });
      this.scheduleFlush();
      return true;
    } catch {
      return false;
    }
  }

  subscribeLiveUpdates(listener: (frame: LiveUpdate) => void): () => void {
    this.liveListeners.add(listener);
    return () => { this.liveListeners.delete(listener); };
  }

  private matchesConfirmedSnapshot(update: string): boolean {
    const confirmed = new Y.Doc();
    try {
      Y.applyUpdate(confirmed, fromBase64(update));
      // Normalize both through Yjs: server history keeps deleted structures,
      // while browser documents may garbage-collect them. Text equality alone
      // cannot establish that the same operation identities were committed.
      return toBase64(Y.encodeStateAsUpdate(confirmed)) === this.doc.snapshot();
    } catch {
      return false;
    } finally {
      confirmed.destroy();
    }
  }

  async start(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.store.get(this.key);
    } catch {
      this.persistFailed = true;
      this.emit("error");
    }
    if (!this.stopped && raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (validRecord(parsed)) this.record = parsed;
      } catch {
        // A malformed local record is ignored; the old draft/cache remains.
      }
    }
    if (this.record.recovery !== undefined) {
      this.readyState = false;
      // An offline draft from an earlier visit goes on taking typing.
      this.armDraft(true);
      if (this.options.online?.() === false) this.emit("offline");
      else await this.replaceRecovery();
      this.scheduleRepair();
      return;
    }
    // Write the ownership marker before the first remote read. A crash or
    // reload during that read must leave the legacy full-file queue parked for
    // the next controller, rather than allowing a background drain to mint a
    // second set of Yjs IDs for the same draft.
    if (this.options.legacyDraft !== undefined && this.record.snapshot === "" && this.record.pending.length === 0 && this.record.documentId === null) {
      // Keep the empty snapshot sentinel intact so the authoritative response
      // remains the first Yjs content that can establish character IDs.
      try {
        await this.store.set(this.key, JSON.stringify(this.record));
      } catch {
        this.persistFailed = true;
        this.emit("error");
      }
    }
    if (holdsDocument(this.record.snapshot)) {
      this.applyServer(this.record.snapshot);
      this.readyState = true;
      this.emit("local");
      this.options.onText(this.doc.markdown());
    }
    // Nothing of the shared document on this device: the note takes typing
    // offline at once, and on a slow link once the read has had its moment.
    this.armDraft(this.options.online?.() === false);
    if (this.options.online?.() === false) {
      this.emit("offline");
    } else {
      await this.readRemote();
    }
    this.scheduleRepair();
  }

  stop(): void {
    this.halt();
    this.doc.destroy();
  }

  private halt(): void {
    this.stopped = true;
    this.liveListeners.clear();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.repairTimer !== null) clearTimeout(this.repairTimer);
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    if (this.draftTimer !== null) clearTimeout(this.draftTimer);
  }

  private applyServer(update: string): void {
    this.doc.applyRemote(update);
    this.seeded = true;
  }

  /**
   * The words this note is, for the editor. Before the shared document has
   * anything in it, that is the text the editor opened with, never the empty
   * document: a failed first read used to report `""`, and the editor drew
   * the note blank a moment after it opened.
   */
  private shownText(): string {
    return this.record.recovery?.desired ??
      (this.seeded ? this.doc.markdown() : this.options.base?.().text ?? this.options.initialText);
  }

  /** Updates waiting for the bucket, an offline draft counted as one. */
  private pendingCount(): number {
    return this.record.pending.length + (this.record.recovery?.offline === true ? 1 : 0);
  }

  /** Whether typing before the first read can become an offline draft: see `offlineDraft.ts`. */
  private mayDraft(): boolean {
    const kept = this.record.recovery;
    if (kept !== undefined && kept.offline !== true) return false;
    if (this.options.legacyDraft !== undefined || this.options.canWrite?.() === false) return false;
    const documentId = documentIdOf(kept?.baseEtag ?? this.options.base?.().etag);
    return documentId !== null && (this.record.documentId === null || this.record.documentId === documentId);
  }

  private drafting(): boolean {
    return this.draftable && !this.readyState && !this.stopped &&
      this.statusState !== "revoked" && this.statusState !== "unavailable";
  }

  /** Take typing now, or once the first read has had `draftWaitMs`. */
  private armDraft(now: boolean): void {
    if (this.readyState || this.draftable || !this.mayDraft()) return;
    if (now) {
      if (this.draftTimer !== null) clearTimeout(this.draftTimer);
      this.draftTimer = null;
      this.draftable = true;
      return;
    }
    if (this.draftTimer !== null) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      if (this.stopped || this.readyState || !this.mayDraft()) return;
      this.draftable = true;
      this.emit(this.statusState);
    }, this.options.draftWaitMs ?? DRAFT_WAIT_MS);
  }

  /**
   * Typing before the shared document is here: kept whole, against the
   * version it was typed on, and sent as a replacement when it can be.
   */
  private draft(text: string): void {
    if (!this.drafting() || this.options.canWrite?.() === false) return;
    const kept = this.record.recovery;
    const base = kept === undefined ? this.options.base?.() : undefined;
    if (kept === undefined ? base === undefined || text === base.text : text === kept.desired) return;
    const baseEtag = kept?.baseEtag ?? base?.etag ?? null;
    if (documentIdOf(baseEtag) === null) return;
    this.record.documentId ??= documentIdOf(baseEtag);
    this.record.recovery = { baseline: kept?.baseline ?? base!.text, desired: text, baseEtag, offline: true };
    const persisted = this.persist();
    this.emit("storing");
    this.options.onText(text);
    void persisted.then((ok) => {
      if (!ok || this.stopped || this.record.recovery?.desired !== text) return;
      if (this.options.online?.() === false) {
        this.emit("offline");
        return;
      }
      this.emit("local");
      this.scheduleDraftSend();
    });
  }

  private scheduleDraftSend(): void {
    if (this.draftTimer !== null || this.stopped || this.held) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.readRemote();
    }, 600);
  }

  private id(): string {
    return `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private emit(status: DurableStatus, legacyAdopted?: { path: string; text: string; baseEtag: string }): void {
    const effective = this.persistFailed && status !== "revoked" ? "error" : status;
    this.statusState = effective;
    this.options.onState({
      status: effective,
      pending: this.pendingCount(),
      etag: this.record.etag,
      documentId: this.record.documentId,
      ready: this.readyState,
      drafting: this.drafting(),
      text: this.shownText(),
      ...(legacyAdopted === undefined ? {} : { legacyAdopted }),
      ...(this.record.recovery === undefined ? {} : { recovery: this.record.recovery }),
    });
  }

  private persist(): Promise<boolean> {
    // Only a document that holds something: see `holdsDocument`.
    if (this.seeded) this.record.snapshot = this.doc.snapshot();
    const value = JSON.stringify(this.record);
    const operation = this.persistChain.then(async () => {
      try {
        await this.store.set(this.key, value);
        this.persistFailed = false;
        return true;
      } catch {
        // The in-memory queue remains authoritative. The UI stays local/error
        // rather than claiming a restart can recover data that could not fit.
        this.persistFailed = true;
        this.emit("error");
        return false;
      }
    });
    this.persistChain = operation.then(() => undefined);
    return operation;
  }

  /** Retry an explicitly retained legacy draft through the gateway's exact-base replacement path. */
  private async replaceRecovery(): Promise<void> {
    const recovery = this.record.recovery;
    const documentId = this.record.documentId;
    if (recovery === undefined) return;
    if (this.options.online?.() === false) {
      this.emit("offline");
      return;
    }
    if (documentId === null || recovery.baseEtag === undefined || recovery.baseEtag === null) {
      // There is no retained server base to compare against. Keep the desired
      // text visible and durable for a later explicit migration decision.
      this.emit("error");
      return;
    }
    const expectedBaseEtag = recovery.baseEtag;
    try {
      const response = await this.send({
        path: this.options.path,
        replacement: { expectedEtag: expectedBaseEtag, text: recovery.desired },
      });
      if (this.stopped || this.statusState === "revoked") return;
      if (response.documentId !== documentId) {
        this.emit("error");
        return;
      }
      if (response.update) this.applyServer(response.update);
      if (response.applied === false || response.pendingDependencies === true) {
        if (!(await this.persist())) return;
        this.emit("error");
        return;
      }
      // Clear recovery only after an authorized response for the exact same
      // generation. A response from a recreated note must never consume an
      // old offline draft.
      const adopted = recovery;
      const typedSince = this.record.recovery === recovery ? undefined : this.record.recovery;
      this.record.documentId = response.documentId;
      this.record.etag = response.etag;
      if (typedSince !== undefined) {
        // Typed while this draft was on its way: sent next, against the
        // version that just answered, before the editor binds.
        this.record.recovery = { ...typedSince, baseline: response.text, baseEtag: response.etag };
        if (!(await this.persist())) return;
        this.emit("syncing");
        void this.readRemote();
        return;
      }
      this.record.recovery = undefined;
      this.readyState = true;
      this.options.onText(this.doc.markdown());
      if (!(await this.persist())) return;
      // An offline draft was never in the legacy queue, so there is nothing to adopt there.
      this.emit(this.record.pending.length > 0 ? "syncing" : "saved", adopted.offline === true ? undefined : {
        path: this.options.path,
        text: adopted.desired,
        baseEtag: expectedBaseEtag,
      });
      this.scheduleFlush();
    } catch (error) {
      // A draft kept for an earlier note at this path names that note's
      // document, and the gateway refuses it; see whether the note was replaced.
      if (error instanceof Error && error.message === "409" && (await this.adoptIfReplaced())) return;
      if (this.isRevoked(error)) this.emit("revoked");
      else if (this.isUnavailable(error)) this.emit("unavailable");
      else if (this.isRetryable(error)) this.emit("offline");
      else this.emit("error");
    }
  }

  private change(text: string): void {
    if (this.stopped) return;
    if (!this.readyState) {
      this.draft(text);
      return;
    }
    if (text === this.doc.markdown()) return;
    this.applyText(text);
  }

  /** Derive an update from the exact rendered Yjs snapshot, then apply it to now. */
  private changeFromSnapshot(baseSnapshot: string, text: string): string | void {
    if (this.stopped) return;
    if (!this.readyState) {
      this.draft(text);
      return;
    }
    try {
      const base = new Y.Doc();
      Y.applyUpdate(base, fromBase64(baseSnapshot));
      const baseText = base.getText("note").toString();
      if (baseText === text) {
        base.destroy();
        return this.doc.snapshot();
      }
      const before = Y.encodeStateVector(base);
      const target = base.getText("note");
      applyTextDiff(target, baseText, text);
      const delta = Y.encodeStateAsUpdate(base, before);
      Y.applyUpdate(this.doc.doc, delta);
      base.destroy();
      return this.doc.snapshot();
    } catch {
      this.emit("error");
      return;
    }
  }

  private localUpdate(update: Uint8Array): void {
    if (this.stopped || !this.readyState) return;
    this.record.pending.push({ id: this.id(), update: toBase64(update) });
    const persisted = this.persist();
    this.emit("storing");
    void persisted.then((ok) => {
      if (ok && !this.stopped && this.statusState !== "revoked") {
        this.emit("local");
        if (this.record.documentId !== null && this.options.canWrite?.() !== false) {
          const frame = { documentId: this.record.documentId, update: toBase64(update) };
          for (const listener of this.liveListeners) {
            try { listener(frame); } catch { /* The durable queue still retries. */ }
          }
        }
      }
    });
    this.options.onText(this.doc.markdown());
    this.scheduleFlush();
  }

  private applyText(text: string): void {
    if (this.stopped || text === this.doc.markdown()) return;
    applyTextDiff(this.doc.text, this.doc.markdown(), text);
  }

  private scheduleFlush(delay = 120): void {
    if (this.flushTimer !== null || this.stopped || this.held) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  /**
   * One read at a time. Focus, a reconnect and the periodic repair can all ask
   * within the same second; the answer to all of them is the next read that
   * starts after they asked, so one follow-up read covers every caller that
   * arrived while one was already in flight.
   */
  private async readRemote(): Promise<void> {
    if (this.reading !== null) {
      this.readAgain = true;
      return this.reading;
    }
    this.reading = (async () => {
      try {
        do {
          this.readAgain = false;
          await this.readRemoteOnce();
        } while (this.readAgain && !this.stopped);
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  private async readRemoteOnce(): Promise<void> {
    if (this.stopped || this.held || this.statusState === "revoked") return;
    if (this.record.recovery !== undefined) {
      await this.replaceRecovery();
      return;
    }
    if (this.options.online?.() === false) {
      this.emit("offline");
      return;
    }
    try {
      const response = await this.send({
        path: this.options.path,
      });
      if (this.stopped || this.isRevokedState()) return;
      if (this.record.documentId !== null && response.documentId !== this.record.documentId) {
        await this.adoptGeneration(response);
        return;
      }
      if (this.record.recovery !== undefined) {
        // Typing began while this read was out (`draft`): it goes next, as a
        // replacement against the version it was typed on.
        this.readAgain = true;
        return;
      }
      this.record.documentId = response.documentId;
      // On a cold start, only the server's Yjs update may establish IDs.
      // response.text is presentation data and must never seed the CRDT.
      if (response.update) this.applyServer(response.update);
      const coldStart = this.record.snapshot === "" && this.record.pending.length === 0;
      this.readyState = true;
      if (coldStart && this.options.legacyDraft !== undefined) {
        // Even when the etag appears to match, the old full-file queue must
        // take the exact replacement path. Applying a local text diff would
        // mint new Yjs IDs and leave the stale outbox able to duplicate it.
        this.record.recovery = this.options.legacyDraft;
        this.readyState = false;
        this.record.etag = response.etag;
        if (!(await this.persist())) return;
        await this.replaceRecovery();
        return;
      }
      this.record.etag = response.etag;
      if (this.matchesConfirmedSnapshot(response.update)) this.record.pending = [];
      this.options.onText(this.doc.markdown());
      if (!(await this.persist())) return;
      this.emit(this.record.pending.length > 0 ? "syncing" : "saved");
      this.scheduleFlush();
    } catch (error) {
      this.armDraft(true);
      if (this.isRevoked(error)) this.emit("revoked");
      else if (this.isUnavailable(error)) this.emit("unavailable");
      else this.emit(this.record.pending.length > 0 || this.isRetryable(error) ? "offline" : "error");
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped || this.held || this.record.pending.length === 0 || this.statusState === "revoked" || this.options.canWrite?.() === false) return;
    if (this.options.online?.() === false) {
      this.emit("offline");
      return;
    }
    this.flushing = true;
    const batch = this.record.pending.slice();
    const update = toBase64(Y.mergeUpdates(batch.map((one) => fromBase64(one.update))));
    this.emit("syncing");
    try {
      let response: CollaborationResponse | null = null;
      let last: unknown;
      for (let attempt = 0; attempt < RETRIES.length + 1; attempt += 1) {
        try {
          response = await this.send({
            path: this.options.path,
            ...(this.record.documentId === null ? {} : { documentId: this.record.documentId }),
            update,
          });
          break;
        } catch (error) {
          last = error;
          if (!this.isRetryable(error) || attempt >= RETRIES.length) throw error;
          await new Promise((resolve) => setTimeout(resolve, RETRIES[attempt]));
        }
      }
      if (response === null) throw last ?? new Error("No collaboration response");
      // A concurrent read or an auth callback may have revoked this
      // generation while the write was in flight. Never let a late response
      // acknowledge or apply content after that terminal decision.
      if (this.stopped || this.isRevokedState()) return;
      if (this.record.documentId !== null && response.documentId !== this.record.documentId) {
        this.emit("error");
        return;
      }
      if (response.pendingDependencies === true || response.applied === false) {
        if (response.update) this.applyServer(response.update);
          this.record.etag = response.etag;
          if (!(await this.persist())) return;
          this.options.onText(this.doc.markdown());
        this.emit("syncing");
        this.scheduleFlush(500);
        return;
      }
      this.record.pending = this.record.pending.filter((one) => !batch.some((sent) => sent.id === one.id));
      this.record.documentId = response.documentId;
      if (response.update) this.applyServer(response.update);
      this.record.etag = response.etag;
      if (!(await this.persist())) {
        this.record.pending = [
          ...batch.filter((sent) => !this.record.pending.some((one) => one.id === sent.id)),
          ...this.record.pending,
        ];
        return;
      }
      this.options.onText(this.doc.markdown());
      this.emit(this.record.pending.length > 0 ? "syncing" : "saved");
      if (this.record.pending.length > 0) this.scheduleFlush();
    } catch (error) {
      this.emit(this.isRevoked(error) ? "revoked" : this.isUnavailable(error) ? "unavailable" : this.isRetryable(error) ? "offline" : "error");
      if (this.isRetryable(error)) this.scheduleFlush(1500);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * The bucket's note at this path is not the document this device holds.
   *
   * The record is keyed by path, and a path outlives its document: a note
   * renamed, moved or deleted leaves its record behind, and the next note
   * made at that name — every `untitled-<date>` of the day, the moment the
   * first one takes its title — opened on the old note's text and identity.
   * Every write then carried the old document's id and was refused, the
   * status sat on an error nothing drew, and the new note kept only the
   * title it was created with (reported 2026-09-26).
   *
   * So the bucket's document wins, and nothing is thrown away. The old record
   * is kept on the device under its own key. If it held typing the bucket
   * never confirmed, and that text still contains everything the bucket's
   * note says below its title, it is carried onto the new document through
   * the exact-base replacement, which is how an older offline draft already
   * reaches the bucket. The title is left out of that test on purpose: a new
   * note is created holding nothing but a placeholder heading, and retitling
   * it is the first thing anybody does — a guard that counted the heading set
   * a retitled 162-word draft aside and opened the note empty (2026-09-26).
   * A draft that would erase the new note's words is an earlier note's, and
   * stays behind in the kept record rather than overwriting somebody's note.
   * Otherwise the note opens
   * as the bucket has it. Either way the controller is rebuilt with a fresh
   * Yjs document, because the old one's items cannot be merged into a
   * document they never belonged to.
   */
  private async adoptGeneration(response: CollaborationResponse): Promise<void> {
    const previous = this.record;
    const unsent = previous.pending.length > 0 || previous.recovery !== undefined;
    const desired = previous.recovery?.desired ?? this.doc.markdown();
    const carry = unsent && desired !== response.text && keepsEveryWord(desired, response.text);
    const next: Persisted = {
      ...emptyRecord(),
      documentId: response.documentId,
      etag: response.etag,
      ...(carry
        ? { recovery: { baseline: response.text, desired, baseEtag: response.etag } }
        : {}),
    };
    try {
      await this.store.set(`${this.key}::superseded::${previous.documentId}`, JSON.stringify(previous));
      await this.store.set(this.key, JSON.stringify(next));
    } catch {
      this.persistFailed = true;
      this.emit("error");
      return;
    }
    if (this.stopped) return;
    this.record = next;
    // The editor shows what the new controller will: the carried draft, or
    // the bucket's text when there was nothing to carry. Nothing this
    // controller still has in flight may touch the new record.
    this.options.onText(next.recovery?.desired ?? response.text);
    this.halt();
    this.options.onRestart?.();
  }

  /** Read the note once; adopt it and report true when it is another document. */
  private async adoptIfReplaced(): Promise<boolean> {
    try {
      const response = await this.send({ path: this.options.path });
      if (this.stopped || this.isRevokedState()) return true;
      if (this.record.documentId === null || response.documentId === this.record.documentId) return false;
      await this.adoptGeneration(response);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One authorized request, with at most one credential refresh.
   *
   * The console's grant is shared by the editor, presence and the agent, and
   * minting for this instance revokes the token minted before it. So a 401 is
   * usually a token another consumer rotated — or one that expired on the
   * server first — not a revocation. Treating it as terminal is what stranded
   * a note on "access revoked" when presence refreshed its credential. A 401
   * with the replacement, or a 403, is the gateway's real answer.
   */
  private async send(body: Parameters<CollaborationTransport["request"]>[1]): Promise<CollaborationResponse> {
    const token = await this.options.transport.mint();
    try {
      return await this.options.transport.request(token, body);
    } catch (error) {
      if (!(error instanceof Error && error.message === "401") || this.stopped) throw error;
      return await this.options.transport.request(await this.options.transport.mint(token), body);
    }
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof TypeError || (error instanceof Error && (
      /^5\d\d$/.test(error.message) || error.message === "404" ||
      // A mint that never answered was bounded by the grant cache; nothing
      // refused this note, so the queued edits wait for the next attempt.
      error.name === "GrantTimeoutError"
    ));
  }

  private isRevokedState(): boolean {
    return this.statusState === "revoked";
  }

  private isRevoked(error: unknown): boolean {
    return error instanceof Error && (error.message === "401" || error.message === "403");
  }

  private isUnavailable(error: unknown): boolean {
    return error instanceof Error && error.message === "404";
  }

  private scheduleRepair(): void {
    if (this.stopped || this.statusState === "revoked") return;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = null;
      void this.readRemote().finally(() => this.scheduleRepair());
    }, 30_000);
  }
}
