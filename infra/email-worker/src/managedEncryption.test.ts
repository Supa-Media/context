/**
 * MAIL INTO AN ENCRYPTED MANAGED WORKSPACE.
 *
 * The one writer with nobody watching must seal what it writes exactly as
 * the gateway does, or an encrypted workspace (which refuses a plain body on
 * read) would hold a message nobody can open. And a mode that arrives without
 * a usable key must refuse the message rather than write it in the clear.
 *
 * Sabotage: `storeFor` not passing `managedEncryption` fails the first; its
 * key check treating a keyless mode as plain fails the second.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmail, type Env, type InboundMessage } from "./index";
import { REFUSAL } from "./refusal";
import { AUTHSERV, rawMessage, streamOf } from "./fixtures.test-helpers";

const ENV: Env = {
  CONTROL_PLANE_URL: "https://control-plane.test",
  EMAIL_WORKER_SECRET: "not-a-real-secret",
  INGEST_DOMAIN: "context.lc",
  AUTH_SERVICE_ID: AUTHSERV,
  OPERATIONS_MAILBOX: "ops@example.com",
  MAX_MESSAGE_BYTES: "5000000",
  NATIVE_BINDINGS: "TEST_BUCKET",
} as unknown as Env;

const KEY = { current: "k1", keys: { k1: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))) } };
const MAGIC = "CTXENC";

function bytesBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        etag: "e1",
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    async put(key: string, value: string | Uint8Array | ArrayBuffer) {
      const bytes =
        typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
      objects.set(key, bytes);
      return { etag: `e${objects.size}` };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return { objects: [...objects.keys()].map((key) => ({ key, size: 1 })), delimitedPrefixes: [], truncated: false };
    },
  };
}

async function deliver(bucket: ReturnType<typeof bytesBucket>, siblings: { managedEncryption: unknown; encryptionKey: unknown }) {
  const rejected: string[] = [];
  const raw = rawMessage();
  const message: InboundMessage = {
    to: "seyi@context.lc",
    from: "alice@example.com",
    raw: streamOf(raw),
    rawSize: raw.length,
    setReject(reason) {
      rejected.push(reason);
    },
    async forward() {},
  };
  const controlPlane = {
    async resolveIngestion() {
      return {
        ticket: "ticket-1",
        context: { kind: "personal" as const, path: "seyi" },
        targetFolder: "0-inbox/",
        attachmentPolicy: "list",
        maxMessageBytes: 5_000_000,
        policy: { allowedSenders: ["alice@example.com"], allowedDomains: [], allowAnySender: false },
      };
    },
    async getBinding() {
      return {
        binding: {
          workspaceId: "ws-1",
          provider: "r2-binding",
          bindingName: "TEST_BUCKET",
          capabilities: { conditionalWrite: true },
          status: "active",
        },
        noteCap: null,
        ...siblings,
      };
    },
    async record() {},
  };
  await handleEmail(message, { ...ENV, TEST_BUCKET: bucket } as unknown as Env, {
    controlPlane: controlPlane as never,
    now: () => new Date("2026-08-26T09:00:00.000Z"),
    nonce: () => "0123456789abcdef",
  });
  return rejected;
}

const inbox = (bucket: ReturnType<typeof bytesBucket>) =>
  [...bucket.objects.entries()].filter(([key]) => key.startsWith("0-inbox/"));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("network access attempted");
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an encrypted managed workspace receiving mail", () => {
  it("lands the message sealed, never in the clear", async () => {
    const bucket = bytesBucket();
    expect(await deliver(bucket, { managedEncryption: { mode: "encrypted" }, encryptionKey: KEY })).toEqual([]);
    const notes = inbox(bucket);
    expect(notes).toHaveLength(1);
    const stored = new TextDecoder().decode(notes[0]![1]);
    expect(stored.startsWith(MAGIC)).toBe(true);
    expect(stored).not.toContain("alice@example.com");
  });

  it("refuses the message when the mode arrives without a key", async () => {
    const bucket = bytesBucket();
    expect(await deliver(bucket, { managedEncryption: { mode: "encrypted" }, encryptionKey: null })).toEqual([REFUSAL]);
    expect(inbox(bucket)).toEqual([]);
  });

  it("writes plain for a workspace that is not encrypted", async () => {
    const bucket = bytesBucket();
    expect(await deliver(bucket, { managedEncryption: null, encryptionKey: null })).toEqual([]);
    expect(new TextDecoder().decode(inbox(bucket)[0]![1]).startsWith(MAGIC)).toBe(false);
  });
});
