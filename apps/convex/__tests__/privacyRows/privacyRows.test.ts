/**
 * Privacy on rows, staff's switch and check (`functions/privacyRows.ts`).
 *
 * What is proved:
 *  - every public function refuses a stranger and an unsigned caller, and
 *    changes nothing and schedules nothing;
 *  - Start keeping rows moves the switch to shadow and derives each workspace;
 *  - a check stores its count, its differences and a sample of at most 20,
 *    path and clearance only;
 *  - Use rows is refused while a difference stands, refused while a check is
 *    missing or stale, refused from Off, and allowed at zero differences;
 *  - orphans are shown and do not block Use rows;
 *  - Back to Off is always allowed;
 *  - every switch change is in the staff audit trail, and a repeat is not.
 *
 * Sabotage (temporary local edit, reverted): drop the `refusalFor` difference
 * check and the differing case is accepted; drop the `checkStatus` version
 * comparison and the stale case passes; drop the `staffActor` call and the
 * stranger cases change state.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { errorCode } from "../fixtures.helpers";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { ADMIN, boundWorkspace, user } from "../noteIds/noteIds.helpers";

/** Typed against the schema, so a `t.run` callback's `ctx.db` knows the tables and their indexes. */
const tester = () => convexTest(schema, modules);
type T = ReturnType<typeof tester>;

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

/** Run every scheduled job until none is left: the derivation and the check chains. */
async function settle(t: T): Promise<void> {
  await t.finishAllScheduledFunctions(() => {}, 200);
}

/** A workspace with rules, and rows the rules name. Returns its id. */
async function ruledWorkspace(t: T, slug: string): Promise<Id<"workspaces">> {
  const workspaceId = await boundWorkspace(t, slug);
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("nodePrivacy", {
      workspaceId,
      etag: "v1",
      invalid: false,
      folders: [
        { prefix: "1-projects", visibility: "team" },
        { prefix: "2-areas", visibility: "private" },
      ],
      notes: [{ path: "2-areas/memo.md", visibility: "team" }],
      observedAt: now,
    });
    for (const [path, kind] of [
      ["1-projects", "folder"],
      ["1-projects/plan.md", "file"],
      ["2-areas", "folder"],
      ["2-areas/memo.md", "file"],
    ] as const) {
      await ctx.db.insert("nodes", { workspaceId, path, name: path.slice(path.lastIndexOf("/") + 1), kind, observedAt: now });
    }
  });
  return workspaceId;
}

async function signedIn(t: T, email: string) {
  return t.withIdentity({ subject: await user(t, email) });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
}

async function sourceOf(t: T): Promise<string | undefined> {
  return (await t.run((ctx) => ctx.db.query("nodeMigration").first()))?.accessSource;
}

async function scheduledCount(t: T): Promise<number> {
  return (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
}

async function auditActions(t: T): Promise<string[]> {
  const rows = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
  return rows.map((row) => row.action);
}

/** Start keeping rows, and let the derivation finish. */
async function keepRows(t: T): Promise<void> {
  await (await signedIn(t, ADMIN)).mutation(api.functions.privacyRows.startKeeping, {});
  await settle(t);
}

/** Check every workspace, and let the check finish. */
async function checkEverything(t: T): Promise<void> {
  await (await signedIn(t, ADMIN)).mutation(api.functions.privacyRows.checkAll, {});
  await settle(t);
}

/** Make one row disagree with the rules: a private base on a file the team folder shows. */
async function corruptRow(t: T, workspaceId: Id<"workspaces">, path: string, base: "private" | undefined): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    if (row === null) throw new Error(`no row at ${path}`);
    await ctx.db.patch(row._id, { access: base === undefined ? undefined : { base } });
  });
}

describe("staff only", () => {
  test("every public function refuses a stranger and an unsigned caller, changing nothing", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    const stranger = await signedIn(t, "stranger@example.test");
    const nobody = t;

    const reads = [
      () => stranger.query(api.functions.privacyRows.report, {}),
      () => nobody.query(api.functions.privacyRows.report, {}),
      () => stranger.query(api.functions.privacyRows.differencesFor, { workspaceId }),
      () => nobody.query(api.functions.privacyRows.differencesFor, { workspaceId }),
    ];
    for (const read of reads) expect(errorCode(await errorOf(read()))).toBe("NOT_FOUND");

    const writes = [
      () => stranger.mutation(api.functions.privacyRows.startKeeping, {}),
      () => nobody.mutation(api.functions.privacyRows.startKeeping, {}),
      () => stranger.mutation(api.functions.privacyRows.checkAll, {}),
      () => nobody.mutation(api.functions.privacyRows.checkAll, {}),
      () => stranger.mutation(api.functions.privacyRows.useRows, {}),
      () => nobody.mutation(api.functions.privacyRows.useRows, {}),
      () => stranger.mutation(api.functions.privacyRows.backToOff, {}),
      () => nobody.mutation(api.functions.privacyRows.backToOff, {}),
    ];
    for (const write of writes) expect(errorCode(await errorOf(write()))).toBe("NOT_FOUND");

    expect(await sourceOf(t)).toBeUndefined();
    expect(await scheduledCount(t)).toBe(0);
    expect(await auditActions(t)).toEqual([]);
  });
});

describe("start keeping rows", () => {
  test("moves the switch to shadow, derives each workspace, and audits the change", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    expect(await sourceOf(t)).toBe("shadow");
    const state = await t.run((ctx) =>
      ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique(),
    );
    expect(state?.version).toBe(1);
    expect(await auditActions(t)).toEqual(["rows.source_set"]);
  });

  test("a repeat is not a change and is not audited again", async () => {
    const t = tester();
    await ruledWorkspace(t, "acme");
    await keepRows(t);
    await keepRows(t);
    expect(await auditActions(t)).toEqual(["rows.source_set"]);
  });
});

describe("check", () => {
  test("a clean check stores its count, no differences and no sample", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    await checkEverything(t);
    const detail = await (await signedIn(t, ADMIN)).query(api.functions.privacyRows.differencesFor, { workspaceId });
    expect(detail?.status).toBe("clean");
    expect(detail?.checked).toBeGreaterThan(0);
    expect(detail?.differences).toBe(0);
    expect(detail?.sample).toEqual([]);
    expect(detail?.checkedAt).not.toBeNull();
  });

  test("a difference is counted, and its sample names the path and clearance only, at most 20", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    await corruptRow(t, workspaceId, "1-projects/plan.md", "private");
    await checkEverything(t);
    const detail = await (await signedIn(t, ADMIN)).query(api.functions.privacyRows.differencesFor, { workspaceId });
    expect(detail?.status).toBe("differs");
    expect(detail?.differences).toBeGreaterThanOrEqual(1);
    expect(detail?.sample.length).toBeLessThanOrEqual(20);
    expect(detail?.sample).toContainEqual({ path: "1-projects/plan.md", clearance: "member" });
    for (const entry of detail?.sample ?? []) expect(Object.keys(entry).sort()).toEqual(["clearance", "path"]);
  });

  test("a check started again supersedes the old run, which stores nothing", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    const staff = await signedIn(t, ADMIN);
    await staff.mutation(api.functions.privacyRows.checkAll, {});
    await staff.mutation(api.functions.privacyRows.checkAll, {});
    await settle(t);
    const row = await t.run((ctx) =>
      ctx.db.query("privacyRowChecks").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique(),
    );
    expect(row?.runId).toBe(2);
    expect(row?.status).toBe("done");
    expect(row?.checked).toBeGreaterThan(0);
  });
});

describe("Use rows", () => {
  test("refused from Off, and nothing changes", async () => {
    const t = tester();
    await ruledWorkspace(t, "acme");
    const error = await errorOf((await signedIn(t, ADMIN)).mutation(api.functions.privacyRows.useRows, {}));
    expect(errorCode(error)).toBe("ROWS_NOT_SHADOW");
    expect(await sourceOf(t)).toBeUndefined();
  });

  test("refused with no check yet, and names how many", async () => {
    const t = tester();
    await ruledWorkspace(t, "acme");
    await keepRows(t);
    const error = await errorOf((await signedIn(t, ADMIN)).mutation(api.functions.privacyRows.useRows, {}));
    expect(errorCode(error)).toBe("ROWS_NOT_CHECKED");
    expect(String((error as { data: { message: string } }).data.message)).toMatch(/^1 workspace has no current check/);
    expect(await sourceOf(t)).toBe("shadow");
  });

  test("refused while a difference stands, and allowed once the next check finds none", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    await corruptRow(t, workspaceId, "1-projects/plan.md", "private");
    await checkEverything(t);
    const staff = await signedIn(t, ADMIN);
    const refused = await errorOf(staff.mutation(api.functions.privacyRows.useRows, {}));
    expect(errorCode(refused)).toBe("ROWS_DIFFER");
    expect(await sourceOf(t)).toBe("shadow");

    await corruptRow(t, workspaceId, "1-projects/plan.md", undefined);
    await checkEverything(t);
    expect(await staff.mutation(api.functions.privacyRows.useRows, {})).toEqual({ source: "rows" });
    expect(await sourceOf(t)).toBe("rows");
    expect(await auditActions(t)).toEqual(["rows.source_set", "rows.source_set"]);
  });

  test("refused when a check was made before the rows were derived again, as stale", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    await checkEverything(t);
    const staff = await signedIn(t, ADMIN);
    const report = await staff.query(api.functions.privacyRows.report, {});
    expect(report.ready.ok).toBe(true);

    // A derivation after the check: the version moves on, so the check no longer stands.
    await t.mutation(internal.functions.privacyRows.deriveWorkspace, { workspaceId });
    const after = await staff.query(api.functions.privacyRows.report, {});
    expect(after.rows[0]?.status).toBe("stale");
    expect(after.ready.ok).toBe(false);
    expect(errorCode(await errorOf(staff.mutation(api.functions.privacyRows.useRows, {})))).toBe("ROWS_NOT_CHECKED");
  });

  test("orphans are shown and do not block", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodePrivacy")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { notes: [{ path: "2-areas/missing.md", visibility: "team" }] });
    });
    await keepRows(t);
    await checkEverything(t);
    const staff = await signedIn(t, ADMIN);
    const report = await staff.query(api.functions.privacyRows.report, {});
    expect(report.rows[0]?.orphans).toBe(1);
    expect(await staff.mutation(api.functions.privacyRows.useRows, {})).toEqual({ source: "rows" });
  });
});

describe("Back to Off", () => {
  test("is allowed from shadow with a difference standing", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    await corruptRow(t, workspaceId, "1-projects/plan.md", "private");
    await checkEverything(t);
    const staff = await signedIn(t, ADMIN);
    expect(await staff.mutation(api.functions.privacyRows.backToOff, {})).toEqual({ source: "file" });
    expect(await sourceOf(t)).toBe("file");
    expect(await auditActions(t)).toEqual(["rows.source_set", "rows.source_set"]);
  });

  test("a repeat from Off is not a change and is not audited", async () => {
    const t = tester();
    await ruledWorkspace(t, "acme");
    const staff = await signedIn(t, ADMIN);
    await staff.mutation(api.functions.privacyRows.backToOff, {});
    expect(await auditActions(t)).toEqual([]);
  });
});

describe("the page", () => {
  test("lists each workspace's slug, check and counts, with its status", async () => {
    const t = tester();
    const workspaceId = await ruledWorkspace(t, "acme");
    await keepRows(t);
    await corruptRow(t, workspaceId, "1-projects/plan.md", "private");
    await checkEverything(t);
    const report = await (await signedIn(t, ADMIN)).query(api.functions.privacyRows.report, {});
    expect(report.source).toBe("shadow");
    expect(report.truncated).toBe(false);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ workspaceId, slug: "acme", archived: false, status: "differs" });
    expect(report.rows[0]!.differences).toBeGreaterThanOrEqual(1);
    expect(report.rows[0]!.checkedAt).not.toBeNull();
  });
});
