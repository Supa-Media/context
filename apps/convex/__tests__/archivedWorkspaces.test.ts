/**
 * Archived accounts' workspaces are left out of the background rounds
 * (`functions/lib/archivedWorkspaces.ts`; the owner, 2026-10-14: "can we stop
 * trying to index/backfill/migrate testagent1's stuff, its archived
 * already"): the tree round and Start all / Check all, the facts fill, the
 * fast search and meaning rollouts, and the meaning sweep and Restart all.
 * A shared workspace a live person still belongs to keeps every round.
 *
 * Sabotage: make `workspaceArchived` return false and every "skips" case
 * below fails; make it ignore members and the shared-workspace case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { workspaceArchived } from "../functions/lib/archivedWorkspaces";
import { addMember, createUser, createWorkspace, seedStorageBinding, setupTest, type TestConvex } from "./fixtures.helpers";

const ADMIN = "staff@example.test";
const deployments: TestConvex[] = [];
let previousAdmins: string | undefined;

beforeEach(() => {
  previousAdmins = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  if (previousAdmins === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previousAdmins;
});

function deployment() {
  const t = setupTest();
  deployments.push(t);
  return t;
}

async function workspace(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { owner, workspaceId };
}

async function archive(t: TestConvex, userId: Id<"users">) {
  const by = await createUser(t, `archiver-${userId}@example.invalid`);
  await t.run(async (ctx) => {
    await ctx.db.insert("archivedAccounts", { userId, archivedBy: by, archivedAt: Date.now() });
  });
}

const archived = (t: TestConvex, workspaceId: Id<"workspaces">) => t.run((ctx) => workspaceArchived(ctx.db, workspaceId));

/** The workspaces scheduled work names, for one kind of file operation or one function. */
async function scheduledFor(t: TestConvex, match: (name: string, kind: string | undefined) => boolean) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.state.kind === "pending")
      .filter((job) => match(job.name, (job.args[0] as { operation?: { kind?: string } })?.operation?.kind))
      .map((job) => (job.args[0] as { workspaceId: Id<"workspaces"> }).workspaceId),
  );
}

describe("which workspaces are archived", () => {
  test("only those whose creator and every member are archived", async () => {
    const t = deployment();
    const live = await workspace(t, "live-one");
    const gone = await workspace(t, "gone-one");
    const joined = await workspace(t, "joined-one");
    const friend = await createUser(t, "friend@example.invalid");
    await addMember(t, joined.workspaceId, friend, "editor", joined.owner);
    await archive(t, gone.owner);
    await archive(t, joined.owner);

    expect(await archived(t, live.workspaceId)).toBe(false);
    expect(await archived(t, gone.workspaceId)).toBe(true);
    // Real people still use it.
    expect(await archived(t, joined.workspaceId)).toBe(false);
    await archive(t, friend);
    expect(await archived(t, joined.workspaceId)).toBe(true);
  });
});

describe("search by meaning", () => {
  async function seedMeaning(t: TestConvex, workspaceId: Id<"workspaces">, status: "backfilling" | "failed") {
    await t.run(async (ctx) => {
      await ctx.db.insert("meaningIndexes", {
        workspaceId,
        enabled: true,
        enabledAt: 1,
        status,
        indexName: `context-meaning-${workspaceId}`,
        ...(status === "failed" ? { errorCode: "UNAVAILABLE" } : {}),
        createdAt: 1,
        updatedAt: 1,
      });
    });
  }

  test("the sweep and Restart all leave an archived workspace where it stopped; the report marks it", async () => {
    const t = deployment();
    const staff = t.withIdentity({ subject: await createUser(t, ADMIN) });
    process.env.MEANING_SEARCH_ROLLOUT = "disabled";
    try {
      const live = await workspace(t, "meaning-live");
      const gone = await workspace(t, "meaning-gone");
      const goneFailed = await workspace(t, "meaning-gone-failed");
      await archive(t, gone.owner);
      await archive(t, goneFailed.owner);
      await seedMeaning(t, live.workspaceId, "backfilling");
      await seedMeaning(t, gone.workspaceId, "backfilling");
      await seedMeaning(t, goneFailed.workspaceId, "failed");

      expect((await t.mutation(internal.functions.meaningSearch.sweep, {})).started).toBe(1);
      expect(await scheduledFor(t, (_, kind) => kind === "projectMeaning")).toEqual([live.workspaceId]);
      expect(await scheduledFor(t, (name) => name.includes("provisionMeaningIndex"))).toEqual([]);

      expect((await staff.mutation(api.functions.meaningAdmin.restartMeaningIndexing, {})).restarted).toBe(1);
      const report = await staff.query(api.functions.meaningAdmin.meaningIndexReport, {});
      const bySlug = Object.fromEntries(report.rows.map((row) => [row.slug, row]));
      expect(bySlug["meaning-gone"]?.archived).toBe(true);
      expect(bySlug["meaning-gone-failed"]).toMatchObject({ archived: true, status: "failed" });
      expect(bySlug["meaning-live"]?.archived).toBe(false);
    } finally {
      delete process.env.MEANING_SEARCH_ROLLOUT;
    }
  });

  test("the rollout never turns it on for an archived workspace", async () => {
    const t = deployment();
    const gone = await workspace(t, "rollout-gone");
    await archive(t, gone.owner);
    await t.mutation(internal.functions.meaningSearch.sweep, {});
    const row = await t.run((ctx) =>
      ctx.db.query("meaningIndexes").withIndex("by_workspace", (q) => q.eq("workspaceId", gone.workspaceId)).unique(),
    );
    expect(row).toBeNull();
  });
});

describe("fast search", () => {
  test("the rollout never turns it on for an archived workspace", async () => {
    const t = deployment();
    const gone = await workspace(t, "fast-gone");
    const live = await workspace(t, "fast-live");
    await archive(t, gone.owner);
    await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});
    const rowOf = (workspaceId: Id<"workspaces">) =>
      t.run((ctx) => ctx.db.query("searchIndexes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique());
    expect(await rowOf(gone.workspaceId)).toBeNull();
    expect(await rowOf(live.workspaceId)).not.toBeNull();
  });
});
