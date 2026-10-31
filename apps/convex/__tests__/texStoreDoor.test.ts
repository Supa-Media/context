/**
 * Tex's notes, reached from this deployment's own stores
 * (`lib/texStore.ts`): through the gateway's door
 * (`apps/mcp/src/texStore/door.js`) with the gateway secret and a ticket this
 * deployment minted, spent at its real `/gateway/tex-store/open`.
 *
 * Sabotage, each confirmed to fail a case here: let `mint` accept another
 * workspace's owner, stop `open` refusing an expired ticket, or let the door
 * skip the ticket's owners.
 */

import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { handleTexStoreDoor } from "../../mcp/src/texStore/door.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { serveTexStore } from "../../mcp/src/texStore/wire.js";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { hashToken } from "../functions/lib/crypto";
import { consoleTexStore } from "../functions/lib/texStore";
import { TEX_STORE_TICKET_TTL_MS } from "../functions/texStoreTickets";
import { TEST_GATEWAY_SECRET, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const GATEWAY = "https://gateway.example.invalid";
const NOTE = "0199a000-0000-7000-8000-00000000000b";

afterEach(() => {
  vi.unstubAllEnvs();
});

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

async function world() {
  const t = setupTest();
  const userId = await createUser(t, "tex-store@example.com");
  const workspaceId = await createWorkspace(t, userId, "tex-store-owner");
  const otherId = await createWorkspace(t, userId, "tex-store-other");
  const objects = new Map<string, ReturnType<typeof texObjects>>();
  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    TEX_STORE: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!objects.has(name)) objects.set(name, texObjects(durableSql()));
        const held = objects.get(name)!;
        return { fetch: (request: Request) => serveTexStore(held, request) };
      },
    },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(t, "/gateway/tex-store/open", { ticket });
      const { opened } = (await response.json()) as { opened: { workspaceId: string; owners: string[] } | null };
      return opened;
    },
  };
  const doors: Request[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    doors.push(request.clone());
    return await handleTexStoreDoor(request, env, { controlPlane });
  }) as unknown as typeof fetch;
  const ctx = { runMutation: (ref: unknown, args: unknown) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args) } as unknown as ActionCtx;
  return { t, workspaceId, otherId, objects, env, controlPlane, fetchImpl, ctx, doors };
}

describe("tickets for Tex's notes", () => {
  test("a ticket names only its own workspace's object, and opens until it expires", async () => {
    const { t, workspaceId, otherId } = await world();
    await expect(
      t.mutation(internal.functions.texStoreTickets.mint, { hashedTicket: await hashToken("a"), workspaceId, owners: [`person:${otherId}`], now: 1 }),
    ).rejects.toThrow();
    await t.mutation(internal.functions.texStoreTickets.mint, { hashedTicket: await hashToken("b"), workspaceId, owners: [`person:${workspaceId}`], now: 1_000 });
    expect(await t.query(internal.functions.texStoreTickets.open, { hashedTicket: await hashToken("b"), now: 2_000 })).toEqual({
      workspaceId,
      owners: [`person:${workspaceId}`],
    });
    expect(await t.query(internal.functions.texStoreTickets.open, { hashedTicket: await hashToken("b"), now: 1_000 + TEX_STORE_TICKET_TTL_MS })).toBeNull();
    expect(await t.query(internal.functions.texStoreTickets.open, { hashedTicket: await hashToken("never"), now: 2_000 })).toBeNull();
  });
});

describe("the console's store reaches Tex's notes through the gateway", () => {
  test("a Tex key written and read from here lands in the person's object, never the bucket", async () => {
    const { workspaceId, objects, fetchImpl, ctx, doors } = await world();
    vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
    vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
    const bucket = new Map<string, unknown>();
    const binding = { provider: "r2-binding", bindingName: "BUCKET", workspaceId: String(workspaceId), conditionalWrite: true, conditionalCreate: true };
    const env = {
      NATIVE_BINDINGS: "BUCKET",
      BUCKET: {
        get: async (key: string) => bucket.get(key) ?? null,
        put: async (key: string, value: unknown) => (bucket.set(key, value), { etag: "e" }),
        head: async () => null,
        delete: async (key: string) => void bucket.delete(key),
        list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }),
      },
    };
    const texStore = consoleTexStore(ctx, workspaceId, { fetchImpl });
    expect(texStore).not.toBeNull();
    const store = storeForBinding(binding, env, { texStore }) as unknown as {
      put: (key: string, value: string) => Promise<{ etag: string } | null>;
      get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
      delete: (key: string) => Promise<void>;
    };
    const key = `tex/person:${workspaceId}/notes/${NOTE}.md`;
    await store.put(key, "# About me");
    expect(await (await store.get(key))!.text()).toBe("# About me");
    expect(bucket.size).toBe(0);
    expect(objects.get(`person:${workspaceId}`)!.list({}).objects.map((object) => object.key)).toEqual([`notes/${NOTE}.md`]);
    // Every call carried the secret, one ticket and the owner.
    expect(new Set(doors.map((request) => request.headers.get("x-tex-ticket"))).size).toBe(1);
    expect(doors.every((request) => request.headers.get("authorization") === `Bearer ${TEST_GATEWAY_SECRET}`)).toBe(true);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  test("without the gateway's origin there is no way in, and the store refuses a Tex key", async () => {
    const { workspaceId, ctx } = await world();
    vi.stubEnv("STORAGE_MOVER_ORIGIN", "");
    expect(consoleTexStore(ctx, workspaceId)).toBeNull();
  });
});

describe("a deleted workspace's Tex notes", () => {
  test("are wiped from its Durable Object through the gateway", async () => {
    const { t, workspaceId, objects, fetchImpl } = await world();
    vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
    vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const held = texObjects(durableSql());
      objects.set(`person:${workspaceId}`, held);
      await held.put(`notes/${NOTE}.md`, "Likes tea.");
      await t.action(internal.functions.texStoreWipe.wipeWorkspace, { workspaceId, attempt: 0 });
      expect(held.list({}).objects).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the gateway's door", () => {
  async function call(env: object, controlPlane: Parameters<typeof handleTexStoreDoor>[2] extends infer D ? (D extends { controlPlane?: infer C } ? C : never) : never, headers: Record<string, string>) {
    return await handleTexStoreDoor(
      new Request(`${GATEWAY}/internal/tex-store`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "list" })), ...headers } }),
      env,
      { controlPlane },
    );
  }

  test("refuses without the secret, without a ticket, and for an owner the ticket does not name", async () => {
    const { t, workspaceId, otherId, env, controlPlane } = await world();
    await t.mutation(internal.functions.texStoreTickets.mint, { hashedTicket: await hashToken("good"), workspaceId, owners: [`person:${workspaceId}`], now: Date.now() });
    const auth = { Authorization: `Bearer ${TEST_GATEWAY_SECRET}` };
    expect((await call(env, controlPlane, { "x-tex-ticket": "good", "x-tex-owner": `person:${workspaceId}` })).status).toBe(401);
    expect((await call(env, controlPlane, { ...auth, Authorization: "Bearer wrong", "x-tex-ticket": "good", "x-tex-owner": `person:${workspaceId}` })).status).toBe(401);
    expect((await call(env, controlPlane, { ...auth, "x-tex-ticket": "forged", "x-tex-owner": `person:${workspaceId}` })).status).toBe(403);
    expect((await call(env, controlPlane, { ...auth, "x-tex-ticket": "good", "x-tex-owner": `person:${otherId}` })).status).toBe(403);
    expect((await call(env, controlPlane, { ...auth, "x-tex-ticket": "good", "x-tex-owner": "../person" })).status).toBe(400);
    expect((await call(env, controlPlane, { ...auth, "x-tex-ticket": "good", "x-tex-owner": `person:${workspaceId}` })).status).toBe(200);
  });
});
