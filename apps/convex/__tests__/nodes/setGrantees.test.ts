/**
 * The owner's own list (`nodesAccess.setGrantees`): the people and groups an owner names on a row, resolved the way
 * every addressed share resolves, and written as the row's list with its base kept.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the owner check in `setGranteesHandler`: "a member and an editor are refused" fails;
 *  - resolve a group without the workspace check: "a group of another workspace" fails;
 *  - return `NOT_FOUND` for a deleted person instead of `GRANTEE_NOT_FOUND`: "one refusal" fails;
 *  - skip the `normalizeId` check on a group id: "a malformed group id" throws instead of refusing.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { convexTest } from "convex-test";
import { modules } from "../../test.setup";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { asUser, addMember, createWorkspace } from "../fixtures.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

async function person(t: T, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never));
}

interface World {
  t: T;
  ws: Id<"workspaces">;
  owner: Id<"users">;
  editor: Id<"users">;
  member: Id<"users">;
  ana: Id<"users">;
  kola: Id<"users">;
  leads: Id<"workspaceGroups">;
  betaTeam: Id<"workspaceGroups">;
  ownerB: Id<"users">;
  beta: Id<"workspaces">;
}

/**
 * Tenant A ("acme") with an owner, an editor and a member; tenant B ("beta") with its own owner and a group.
 * `ana` owns a personal context named `ana` and is not a member of acme; `kola` is a member who owns `kola`.
 */
async function world(): Promise<World> {
  const t = makeTest();
  const owner = await person(t, "owner@example.test");
  const editor = await person(t, "editor@example.test");
  const member = await person(t, "member@example.test");
  const ana = await person(t, "ana@example.test");
  const kola = await person(t, "kola@example.test");
  const ownerB = await person(t, "ownerb@example.test");
  const ws = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  await addMember(t, ws, editor, "editor", owner);
  await addMember(t, ws, member, "member", owner);
  await addMember(t, ws, kola, "member", owner);
  await createWorkspace(t, ana, "ana", { kind: "personal" });
  await createWorkspace(t, kola, "kola", { kind: "personal" });
  const beta = await createWorkspace(t, ownerB, "globex", { kind: "shared", displayName: "Globex" });
  const leads = (await asUser(t, owner).mutation(api.functions.groups.createGroup, { workspaceId: ws, label: "leads" })).groupId;
  const betaTeam = (await asUser(t, ownerB).mutation(api.functions.groups.createGroup, { workspaceId: beta, label: "crew" })).groupId;
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    for (const path of ["1-projects", "1-projects/plan.md"]) {
      await ctx.db.insert("nodes", { workspaceId: ws, path, name: path.slice(path.lastIndexOf("/") + 1), kind: path.endsWith(".md") ? "file" : "folder", observedAt: 1 });
    }
  });
  return { t, ws, owner, editor, member, ana, kola, leads, betaTeam, ownerB, beta };
}

const PLAN = "1-projects/plan.md";

async function grantsOn(t: T, ws: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).eq("path", path)).unique();
    if (row === null) throw new Error(`no row at ${path}`);
    return await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect();
  });
}

async function accessOn(t: T, ws: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).eq("path", path)).unique();
    return row?.access;
  });
}

function setGrantees(w: World, who: Id<"users">, path: string, grantees: Array<Record<string, unknown>>) {
  return asUser(w.t, who).mutation(api.functions.nodesAccess.setGrantees, {
    workspaceId: w.ws,
    path,
    grantees: grantees as never,
  });
}

describe("the owner's list: who may set it, and what it writes", () => {
  test("the owner sets a group, a member's handle and an email, with mixed roles, and reads them back", async () => {
    const w = await world();
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: PLAN, base: "team", actor: { userId: w.owner, role: "owner" } }),
    );
    const answer = await setGrantees(w, w.owner, PLAN, [
      { groupId: w.leads, role: "view" },
      { handle: "@kola", role: "edit" },
      { email: "  Dev@Example.TEST ", role: "edit" },
    ]);
    expect(answer).toMatchObject({ ok: true });
    const grants = await grantsOn(w.t, w.ws, PLAN);
    const readBack = grants
      .map((grant) => `${grant.granteeKind}|${grant.granteeGroupId ?? grant.granteeUserId ?? grant.granteeEmail}|${grant.role}|${grant.source}`)
      .sort();
    expect(readBack).toEqual(
      [
        `group|${w.leads}|view|owner`,
        `user|${w.kola}|edit|owner`,
        `email|dev@example.test|edit|owner`,
      ].sort(),
    );
    // The base the owner set is kept by a list change.
    expect(await accessOn(w.t, w.ws, PLAN)).toEqual({ base: "team" });
  });

  test("someone outside the workspace is not named by handle: the answer is the one an unclaimed handle gets", async () => {
    const w = await world();
    const outsider = await setGrantees(w, w.owner, PLAN, [{ handle: "ana", role: "view" }]);
    const nobody = await setGrantees(w, w.owner, PLAN, [{ handle: "nobody-holds-this", role: "view" }]);
    expect(outsider).toEqual({ ok: false, code: "GRANTEE_NOT_FOUND" });
    expect(nobody).toEqual(outsider);
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });

  test("the row's base is kept, and an empty list clears the owner's list", async () => {
    const w = await world();
    await setGrantees(w, w.owner, PLAN, [{ groupId: w.leads, role: "view" }]);
    await w.t.run(async (ctx) => {
      const row = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", PLAN)).unique();
      await ctx.db.patch(row!._id, { access: { base: "team" } });
    });
    expect(await setGrantees(w, w.owner, PLAN, [])).toMatchObject({ ok: true });
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
    expect(await accessOn(w.t, w.ws, PLAN)).toEqual({ base: "team" });
  });

  test("an editor and a member are refused with FORBIDDEN, and nothing is written", async () => {
    const w = await world();
    for (const who of [w.editor, w.member]) {
      expect(await setGrantees(w, who, PLAN, [{ groupId: w.leads, role: "view" }])).toEqual({ ok: false, code: "FORBIDDEN" });
    }
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });

  test("a non-member owner of another workspace gets the answer a path that does not exist gets, and nothing is written", async () => {
    const w = await world();
    const otherTenant = await setGrantees(w, w.ownerB, PLAN, [{ groupId: w.leads, role: "view" }]);
    const missingPath = await setGrantees(w, w.owner, "9-missing/none.md", [{ groupId: w.leads, role: "view" }]);
    expect(otherTenant).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(JSON.stringify(otherTenant)).toBe(JSON.stringify(missingPath));
    // Tenant B's owner cannot even name the row in tenant B: it is not there either.
    expect(await setGrantees(w, w.ownerB, PLAN, [])).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });

  test("outside rows mode nothing is written", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const row = await ctx.db.query("nodeMigration").first();
      await ctx.db.patch(row!._id, { accessSource: "file" });
    });
    expect(await setGrantees(w, w.owner, PLAN, [{ groupId: w.leads, role: "view" }])).toEqual({ ok: false, code: "NOT_ROWS_MODE" });
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });

  test("a shape error is INVALID: an entry naming two of handle, group and email, and a list over the cap", async () => {
    const w = await world();
    expect(await setGrantees(w, w.owner, PLAN, [{ handle: "@kola", email: "kola@example.test", role: "view" }])).toEqual({ ok: false, code: "INVALID" });
    expect(await setGrantees(w, w.owner, PLAN, [{ role: "view" }])).toEqual({ ok: false, code: "INVALID" });
    const emails = Array.from({ length: 101 }, (_, i) => ({ email: `user${i}@example.test`, role: "view" }));
    expect(await setGrantees(w, w.owner, PLAN, emails)).toEqual({ ok: false, code: "INVALID" });
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });
});

describe("one refusal for every grantee that does not resolve", () => {
  test("a group of another workspace, an unknown handle, a shared context's name, a deleted person, and malformed ids and emails give one identical refusal, and nothing is written", async () => {
    const w = await world();
    const deleted = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "gone@example.test", emailVerificationTime: 1 } as never);
      await ctx.db.insert("names", { name: "gone", kind: "user", userId: id, claimedBy: id, claimedAt: 1 });
      await ctx.db.delete(id);
      return id;
    });
    expect(deleted).toBeDefined();
    const refused = [
      { groupId: w.betaTeam, role: "view" },
      { handle: "@globex-crew", role: "view" },
      { handle: "@nobody-claims-this", role: "view" },
      { handle: "globex", role: "view" },
      { handle: "@gone", role: "view" },
      { groupId: "not-an-id", role: "view" },
      { email: "not an email", role: "view" },
      { email: "", role: "view" },
    ];
    const answers = [];
    for (const entry of refused) answers.push(await setGrantees(w, w.owner, PLAN, [entry]));
    // Byte-identical: the same JSON for every one of them, and that refusal and nothing else.
    const once = JSON.stringify(answers[0]);
    expect(answers.every((answer) => JSON.stringify(answer) === once)).toBe(true);
    expect(answers[0]).toEqual({ ok: false, code: "GRANTEE_NOT_FOUND" });
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });

  test("one entry that does not resolve refuses the whole list, and the others are not written", async () => {
    const w = await world();
    expect(await setGrantees(w, w.owner, PLAN, [{ groupId: w.leads, role: "view" }, { handle: "@nobody-claims-this", role: "edit" }])).toEqual({
      ok: false,
      code: "GRANTEE_NOT_FOUND",
    });
    expect(await grantsOn(w.t, w.ws, PLAN)).toHaveLength(0);
  });

  test("a member's handle with and without the sigil resolves to the same person", async () => {
    const w = await world();
    await setGrantees(w, w.owner, PLAN, [{ handle: "@kola", role: "view" }]);
    const withSigil = await grantsOn(w.t, w.ws, PLAN);
    await setGrantees(w, w.owner, PLAN, [{ handle: "kola", role: "view" }]);
    const without = await grantsOn(w.t, w.ws, PLAN);
    expect(withSigil.map((g) => g.granteeUserId)).toEqual([w.kola]);
    expect(without.map((g) => g.granteeUserId)).toEqual([w.kola]);
  });

  test("the audit row of a list the owner set holds the owner, the row, and no raw email", async () => {
    const w = await world();
    await setGrantees(w, w.owner, PLAN, [{ email: "Dev@Example.TEST", role: "view" }]);
    const events = await w.t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === "access.list"));
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(w.owner);
    expect(JSON.stringify(events[0]).toLowerCase()).not.toContain("dev@example.test");
  });
});

describe("the console's group verbs are unchanged", () => {
  test("a group verb still gives the row a list of that group", async () => {
    const w = await world();
    const named = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: PLAN,
      kind: "note",
      group: "acme-leads",
    });
    expect(named).toMatchObject({ ok: true, visibility: "@acme-leads" });
    expect((await grantsOn(w.t, w.ws, PLAN)).map((g) => g.granteeGroupId)).toEqual([w.leads]);
  });
});
