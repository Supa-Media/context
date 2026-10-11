/**
 * "On for everyone", and the owner's switch.
 *
 * The owner decided on 2026-10-07 that search by meaning reaches every
 * workspace without anybody asking, and that the owner can switch it off.
 * What is asserted is that both halves hold together: the rollout reaches
 * every workspace with storage, proves the credential on one before it
 * spends it on all, never turns back on what an owner turned off, and a
 * storage disconnect or a deleted workspace leaves the right thing behind.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `auto` not checked in `enableMeaningHandler`           → "an owner's off is never turned back on…" fails
 *   `forgetMeaningIndexHandler` deleting an opted-out row   → "off deletes the index and keeps the row…" fails
 *   the probe limit removed (whole pages before proof)      → "before any index is serving, one workspace at a time" fails
 *   the storage release forgetting `optedOut`               → "a storage disconnect keeps an owner's off" fails
 *   `set` checking `editor` instead of `owner`              → "only the owner can switch it" fails
 */

import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  delete process.env.MEANING_SEARCH_ROLLOUT;
});

function deployment() {
  const t = setupTest();
  deployments.push(t);
  return t;
}

/** A workspace with its own owner (createWorkspace is rate-limited per owner), bound or not. */
async function workspace(t: TestConvex, slug: string, bound = true) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  if (bound) await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { owner, workspaceId };
}

const row = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query("meaningIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );

/** A row in `status`, as if an index had been set up for `workspaceId`. */
async function seedRow(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  fields: Partial<Doc<"meaningIndexes">> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("meaningIndexes", {
      workspaceId,
      enabled: true,
      enabledAt: 1,
      status: "ready",
      indexName: `context-meaning-${workspaceId}`,
      createdAt: 1,
      updatedAt: Date.now(),
      ...fields,
    });
  });
}

const sweep = (t: TestConvex) => t.mutation(internal.functions.meaningSearch.sweep, {});
const forget = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.mutation(internal.functions.meaningSearch.forgetIndex, { workspaceId });

describe("the rollout", () => {
  test("before any index is serving, one workspace at a time", async () => {
    const t = deployment();
    const a = await workspace(t, "probe-a");
    const b = await workspace(t, "probe-b");

    expect((await sweep(t)).started).toBe(1);
    const turnedOn = [await row(t, a.workspaceId), await row(t, b.workspaceId)].filter((r) => r !== null);
    expect(turnedOn).toHaveLength(1);
    expect(turnedOn[0]?.status).toBe("provisioning");
    expect(turnedOn[0]?.enabledBy).toBeUndefined();

    // The first is still being set up: nothing more until it proves the credential.
    expect((await sweep(t)).started).toBe(0);
    // A first index that failed holds the rollout too, rather than failing everyone.
    await t.run(async (ctx) => {
      await ctx.db.patch(turnedOn[0]!._id, { status: "failed", errorCode: "UNAUTHORIZED", updatedAt: Date.now() });
    });
    expect((await sweep(t)).started).toBe(0);
  });

  test("once an index is serving, every workspace with storage is turned on, and only those", async () => {
    const t = deployment();
    const proven = await workspace(t, "proven");
    await seedRow(t, proven.workspaceId, { status: "ready" });
    const bound = await workspace(t, "bound");
    const unbound = await workspace(t, "unbound", false);

    await sweep(t);
    expect((await row(t, bound.workspaceId))?.status).toBe("provisioning");
    expect(await row(t, unbound.workspaceId)).toBeNull();
    // The serving one is left exactly as it was.
    expect((await row(t, proven.workspaceId))?.status).toBe("ready");
  });

  test("an owner's off is never turned back on by the rollout", async () => {
    const t = deployment();
    const proven = await workspace(t, "proven-2");
    await seedRow(t, proven.workspaceId, { status: "ready" });
    const declined = await workspace(t, "declined");
    await asUser(t, declined.owner).mutation(api.functions.meaningSearch.set, {
      workspaceId: declined.workspaceId,
      on: false,
    });
    expect((await row(t, declined.workspaceId))?.status).toBe("off");

    for (let lap = 0; lap < 3; lap += 1) await sweep(t);
    expect((await row(t, declined.workspaceId))?.status).toBe("off");
    expect((await row(t, declined.workspaceId))?.enabled).toBe(false);
  });

  test("the brake stops it", async () => {
    const t = deployment();
    await workspace(t, "braked");
    process.env.MEANING_SEARCH_ROLLOUT = "disabled";
    expect((await sweep(t)).started).toBe(0);
  });
});

describe("the owner's switch", () => {
  test("off deletes the index and keeps the row, so it stays off; on builds it again", async () => {
    const t = deployment();
    const { owner, workspaceId } = await workspace(t, "switch");
    await seedRow(t, workspaceId, { status: "ready", notesIndexed: 12 });

    const off = await asUser(t, owner).mutation(api.functions.meaningSearch.set, { workspaceId, on: false });
    expect(off.state).toBe("off");
    expect((await row(t, workspaceId))?.status).toBe("releasing");

    // Cloudflare confirmed the delete.
    await forget(t, workspaceId);
    const kept = await row(t, workspaceId);
    expect(kept?.status).toBe("off");
    expect(kept?.indexName).toBeUndefined();
    expect(kept?.notesIndexed).toBeUndefined();

    const on = await asUser(t, owner).mutation(api.functions.meaningSearch.set, { workspaceId, on: true });
    expect(on.state).toBe("preparing");
    const back = await row(t, workspaceId);
    expect(back?.enabled).toBe(true);
    expect(back?.optedOut).toBeUndefined();
    expect(back?.enabledBy).toBe(owner);
  });

  test("only the owner can switch it, and only the owner sees the counts", async () => {
    const t = deployment();
    const { workspaceId } = await workspace(t, "roles");
    await seedRow(t, workspaceId, { status: "ready", notesIndexed: 40, notesPending: 2 });
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor");

    await expect(
      asUser(t, editor).mutation(api.functions.meaningSearch.set, { workspaceId, on: false }),
    ).rejects.toThrow();
    expect((await row(t, workspaceId))?.enabled).toBe(true);

    const seen = await asUser(t, editor).query(api.functions.meaningSearch.status, { workspaceId });
    expect(seen).toEqual({ state: "on", canChange: false, notesIndexed: undefined, notesPending: undefined });
  });

  test("a workspace the rollout has not reached reads as on, waiting", async () => {
    const t = deployment();
    const { owner, workspaceId } = await workspace(t, "not-yet");
    const seen = await asUser(t, owner).query(api.functions.meaningSearch.status, { workspaceId });
    expect(seen.state).toBe("waiting");
    expect(seen.canChange).toBe(true);
  });
});

describe("what storage and deletion leave behind", () => {
  test("a storage disconnect releases the index and lets the rollout come back", async () => {
    const t = deployment();
    const { workspaceId } = await workspace(t, "unplugged");
    await seedRow(t, workspaceId, { status: "ready" });
    await t.mutation(internal.functions.fastSearch.releaseForStorage, { workspaceId });
    expect((await row(t, workspaceId))?.status).toBe("releasing");
    await forget(t, workspaceId);
    expect(await row(t, workspaceId)).toBeNull();
  });

  test("a storage disconnect keeps an owner's off", async () => {
    const t = deployment();
    const { workspaceId } = await workspace(t, "disconnect-off");
    await seedRow(t, workspaceId, { status: "releasing", enabled: false, optedOut: true });
    await t.mutation(internal.functions.fastSearch.releaseForStorage, { workspaceId });
    await forget(t, workspaceId);
    expect((await row(t, workspaceId))?.status).toBe("off");
  });

  test("a deleted workspace keeps nothing, even an owner's off", async () => {
    const t = deployment();
    const { workspaceId } = await workspace(t, "deleted");
    await seedRow(t, workspaceId, { status: "releasing", enabled: false, optedOut: true });
    await t.mutation(internal.functions.meaningSearch.disable, { workspaceId });
    await forget(t, workspaceId);
    expect(await row(t, workspaceId)).toBeNull();
  });
});
