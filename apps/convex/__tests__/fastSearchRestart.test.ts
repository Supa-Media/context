/**
 * Staff's Restart for fast search, and the sweep that no longer starves.
 *
 * After Seal again made @segunawe's last two notes readable (2026-10-14),
 * search by meaning finished on its Restart while fast search sat on
 * "Indexing 4 of 6": its copy chain had stopped on links that moved nothing,
 * only the fifteen-minute sweep picks one up again, and admin had no button.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `restartFastSearchIndex` ignoring the projection lease     → "a pass still running is left to finish" fails
 *   the restart turning on a row that is opted out             → "a copy that is off stays off" fails
 *   the sweep back on `.take(SWEEP_BATCH)` of backfilling rows → "rows the sweep passes over do not starve…" fails
 *   `requireAdmin` dropped from `restartFastSearch`            → "only staff…" fails
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { asUser, createUser, createWorkspace } from "./fixtures.helpers";
import { cancelPendingJobs, opted, queued, row } from "./searchBackfill.trigger.helpers";

const ADMIN = "staff@example.invalid";

afterEach(async () => {
  await cancelPendingJobs();
  vi.unstubAllGlobals();
  delete process.env[ADMIN_EMAILS_ENV_VAR];
});

async function world(options: Parameters<typeof opted>[0] = {}) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const made = await opted(options);
  const staff = await createUser(made.t, ADMIN);
  const restart = () =>
    asUser(made.t, staff).mutation(api.functions.meaningAdmin.restartFastSearch, { workspaceId: made.workspaceId });
  return { ...made, staff, restart };
}

async function patchRow(
  t: Awaited<ReturnType<typeof opted>>["t"],
  workspaceId: Awaited<ReturnType<typeof opted>>["workspaceId"],
  fields: Record<string, unknown>,
) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("searchIndexes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    await ctx.db.patch(existing!._id, fields);
  });
}

describe("Restart for fast search", () => {
  test("only staff can restart a copy", async () => {
    const { t, workspaceId, owner } = await world();
    await expect(
      asUser(t, owner).mutation(api.functions.meaningAdmin.restartFastSearch, { workspaceId }),
    ).rejects.toThrow();
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a copy whose chain stopped starts again from its cursor now, and staff's act is recorded", async () => {
    const { t, workspaceId, restart } = await world();
    const stale = Date.now() - 60_000;
    await patchRow(t, workspaceId, { chainedAt: stale, notesIndexed: 4, notesPending: 2 });

    expect(await restart()).toEqual({ restarted: 1, outcome: "restarted" });

    const jobs = await queued(t, "runFileOperation");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.args[0].operation.kind).toBe("projectIndex");
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("backfilling");
    // Counters kept, and the heartbeat moved so the sweep does not start a second.
    expect(after?.notesIndexed).toBe(4);
    expect(after!.chainedAt!).toBeGreaterThan(stale);
    const audit = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    expect(audit.map((event) => event.action)).toContain("search.fast_restarted");
  });

  test("a pass still running is left to finish", async () => {
    const { t, workspaceId, restart } = await world();
    await patchRow(t, workspaceId, { projectionLease: { token: "busy", until: Date.now() + 60_000 } });

    expect(await restart()).toEqual({ restarted: 0, outcome: "running" });
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a failure waiting cannot fix is resumed when staff press it, counters kept", async () => {
    const { t, workspaceId, restart } = await world({ status: "failed" });
    await patchRow(t, workspaceId, { errorCode: "REFUSED", error: "Refused.", notesIndexed: 4 });

    expect((await restart()).outcome).toBe("restarted");

    const after = await row(t, workspaceId);
    expect(after?.status).toBe("backfilling");
    expect(after?.errorCode).toBeUndefined();
    expect(after?.notesIndexed).toBe(4);
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("a copy that is off stays off", async () => {
    const { t, restart } = await world({ optedIn: false });
    expect((await restart()).outcome).toBe("off");
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a ready copy has nothing to restart", async () => {
    const { t, restart } = await world({ status: "ready" });
    expect((await restart()).outcome).toBe("ready");
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });
});

describe("the fifteen-minute sweep", () => {
  test("rows the sweep passes over do not starve the stalled row behind them", async () => {
    const { t, workspaceId, owner } = await opted();
    const other = await createWorkspace(t, owner, "other-notes");
    const longAgo = Date.now() - 86_400_000;
    await t.run(async (ctx) => {
      const mine = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      const { _id, _creationTime, ...fields } = mine!;
      await ctx.db.delete(_id);
      // Sixty rows ahead of it in the status index that the sweep skips
      // every time, as an archived workspace's row is.
      for (let n = 0; n < 60; n += 1) {
        await ctx.db.insert("searchIndexes", { ...fields, workspaceId: other, optedIn: false, chainedAt: longAgo });
      }
      await ctx.db.insert("searchIndexes", { ...fields, chainedAt: longAgo });
    });

    await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    const jobs = await queued(t, "runFileOperation");
    expect(jobs.map((job) => job.args[0].workspaceId)).toContain(workspaceId);
  });
});
