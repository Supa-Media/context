/**
 * THE FREE MANAGED TIER'S NOTE CAP, ON THE ONE PATH THAT CREATES NOTES WITH NO
 * PERSON WATCHING.
 *
 * A full personal context refuses the message with the one refusal every other
 * failure uses — nothing a sender can read says why — writes no note, and says
 * why only in this Worker's own log. The cap itself is the gateway's store
 * wrapper (`apps/mcp/src/store/noteCap.js`), reached through the same factory;
 * what is proved here is that this Worker hands it the number and answers the
 * refusal.
 *
 * Sabotage: not passing the cap to the factory fails the first and third; not
 * naming `NoteCapReached` as its own log reason fails the third (it logs
 * `write_failed`, which is true and useless to an operator).
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

/** An in-memory R2 binding that lists what it holds — the cap counts. */
function bucketHolding(notes: number) {
  const objects = new Map<string, string>();
  for (let i = 0; i < notes; i += 1) objects.set(`1-projects/n-${i}.md`, "x");
  return {
    objects,
    async get(key: string) {
      return objects.has(key) ? { etag: "e1", text: async () => objects.get(key)! } : null;
    },
    async put(key: string, value: string | Uint8Array) {
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
      return { etag: `e${objects.size}` };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter }: { prefix?: string; delimiter?: string } = {}) {
      const found: Array<{ key: string; size: number }> = [];
      const prefixes = new Set<string>();
      for (const key of [...objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort()) {
        const rest = key.slice(prefix.length);
        const split = delimiter ? rest.indexOf(delimiter) : -1;
        if (split >= 0) prefixes.add(`${prefix}${rest.slice(0, split + 1)}`);
        else found.push({ key, size: objects.get(key)!.length });
      }
      return { objects: found, delimitedPrefixes: [...prefixes], truncated: false };
    },
  };
}

async function deliver(bucket: ReturnType<typeof bucketHolding>, noteCap: number | null) {
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
        noteCap,
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

const inbox = (bucket: ReturnType<typeof bucketHolding>) =>
  [...bucket.objects.keys()].filter((key) => key.startsWith("0-inbox/"));

let logs: string[];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("network access attempted");
  }));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a personal context on the free tier that is full", () => {
  it("refuses the message with the one refusal, and writes no note", async () => {
    const bucket = bucketHolding(3);
    expect(await deliver(bucket, 3)).toEqual([REFUSAL]);
    expect(inbox(bucket)).toEqual([]);
  });

  it("takes the message while there is room, and with no cap at all", async () => {
    const roomy = bucketHolding(2);
    expect(await deliver(roomy, 3)).toEqual([]);
    expect(inbox(roomy)).toHaveLength(1);
    const uncapped = bucketHolding(3);
    expect(await deliver(uncapped, null)).toEqual([]);
    expect(inbox(uncapped)).toHaveLength(1);
  });

  it("says why in its own log, and only there", async () => {
    await deliver(bucketHolding(3), 3);
    expect(logs.some((line) => line.includes('"note_cap_reached"'))).toBe(true);
  });
});
