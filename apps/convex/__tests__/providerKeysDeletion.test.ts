import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, drainScheduled, setupTest } from "./fixtures.helpers";
import type { TestConvex } from "./fixtures.helpers";

/**
 * DELETING EVERY SAVED MODEL KEY (decided by the owner, 2026-10-10).
 *
 * People's own Anthropic and OpenAI keys are no longer used: the assistant
 * runs only on the built-in model. `deleteSavedKeys` empties
 * `providerCredentials` in batches, scheduling itself until nothing is left,
 * so one run on a deployment is enough. These checks are what that run must
 * do and must not do:
 *
 *  - every row goes, across every workspace;
 *  - more rows than one batch still all go, from a single call;
 *  - no other table is touched, not even the audit trail;
 *  - what it logs is counts, never a key, a fingerprint or a workspace id.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. The handler never scheduling itself again. → **3 fail**: `more rows
 *     than one batch are all deleted by a single call`, `a limit outside
 *     1..500 is clamped rather than trusted` and `no other table is touched`,
 *     each of which runs with a batch smaller than the table.
 *  2. The handler also deleting `workspaces` rows it found through a
 *     credential. → `no other table is touched` fails.
 *  3. The log line carrying `workspaceId`. → `it logs counts, never a key, a
 *     fingerprint or a workspace` fails.
 */

/** Obviously fake envelopes: the deletion never opens one, so nothing real is needed. */
function fakeEnvelope(n: number): string {
  return `v1.fake-envelope-not-a-real-key-${n}`;
}

async function saveKeys(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  providers: Array<"anthropic" | "openai">,
  start: number,
): Promise<void> {
  await t.run(async (ctx) => {
    for (const [index, provider] of providers.entries()) {
      await ctx.db.insert("providerCredentials", {
        workspaceId,
        provider,
        encryptedApiKey: fakeEnvelope(start + index),
        fingerprint: `f${String(start + index).padStart(7, "0")}`,
        connectedBy: userId,
        connectedAt: 1_700_000_000_000 + start + index,
      });
    }
  });
}

async function savedKeyCount(t: TestConvex): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.query("providerCredentials").collect()).length);
}

/** Every document in every table but the one being emptied, keyed by table. */
async function everythingElse(t: TestConvex): Promise<Record<string, unknown[]>> {
  const tables = Object.keys(schema.tables).filter((name) => name !== "providerCredentials");
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const name of tables) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out[name] = await ctx.db.query(name as any).collect();
    }
    return out;
  });
}

/** Two workspaces with two people, each with keys saved. */
async function twoWorkspacesWithKeys(t: TestConvex) {
  const ada = await createUser(t, "ada@example.test");
  const bo = await createUser(t, "bo@example.test");
  const adaWorkspace = await createWorkspace(t, ada, "ada-keys");
  const boWorkspace = await createWorkspace(t, bo, "bo-keys");
  return { ada, bo, adaWorkspace, boWorkspace };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteSavedKeys", () => {
  test("every saved key goes, across every workspace", async () => {
    const t = setupTest();
    const { ada, bo, adaWorkspace, boWorkspace } = await twoWorkspacesWithKeys(t);
    await saveKeys(t, adaWorkspace, ada, ["anthropic", "openai"], 0);
    await saveKeys(t, boWorkspace, bo, ["anthropic"], 10);
    expect(await savedKeyCount(t)).toBe(3);

    const result = await t.mutation(internal.functions.providers.deleteSavedKeys, {});
    await drainScheduled(t);

    expect(result).toEqual({ deleted: 3, more: false });
    expect(await savedKeyCount(t)).toBe(0);
  });

  test("more rows than one batch are all deleted by a single call", async () => {
    const t = setupTest();
    const { ada, bo, adaWorkspace, boWorkspace } = await twoWorkspacesWithKeys(t);
    await saveKeys(t, adaWorkspace, ada, ["anthropic", "openai"], 0);
    await saveKeys(t, boWorkspace, bo, ["anthropic", "openai"], 10);
    const carol = await createUser(t, "carol@example.test");
    const carolWorkspace = await createWorkspace(t, carol, "carol-keys");
    await saveKeys(t, carolWorkspace, carol, ["openai"], 20);

    const first = await t.mutation(internal.functions.providers.deleteSavedKeys, { limit: 2 });
    expect(first).toEqual({ deleted: 2, more: true });

    await drainScheduled(t);
    expect(await savedKeyCount(t)).toBe(0);
  });

  test("an empty table is a no-op that schedules nothing", async () => {
    const t = setupTest();
    const result = await t.mutation(internal.functions.providers.deleteSavedKeys, {});
    expect(result).toEqual({ deleted: 0, more: false });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("a limit outside 1..500 is clamped rather than trusted", async () => {
    const t = setupTest();
    const { ada, adaWorkspace } = await twoWorkspacesWithKeys(t);
    await saveKeys(t, adaWorkspace, ada, ["anthropic", "openai"], 0);
    // Zero would delete nothing and reschedule forever; it deletes one.
    const result = await t.mutation(internal.functions.providers.deleteSavedKeys, { limit: 0 });
    expect(result.deleted).toBe(1);
    await drainScheduled(t);
    expect(await savedKeyCount(t)).toBe(0);
  });

  test("no other table is touched", async () => {
    const t = setupTest();
    const { ada, bo, adaWorkspace, boWorkspace } = await twoWorkspacesWithKeys(t);
    await saveKeys(t, adaWorkspace, ada, ["anthropic", "openai"], 0);
    await saveKeys(t, boWorkspace, bo, ["openai"], 10);
    const before = await everythingElse(t);
    expect(before.workspaces).toHaveLength(2);
    expect(before.users).toHaveLength(2);

    await t.mutation(internal.functions.providers.deleteSavedKeys, { limit: 1 });
    await drainScheduled(t);

    expect(await savedKeyCount(t)).toBe(0);
    expect(await everythingElse(t)).toEqual(before);
  });

  test("it logs counts, never a key, a fingerprint or a workspace", async () => {
    const t = setupTest();
    const { ada, adaWorkspace } = await twoWorkspacesWithKeys(t);
    await saveKeys(t, adaWorkspace, ada, ["anthropic", "openai"], 0);
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "info").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);

    await t.mutation(internal.functions.providers.deleteSavedKeys, { limit: 1 });
    await drainScheduled(t);

    const logged = lines.join("\n");
    expect(logged).toContain("provider_keys_deleted");
    for (const secretish of [fakeEnvelope(0), fakeEnvelope(1), "f0000000", "f0000001", adaWorkspace, ada]) {
      expect(logged).not.toContain(secretish);
    }
  });
});
