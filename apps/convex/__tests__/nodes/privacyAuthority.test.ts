/**
 * Phase 3: the privacy rules held in `nodePrivacy` as the authority, and
 * `privacy.md` as their export (`functions/nodesPrivacy.ts`,
 * `lib/nodes/privacyAuthority.ts`, `lib/gatewayRoutes/privacy.ts`).
 *
 * Sabotage: drop the `expected` comparison in `write` and the stale-version
 * case fails; accept any `written` once authoritative and the past-the-rules
 * case fails; drop the workspace comparison in the route and the cross-tenant
 * case fails; drop the owed check in `setPrivacyAuthority` and the hand-back
 * case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, CLIENT_B, bodyOf, seedConnectedClient, token, twoConnectedTenants } from "../controlPlane/fixtures.helpers";
import { forgetWorkspaceTree } from "../../functions/nodesPurge";

type T = Awaited<ReturnType<typeof twoConnectedTenants>>["t"];

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

const TEAM_PROJECTS = { folders: [{ prefix: "1-projects", visibility: "team" }], notes: [] };
const PRIVATE_PLAN = {
  folders: [{ prefix: "1-projects", visibility: "team" }],
  notes: [{ path: "1-projects/plan.md", visibility: "private" }],
};

/** The rules as a listing of the file read them, at bucket version `etag`. */
async function observeFile(t: T, workspaceId: Id<"workspaces">, etag: string, at: number) {
  await t.mutation(internal.functions.nodes.savePrivacy, {
    workspaceId,
    at,
    mirror: { etag, invalid: false, ...TEAM_PROJECTS },
  });
}

async function setSwitch(t: T, on: boolean) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, privacyAuthority: on, updatedAt: 1 });
    else await ctx.db.patch(row._id, { privacyAuthority: on });
  });
}

async function rowOf(t: T, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

async function exportsScheduled(t: T): Promise<number> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((job) => (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "nodesPrivacyExport")
      .length;
  });
}

/** The version a successful write answered. */
function versionOf(answer: { etag: string } | { current: unknown } | null): string {
  if (answer === null || !("etag" in answer)) throw new Error("the write did not swap");
  return answer.etag;
}

/** Alice's workspace with its rules observed from the file, and the authority on. */
async function authoritative() {
  const tenants = await twoConnectedTenants();
  await observeFile(tenants.t, tenants.aliceWs, "e1", 10);
  await setSwitch(tenants.t, true);
  return tenants;
}

describe("when the rules are the authority", () => {
  test("only with the switch on and rules read from a file that parsed", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    await observeFile(t, aliceWs, "e1", 10);
    await t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: bobWs,
      at: 10,
      mirror: { etag: "e9", invalid: true, folders: [], notes: [] },
    });
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toBeNull();
    await setSwitch(t, true);
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toEqual({
      etag: "e1",
      ...TEAM_PROJECTS,
    });
    // A broken file keeps the file as the authority, so its fail-closed answer stands.
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: bobWs })).toBeNull();
  });
});

describe("changing the rules", () => {
  test("is a compare-and-swap on the held version", async () => {
    const { t, aliceWs } = await authoritative();
    expect(
      await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: "e0", ...PRIVATE_PLAN }),
    ).toEqual({ current: { etag: "e1", ...TEAM_PROJECTS } });
    const swapped = await t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: aliceWs,
      expected: "e1",
      ...PRIVATE_PLAN,
    });
    expect(versionOf(swapped)).toMatch(/^ctx-/);
    const row = await rowOf(t, aliceWs);
    expect(row).toMatchObject({ etag: versionOf(swapped), exportOwed: true, ...PRIVATE_PLAN });
    // The old version no longer passes.
    expect(
      await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: "e1", ...TEAM_PROJECTS }),
    ).toEqual({ current: { etag: versionOf(swapped), ...PRIVATE_PLAN } });
  });

  test("is refused while the file is the authority", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await observeFile(t, aliceWs, "e1", 10);
    expect(
      await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: null, ...PRIVATE_PLAN }),
    ).toBeNull();
  });

  test("an export settles only the version it was rendered from", async () => {
    const { t, aliceWs } = await authoritative();
    const first = await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: "e1", ...PRIVATE_PLAN });
    const second = await t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: aliceWs,
      expected: versionOf(first),
      ...TEAM_PROJECTS,
    });
    // Each change leaves a net under its writer's export.
    expect(await exportsScheduled(t)).toBe(2);
    // The first export lands after the second change: it is written over again.
    await t.mutation(internal.functions.nodesPrivacy.exported, { workspaceId: aliceWs, rendered: versionOf(first), etag: "e2" });
    expect((await rowOf(t, aliceWs))?.exportOwed).toBe(true);
    expect(await exportsScheduled(t)).toBe(3);
    expect(await t.query(internal.functions.nodesPrivacy.exportOwedNow, { workspaceId: aliceWs })).toBe(true);
    await t.mutation(internal.functions.nodesPrivacy.exported, { workspaceId: aliceWs, rendered: versionOf(second), etag: "e3" });
    expect(await rowOf(t, aliceWs)).toMatchObject({ exportOwed: false, exportedEtag: "e3" });
    // So the nets that run later write nothing.
    expect(await t.query(internal.functions.nodesPrivacy.exportOwedNow, { workspaceId: aliceWs })).toBe(false);
  });

  test("an export that failed is tried again later", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodesPrivacy.owed, { workspaceId: aliceWs });
    expect((await rowOf(t, aliceWs))?.exportOwed).toBe(true);
    expect(await exportsScheduled(t)).toBe(1);
  });
});

describe("the file written past the rules", () => {
  test("before the flip, a write of the file is an observation of it", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await observeFile(t, aliceWs, "e1", 10);
    await t.mutation(internal.functions.nodesPrivacy.written, {
      workspaceId: aliceWs,
      previous: "e1",
      etag: "e2",
      at: 20,
      ...PRIVATE_PLAN,
    });
    // A copy of the file, like any read: nothing marks it as decided here.
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e2", ...PRIVATE_PLAN });
    expect((await rowOf(t, aliceWs))?.exportedEtag).toBeUndefined();
    // An older report never replaces a newer one.
    await t.mutation(internal.functions.nodesPrivacy.written, {
      workspaceId: aliceWs,
      previous: null,
      etag: "e0",
      at: 5,
      ...TEAM_PROJECTS,
    });
    expect((await rowOf(t, aliceWs))?.etag).toBe("e2");
  });

  test("after the flip, a write begun just before it is kept", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodesPrivacy.written, {
      workspaceId: aliceWs,
      previous: "e1",
      etag: "e2",
      at: 20,
      ...PRIVATE_PLAN,
    });
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e2", ...PRIVATE_PLAN, exportOwed: false });
    expect(await exportsScheduled(t)).toBe(0);
  });

  test("after the flip, any other write is put back from the rules", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodesPrivacy.written, {
      workspaceId: aliceWs,
      previous: "e0",
      etag: "e5",
      at: 20,
      ...PRIVATE_PLAN,
    });
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e1", ...TEAM_PROJECTS, exportOwed: true });
    expect(await exportsScheduled(t)).toBe(1);
  });

  test("a mirror read from the file is never stored once the rules are the authority", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: aliceWs,
      at: 99,
      mirror: { etag: "e7", invalid: false, ...PRIVATE_PLAN },
    });
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e1", ...TEAM_PROJECTS });
  });

  test("a listing that sees the file at another version owes the export once", async () => {
    const { t, aliceWs } = await authoritative();
    // Rules this deployment has authored, and a file written from them: from
    // here the rules are the authority and a file edited past them is put back.
    const swapped = await t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: aliceWs,
      expected: "e1",
      ...PRIVATE_PLAN,
    });
    await t.mutation(internal.functions.nodesPrivacy.exported, {
      workspaceId: aliceWs,
      rendered: versionOf(swapped),
      etag: "e2",
    });
    const observe = (etag: string, at: number) =>
      t.mutation(internal.functions.nodes.observe, {
        workspaceId: aliceWs,
        at,
        rows: [{ path: "privacy.md", etag }],
        gone: [],
        vanishedUnder: [],
      });
    // The file the rules were last written to: nothing to do.
    await observe("e2", 30);
    expect(await exportsScheduled(t)).toBe(1);
    await observe("e8", 40);
    expect((await rowOf(t, aliceWs))?.exportOwed).toBe(true);
    expect(await exportsScheduled(t)).toBe(2);
    await observe("e9", 50);
    expect(await exportsScheduled(t)).toBe(2);
  });
});

/*
  A copy is not an authority.

  Between the read that filled `nodePrivacy` and the moment staff turn the
  switch on, the customer may have edited `privacy.md` in their own bucket —
  the copy follows an out-of-band edit only when a sweep is next due, which is
  up to an hour. `setPrivacyAuthority` writes nothing and checks nothing,
  reasoning that "each workspace's file is already its rules' export"; for
  those workspaces it is not, and the first listing that notices would put the
  copy back over the owner's newer file. A note they withheld by hand would be
  team-readable again, permanently, with nothing saying so.

  So a row whose version is still the bucket's own, and from which no file has
  ever been written, is a copy and nothing more: the moment the file moves
  past it, it stops being the authority and the file is read again. A row this
  deployment has authored keeps phase 3's rule, which the test above holds.
*/
describe("rules that are only a copy of the file", () => {
  test("stop being the authority when a listing shows the file has moved past them", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: aliceWs,
      at: 30,
      rows: [{ path: "privacy.md", etag: "e8" }],
      gone: [],
      vanishedUnder: [],
    });
    // Nothing of the owner's is written over.
    expect(await exportsScheduled(t)).toBe(0);
    expect((await rowOf(t, aliceWs))?.exportOwed).not.toBe(true);
    // And the file decides again, as it did before the switch.
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toBeNull();
    expect(
      await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: null, ...TEAM_PROJECTS }),
    ).toBeNull();
    // So the next read of the file is stored, which it would not be while the rules were the authority.
    await t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: aliceWs,
      at: 40,
      mirror: { etag: "e8", invalid: false, ...PRIVATE_PLAN },
    });
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toEqual({
      etag: "e8",
      ...PRIVATE_PLAN,
    });
  });

  test("a file still at the version they were copied from leaves them the authority", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: aliceWs,
      at: 30,
      rows: [{ path: "privacy.md", etag: "e1" }],
      gone: [],
      vanishedUnder: [],
    });
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toEqual({
      etag: "e1",
      ...TEAM_PROJECTS,
    });
  });
});

/*
  Found by an audit of phase 3 (2026-10-13), each before the switch was ever on.
*/
describe("a file the owner edited past a copy", () => {
  /** Alice's rules authored here and exported at `e2`, so they are the authority. */
  async function authored() {
    const tenants = await authoritative();
    const swapped = await tenants.t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: tenants.aliceWs,
      expected: "e1",
      ...PRIVATE_PLAN,
    });
    await tenants.t.mutation(internal.functions.nodesPrivacy.exported, {
      workspaceId: tenants.aliceWs,
      rendered: versionOf(swapped),
      etag: "e2",
    });
    return tenants;
  }

  test("a write of the file while it was the authority leaves the rules a copy at the flip", async () => {
    // The owner's last change went through us, then they edited the file in
    // their own bucket; no sweep had read it when staff turned the switch on.
    const { t, aliceWs } = await twoConnectedTenants();
    await observeFile(t, aliceWs, "e1", 10);
    await t.mutation(internal.functions.nodesPrivacy.written, { workspaceId: aliceWs, previous: "e1", etag: "e2", at: 20, ...PRIVATE_PLAN });
    await setSwitch(t, true);
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: aliceWs,
      at: 30,
      rows: [{ path: "privacy.md", etag: "e3" }],
      gone: [],
      vanishedUnder: [],
    });
    // Their edit is read, never written over.
    expect(await exportsScheduled(t)).toBe(0);
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toBeNull();
  });

  test("the rules rendered by a run that began before is never stored as a read of the file", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: aliceWs,
      at: 30,
      rows: [{ path: "privacy.md", etag: "e8" }],
      gone: [],
      vanishedUnder: [],
    });
    expect((await rowOf(t, aliceWs))?.fileAhead).toBe(true);
    // The same run, still holding the rules, refreshes the mirror from its render.
    await t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: aliceWs,
      at: 31,
      mirror: { etag: "ctx-render", invalid: false, ...TEAM_PROJECTS },
    });
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e1", fileAhead: true });
    // And the file is read again at once, by a run that opens it as it is.
    const touches = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => (job.args[0] as { operation?: { kind?: string; files?: string[] } })?.operation?.kind === "nodesTouch",
      ),
    );
    expect(touches.map((job) => (job.args[0] as { operation: { files: string[] } }).operation.files)).toEqual([["privacy.md"]]);
  });

  test("a read of the file makes the rules a copy of it again", async () => {
    const { t, aliceWs } = await authored();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: aliceWs,
      at: 30,
      rows: [{ path: "privacy.md", etag: "e8" }],
      gone: [],
      vanishedUnder: [],
    });
    // Authored here: the owner's edit is put back (phase 3's rule).
    expect(await exportsScheduled(t)).toBe(2);
    const held = await rowOf(t, aliceWs);
    await t.mutation(internal.functions.nodesPrivacy.exported, { workspaceId: aliceWs, rendered: held!.etag!, etag: "e8b" });
    // Staff hand the authority back, and a sweep reads the file the owner edits next.
    await setSwitch(t, false);
    await observeFile(t, aliceWs, "e9", Date.now() + 60_000);
    expect((await rowOf(t, aliceWs))?.exportedEtag).toBeUndefined();
    await setSwitch(t, true);
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: aliceWs,
      at: 50,
      rows: [{ path: "privacy.md", etag: "e10" }],
      gone: [],
      vanishedUnder: [],
    });
    // A copy now: an edit past it is read, never exported over.
    expect(await exportsScheduled(t)).toBe(2);
    expect((await rowOf(t, aliceWs))?.fileAhead).toBe(true);
  });
});

describe("a storage move", () => {
  test("keeps the rules that are the authority and writes them to the new bucket", async () => {
    const { t, aliceWs } = await authoritative();
    await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: "e1", ...PRIVATE_PLAN });
    const before = await exportsScheduled(t);
    await t.run(async (ctx) => forgetWorkspaceTree(ctx, aliceWs, { storageMoved: true }));
    expect(await rowOf(t, aliceWs)).toMatchObject({ ...PRIVATE_PLAN, exportOwed: true });
    expect(await exportsScheduled(t)).toBe(before + 1);
  });

  test("forgets rules that are only a copy, and every rule when the workspace goes", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    await observeFile(t, aliceWs, "e1", 10);
    await t.run(async (ctx) => forgetWorkspaceTree(ctx, aliceWs, { storageMoved: true }));
    expect(await rowOf(t, aliceWs)).toBeNull();
    await observeFile(t, bobWs, "b1", 10);
    await setSwitch(t, true);
    await t.run(async (ctx) => forgetWorkspaceTree(ctx, bobWs));
    expect(await rowOf(t, bobWs)).toBeNull();
  });
});

describe("the staff switch", () => {
  test("hands the authority back only once every export is written", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const staff = t.withIdentity({
      subject: await t.run(async (ctx) => await ctx.db.insert("users", { email: ADMIN, emailVerificationTime: 1 } as never)),
    });
    await observeFile(t, aliceWs, "e1", 10);
    await staff.mutation(api.functions.nodesMigration.setPrivacyAuthority, { on: true });
    expect(await staff.query(api.functions.nodesMigration.report, {})).toMatchObject({ privacyAuthority: true, owedExports: 0 });
    await t.mutation(internal.functions.nodesPrivacy.write, { workspaceId: aliceWs, expected: "e1", ...PRIVATE_PLAN });
    expect((await staff.query(api.functions.nodesMigration.report, {})).owedExports).toBe(1);
    await expect(staff.mutation(api.functions.nodesMigration.setPrivacyAuthority, { on: false })).rejects.toThrow(
      /still being written/,
    );
    const row = await rowOf(t, aliceWs);
    await t.mutation(internal.functions.nodesPrivacy.exported, { workspaceId: aliceWs, rendered: row!.etag!, etag: "e2" });
    await staff.mutation(api.functions.nodesMigration.setPrivacyAuthority, { on: false });
    expect(await t.query(internal.functions.nodesPrivacy.authority, { workspaceId: aliceWs })).toBeNull();
  });
});

describe("the gateway's route", () => {
  const post = (t: T, body: Record<string, unknown>) => gatewayPost(t, "/gateway/privacy", body);

  test("changes the rules of the workspace the token reaches", async () => {
    const { t, aliceWs } = await authoritative();
    const answer = await bodyOf(
      await post(t, { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "write", expected: "e1", ...PRIVATE_PLAN }),
    );
    expect(answer).toMatchObject({ ok: true, swapped: { etag: expect.stringMatching(/^ctx-/) } });
    expect((await rowOf(t, aliceWs))?.notes).toEqual(PRIVATE_PLAN.notes);
  });

  test("never one it does not reach, and says nothing about it", async () => {
    const { t, aliceWs, bobWs } = await authoritative();
    await observeFile(t, bobWs, "b1", 10);
    for (const body of [
      { accessToken: ACCESS_A, expectedWorkspaceId: bobWs },
      { accessToken: token("nobody_at_all"), expectedWorkspaceId: aliceWs },
      { expectedWorkspaceId: aliceWs },
      { accessToken: ACCESS_A, ticket: "tkt", expectedWorkspaceId: aliceWs },
      { accessToken: ACCESS_B, expectedWorkspaceId: aliceWs },
    ]) {
      const answer = await bodyOf(await post(t, { ...body, op: "written", previous: null, etag: "x", ...PRIVATE_PLAN }));
      expect(answer).toEqual({ ok: false });
    }
    expect(await rowOf(t, bobWs)).toMatchObject({ etag: "b1", ...TEAM_PROJECTS });
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e1", ...TEAM_PROJECTS });
    // Without the gateway's secret, nothing at all.
    const bare = await gatewayPost(
      t,
      "/gateway/privacy",
      { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "owed" },
      { secret: null },
    );
    expect(bare.status).not.toBe(200);
  });

  test("never from a grant that cannot write the workspace", async () => {
    const { t, aliceWs, alice, bob } = await authoritative();
    const readOnly = token("read_only_alice");
    await seedConnectedClient(t, { workspaceId: aliceWs, userId: alice, clientId: CLIENT_B, accessToken: readOnly, scopes: ["context:read"] });
    // Bob, a member of Alice's workspace who may read it.
    await t.run(async (ctx) => ctx.db.insert("workspaceMembers", { workspaceId: aliceWs, userId: bob, role: "member", joinedAt: Date.now() }));
    for (const accessToken of [readOnly, ACCESS_B]) {
      const answer = await bodyOf(
        await post(t, { accessToken, expectedWorkspaceId: aliceWs, op: "write", expected: "e1", folders: [], notes: [] }),
      );
      expect(answer).toEqual({ ok: false });
    }
    expect(await rowOf(t, aliceWs)).toMatchObject({ etag: "e1", ...TEAM_PROJECTS });
  });

  test("refuses rules of the wrong shape", async () => {
    const { t, aliceWs } = await authoritative();
    for (const rules of [
      { folders: "1-projects: team", notes: [] },
      { folders: [{ prefix: "", visibility: "team" }], notes: [] },
      { folders: [], notes: [{ path: "x".repeat(2000), visibility: "team" }] },
    ]) {
      const answer = await bodyOf(
        await post(t, { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "write", expected: null, ...rules }),
      );
      expect(answer).toEqual({ ok: false });
    }
  });

  test("a queued move's ticket counts while its job holds the lease", async () => {
    const { t, alice, aliceWs, grantA } = await authoritative();
    const ticket = token("move_ticket");
    const now = Date.now();
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("gatewayJobs", {
        hashedTicket: await hashToken(ticket),
        workspaceId: aliceWs,
        actorUserId: alice,
        actorClientId: "client",
        grantId: grantA,
        kind: "materialize_move",
        status: "running",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60_000,
        leasedAt: now,
      }),
    );
    const owed = () => post(t, { ticket, expectedWorkspaceId: aliceWs, op: "owed" }).then(bodyOf);
    expect(await owed()).toEqual({ ok: true });
    await t.run(async (ctx) => ctx.db.patch(jobId, { status: "complete" }));
    expect(await owed()).toEqual({ ok: false });
  });

  test("the binding carries the rules while they are the authority", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await observeFile(t, aliceWs, "e1", 10);
    const before = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect(before).not.toHaveProperty("privacy");
    await setSwitch(t, true);
    const after = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect(after).toMatchObject({ privacy: { etag: "e1", ...TEAM_PROJECTS } });
  });
});
