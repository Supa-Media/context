import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, drainScheduled, errorCode, captureError, FAKE_STORAGE, seedStorageBinding } from "./fixtures.helpers";
import {
  DAILY,
  DAILY_TEXT,
  routineFixture,
  runPendingScans,
  rowAt,
  rows,
  seededBucket,
  signal,
  stubBuckets,
} from "./routines.helpers";
import { routinePathsTouched } from "../functions/lib/routines/changes";
import type { FileOperation, OperationResult } from "../functions/lib/filesFns/operationTypes";

/**
 * ROUTINES: KEEPING THE CONTROL PLANE'S ROWS A DESCRIPTION OF THE BUCKET.
 *
 * Driven through the real `/gateway/routines` route and the real barrier,
 * against an in-memory bucket. The rows hold when and as whom, never what a
 * routine says (`docs/decisions/routines.md`).
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `recordRoutineSignalHandler` keeping a writer without `writingRole`
 *     → nothing fails, and that is by design: the commit asks again. With the
 *     commit's check removed as well, "a signal from someone who cannot write
 *     here names no writer" and the tenant-isolation test both fail.
 *   `commitRoutinesHandler` falling back to the owner for a row whose writer
 *     is gone → "a writer who lost access is not replaced by the owner" fails
 */

// Each test builds a deployment and a bucket; the first one in a run pays to warm both.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a signal reads the folder", () => {
  test("keeps the schedule, the writer and nothing the note says", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    f.backend.seed("routines/weekly/review.md", "---\non: friday\nat: 4pm\nto: @studio-cy, @Studio-Bo\nsend: both\n---\nReview the week.\n");
    f.backend.seed("routines/loose.md", "Not in a schedule folder.\n");
    f.backend.seed("routines/every-1-minute/fast.md", "Too fast.\n");
    f.backend.seed("routines/daily/deeper/nested.md", "Too deep.\n");
    const response = await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY] });
    expect(JSON.parse(await response.text())).toEqual({ ok: true });

    const found = await rows(f.t, f.workspaceId);
    expect(found.map((row) => row.path).sort()).toEqual([DAILY, "routines/weekly/review.md"]);
    const daily = found.find((row) => row.path === DAILY)!;
    expect(daily).toMatchObject({
      writerUserId: f.editor,
      cadence: { unit: "day", every: 1 },
      at: { hour: 7, minute: 30 },
      paused: false,
      send: "text",
      to: [],
    });
    expect(daily.nextRunAt).toBeGreaterThan(Date.now());
    const weekly = found.find((row) => row.path === "routines/weekly/review.md")!;
    expect(weekly).toMatchObject({ days: [5], send: "both", to: ["studio-cy", "studio-bo"] });
    // A file found with no signal naming its writer runs as the owner.
    expect(weekly.writerUserId).toBe(f.owner);

    // Metadata only: no body, no `until:` sentence, anywhere in the rows.
    const stored = JSON.stringify(await f.t.run(async (ctx) => [
      await ctx.db.query("routines").collect(),
      await ctx.db.query("routineReconciles").collect(),
    ]));
    expect(stored).not.toContain("Summarize");
    expect(stored).not.toContain("launch ships");
    expect(stored).not.toContain("Review the week");
  });

  test("a paused routine has no next run", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, "---\npaused: yes\n---\nHold on.\n");
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: [DAILY] });
    const row = await rowAt(f.t, f.workspaceId, DAILY);
    expect(row).toMatchObject({ paused: true, nextRunAt: null });
    expect(
      await asUser(f.t, f.owner).mutation(api.functions.routines.runRoutineNow, {
        workspaceId: f.workspaceId,
        path: DAILY,
      }),
    ).toBe(false);
  });

  test("a deleted file loses its row, and a moved one is scheduled under its new folder", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY] });
    expect(await rows(f.t, f.workspaceId)).toHaveLength(1);

    f.backend.objects.delete(DAILY);
    f.backend.seed("routines/every-3-hours/standup.md", DAILY_TEXT);
    await signal(f.t, {
      workspaceId: f.workspaceId,
      userId: f.editor,
      paths: ["routines/daily", "routines/every-3-hours"],
    });
    const after = await rows(f.t, f.workspaceId);
    expect(after.map((row) => row.path)).toEqual(["routines/every-3-hours/standup.md"]);
    // The person who moved the folder is the writer, not the owner.
    expect(after[0]!.writerUserId).toBe(f.editor);
    expect(after[0]!.cadence).toEqual({ unit: "hour", every: 3 });
  });

  test("a burst of signals shares one scan", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    for (let i = 0; i < 3; i += 1) {
      await f.t.mutation(internal.functions.routines.recordRoutineSignal, {
        workspaceId: f.workspaceId,
        userId: f.editor,
        paths: [DAILY],
      });
    }
    const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => job.name.includes("reconcileRoutines"))).toHaveLength(1);
    expect(await runPendingScans(f.t)).toBe(1);
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({ writerUserId: f.editor });
  });

  test("paths outside routines/ and malformed bodies change nothing and answer the same", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    for (const body of [
      { workspaceId: f.workspaceId, userId: f.editor, paths: ["1-projects/a.md"] },
      { workspaceId: f.workspaceId, userId: f.editor, paths: "routines/daily/standup.md" },
      { workspaceId: "not-an-id", userId: f.editor, paths: [DAILY] },
      { workspaceId: f.workspaceId, userId: 42, paths: [DAILY] },
      { workspaceId: f.workspaceId, paths: ["routines/../privacy.md"] },
    ]) {
      const response = await signal(f.t, body as never);
      expect(response.status).toBe(200);
      expect(JSON.parse(await response.text())).toEqual({ ok: true });
    }
    expect(await rows(f.t, f.workspaceId)).toHaveLength(0);
  });

  test("the route needs the gateway's secret", async () => {
    const f = await routineFixture();
    const response = await f.t.fetch("/gateway/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-agent-worker-secret-not-a-real-one" },
      body: JSON.stringify({ workspaceId: f.workspaceId, paths: [DAILY] }),
    });
    expect(response.status).toBe(401);
  });
});

describe("who a routine runs as", () => {
  test("a signal from someone who cannot write here names no writer", async () => {
    for (const who of ["member", "stranger"] as const) {
      const f = await routineFixture();
      f.backend.seed(DAILY, DAILY_TEXT);
      await signal(f.t, { workspaceId: f.workspaceId, userId: f[who], paths: [DAILY] });
      expect((await rowAt(f.t, f.workspaceId, DAILY))?.writerUserId).toBe(f.owner);
      vi.unstubAllGlobals();
    }
  });

  test("the last person who wrote it is its writer", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: [DAILY] });
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY] });
    expect((await rowAt(f.t, f.workspaceId, DAILY))?.writerUserId).toBe(f.editor);
    // A re-read with no signal keeps them while they can still write.
    await f.t.action(internal.functions.routines.reconcileRoutines, { workspaceId: f.workspaceId });
    expect((await rowAt(f.t, f.workspaceId, DAILY))?.writerUserId).toBe(f.editor);
  });

  test("a writer who lost access is not replaced by the owner", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY] });
    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.editor))
        .unique();
      await ctx.db.patch(membership!._id, { role: "member" });
    });
    await f.t.action(internal.functions.routines.reconcileRoutines, { workspaceId: f.workspaceId });
    // Handing an editor's words to the owner would run them with the owner's
    // private reach. It waits for someone who can write to save it.
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({
      writerUserId: f.editor,
      nextRunAt: null,
      lastOutcome: "writer_gone",
    });
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: [DAILY] });
    const row = await rowAt(f.t, f.workspaceId, DAILY);
    expect(row?.writerUserId).toBe(f.owner);
    expect(row?.nextRunAt).toBeGreaterThan(Date.now());
    expect(row?.lastOutcome).toBeUndefined();
  });

  test("a console write records the person who made it", async () => {
    const f = await routineFixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "routines",
      visibility: "team",
    });
    await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: DAILY,
      text: DAILY_TEXT,
    });
    await runPendingScans(f.t);
    expect((await rowAt(f.t, f.workspaceId, DAILY))?.writerUserId).toBe(f.editor);
  });
});

describe("tenant isolation", () => {
  test("a signal for one workspace reads only that workspace's bucket", async () => {
    const a = await routineFixture({ slug: "alfa", stub: false });
    const t = a.t;
    // A second workspace in the same deployment, on a bucket of its own.
    const other = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { email: "beta@example.invalid", emailVerificationTime: Date.now() });
      return owner;
    });
    const betaId = await asUser(t, other).mutation(api.functions.workspaces.createWorkspace, {
      slug: "bravo-team",
      displayName: "bravo",
      kind: "shared",
    });
    const betaBucket = seededBucket("beta-bucket");
    betaBucket.seed("routines/daily/beta-only.md", "Beta's routine.\n");
    a.backend.seed(DAILY, DAILY_TEXT);
    stubBuckets(a.backend, betaBucket);
    await seedStorageBinding(t, { workspaceId: betaId.workspaceId, boundBy: other, bucket: "beta-bucket" });

    // A's editor names B, and B's file under A.
    await signal(t, { workspaceId: betaId.workspaceId, userId: a.editor, paths: ["routines/daily/beta-only.md"] });
    await signal(t, { workspaceId: a.workspaceId, userId: a.editor, paths: ["routines/daily/beta-only.md"] });

    const inA = await rows(t, a.workspaceId);
    const inB = await rows(t, betaId.workspaceId);
    expect(inA.map((row) => row.path)).toEqual([DAILY]);
    expect(inB.map((row) => row.path)).toEqual(["routines/daily/beta-only.md"]);
    // A's editor is nobody in B: B's routine runs as B's owner.
    expect(inB[0]!.writerUserId).toBe(other);
    expect(FAKE_STORAGE.bucket).not.toBe("beta-bucket");
  });

  test("the app's view of a routine is for its workspace's members only", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY] });
    const view = await asUser(f.t, f.member).query(api.functions.routines.routineForNote, {
      workspaceId: f.workspaceId,
      path: DAILY,
    });
    expect(view).toMatchObject({ writer: "@studio-bo", cadence: { unit: "day", every: 1 }, lastOutcome: null });
    const refused = await captureError(() =>
      asUser(f.t, f.stranger).query(api.functions.routines.routineForNote, { workspaceId: f.workspaceId, path: DAILY }),
    );
    expect(errorCode(refused)).toBe("WORKSPACE_NOT_FOUND");
    const notMember = await captureError(() =>
      asUser(f.t, f.member).mutation(api.functions.routines.runRoutineNow, { workspaceId: f.workspaceId, path: DAILY }),
    );
    expect(errorCode(notMember)).toBe("INSUFFICIENT_ROLE");
    expect(
      await asUser(f.t, f.editor).mutation(api.functions.routines.runRoutineNow, { workspaceId: f.workspaceId, path: DAILY }),
    ).toBe(true);
    expect((await rowAt(f.t, f.workspaceId, DAILY))!.nextRunAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("time zones", () => {
  test("the file's zone, else the writer's, else New York", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, "---\nat: 7:00\n---\nGo.\n");
    f.backend.seed("routines/daily/tokyo.md", "---\nat: 7:00\ntimezone: Asia/Tokyo\n---\nGo.\n");
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY, "routines/daily/tokyo.md"] });
    const hourIn = (ms: number, timeZone: string) =>
      Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(ms));
    const daily = await rowAt(f.t, f.workspaceId, DAILY);
    expect(hourIn(daily!.nextRunAt!, "America/New_York")).toBe(7);
    const tokyo = await rowAt(f.t, f.workspaceId, "routines/daily/tokyo.md");
    expect(hourIn(tokyo!.nextRunAt!, "Asia/Tokyo")).toBe(7);

    const bad = await captureError(() =>
      asUser(f.t, f.editor).mutation(api.functions.routines.setMyTimeZone, { timeZone: "Mars/Olympus" }),
    );
    expect(errorCode(bad)).toBe("INVALID_ARGUMENT");
    await asUser(f.t, f.editor).mutation(api.functions.routines.setMyTimeZone, { timeZone: "Europe/London" });
    await f.t.action(internal.functions.routines.reconcileRoutines, { workspaceId: f.workspaceId });
    expect(hourIn((await rowAt(f.t, f.workspaceId, DAILY))!.nextRunAt!, "Europe/London")).toBe(7);
  });
});

describe("which console operations touch routines/", () => {
  const moved = { kind: "moved", from: "1-projects/a.md", to: "routines/daily/a.md" } as unknown as OperationResult;
  const written = { kind: "written" } as unknown as OperationResult;
  test("either side of a move, a write, and not elsewhere", () => {
    expect(routinePathsTouched({ kind: "move", from: "1-projects/a.md", to: "routines/daily/a.md" }, moved)).toEqual([
      "routines/daily/a.md",
    ]);
    expect(routinePathsTouched({ kind: "write", path: "routines/daily/a.md", text: "" } as FileOperation, written)).toEqual([
      "routines/daily/a.md",
    ]);
    expect(routinePathsTouched({ kind: "write", path: "1-projects/routines.md", text: "" } as FileOperation, written)).toEqual([]);
    expect(routinePathsTouched({ kind: "trash", path: "routines" } as FileOperation, written)).toEqual(["routines"]);
  });
});
