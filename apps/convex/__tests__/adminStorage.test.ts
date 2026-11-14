/**
 * The staff console's storage page (`functions/adminStorage.ts`): where every
 * workspace's notes are read from, and the one move per workspace that the
 * "Workspace objects home" workflow makes by hand (decided by the owner,
 * 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * The move never skips parity: `object` is refused unless the workspace was
 * backfilled and its last parity check was clean, and the refusal's reason is
 * handed back as it was given. The request is audited when it is made, and
 * its outcome when it finishes; the report shows the newest of them.
 */

import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { asUser, createUser, type TestConvex } from "./fixtures.helpers";
import { withSession } from "./session.helpers";
import { world } from "./workspaceObjectWorld.helpers";

const ADMIN = "staff@supa.media";

type RunMoveArgs = {
  workspaceId: Id<"workspaces">;
  slug: string;
  to: "dual" | "object";
  actorUserId: Id<"users">;
  actorEmail: string;
};

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

/** The queued `runMove` jobs, cancelled here so the test runs each one itself (see `move`). */
async function takeQueuedMoves(t: TestConvex): Promise<RunMoveArgs[]> {
  return await t.run(async (ctx) => {
    const jobs = (
      await ctx.db.system.query("_scheduled_functions").collect()
    ).filter((job) => job.name.includes("adminStorage:runMove"));
    for (const job of jobs) await ctx.scheduler.cancel(job._id);
    return jobs.map((job) => job.args[0] as RunMoveArgs);
  });
}

/**
 * Ask for a move as staff. The move is queued, and the queued `runMove` is then run directly. A scheduled run
 * reaches the workspace object's door with a 503 under the test's clock, while a direct run reaches it, as the
 * other object tests call their actions.
 */
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
  for (const args of await takeQueuedMoves(t))
    await t.action(internal.functions.adminStorage.runMove, args);
}

const homeOf = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId });

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
        since: 5,
        lastMove: null,
      },
      {
        workspaceId: mid,
        slug: "mid",
        kind: "shared",
        home: "object",
        notes: null,
        since: 7,
        lastMove: null,
      },
      {
        workspaceId: zeta,
        slug: "zeta",
        kind: "personal",
        home: "bucket",
        notes: null,
        since: null,
        lastMove: null,
      },
    ]);
    expect(report.counts).toEqual({ object: 1, dual: 1, bucket: 1, total: 3 });
    expect(report.truncated).toBe(false);
  });
});

describe("moving one workspace's home", () => {
  test("a move is queued and audited as started; the report shows it copying until the outcome is recorded", async () => {
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
    ).toMatchObject({ to: "dual", state: "started", reason: null });
  });

  test("bucket to dual arms the workspace, its reads stay on the bucket, and the outcome is audited as done", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);

    await move(w.t, as, w.workspaceId, "dual");

    expect(await homeOf(w.t, w.workspaceId)).toBe("dual");
    expect(w.ops()).toContain("ws.home");
    // This fixture binds no bucket, so the copy has nothing to read and says it did not finish.
    const details = (await moveRows(w.t)).map((row) => row.details);
    expect(details).toContainEqual({
      to: "dual",
      state: "done",
      copied: false,
    });
    expect(
      (
        await as.query(api.functions.adminStorage.storageReport, {})
      ).workspaces.find((row) => row.slug === "object-push")?.lastMove,
    ).toMatchObject({
      to: "dual",
      state: "done",
      reason: null,
    });
  });

  test("dual to object is refused without a backfill; the reason is passed through and shown as the last move", async () => {
    const w = await world();
    const { as } = await seedStaff(w.t);
    await move(w.t, as, w.workspaceId, "dual");

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
});
