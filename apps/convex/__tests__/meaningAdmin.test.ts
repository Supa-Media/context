/**
 * The admin console's search-by-meaning panel: what staff see, and Restart.
 *
 * "Make sure I can restart indexing from admin tab" (the owner, 2026-10-07),
 * after the first rollout left every workspace larger than one pass `failed`
 * with a code nobody could read and a six-hour wait before the sweep tried
 * again.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `restartMeaningIndex` restarting an owner's off           → "an owner's off is never restarted" fails
 *   the restart patching `enabledAt` (a new generation)       → "a failed row goes back through the provisioner…" fails
 *   `restartStuckMeaningIndexes` reading statuses one by one  → "restart everything stuck…" fails (provisioner twice)
 *   `requireAdmin` dropped from `meaningIndexReport`          → "only staff…" fails
 *   `cleanPriorities` returning its input                     → "counts per indexing priority…" fails
 */

import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { FAST_SEARCH_GENERATION } from "../functions/lib/fastSearch";
import { asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

const ADMIN = "staff@example.invalid";
const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  delete process.env[ADMIN_EMAILS_ENV_VAR];
});

async function world() {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const t = setupTest();
  deployments.push(t);
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
  return { t, staff, ada, adaWs };
}

async function seedRow(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  fields: Partial<Doc<"meaningIndexes">> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("meaningIndexes", {
      workspaceId,
      enabled: true,
      enabledAt: 1_700_000_000_000,
      status: "failed",
      indexName: `context-meaning-${workspaceId}`,
      errorCode: "REFUSED",
      errorCause: "http_400",
      error: "Cloudflare refused the meaning index request.",
      notesIndexed: 40,
      notesPending: 700,
      createdAt: 1,
      updatedAt: 1,
      ...fields,
    });
  });
}

const rowOf = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("meaningIndexes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );

const queued = (t: TestConvex, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.state.kind === "pending" && job.name.includes(name),
    ),
  );

describe("the indexing panel", () => {
  test("only staff can read it or restart anything", async () => {
    const { t, ada, adaWs } = await world();
    await seedRow(t, adaWs);
    await expect(asUser(t, ada).query(api.functions.meaningAdmin.meaningIndexReport, {})).rejects.toThrow();
    await expect(
      asUser(t, ada).mutation(api.functions.meaningAdmin.restartMeaningIndexing, { workspaceId: adaWs }),
    ).rejects.toThrow();
    expect((await rowOf(t, adaWs))?.status).toBe("failed");
  });

  test("shows each workspace's status, our code and cause, and counts, failed first", async () => {
    const { t, staff, adaWs } = await world();
    const bo = await createUser(t, "bo@example.invalid");
    const boWs = await createWorkspace(t, bo, "bo", { kind: "personal" });
    await seedRow(t, boWs, { status: "ready", errorCode: undefined, errorCause: undefined, notesPending: 0 });
    await seedRow(t, adaWs);
    const report = await asUser(t, staff).query(api.functions.meaningAdmin.meaningIndexReport, {});
    expect(report.truncated).toBe(false);
    expect(report.rows.map((row) => [row.slug, row.status])).toEqual([
      ["ada", "failed"],
      ["bo", "ready"],
    ]);
    expect(report.rows[0]).toMatchObject({
      errorCode: "REFUSED",
      errorCause: "http_400",
      notesIndexed: 40,
      notesPending: 700,
      kind: "personal",
    });
    // Our words only: the operator sentence and the index name stay on the row.
    expect(Object.keys(report.rows[0]).sort()).toEqual(
      ["enabled", "errorCause", "errorCode", "fastSearch", "kind", "notesIndexed", "notesPending", "priorities", "slug", "status", "updatedAt", "workspaceId"].sort(),
    );
  });

  test("counts per indexing priority, for search by meaning and the fast index, as the passes report them", async () => {
    const { t, staff, adaWs } = await world();
    await seedRow(t, adaWs, { status: "backfilling", errorCode: undefined, errorCause: undefined });
    await t.run(async (ctx) => {
      await ctx.db.insert("searchIndexes", {
        workspaceId: adaWs,
        generation: FAST_SEARCH_GENERATION,
        optedIn: true,
        optedInAt: 1,
        status: "backfilling",
        databaseId: "db-ada",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const priorities = [
      { priority: 1, indexed: 300, pending: 0 },
      { priority: 2, indexed: 12, pending: 30 },
      { priority: 3, indexed: 0, pending: 900 },
    ];
    await t.mutation(internal.functions.meaningSearch.recordProgress, {
      workspaceId: adaWs,
      notesIndexed: 312,
      notesPending: 930,
      priorities,
      ready: false,
    });
    // A fractional or duplicated entry is cleaned on the way in.
    await t.mutation(internal.functions.fastSearch.recordProjectionProgress, {
      workspaceId: adaWs,
      notesIndexed: 312,
      notesPending: 930,
      priorities: [...priorities, { priority: 1, indexed: 5, pending: 5 }, { priority: 7, indexed: 1, pending: 1 }].map(
        (entry) => ({ ...entry, pending: entry.pending + 0.4 }),
      ),
      ready: false,
    });
    const [row] = (await asUser(t, staff).query(api.functions.meaningAdmin.meaningIndexReport, {})).rows;
    expect(row.priorities).toEqual(priorities);
    expect(row.fastSearch).toEqual({ status: "backfilling", notesIndexed: 312, notesPending: 930, priorities });

    // A report without them (the gateway's) keeps the last ones.
    await t.mutation(internal.functions.meaningSearch.recordProgress, {
      workspaceId: adaWs,
      notesIndexed: 320,
      notesPending: 922,
      ready: false,
    });
    expect((await rowOf(t, adaWs))?.priorities).toEqual(priorities);
  });
});

describe("Restart", () => {
  test("a failed row goes back through the provisioner and keeps its generation", async () => {
    const { t, staff, adaWs } = await world();
    await seedRow(t, adaWs);
    const result = await asUser(t, staff).mutation(api.functions.meaningAdmin.restartMeaningIndexing, { workspaceId: adaWs });
    expect(result).toEqual({ restarted: 1, outcome: "restarted" });
    const row = await rowOf(t, adaWs);
    expect(row?.status).toBe("provisioning");
    expect(row?.errorCode).toBeUndefined();
    expect(row?.errorCause).toBeUndefined();
    // The same generation, so the map in the bucket still counts and the walk resumes.
    expect(row?.enabledAt).toBe(1_700_000_000_000);
    expect(await queued(t, "provisionMeaningIndex")).toHaveLength(1);
    const audit = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    expect(audit.map((event) => event.action)).toEqual(["search.meaning_restarted"]);
  });

  test("a stalled walk is started again where it stopped", async () => {
    const { t, staff, adaWs } = await world();
    await seedRow(t, adaWs, { status: "backfilling", errorCode: undefined, errorCause: undefined });
    await asUser(t, staff).mutation(api.functions.meaningAdmin.restartMeaningIndexing, { workspaceId: adaWs });
    expect((await rowOf(t, adaWs))?.status).toBe("backfilling");
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("an owner's off is never restarted", async () => {
    const { t, staff, adaWs } = await world();
    await seedRow(t, adaWs, { enabled: false, optedOut: true, status: "off", errorCode: undefined });
    const result = await asUser(t, staff).mutation(api.functions.meaningAdmin.restartMeaningIndexing, { workspaceId: adaWs });
    expect(result).toEqual({ restarted: 0, outcome: "turnedOff" });
    expect((await rowOf(t, adaWs))?.status).toBe("off");
    expect(await queued(t, "provisionMeaningIndex")).toHaveLength(0);
  });

  test("a workspace not reached yet is turned on the way the rollout would", async () => {
    const { t, staff, adaWs } = await world();
    await asUser(t, staff).mutation(api.functions.meaningAdmin.restartMeaningIndexing, { workspaceId: adaWs });
    const row = await rowOf(t, adaWs);
    expect(row?.status).toBe("provisioning");
    expect(row?.enabledBy).toBeUndefined();
    expect(await queued(t, "provisionMeaningIndex")).toHaveLength(1);
  });

  test("restart everything stuck: each failed or filling row once, nothing else", async () => {
    const { t, staff, adaWs } = await world();
    const names = ["bo", "cy", "di"] as const;
    const ids: Id<"workspaces">[] = [];
    for (const name of names) {
      const owner = await createUser(t, `${name}@example.invalid`);
      ids.push(await createWorkspace(t, owner, name, { kind: "personal" }));
    }
    await seedRow(t, adaWs);
    await seedRow(t, ids[0]!, { status: "backfilling", errorCode: undefined });
    await seedRow(t, ids[1]!, { status: "ready", errorCode: undefined });
    await seedRow(t, ids[2]!, { enabled: false, optedOut: true, status: "off", errorCode: undefined });
    const result = await asUser(t, staff).mutation(api.functions.meaningAdmin.restartMeaningIndexing, {});
    expect(result.restarted).toBe(2);
    expect(await queued(t, "provisionMeaningIndex")).toHaveLength(1);
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
    expect((await rowOf(t, ids[2]!))?.status).toBe("off");
  });
});
