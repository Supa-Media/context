/**
 * The migration's staff surface (`functions/nodesMigration.ts`) and its
 * switch (`lib/nodes/pause.ts`): only staff read or change it, the report
 * carries counts and never a path, and a pause really stops new work.
 *
 * Sabotage: drop `staffOnly` from `report` and the stranger case fails; drop
 * the `staffOnly` check from `setPaused` and the stranger case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { PROPS_VERSION } from "../../functions/lib/nodes/facts";
import { seedTreeRows } from "../fixtures.helpers";
import { withSession } from "../session.helpers";

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


describe("migration report", () => {
  test("staff see every bound workspace's counts and facts, never a path", async () => {
    const t = convexTest(schema, modules);
    const staff = withSession(t, await user(t, ADMIN));
    const copied = await boundWorkspace(t, "copied");
    await boundWorkspace(t, "fresh");
    await seedTreeRows(t, copied, [{ path: "1-projects/secret-plan.md", etag: "e1" }]);

    const report = await staff.query(api.functions.nodesMigration.report, {});
    expect(report.paused).toBe(false);
    expect(report.phase).toBe(3);
    const bySlug = Object.fromEntries(report.rows.map((row) => [row.slug, row]));
    expect(bySlug.copied).toMatchObject({ archived: false });
    expect(bySlug.fresh).toMatchObject({ archived: false, facts: null });
    expect(JSON.stringify(report)).not.toMatch(/secret-plan|1-projects|bucket-/);
  });

  test("a signed-in stranger and a signed-out caller are refused everything", async () => {
    const t = convexTest(schema, modules);
    const stranger = withSession(t, await user(t, "someone@example.com"));
    for (const caller of [t, stranger]) {
      await expect(caller.query(api.functions.nodesMigration.report, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.nodesMigration.setPaused, { paused: true })).rejects.toThrow();
    }
    expect(await t.run(async (ctx) => await ctx.db.query("nodeMigration").first())).toBeNull();
  });
});

describe("keeping every copy current", () => {
  test("the cron starts the facts fill where a served tree's facts are behind, and only there", async () => {
    const t = convexTest(schema, modules);
    const serve = async (slug: string) => {
      const workspaceId = await boundWorkspace(t, slug);
      await seedTreeRows(t, workspaceId, [{ path: "a.md", etag: "e1" }]);
      return workspaceId;
    };
    const never = await serve("never-filled");
    const current = await serve("caught-up");
    const held = await serve("held");
    const oldProps = await serve("old-props");
    await boundWorkspace(t, "not-served");
    await t.run(async (ctx) => {
      // Caught up, its rows read at today's props version.
      await ctx.db.insert("nodeFactState", { workspaceId: current, ready: true, seq: Number.MAX_SAFE_INTEGER, propsVersion: PROPS_VERSION });
      await ctx.db.insert("nodeFactState", { workspaceId: held, ready: false, seq: 0, leaseAt: Date.now() });
      // Caught up, but read before the props carried what readers now ask of them.
      await ctx.db.insert("nodeFactState", { workspaceId: oldProps, ready: true, seq: Number.MAX_SAFE_INTEGER });
    });
    await t.mutation(internal.functions.nodesMigration.keepCurrent, {});
    const fills = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((job) => (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "nodesFactFill")
        .map((job) => (job.args[0] as { workspaceId: Id<"workspaces"> }).workspaceId),
    );
    expect([...fills].sort()).toEqual([never, oldProps].sort());
  });
});

