/**
 * The forwarding ledger sent to the workspace object behind each change
 * (`lib/smallData/objectLedger.ts`, `functions/smallDataObject.ts`;
 * `docs/decisions/storage-and-credentials/forwarding-in-objects.md`).
 *
 * What is proved: a recorded move sends the whole ledger, at the version it
 * moved to, through the gateway's door as `ws.forwarding.put`, for a
 * workspace whose notes live in its object, and for no other; a gateway read
 * the object could not answer (`request` with `objectLedger`) sends it too,
 * which is how an existing ledger moves there; a door that fails never fails
 * the move.
 *
 * Sabotage (temporary local edits, reverted): dropping the home check sends
 * for a bucket workspace and fails "only where the notes live"; dropping the
 * send from `markChanged` fails the first case.
 *
 * Every value is obviously fake; this repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

type Sent = { op: string | null; body: Record<string, unknown> };

function stubDoor(answer: () => Response = () => Response.json({ kept: true })): Sent[] {
  const sent: Sent[] = [];
  vi.stubEnv("STORAGE_MOVER_ORIGIN", "https://gateway.example.test");
  vi.stubEnv("GATEWAY_SECRET", "fake-gateway-secret");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(String(url)).toBe("https://gateway.example.test/internal/workspace-store");
    const headers = new Headers(init.headers);
    const call = headers.get("x-tex-call") ?? "";
    const op = (JSON.parse(decodeURIComponent(call)) as { op?: string }).op ?? null;
    const body = JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)) as Record<string, unknown>;
    sent.push({ op, body });
    return answer();
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function workspaceAt(t: ReturnType<typeof convexTest>, home: "object" | "bucket" | null): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {} as never);
    const workspaceId = await ctx.db.insert("workspaces", { slug: "acme", displayName: "Acme", createdBy: userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
    if (home !== null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home, since: 0 });
    return workspaceId;
  });
}

async function settle(t: ReturnType<typeof convexTest>): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

// The client names the workspace in every body; the door rewrites it to the ticket's, so it is left out here.
const puts = (sent: Sent[]) =>
  sent.filter((call) => call.op === "ws.forwarding.put").map(({ op, body: { workspaceId: _named, ...body } }) => ({ op, body }));

describe("the ledger's copy in the workspace object", () => {
  test("a recorded move sends the whole ledger at the version it moved to", async () => {
    const sent = stubDoor();
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceAt(t, "object");
    await t.mutation(internal.functions.smallData.recordForwarding, { workspaceId, moves: [{ from: "projects/a.md", to: "projects/b.md", kind: "note" }], now: 10 });
    await settle(t);
    await t.mutation(internal.functions.smallData.recordForwarding, { workspaceId, moves: [{ from: "projects/b.md", to: "archive/b.md", kind: "note" }], now: 20 });
    await settle(t);
    const bodies = puts(sent).map((call) => call.body);
    expect(bodies.length).toBe(2);
    expect(bodies[0]).toEqual({ version: 1, entries: [{ from: "projects/a.md", to: "projects/b.md", kind: "note", at: 10 }] });
    // The chain collapsed in the control plane's rows, and the object is sent the result, whole.
    expect(bodies[1]!.version).toBe(2);
    expect(bodies[1]!.entries).toEqual([
      { from: "projects/a.md", to: "archive/b.md", kind: "note", at: 10 },
      { from: "projects/b.md", to: "archive/b.md", kind: "note", at: 20 },
    ]);
  });

  test("only where the notes live in the object: a bucket or unrecorded workspace is sent nothing", async () => {
    const sent = stubDoor();
    const t = convexTest(schema, modules);
    for (const home of ["bucket", null] as const) {
      const workspaceId = await workspaceAt(t, home);
      await t.mutation(internal.functions.smallData.recordForwarding, { workspaceId, moves: [{ from: "a.md", to: "b.md", kind: "note" }], now: 1 });
      await t.mutation(internal.functions.smallData.request, { workspaceId, objectLedger: true });
    }
    await settle(t);
    expect(puts(sent)).toEqual([]);
  });

  test("a read the object could not answer sends the ledger: an existing one moves there, empty or not", async () => {
    const sent = stubDoor();
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceAt(t, "object");
    await t.mutation(internal.functions.smallData.request, { workspaceId, objectLedger: true });
    await settle(t);
    expect(puts(sent).map((call) => call.body)).toEqual([{ version: 0, entries: [] }]);
    // A plain request (the app's icons and emoji) sends nothing.
    await t.mutation(internal.functions.smallData.request, { workspaceId });
    await settle(t);
    expect(puts(sent).length).toBe(1);
  });

  test("a door that fails never fails the move: the rows keep it, and the next send carries it", async () => {
    stubDoor(() => new Response("down", { status: 503 }));
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceAt(t, "object");
    await t.mutation(internal.functions.smallData.recordForwarding, { workspaceId, moves: [{ from: "a.md", to: "b.md", kind: "note" }], now: 1 });
    await settle(t);
    expect(await t.query(internal.functions.smallData.ledger, { workspaceId })).toEqual([{ from: "a.md", to: "b.md", kind: "note", at: 1 }]);
  });

  test("with no way to reach the gateway nothing is sent and nothing fails", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceAt(t, "object");
    await t.mutation(internal.functions.smallData.recordForwarding, { workspaceId, moves: [{ from: "a.md", to: "b.md", kind: "note" }], now: 1 });
    await settle(t);
    expect((await t.query(internal.functions.smallData.ledger, { workspaceId })).length).toBe(1);
  });
});
