/**
 * The staff console's storage page (`functions/adminStorage.ts`): where every
 * workspace's notes are read from, and the one move per workspace that the
 * "Workspace objects home" workflow makes by hand (decided by the owner,
 * 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * The move never skips parity: `object` is refused unless the workspace was
 * backfilled and its last parity check was clean, and the refusal's reason is
 * handed back as it was given. A move is one row (`storageMoves`) the report
 * reads; a second request is refused while it runs, a stopped one resumes from
 * its cursor, and an incomplete copy says so.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";

import { MOVE_STALE_MS } from "../functions/adminStorageRules";
import { asUser, createUser, type TestConvex } from "./fixtures.helpers";
import { withSession } from "./session.helpers";
import { world } from "./workspaceObjectWorld.helpers";

const ADMIN = "staff@supa.media";

afterEach(() => {
  delete process.env[ADMIN_EMAILS_ENV_VAR];
});

async function seedStaff(t: TestConvex) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const userId = await t.run(
    async (ctx) =>
      await ctx.db.insert("users", {
        email: ADMIN,
        emailVerificationTime: Date.now(),
      } as never),
  );
  return { userId, as: withSession(t, userId) };
}

async function seedWorkspace(
  t: TestConvex,
  slug: string,
  kind: "personal" | "shared",
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    return await ctx.db.insert("workspaces", {
      slug,
      displayName: slug,
      createdBy: userId,
      kind,
      structureTemplate: "para",
      createdAt: 1,
      updatedAt: 1,
    } as never);
  });
}

async function moveRows(t: TestConvex) {
  const rows = await t.run(
    async (ctx) =>
      await ctx.db.query("adminAuditEvents").withIndex("by_at").collect(),
  );
  return rows.filter((row) => row.action === "storage.home_set");
}

/** The queued `runMove` steps, taken off the schedule so the test runs each one itself (see `drain`). */
async function takeQueuedMoves(t: TestConvex) {
  return await t.run(async (ctx) => {
    const jobs = (
      await ctx.db.system.query("_scheduled_functions").collect()
    ).filter(
      (job) =>
        job.name.includes("adminStorage:runMove") &&
        job.state.kind === "pending",
    );
    for (const job of jobs) await ctx.scheduler.cancel(job._id);
    return jobs.map((job) => job.args[0] as Record<string, unknown>);
  });
}

/**
 * Runs queued steps until none is left. Each step hands on by scheduling the next, which the next round takes;
 * a direct run reaches the workspace object's door, as the other object tests call their actions.
 */
async function drain(t: TestConvex) {
  for (let round = 0; round < 20; round++) {
    const steps = await takeQueuedMoves(t);
    if (steps.length === 0) return;
    for (const args of steps)
      await t.action(internal.functions.adminStorage.runMove, args as never);
  }
  throw new Error("the move did not finish");
}

/** Asks for a move as staff, then runs it to its outcome. */
async function move(
  t: TestConvex,
  as: ReturnType<typeof withSession>,
  workspaceId: Id<"workspaces">,
  to: "dual" | "object",
) {
  await as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
    workspaceId,
    to,
  });
  await drain(t);
}

const homeOf = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId });

const moveRow = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query("storageMoves")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );

/** Records a copy that finished clean, as a page that found nothing held back would. Used where a test needs a finished copy. */
async function finishCopy(t: TestConvex, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("storageMoves")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (row === null) throw new Error("no move to finish");
    await ctx.db.patch(row._id, {
      state: "done",
      gaps: false,
      cursor: undefined,
    });
  });
}

/** A row as a killed run leaves it: running, its last heartbeat `ageMs` ago. */
async function seedKilledMove(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  fields: { ageMs: number; cursor?: string; gaps: boolean },
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    const home = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (home === null)
      await ctx.db.insert("workspaceObjectHomes", {
        workspaceId,
        home: "dual",
        since: 1,
      });
    await ctx.db.insert("storageMoves", {
      workspaceId,
      to: "dual",
      state: "running",
      startedAt: now - fields.ageMs - 60_000,
      heartbeatAt: now - fields.ageMs,
      gaps: fields.gaps,
      ...(fields.cursor === undefined ? {} : { cursor: fields.cursor }),
    });
  });
}

/** A backfill cursor with nothing left to copy: the page it resumes into finishes at once. */
const EXHAUSTED_CURSOR = JSON.stringify({
  page: null,
  queue: [],
  exhausted: true,
});

describe("the storage page refuses everyone who is not staff", () => {
  test("a signed-out caller and an ordinary member are both refused, and a move changes nothing", async () => {
    const w = await world();
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    await expect(
      w.t.query(api.functions.adminStorage.storageReport, {}),
    ).rejects.toThrow();
    await expect(
      w.t.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "dual",
      }),
    ).rejects.toThrow();
    const member = await createUser(w.t, "member@example.com");
    await expect(
      asUser(w.t, member).query(api.functions.adminStorage.storageReport, {}),
    ).rejects.toThrow();
    await expect(
      asUser(w.t, member).mutation(
        api.functions.adminStorage.moveWorkspaceHome,
        { workspaceId: w.workspaceId, to: "dual" },
      ),
    ).rejects.toThrow();
    expect(await homeOf(w.t, w.workspaceId)).toBe("bucket");
    expect(await moveRows(w.t)).toEqual([]);
    expect(await takeQueuedMoves(w.t)).toEqual([]);
  });
});

describe("the storage report", () => {
  test("every workspace, sorted by slug, reads from its bucket unless its record says otherwise; counts add up", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedStaff(t);
    const zeta = await seedWorkspace(t, "zeta", "personal");
    const alpha = await seedWorkspace(t, "alpha", "shared");
    const mid = await seedWorkspace(t, "mid", "shared");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", {
        workspaceId: alpha,
        home: "dual",
        since: 5,
      });
      await ctx.db.insert("workspaceObjectHomes", {
        workspaceId: mid,
        home: "object",
        since: 7,
      });
    });

    const report = await as.query(api.functions.adminStorage.storageReport, {});
    expect(report.workspaces).toEqual([
      {
        workspaceId: alpha,
        slug: "alpha",
        kind: "shared",
        home: "dual",
        notes: null,
        notesFloor: false,
        since: 5,
        lastMove: null,
      },
      {
        workspaceId: mid,
        slug: "mid",
        kind: "shared",
        home: "object",
        notes: null,
        notesFloor: false,
        since: 7,
        lastMove: null,
      },
      {
        workspaceId: zeta,
        slug: "zeta",
        kind: "personal",
        home: "bucket",
        notes: null,
        notesFloor: false,
        since: null,
        lastMove: null,
      },
    ]);
    expect(report.counts).toEqual({ object: 1, dual: 1, bucket: 1, total: 3 });
    expect(report.truncated).toBe(false);
  });

  test("the notes column is the last walk's count, a floor when the walk was cut short, and null when nothing counted", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedStaff(t);
    const alpha = await seedWorkspace(t, "alpha", "shared");
    const beta = await seedWorkspace(t, "beta", "shared");
    const gamma = await seedWorkspace(t, "gamma", "shared");
    await t.run(async (ctx) => {
      const boundBy = (await ctx.db.insert("users", {})) as Id<"users">;
      const binding = (workspaceId: Id<"workspaces">) => ({
        workspaceId,
        provider: "r2" as const,
        bucket: "fake-bucket",
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        boundBy,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("storageBindings", { ...binding(alpha), noteCount: 1284, noteCountedAt: 2 });
      await ctx.db.insert("storageBindings", {
        ...binding(beta),
        noteCount: 5000,
        noteCountedAt: 2,
        noteCountTruncated: true,
      });
      await ctx.db.insert("storageBindings", binding(gamma));
    });
    const report = await as.query(api.functions.adminStorage.storageReport, {});
    expect(report.workspaces.map((w) => [w.slug, w.notes, w.notesFloor])).toEqual([
      ["alpha", 1284, false],
      ["beta", 5000, true],
      ["gamma", null, false],
    ]);
  });

  test("the last move comes from the move rows, not the audit log, and a running row past its heartbeat is stale", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedStaff(t);
    const alpha = await seedWorkspace(t, "alpha", "shared");
    const mid = await seedWorkspace(t, "mid", "shared");
    const now = Date.now();
    await t.run(async (ctx) => {
      // An audit row with no move row is not a move: the report must not read the audit log for it.
      await ctx.db.insert("adminAuditEvents", {
        actorUserId: (await ctx.db.insert("users", {})) as Id<"users">,
        actorEmail: ADMIN,
        action: "storage.home_set",
        subject: "alpha",
        at: now,
        details: { to: "dual", state: "done" },
      });
      await ctx.db.insert("storageMoves", {
        workspaceId: mid,
        to: "dual",
        state: "running",
        startedAt: now - MOVE_STALE_MS - 60_000,
        heartbeatAt: now - MOVE_STALE_MS - 60_000,
        gaps: false,
      });
    });
    const report = await as.query(api.functions.adminStorage.storageReport, {});
    expect(
      report.workspaces.find((w) => w.slug === "alpha")?.lastMove,
    ).toBeNull();
    expect(
      report.workspaces.find((w) => w.slug === "mid")?.lastMove,
    ).toMatchObject({
      to: "dual",
      state: "stale",
      reason: null,
    });
    expect(alpha).toBeDefined();
  });
});

describe("moving one workspace's home", () => {
  // convex-test runs a scheduled step on a timer: faked, a step runs only when `drain` runs it.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a move is queued and audited as started; the report shows it running", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);

    expect(
      await as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "dual",
      }),
    ).toEqual({ queued: true });
    expect(await homeOf(w.t, w.workspaceId)).toBe("bucket");
    expect(await takeQueuedMoves(w.t)).toEqual([
      expect.objectContaining({
        workspaceId: w.workspaceId,
        slug: "object-push",
        to: "dual",
        switched: false,
      }),
    ]);
    expect(await moveRows(w.t)).toEqual([
      expect.objectContaining({
        actorEmail: ADMIN,
        subject: "object-push",
        details: { to: "dual", state: "started" },
      }),
    ]);
    expect(
      (await as.query(api.functions.adminStorage.storageReport, {}))
        .workspaces[0].lastMove,
    ).toMatchObject({ to: "dual", state: "running", reason: null });
  });

  test("a second request while a move runs is refused, and nothing is queued or audited twice", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
      workspaceId: w.workspaceId,
      to: "dual",
    });

    await expect(
      as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "dual",
      }),
    ).rejects.toThrow(/already running/);
    expect(await takeQueuedMoves(w.t)).toHaveLength(1);
    expect(await moveRows(w.t)).toHaveLength(1);
  });

  test("a move out of stage is refused with the reason, and changes nothing", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);

    // bucket -> object: the copy comes first.
    await expect(
      as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "object",
      }),
    ).rejects.toThrow("Copy @object-push first");

    // Already on the object: nothing further moves.
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", {
        workspaceId: w.workspaceId,
        home: "object",
        since: 1,
      });
    });
    await expect(
      as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "dual",
      }),
    ).rejects.toThrow("already on its object");
    await expect(
      as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "object",
      }),
    ).rejects.toThrow("already on its object");

    expect(await homeOf(w.t, w.workspaceId)).toBe("object");
    expect(await takeQueuedMoves(w.t)).toEqual([]);
    expect(await moveRows(w.t)).toEqual([]);
  });

  test("bucket to dual arms the workspace, its reads stay on the bucket, and a copy with nothing to read is incomplete", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);

    await move(w.t, as, w.workspaceId, "dual");

    expect(await homeOf(w.t, w.workspaceId)).toBe("dual");
    expect(w.ops()).toContain("ws.home");
    // This fixture binds no bucket, so the copy has nothing to read and says it did not finish.
    expect((await moveRows(w.t)).map((row) => row.details)).toContainEqual({
      to: "dual",
      state: "incomplete",
      copied: false,
    });
    expect(
      (
        await as.query(api.functions.adminStorage.storageReport, {})
      ).workspaces.find((row) => row.slug === "object-push")?.lastMove,
    ).toMatchObject({ to: "dual", state: "incomplete", reason: null });
  });

  test("an incomplete copy is copied again, not switched: the object is refused until a copy finishes", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await move(w.t, as, w.workspaceId, "dual");

    await expect(
      as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "object",
      }),
    ).rejects.toThrow("Copy @object-push again first");

    // Copy again: starts from the top, with no gaps carried over.
    await as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
      workspaceId: w.workspaceId,
      to: "dual",
    });
    expect(await takeQueuedMoves(w.t)).toEqual([
      expect.objectContaining({ to: "dual", switched: true, gaps: false }),
    ]);
  });

  test("dual to object is refused without a backfill; the reason is passed through and shown as the last move", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", {
        workspaceId: w.workspaceId,
        home: "dual",
        since: 1,
      });
    });

    await move(w.t, as, w.workspaceId, "object");
    expect(await homeOf(w.t, w.workspaceId)).toBe("dual");
    expect((await moveRows(w.t)).map((row) => row.details)).toContainEqual({
      to: "object",
      state: "refused",
      reason: "NOT_BACKFILLED",
    });
    expect(
      (
        await as.query(api.functions.adminStorage.storageReport, {})
      ).workspaces.find((row) => row.slug === "object-push")?.lastMove,
    ).toMatchObject({
      to: "object",
      state: "refused",
      reason: "NOT_BACKFILLED",
    });
  });

  test("dual to object is refused while the last parity check differs", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await move(w.t, as, w.workspaceId, "dual");
    await finishCopy(w.t, w.workspaceId);
    await w.t.mutation(internal.functions.workspaceObjectsRows.recordCopy, {
      workspaceId: w.workspaceId,
      backfilledAt: Date.now(),
    });
    await w.t.mutation(internal.functions.workspaceObjectsRows.recordParity, {
      workspaceId: w.workspaceId,
      parity: {
        at: Date.now(),
        bodies: {
          bucketKeys: 1,
          objectKeys: 1,
          missingInObject: 0,
          extraInObject: 0,
          differ: 1,
        },
        rows: { convex: 1, object: 1, match: true },
        rules: { match: true },
        visibility: { principals: 2, checked: 2, differ: 0 },
      },
    });

    await move(w.t, as, w.workspaceId, "object");
    expect(await homeOf(w.t, w.workspaceId)).toBe("dual");
    expect((await moveRows(w.t)).map((row) => row.details)).toContainEqual({
      to: "object",
      state: "refused",
      reason: "PARITY_DIFFERS",
    });
  });

  test("dual to object with a clean, fresh parity check moves the reads to the object", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await move(w.t, as, w.workspaceId, "dual");
    await finishCopy(w.t, w.workspaceId);
    await w.t.mutation(internal.functions.workspaceObjectsRows.recordCopy, {
      workspaceId: w.workspaceId,
      backfilledAt: Date.now(),
    });
    await w.t.mutation(internal.functions.workspaceObjectsRows.recordParity, {
      workspaceId: w.workspaceId,
      parity: {
        at: Date.now(),
        bodies: {
          bucketKeys: 1,
          objectKeys: 1,
          missingInObject: 0,
          extraInObject: 0,
          differ: 0,
        },
        rows: { convex: 1, object: 1, match: true },
        rules: { match: true },
        visibility: { principals: 2, checked: 2, differ: 0 },
      },
    });

    await move(w.t, as, w.workspaceId, "object");
    expect(await homeOf(w.t, w.workspaceId)).toBe("object");
    expect((await moveRows(w.t)).map((row) => row.details)).toContainEqual({
      to: "object",
      state: "done",
    });
  });

  test("a killed run (stale heartbeat) is shown as stale, and a new request resumes it from its cursor", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await seedKilledMove(w.t, w.workspaceId, {
      ageMs: MOVE_STALE_MS + 60_000,
      cursor: EXHAUSTED_CURSOR,
      gaps: false,
    });
    expect(
      (await as.query(api.functions.adminStorage.storageReport, {}))
        .workspaces[0].lastMove,
    ).toMatchObject({ to: "dual", state: "stale" });

    await as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
      workspaceId: w.workspaceId,
      to: "dual",
    });
    const [resume] = await takeQueuedMoves(w.t);
    expect(resume).toEqual(
      expect.objectContaining({
        to: "dual",
        switched: true,
        cursor: EXHAUSTED_CURSOR,
        gaps: false,
      }),
    );
    // Run the resume step as the scheduler would, then the rest of the move.
    await w.t.action(internal.functions.adminStorage.runMove, resume as never);
    await drain(w.t);

    // Resumed from the cursor: the switch is not repeated, and the copy finishes clean.
    expect(w.ops()).not.toContain("ws.home");
    expect((await moveRow(w.t, w.workspaceId))?.state).toBe("done");
    expect((await moveRows(w.t)).map((row) => row.details)).toContainEqual({
      to: "dual",
      state: "done",
      copied: true,
    });
  });

  test("a resumed copy keeps the gaps its earlier pages had", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await seedKilledMove(w.t, w.workspaceId, {
      ageMs: MOVE_STALE_MS + 60_000,
      cursor: EXHAUSTED_CURSOR,
      gaps: true,
    });
    await as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
      workspaceId: w.workspaceId,
      to: "dual",
    });
    await drain(w.t);
    expect((await moveRow(w.t, w.workspaceId))?.state).toBe("incomplete");
  });

  test("a fresh run is not resumed: a request while its heartbeat is recent is refused", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await seedKilledMove(w.t, w.workspaceId, { ageMs: 60_000, gaps: false });
    await expect(
      as.mutation(api.functions.adminStorage.moveWorkspaceHome, {
        workspaceId: w.workspaceId,
        to: "dual",
      }),
    ).rejects.toThrow(/already running/);
  });
});
