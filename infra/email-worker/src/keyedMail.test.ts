/**
 * Mail into a keyed workspace (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A keyed workspace's notes live at `notes/<noteId>.md`, so a capture is written
 * through the id layer (`apps/mcp/src/store/idLayout.js`, mode "keys"): the note
 * gets a new id, its bytes land at that id's key, and the control plane is asked
 * for its row under the capture's ticket. These tests drive that path with a
 * control plane that keeps rows the way the Convex routes do.
 *
 * Sabotage: drop `idLayout` from `storeFor` in `index.ts` and the first case
 * fails (the note lands at its path, which nothing reads).
 *
 * Every test runs offline, and every value here is obviously fake.
 */
import { describe, expect, it } from "vitest";
import { handleEmail, type Env, type InboundMessage } from "./index";
import { AUTHSERV, rawMessage, streamOf } from "./fixtures.test-helpers";

const ENV: Env = {
  CONTROL_PLANE_URL: "https://control-plane.test",
  EMAIL_WORKER_SECRET: "not-a-real-secret",
  INGEST_DOMAIN: "context.lc",
  AUTH_SERVICE_ID: AUTHSERV,
  OPERATIONS_MAILBOX: "ops@example.com",
  MAX_MESSAGE_BYTES: "5000000",
  NATIVE_BINDINGS: "TEST_BUCKET",
};

const NOTE_KEY = /^notes\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/;

/** An in-memory R2 binding, wrapped by the real adapter the Worker builds. */
function bucketStub() {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key: string) {
      if (!objects.has(key)) return null;
      return { etag: "e1", text: async () => objects.get(key)! };
    },
    async put(key: string, value: string | Uint8Array) {
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
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

const RESOLUTION = {
  ticket: "ticket-1",
  context: { kind: "personal" as const, path: "seyi" },
  targetFolder: "0-inbox/",
  attachmentPolicy: "list",
  maxMessageBytes: 5_000_000,
  policy: { allowedSenders: ["alice@example.com"], allowedDomains: [], allowAnySender: false },
};

/** A keyed row, as the control plane holds it. */
interface Row {
  state: "keyed";
  key: string;
  etag: string;
  noteId: string;
}

/**
 * A control plane for one workspace, answering the id routes the way the Convex
 * handlers do: rows by path, a lookup that names them, adopt refused for a name
 * already held, and a record that is kept only for the row's own key.
 */
function keyedPlane(options: { keyed: boolean }) {
  const rows = new Map<string, Row>();
  const calls: string[] = [];
  return {
    rows,
    calls,
    async resolveIngestion() {
      calls.push("resolve");
      return RESOLUTION;
    },
    async getBinding() {
      calls.push("binding");
      return {
        binding: {
          workspaceId: "ws-1",
          provider: "r2-binding",
          bindingName: "TEST_BUCKET",
          capabilities: { conditionalWrite: true },
          status: "active",
        },
        noteCap: null,
        noteCount: null,
        managedEncryption: null,
        encryptionKey: null,
        keyed: options.keyed,
      };
    },
    async record() {
      calls.push("record");
    },
    async noteIdLookup(ticket: string, paths: string[]) {
      calls.push(`lookup:${ticket}`);
      const notes: Record<string, Row> = {};
      for (const path of paths) {
        const row = rows.get(path);
        if (row) notes[path] = row;
      }
      return { copies: {}, keyed: true, notes };
    },
    async noteIdAdopt(ticket: string, note: { path: string; noteId: string; key: string; etag: string }) {
      calls.push(`adopt:${ticket}`);
      const held = rows.get(note.path);
      if (held) return { adopted: false, taken: held };
      rows.set(note.path, { state: "keyed", key: note.key, etag: note.etag, noteId: note.noteId });
      return { adopted: true, taken: null };
    },
    async noteIdWrote(ticket: string, copy: { path: string; key: string; etag: string }) {
      calls.push(`wrote:${ticket}`);
      const row = rows.get(copy.path);
      if (!row || row.key !== copy.key) return { recorded: false };
      row.etag = copy.etag;
      return { recorded: true };
    },
  };
}

type Plane = ReturnType<typeof keyedPlane>;

function inbound(raw: Uint8Array, from: string) {
  const observed = { rejected: [] as string[] };
  const message: InboundMessage = {
    to: "seyi@context.lc",
    from,
    raw: streamOf(raw),
    rawSize: raw.length,
    setReject(reason) {
      observed.rejected.push(reason);
    },
    async forward() {},
  };
  return { message, observed };
}

async function deliver(plane: Plane, bucket: ReturnType<typeof bucketStub>, raw = rawMessage(), from = "alice@example.com") {
  const { message, observed } = inbound(raw, from);
  await handleEmail(message, { ...ENV, TEST_BUCKET: bucket }, {
    controlPlane: plane as never,
    now: () => new Date("2026-10-15T09:00:00.000Z"),
    nonce: () => "0123456789abcdef",
  });
  return observed;
}

/** The keys of a bucket that hold note bodies at their id keys. */
function idKeysIn(bucket: ReturnType<typeof bucketStub>): string[] {
  return [...bucket.objects.keys()].filter((key) => key.startsWith("notes/"));
}

describe("mail into a keyed workspace", () => {
  it("lands at a notes/<uuid>.md key, never at its path, and the control plane adopts that key", async () => {
    const plane = keyedPlane({ keyed: true });
    const bucket = bucketStub();
    const observed = await deliver(plane, bucket);

    expect(observed.rejected).toEqual([]);
    const keys = idKeysIn(bucket);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(NOTE_KEY);
    expect([...bucket.objects.keys()].some((key) => key.startsWith("0-inbox/email/"))).toBe(false);

    // The row names the same key, under the path the capture was filed at.
    const [[path, row]] = [...plane.rows.entries()];
    expect(path).toMatch(/^0-inbox\/email\/[0-9a-f]{24}\.md$/);
    expect(row).toMatchObject({ state: "keyed", key: keys[0] });
    expect(bucket.objects.get(keys[0])).toContain("alice@example.com");
  });

  it("makes every id call under the ticket it was minted with", async () => {
    const plane = keyedPlane({ keyed: true });
    await deliver(plane, bucketStub());
    const idCalls = plane.calls.filter((call) => /^(lookup|adopt|wrote):/.test(call));
    expect(idCalls.length).toBeGreaterThan(0);
    expect(idCalls.every((call) => call.endsWith(":ticket-1"))).toBe(true);
  });

  it("a duplicate delivery of the same message is accepted and adds no second note", async () => {
    const plane = keyedPlane({ keyed: true });
    const bucket = bucketStub();
    await deliver(plane, bucket);
    const adoptsBefore = plane.calls.filter((call) => call.startsWith("adopt:")).length;

    const observed = await deliver(plane, bucket);
    expect(observed.rejected).toEqual([]);
    expect(idKeysIn(bucket)).toHaveLength(1);
    expect(plane.calls.filter((call) => call.startsWith("adopt:")).length).toBe(adoptsBefore);
  });

  it("refuses a sender the owner does not admit before any id call or write", async () => {
    const plane = keyedPlane({ keyed: true });
    const bucket = bucketStub();
    const observed = await deliver(plane, bucket, rawMessage({ from: "bob@example.com" }), "bob@example.com");

    expect(observed.rejected).toHaveLength(1);
    expect(plane.calls.some((call) => call.includes(":"))).toBe(false);
    expect(bucket.objects.size).toBe(0);
  });

  it("a workspace that is not keyed is unchanged: the note lands at its path and no id call is made", async () => {
    const plane = keyedPlane({ keyed: false });
    const bucket = bucketStub();
    const observed = await deliver(plane, bucket);

    expect(observed.rejected).toEqual([]);
    expect(idKeysIn(bucket)).toHaveLength(0);
    expect([...bucket.objects.keys()].some((key) => /^0-inbox\/email\/[0-9a-f]{24}\.md$/.test(key))).toBe(true);
    expect(plane.calls.some((call) => /^(lookup|adopt|wrote):/.test(call))).toBe(false);
    expect(plane.rows.size).toBe(0);
  });
});
