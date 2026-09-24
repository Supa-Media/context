import * as Y from "yjs";
import { scopedKeyFor, type CacheScope } from "../../offline/keys";
import { openStore } from "../../offline/store";
import { createSharedDoc, fromBase64, toBase64, type SharedDoc } from "../presence/sharedDoc";

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
  recovery?: { baseline: string; desired: string; baseEtag?: string | null };
  legacyAdopted?: { path: string; text: string; baseEtag: string };
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
  legacyDraft?: { baseline: string; desired: string; baseEtag?: string | null };
  transport: CollaborationTransport;
  onText: (text: string) => void;
  onState: (state: { status: DurableStatus; pending: number; etag: string | null; documentId: string | null; ready: boolean; text: string; recovery?: { baseline: string; desired: string; baseEtag?: string | null }; legacyAdopted?: { path: string; text: string; baseEtag: string } }) => void;
  online?: () => boolean;
  store?: ReturnType<typeof openStore>;
  now?: () => number;
  canWrite?: () => boolean;
}

interface Persisted {
  version: 1;
  documentId: string | null;
  etag: string | null;
  snapshot: string;
  pending: { id: string; update: string }[];
  recovery?: { baseline: string; desired: string; baseEtag?: string | null };
}

const RETRIES = [500, 1500, 5000];

type TextEdit = { kind: "insert"; at: number; text: string } | { kind: "delete"; at: number; count: number };

/**
 * Compute an edit script against the exact text represented by a Yjs
 * snapshot. A common-prefix/suffix replacement is tempting here, but repeated
 * text and a peer insertion in the middle make that replacement delete the
 * wrong Yjs items. Myers' shortest edit script keeps the operation anchored to
 * the snapshot's item IDs when its update is applied to the live document.
 */
function textEdits(from: string, to: string): TextEdit[] {
  if (from === to) return [];
  // Y.Text indexes strings in UTF-16 code units, but diffing individual code
  // units can split a surrogate pair (😀 -> 😎 would preserve the high half
  // and replace only the low half). Diff by code point, then convert each
  // edit's coordinate/count back to UTF-16 for Yjs.
  const fromPoints = Array.from(from);
  const toPoints = Array.from(to);
  const n = fromPoints.length;
  const m = toPoints.length;
  const max = n + m;
  let vector = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let endDepth = max;
  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(new Map(vector));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = diagonal === -depth || (diagonal !== depth && (vector.get(diagonal - 1) ?? -1) < (vector.get(diagonal + 1) ?? -1));
      let x = down ? (vector.get(diagonal + 1) ?? 0) : (vector.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && fromPoints[x] === toPoints[y]) {
        x += 1;
        y += 1;
      }
      vector.set(diagonal, x);
      if (x >= n && y >= m) {
        endDepth = depth;
        break;
      }
    }
    if (endDepth === depth) break;
  }

  const primitive: ({ kind: "equal"; text: string } | { kind: "insert"; text: string } | { kind: "delete"; text: string })[] = [];
  let x = n;
  let y = m;
  for (let depth = endDepth; depth > 0; depth -= 1) {
    // trace[depth] is the frontier before this depth was expanded. The
    // initial frontier is trace[0], and each later entry was captured at the
    // start of that depth's iteration.
    const previous = trace[depth];
    const diagonal = x - y;
    const down = diagonal === -depth || (diagonal !== depth && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      primitive.push({ kind: "equal", text: fromPoints[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      primitive.push({ kind: "insert", text: toPoints[previousY] ?? "" });
    } else {
      primitive.push({ kind: "delete", text: fromPoints[previousX] ?? "" });
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    primitive.push({ kind: "equal", text: fromPoints[x - 1] });
    x -= 1;
    y -= 1;
  }
  primitive.reverse();

  const edits: TextEdit[] = [];
  let at = 0;
  for (const part of primitive) {
    if (part.kind === "equal") {
      at += part.text.length;
    } else if (part.kind === "delete") {
      const previous = edits[edits.length - 1];
      if (previous?.kind === "delete" && previous.at === at) previous.count += part.text.length;
      else edits.push({ kind: "delete", at, count: part.text.length });
    } else {
      const previous = edits[edits.length - 1];
      if (previous?.kind === "insert" && previous.at === at) previous.text += part.text;
      else edits.push({ kind: "insert", at, text: part.text });
      at += part.text.length;
    }
  }
  return edits;
}

function applyTextDiff(target: Y.Text, from: string, to: string): void {
  const edits = textEdits(from, to);
  target.doc?.transact(() => {
    // Edits are expressed in the target text's current coordinate space. The
    // script walks from left to right, so earlier inserts/deletes are already
    // reflected in the later positions.
    for (const edit of edits) {
      if (edit.kind === "delete") target.delete(edit.at, edit.count);
      else target.insert(edit.at, edit.text);
    }
  });
}

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
export class DurableCollaborationController {
  private readonly options: DurableControllerOptions;
  private readonly store: ReturnType<typeof openStore>;
  private readonly key: string;
  private readonly now: () => number;
  private readonly doc: SharedDoc;
  private record = emptyRecord();
  private readyState = false;
  private statusState: DurableStatus = "loading";
  private persistChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private repairTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
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
  }

  get state(): DurableCollaboration {
    return {
      mode: "durable",
      ready: this.readyState,
      status: this.statusState,
      pending: this.record.pending.length,
      etag: this.record.etag,
      documentId: this.record.documentId,
      text: this.record.recovery?.desired ?? this.doc.markdown(),
      revision: this.doc.snapshot(),
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
    if (this.record.snapshot !== "") {
      this.doc.applyRemote(this.record.snapshot);
      this.readyState = true;
      this.emit("local");
      this.options.onText(this.doc.markdown());
    }
    if (this.options.online?.() === false) {
      this.emit("offline");
    } else {
      await this.readRemote();
    }
    this.scheduleRepair();
  }

  stop(): void {
    this.stopped = true;
    this.liveListeners.clear();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.repairTimer !== null) clearTimeout(this.repairTimer);
    this.doc.destroy();
  }

  private id(): string {
    return `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private emit(status: DurableStatus, legacyAdopted?: { path: string; text: string; baseEtag: string }): void {
    const effective = this.persistFailed && status !== "revoked" ? "error" : status;
    this.statusState = effective;
    this.options.onState({
      status: effective,
      pending: this.record.pending.length,
      etag: this.record.etag,
      documentId: this.record.documentId,
      ready: this.readyState,
      text: this.record.recovery?.desired ?? this.doc.markdown(),
      ...(legacyAdopted === undefined ? {} : { legacyAdopted }),
      ...(this.record.recovery === undefined ? {} : { recovery: this.record.recovery }),
    });
  }

  private persist(): Promise<boolean> {
    this.record.snapshot = this.doc.snapshot();
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
      if (response.update) this.doc.applyRemote(response.update);
      if (response.applied === false || response.pendingDependencies === true) {
        if (!(await this.persist())) return;
        this.emit("error");
        return;
      }
      // Clear recovery only after an authorized response for the exact same
      // generation. A response from a recreated note must never consume an
      // old offline draft.
      const adopted = recovery;
      this.record.recovery = undefined;
      this.record.documentId = response.documentId;
      this.record.etag = response.etag;
      this.readyState = true;
      this.options.onText(this.doc.markdown());
      if (!(await this.persist())) return;
      this.emit(this.record.pending.length > 0 ? "syncing" : "saved", {
        path: this.options.path,
        text: adopted.desired,
        baseEtag: expectedBaseEtag,
      });
      this.scheduleFlush();
    } catch (error) {
      if (this.isRevoked(error)) this.emit("revoked");
      else if (this.isUnavailable(error)) this.emit("unavailable");
      else if (this.isRetryable(error)) this.emit("offline");
      else this.emit("error");
    }
  }

  private change(text: string): void {
    if (this.stopped || !this.readyState || text === this.doc.markdown()) return;
    this.applyText(text);
  }

  /** Derive an update from the exact rendered Yjs snapshot, then apply it to now. */
  private changeFromSnapshot(baseSnapshot: string, text: string): string | void {
    if (this.stopped || !this.readyState) return;
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
    if (this.flushTimer !== null || this.stopped) return;
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
    if (this.stopped || this.statusState === "revoked") return;
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
        this.emit("error");
        return;
      }
      this.record.documentId = response.documentId;
      // On a cold start, only the server's Yjs update may establish IDs.
      // response.text is presentation data and must never seed the CRDT.
      if (response.update) this.doc.applyRemote(response.update);
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
      if (this.isRevoked(error)) this.emit("revoked");
      else if (this.isUnavailable(error)) this.emit("unavailable");
      else this.emit(this.record.pending.length > 0 || this.isRetryable(error) ? "offline" : "error");
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped || this.record.pending.length === 0 || this.statusState === "revoked" || this.options.canWrite?.() === false) return;
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
        if (response.update) this.doc.applyRemote(response.update);
          this.record.etag = response.etag;
          if (!(await this.persist())) return;
          this.options.onText(this.doc.markdown());
        this.emit("syncing");
        this.scheduleFlush(500);
        return;
      }
      this.record.pending = this.record.pending.filter((one) => !batch.some((sent) => sent.id === one.id));
      this.record.documentId = response.documentId;
      if (response.update) this.doc.applyRemote(response.update);
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
