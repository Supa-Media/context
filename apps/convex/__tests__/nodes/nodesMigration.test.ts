/**
 * The migration's staff surface (`functions/nodesMigration.ts`) and its
 * switch (`lib/nodes/pause.ts`): only staff read or change it, the report
 * carries counts and never a path, and a pause really stops new work.
 *
 * Sabotage: drop `staffOnly` from `report` and the stranger case fails; drop
 * the `migrationPaused` check in `requestSweep` and the pause case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { stageOf } from "../../functions/nodesMigration";

const ADMIN = "staff@example.test";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});

afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

type T = ReturnType<typeof convexTest>;

async function user(t: T, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never));
}

/** A workspace with a storage binding, as the report finds them. */
async function boundWorkspace(t: T, slug: string): Promise<Id<"workspaces">> {
  const createdBy = await user(t, `${slug}@example.test`);
  return await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: `Workspace ${slug}`,
      createdBy,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      bucket: `bucket-${slug}`,
      endpoint: "https://storage.example.test",
      region: "auto",
      accessKeyId: "fake",
      encryptedSecretAccessKey: "fake",
      capabilities: { conditionalWrite: true },
      status: "connected",
      boundBy: createdBy,
      createdAt: now,
      updatedAt: now,
    } as never);
    return workspaceId;
  });
}

async function scheduledSweeps(t: T): Promise<number> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((job) => (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "nodesSweep").length;
  });
}

describe("migration report", () => {
  test("staff see every bound workspace's stage and counts, never a path", async () => {
    const t = convexTest(schema, modules);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const copied = await boundWorkspace(t, "copied");
    await boundWorkspace(t, "fresh");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: copied,
      at: 10,
      rows: [{ path: "1-projects/secret-plan.md", etag: "e1" }],
      gone: [],
      vanishedUnder: [],
    });
    await t.mutation(internal.functions.nodes.begin, { workspaceId: copied, at: 5 });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: copied, at: 20, files: 1 });

    const report = await staff.query(api.functions.nodesMigration.report, {});
    expect(report.paused).toBe(false);
    expect(report.phase).toBe(3);
    expect(report).toMatchObject({ privacyAuthority: false, owedExports: 0 });
    const bySlug = Object.fromEntries(report.rows.map((row) => [row.slug, row]));
    expect(bySlug.copied).toMatchObject({ stage: "copied", files: 1, sweptAt: 20 });
    expect(bySlug.fresh).toMatchObject({ stage: "waiting", files: 0, sweptAt: null });
    expect(JSON.stringify(report)).not.toMatch(/secret-plan|1-projects|bucket-/);
  });

  test("a signed-in stranger and a signed-out caller are refused everything", async () => {
    const t = convexTest(schema, modules);
    const stranger = t.withIdentity({ subject: await user(t, "someone@example.com") });
    for (const caller of [t, stranger]) {
      await expect(caller.query(api.functions.nodesMigration.report, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.nodesMigration.setPaused, { paused: true })).rejects.toThrow();
      await expect(caller.mutation(api.functions.nodesMigration.start, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.nodesMigration.checkParity, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.nodesMigration.setPrivacyAuthority, { on: true })).rejects.toThrow();
    }
    expect(await t.run(async (ctx) => await ctx.db.query("nodeMigration").first())).toBeNull();
  });
});

describe("migration switch", () => {
  test("paused: nothing new is scheduled, Start is refused, and resuming starts what is due", async () => {
    const t = convexTest(schema, modules);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const ws = await boundWorkspace(t, "paused");

    await staff.mutation(api.functions.nodesMigration.setPaused, { paused: true });
    expect((await staff.query(api.functions.nodesMigration.report, {})).paused).toBe(true);
    expect(await t.query(internal.functions.nodes.paused, {})).toBe(true);

    // A change while paused only marks the tree dirty.
    await t.mutation(internal.functions.nodes.requestSweep, { workspaceId: ws });
    expect(await scheduledSweeps(t)).toBe(0);
    const state = await t.query(internal.functions.nodes.state, { workspaceId: ws });
    expect(state?.dirty).toBe(true);

    await expect(staff.mutation(api.functions.nodesMigration.start, {})).rejects.toThrow(/paused/i);
    expect(await scheduledSweeps(t)).toBe(0);

    const resumed = await staff.mutation(api.functions.nodesMigration.setPaused, { paused: false });
    expect(resumed.started).toBe(1);
    expect(await scheduledSweeps(t)).toBe(1);
  });

  test("Start skips a workspace whose sweep holds the lease", async () => {
    const t = convexTest(schema, modules);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const busy = await boundWorkspace(t, "busy");
    await boundWorkspace(t, "idle");
    await t.mutation(internal.functions.nodes.begin, { workspaceId: busy, at: Date.now() });

    expect((await staff.mutation(api.functions.nodesMigration.start, {})).started).toBe(1);
  });

  test("Check runs only where a copy is finished", async () => {
    const t = convexTest(schema, modules);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const done = await boundWorkspace(t, "done");
    await boundWorkspace(t, "notyet");
    await t.mutation(internal.functions.nodes.begin, { workspaceId: done, at: 1 });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: done, at: 2, files: 0 });

    expect((await staff.mutation(api.functions.nodesMigration.checkParity, {})).started).toBe(1);
  });
});

describe("stageOf", () => {
  const base = { _id: "x" as never, _creationTime: 0, workspaceId: "w" as never, dirty: false, files: 0 };
  test("one word per state", () => {
    expect(stageOf(null)).toBe("waiting");
    expect(stageOf({ ...base, status: "empty" })).toBe("waiting");
    expect(stageOf({ ...base, status: "empty", error: "failed" })).toBe("stuck");
    expect(stageOf({ ...base, status: "filling", cursor: "a" })).toBe("copying");
    expect(stageOf({ ...base, status: "ready", cursor: "a" })).toBe("copying");
    expect(stageOf({ ...base, status: "ready", error: "failed" })).toBe("stuck");
    expect(stageOf({ ...base, status: "unsupported" })).toBe("skipped");
    expect(stageOf({ ...base, status: "ready" })).toBe("copied");
    const parity = { checkedAt: 1, clearances: 3, mismatches: 0, privacyMatches: true };
    expect(stageOf({ ...base, status: "ready", parity })).toBe("matches");
    expect(stageOf({ ...base, status: "ready", parity: { ...parity, mismatches: 2 } })).toBe("differs");
    expect(stageOf({ ...base, status: "ready", parity: { ...parity, privacyMatches: false } })).toBe("differs");
  });
});

describe("keeping every copy current", () => {
  test("the cron starts every due copy, retries a failed one, and does nothing while paused", async () => {
    const t = convexTest(schema, modules);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await boundWorkspace(t, "fresh");
    const failed = await boundWorkspace(t, "failed");
    const current = await boundWorkspace(t, "current");
    // A pass that failed long enough ago that its lease has run out.
    await t.mutation(internal.functions.nodes.begin, { workspaceId: failed, at: 1 });
    await t.mutation(internal.functions.nodes.fail, { workspaceId: failed, label: "Tree sweep failed; inspect service logs" });
    // One finished a moment ago is not due.
    await t.mutation(internal.functions.nodes.begin, { workspaceId: current, at: Date.now() - 2 });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: current, at: Date.now() - 1, files: 0 });

    await staff.mutation(api.functions.nodesMigration.setPaused, { paused: true });
    expect((await t.mutation(internal.functions.nodesMigration.keepCurrent, {})).started).toBe(0);
    expect(await scheduledSweeps(t)).toBe(0);

    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeMigration").first();
      if (row) await ctx.db.patch(row._id, { paused: false });
    });
    expect((await t.mutation(internal.functions.nodesMigration.keepCurrent, {})).started).toBe(2);
    expect(await scheduledSweeps(t)).toBe(2);
  });
});
