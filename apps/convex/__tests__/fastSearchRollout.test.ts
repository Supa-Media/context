/**
 * Fast search "on for everyone", and the owner's switch.
 *
 * The owner decided on 2026-10-08 ("lets do fast search for all") that every
 * workspace gets the fast index, free plan included, and the owner can still
 * switch it off. What is asserted: the rollout reaches every workspace with
 * storage a few at a time, never turns back on what an owner turned off, and
 * a storage disconnect or a deleted workspace leaves the right thing behind.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `autoEnableHandler` not checking for an existing row → "an owner's off is never turned back on…" fails
 *   `forgetIndexHandler` deleting an opted-out row        → "off deletes the database and keeps the row…" fails
 *   the in-flight count ignored                           → "a few at a time…" and "recent failures…" fail
 *   `releaseForStorage` ignoring `optedOut`               → "a storage disconnect keeps an owner's off" fails
 */

import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FAST_SEARCH_GENERATION } from "../functions/lib/fastSearch";
import { FAST_SEARCH_ROLLOUT_IN_FLIGHT } from "../functions/lib/fastSearchFns/rollout";
import {
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
  delete process.env.FAST_SEARCH_ROLLOUT;
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
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );

async function seedRow(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  fields: Partial<Doc<"searchIndexes">> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("searchIndexes", {
      workspaceId,
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      optedInAt: 1,
      status: "ready",
      databaseId: `db-${workspaceId}`,
      createdAt: 1,
      updatedAt: Date.now(),
      ...fields,
    });
  });
}

const sweep = (t: TestConvex) => t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});
const forget = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.mutation(internal.functions.fastSearch.forgetIndex, { workspaceId });

describe("the rollout", () => {
  test("every workspace with storage is turned on, free plan included, and only those", async () => {
    const t = deployment();
    const bound = await workspace(t, "bound");
    const unbound = await workspace(t, "unbound", false);

    expect((await sweep(t)).started).toBe(1);
    const turnedOn = await row(t, bound.workspaceId);
    expect(turnedOn?.status).toBe("provisioning");
    expect(turnedOn?.optedIn).toBe(true);
    expect(turnedOn?.optedInBy).toBeUndefined();
    expect(await row(t, unbound.workspaceId)).toBeNull();

    // The owner's screen calls it on its way, and the owner can still switch it.
    const seen = await asUser(t, bound.owner).query(api.functions.fastSearch.status, {
      workspaceId: bound.workspaceId,
    });
    expect(seen.state).toBe("preparing");
    expect(seen.canChange).toBe(true);
  });

  test("a few at a time: indexes being built hold the walk back", async () => {
    const t = deployment();
    const spaces = [];
    for (let i = 0; i < FAST_SEARCH_ROLLOUT_IN_FLIGHT + 2; i += 1) spaces.push(await workspace(t, `many-${i}`));

    expect((await sweep(t)).started).toBe(FAST_SEARCH_ROLLOUT_IN_FLIGHT);
    // All still provisioning: nothing more.
    expect((await sweep(t)).started).toBe(0);

    // One finishes; one more may start.
    const first = (await Promise.all(spaces.map((s) => row(t, s.workspaceId)))).find((r) => r !== null)!;
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { status: "ready", databaseId: "db-done" });
    });
    expect((await sweep(t)).started).toBe(1);
  });

  test("recent failures hold the walk back, so a broken credential fails a handful, not everyone", async () => {
    const t = deployment();
    for (let i = 0; i < FAST_SEARCH_ROLLOUT_IN_FLIGHT; i += 1) {
      const failed = await workspace(t, `failed-${i}`);
      await seedRow(t, failed.workspaceId, { status: "failed", errorCode: "UNAUTHORIZED", databaseId: undefined });
    }
    const waiting = await workspace(t, "waiting");
    await sweep(t);
    expect(await row(t, waiting.workspaceId)).toBeNull();
  });

  test("an owner's off is never turned back on by the rollout", async () => {
    const t = deployment();
    const declined = await workspace(t, "declined");
    // Off before the rollout ever reached it.
    const off = await asUser(t, declined.owner).mutation(api.functions.fastSearch.disable, {
      workspaceId: declined.workspaceId,
    });
    expect(off.state).toBe("off");
    expect((await row(t, declined.workspaceId))?.status).toBe("off");

    for (let lap = 0; lap < 3; lap += 1) await sweep(t);
    const kept = await row(t, declined.workspaceId);
    expect(kept?.status).toBe("off");
    expect(kept?.optedIn).toBe(false);
    expect(kept?.optedOut).toBe(true);
  });

  test("the brake stops it", async () => {
    const t = deployment();
    const braked = await workspace(t, "braked");
    process.env.FAST_SEARCH_ROLLOUT = "disabled";
    await sweep(t);
    expect(await row(t, braked.workspaceId)).toBeNull();
  });
});

describe("the owner's switch", () => {
  test("off deletes the database and keeps the row, so it stays off; on builds it again", async () => {
    const t = deployment();
    const { owner, workspaceId } = await workspace(t, "switch");
    await seedRow(t, workspaceId, { status: "ready", notesIndexed: 12, notesPending: 0 });

    await asUser(t, owner).mutation(api.functions.fastSearch.disable, { workspaceId });
    expect((await row(t, workspaceId))?.status).toBe("releasing");

    // Cloudflare confirmed the delete.
    await forget(t, workspaceId);
    const kept = await row(t, workspaceId);
    expect(kept?.status).toBe("off");
    expect(kept?.databaseId).toBeUndefined();
    expect(kept?.notesIndexed).toBeUndefined();

    await sweep(t);
    expect((await row(t, workspaceId))?.status).toBe("off");

    const on = await asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId });
    expect(on.state).toBe("preparing");
    const back = await row(t, workspaceId);
    expect(back?.optedIn).toBe(true);
    expect(back?.optedOut).toBeUndefined();
    expect(back?.optedInBy).toBe(owner);
  });

  test("a storage disconnect keeps an owner's off, and drops a row Context made", async () => {
    const t = deployment();
    const declined = await workspace(t, "declined-storage");
    await asUser(t, declined.owner).mutation(api.functions.fastSearch.disable, {
      workspaceId: declined.workspaceId,
    });
    await t.mutation(internal.functions.fastSearch.releaseForStorage, { workspaceId: declined.workspaceId });
    expect((await row(t, declined.workspaceId))?.status).toBe("off");

    const auto = await workspace(t, "auto-storage");
    await sweep(t);
    expect((await row(t, auto.workspaceId))?.status).toBe("provisioning");
    await t.mutation(internal.functions.fastSearch.releaseForStorage, { workspaceId: auto.workspaceId });
    // Nothing was created yet, so the row goes and a reconnect is picked up again.
    expect(await row(t, auto.workspaceId)).toBeNull();
  });

  test("a storage release of a built index ends with no row, so a reconnect is picked up", async () => {
    const t = deployment();
    const { workspaceId } = await workspace(t, "built-storage");
    await seedRow(t, workspaceId, { status: "ready" });
    await t.mutation(internal.functions.fastSearch.releaseForStorage, { workspaceId });
    expect((await row(t, workspaceId))?.status).toBe("releasing");
    await forget(t, workspaceId);
    expect(await row(t, workspaceId)).toBeNull();
  });

  test("an opted-in legacy row is replaced by the owner's switch and by the rollout", async () => {
    // A legacy row that says `optedIn: true` never serves, so it reads "off".
    // Neither the owner's switch nor "on for everyone" may treat it as on.
    for (const via of ["owner", "rollout"] as const) {
      const t = setupTest();
      const { owner, workspaceId } = await workspace(t, `legacy-on-${via}`);
      await t.run((ctx) =>
        ctx.db.insert("searchIndexes", {
          workspaceId,
          optedIn: true,
          optedInBy: owner,
          optedInAt: 1,
          status: "ready",
          databaseId: "legacy-database-must-not-serve",
          createdAt: 1,
          updatedAt: 1,
        }),
      );
      if (via === "owner") {
        const result = await asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId });
        expect(result.state).toBe("preparing");
      } else {
        expect(
          (await t.mutation(internal.functions.fastSearch.autoEnable, { workspaceId })).scheduled,
        ).toBe(true);
      }
      const legacyRow = await row(t, workspaceId);
      expect(legacyRow?.generation).toBe(FAST_SEARCH_GENERATION);
      expect(legacyRow?.status).toBe("provisioning");
      expect(legacyRow?.databaseId).toBeUndefined();
    }
  });
});
