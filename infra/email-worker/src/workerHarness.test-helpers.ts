/**
 * The harness the Worker's email suites share: an in-memory bucket behind the
 * real adapter, a stub control plane with a call log, and `run`, which drives a
 * message through `handleEmail` offline. Not a test file: vitest does not collect
 * it, and each suite imports what it needs.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { handleEmail, type Env, type InboundMessage } from "./index";
import { REFUSAL } from "./refusal";
import { AUTHSERV, streamOf } from "./fixtures.test-helpers";

export { REFUSAL };

/* ------------------------------- the harness ------------------------------- */

export const ENV: Env = {
  CONTROL_PLANE_URL: "https://control-plane.test",
  EMAIL_WORKER_SECRET: "not-a-real-secret",
  INGEST_DOMAIN: "context.lc",
  AUTH_SERVICE_ID: AUTHSERV,
  OPERATIONS_MAILBOX: "ops@example.com",
  MAX_MESSAGE_BYTES: "5000000",
  NATIVE_BINDINGS: "TEST_BUCKET",
};

/** An in-memory R2 binding, wrapped in the real adapter the Worker builds. */
export function bucketStub(overrides: { failPut?: boolean; failGet?: boolean } = {}) {
  const objects = new Map<string, string>();
  const types = new Map<string, string>();
  return {
    objects,
    async get(key: string) {
      if (overrides.failGet) throw new Error("get failed");
      if (!objects.has(key)) return null;
      return { etag: "e1", text: async () => objects.get(key)! };
    },
    // The content type is recorded, not ignored. R2 carries it in
    // `httpMetadata` and the adapter always sets one, so a stub that drops the
    // third argument cannot tell a stored PNG from a stored note — which is
    // precisely how every emailed image came to be labelled markdown.
    types,
    async put(
      key: string,
      value: string | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      if (overrides.failPut) throw new Error("put failed");
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
      types.set(key, options?.httpMetadata?.contentType ?? "(none)");
      return { etag: `e${objects.size}` };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

export const RESOLUTION = {
  ticket: "ticket-1",
  context: { kind: "personal" as const, path: "seyi" },
  targetFolder: "0-inbox/",
  attachmentPolicy: "list",
  maxMessageBytes: 5_000_000,
  policy: {
    allowedSenders: ["alice@example.com"],
    allowedDomains: [],
    allowAnySender: false,
  },
};

export const BINDING = {
  // The real `/gateway/binding` shape, unchanged: the workspace row IS the
  // context, and a personal context is a workspace with one owner member.
  workspaceId: "ws-1",
  provider: "r2-binding",
  bindingName: "TEST_BUCKET",
  capabilities: { conditionalWrite: true },
  status: "active",
};

export interface Observed {
  rejected: string[];
  forwarded: string[];
}

/**
 * How many bytes of the message body the Worker actually pulled.
 *
 * `fingerprint` above covers what an SMTP peer can SEE. This covers what the
 * Worker DOES, which is the other half of the same question: two refusals that
 * are byte-identical to read and a different amount of work apart are still two
 * answers. Ingestion is on the apex, so the party doing the measuring here
 * needs no account at all.
 */
export function countingStream(bytes: Uint8Array, meter: { read: number }): ReadableStream<Uint8Array> {
  const inner = streamOf(bytes);
  const reader = inner.getReader();
  // `highWaterMark: 0` so the stream pulls only on demand. With the default of
  // 1 the queue is primed at construction and the meter reports one chunk the
  // Worker never consumed — which understates the gap and is exactly the kind
  // of instrument artifact that reads like a result.
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        meter.read += value.byteLength;
        controller.enqueue(value);
      },
    },
    { highWaterMark: 0 },
  );
}

export function inbound(
  raw: Uint8Array,
  to = "seyi@context.lc",
  from = "alice@example.com",
  meter?: { read: number },
) {
  const observed: Observed = { rejected: [], forwarded: [] };
  const message: InboundMessage = {
    to,
    from,
    raw: meter ? countingStream(raw, meter) : streamOf(raw),
    rawSize: raw.length,
    setReject(reason) {
      observed.rejected.push(reason);
    },
    async forward(rcptTo) {
      observed.forwarded.push(rcptTo);
    },
  };
  return { message, observed };
}

/**
 * Everything an SMTP peer can observe about how a message was handled.
 *
 * The email analogue of `responseFingerprint`. Two outcomes with the same
 * fingerprint are indistinguishable from outside — which is the property.
 */
export function fingerprint(observed: Observed): string {
  return JSON.stringify({ rejected: observed.rejected, forwarded: observed.forwarded });
}

export interface StubOptions {
  /**
   * Loosely typed on purpose. `IngestionResolution.context` is a union of one
   * (`{ kind: "personal" }`), so a shared context is not expressible in the
   * package's own types — which is the property. The tests still have to be
   * able to hand the handler one, to prove it refuses.
   */
  resolution?: Record<string, unknown> | null;
  binding?: Record<string, unknown> | null;
  resolveThrows?: boolean;
  bindingThrows?: boolean;
  recordThrows?: boolean;
}

/** The shape the handler needs, plus the call log the assertions read. */
export type StubbedControlPlane = NonNullable<
  NonNullable<Parameters<typeof handleEmail>[2]>["controlPlane"]
> & { calls: string[]; rows: Map<string, KeyedRow> };

/** A keyed row, as the control plane holds it: the note's id key and the key's version. */
export interface KeyedRow {
  state: "keyed";
  key: string;
  etag: string;
  noteId: string;
}

/**
 * The control plane the handler talks to. Every workspace is keyed, so it
 * answers the id routes the way the Convex handlers do: rows by path, a lookup
 * that names them, adopt refused for a name already held, and a record kept
 * only for the row's own key. `rows` is the tree, by path.
 */
export function controlPlaneStub(options: StubOptions = {}): StubbedControlPlane {
  const calls: string[] = [];
  const rows = new Map<string, KeyedRow>();
  return {
    calls,
    rows,
    async noteIdLookup(_ticket: string, paths: string[]) {
      const notes: Record<string, KeyedRow> = {};
      for (const path of paths) {
        const row = rows.get(path);
        if (row) notes[path] = row;
      }
      return { keyed: true, notes };
    },
    async noteIdAdopt(_ticket: string, note: { path: string; noteId: string; key: string; etag: string }) {
      const held = rows.get(note.path);
      if (held) return { adopted: false, taken: held };
      rows.set(note.path, { state: "keyed", key: note.key, etag: note.etag, noteId: note.noteId });
      return { adopted: true, taken: null };
    },
    async noteIdWrote(_ticket: string, copy: { path: string; key: string; etag: string }) {
      const row = rows.get(copy.path);
      if (!row || row.key !== copy.key) return { recorded: false };
      row.etag = copy.etag;
      return { recorded: true };
    },
    async resolveIngestion() {
      calls.push("resolve");
      if (options.resolveThrows) throw new Error("control plane down");
      return options.resolution === undefined ? RESOLUTION : options.resolution;
    },
    async getBinding() {
      calls.push("binding");
      if (options.bindingThrows) throw new Error("control plane down");
      return options.binding === null ? null : { binding: options.binding ?? BINDING, noteCap: null };
    },
    async record() {
      calls.push("record");
      if (options.recordThrows) throw new Error("record failed");
    },
  } as unknown as StubbedControlPlane;
}

/**
 * Runs a message through the handler with the policy matcher forced on.
 *
 * ./policy.ts ships an unwired matcher that denies everything (deliberately —
 * an ingestion path whose only protection is a policy check must not run
 * without one). The suite injects a stand-in so the rest of the pipeline is
 * exercised; `describe("fail-closed")` below covers the unwired case itself.
 */
export async function run(
  raw: Uint8Array,
  {
    env = ENV,
    to = "seyi@context.lc",
    from = "alice@example.com",
    bucket = bucketStub(),
    stub = {},
    plane,
    meter,
  }: {
    env?: Env;
    to?: string;
    from?: string;
    bucket?: ReturnType<typeof bucketStub>;
    stub?: StubOptions;
    /** The control plane of an earlier run, so a redelivery meets the same tree. */
    plane?: StubbedControlPlane;
    meter?: { read: number };
  } = {},
) {
  const { message, observed } = inbound(raw, to, from, meter);
  const controlPlane = plane ?? controlPlaneStub(stub);
  const fullEnv: Env = { ...env, TEST_BUCKET: bucket };
  let threw: unknown = null;
  try {
    await handleEmail(message, fullEnv, {
      controlPlane,
      now: () => new Date("2026-08-26T09:00:00.000Z"),
      nonce: () => "0123456789abcdef",
    });
  } catch (error) {
    threw = error;
  }
  return { observed, bucket, threw, controlPlane, notes: notesOf(bucket, controlPlane) };
}

/** What each note's name holds: the tree's rows read through the bucket, by path. */
export function notesOf(bucket: ReturnType<typeof bucketStub>, controlPlane: StubbedControlPlane): Map<string, string> {
  const notes = new Map<string, string>();
  for (const [path, row] of controlPlane.rows) {
    const body = bucket.objects.get(row.key);
    if (body !== undefined) notes.set(path, body);
  }
  return notes;
}

/**
 * Offline guards every suite installs: `fetch` throws, so a stray network call
 * fails loudly, and `console.log` is captured so a test can read what was logged.
 * Call once at the top of a suite; the returned object carries the spy and the log.
 */
export function offlineGuards() {
  const guards = { fetchSpy: vi.fn(), logs: [] as string[] };
  beforeEach(() => {
    guards.fetchSpy = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", guards.fetchSpy);
    guards.logs = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      guards.logs.push(String(line));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  return guards;
}
