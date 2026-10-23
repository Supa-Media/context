/**
 * The share dialog's server side: reading one row's list (`nodesAccess.shareList`), and writing a list and its
 * base together (`nodesAccess.setGrantees` with `base`, and grantees named by `userId`).
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the owner check in `shareListHandler`: "only the owner reads the list" fails;
 *  - read the folder's list for a note that has a base of its own: "a note with its own base" fails;
 *  - let a `userId` through without the member-or-held check: "a stranger by id" fails;
 *  - let `inherit` keep a list: "going back to the folder" fails;
 *  - drop the `listed` check in `consoleAccess`: "letting the workspace in keeps the list" fails.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTest } from "convex-test";
import { modules } from "../../test.setup";
import { asUser, addMember, createWorkspace } from "../fixtures.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

async function person(t: T, email: string, name?: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { email, name, emailVerificationTime: Date.now() } as never));
}

const FOLDER = "1-projects";
const PLAN = "1-projects/plan.md";
const DEEP = "1-projects/launch/budget.md";

async function world() {
  const t = makeTest();
  const owner = await person(t, "owner@example.test", "Owner");
  const member = await person(t, "member@example.test", "Mel");
  const kola = await person(t, "kola@example.test", "Kola");
  const stranger = await person(t, "stranger@example.test", "Stranger");
  const ownerB = await person(t, "ownerb@example.test");
  const ws = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  await addMember(t, ws, member, "member", owner);
  await addMember(t, ws, kola, "member", owner);
  await createWorkspace(t, kola, "kola", { kind: "personal" });
  await createWorkspace(t, ownerB, "globex", { kind: "shared", displayName: "Globex" });
  const leads = (await asUser(t, owner).mutation(api.functions.groups.createGroup, { workspaceId: ws, label: "leads" })).groupId;
  await asUser(t, owner).mutation(api.functions.groups.addGroupMember, { workspaceId: ws, groupId: leads, userId: member });
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    for (const path of [FOLDER, PLAN, "1-projects/launch", DEEP]) {
      await ctx.db.insert("nodes", {
        workspaceId: ws,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: path.endsWith(".md") ? "file" : "folder",
        observedAt: 1,
      });
    }
  });
  return { t, ws, owner, member, kola, stranger, ownerB, leads };
}
type World = Awaited<ReturnType<typeof world>>;

function list(w: World, who: Id<"users">, path: string) {
  return asUser(w.t, who).query(api.functions.nodesAccess.shareList, { workspaceId: w.ws, path });
}

function save(w: World, path: string, grantees: Array<Record<string, unknown>>, base?: "private" | "team" | "inherit") {
  return asUser(w.t, w.owner).mutation(api.functions.nodesAccess.setGrantees, {
    workspaceId: w.ws,
    path,
    grantees: grantees as never,
    ...(base === undefined ? {} : { base }),
  });
}

async function accessOn(w: World, path: string) {
  return await w.t.run(async (ctx) => {
    const row = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", path)).unique();
    return row?.access;
  });
}

describe("reading one row's list", () => {
  test("the owner reads a group with its live count, a member with their address, and an email", async () => {
    const w = await world();
    expect(await save(w, PLAN, [{ handle: "@acme-leads", role: "edit" }, { userId: w.kola, role: "view" }, { email: "Pat@Example.TEST", role: "view" }], "private")).toMatchObject({ ok: true });
    const answer = await list(w, w.owner, PLAN);
    expect(answer).toMatchObject({ kind: "file", base: "private", tier: "private", from: null });
    const byKind = Object.fromEntries((answer?.grantees ?? []).map((entry) => [entry.kind, entry]));
    expect(byKind.group).toMatchObject({ groupId: w.leads, count: 1, role: "edit" });
    expect(byKind.user).toMatchObject({ userId: w.kola, label: "Kola", detail: "kola@example.test", member: true, role: "view" });
    expect(byKind.email).toEqual({ kind: "email", email: "pat@example.test", role: "view" });
  });

  test("a note that sets nothing follows the nearest folder that does, and says which", async () => {
    const w = await world();
    await save(w, FOLDER, [{ userId: w.kola, role: "edit" }], "team");
    const answer = await list(w, w.owner, DEEP);
    expect(answer).toMatchObject({ base: null, tier: "team", from: FOLDER });
    expect(answer?.grantees.map((entry) => entry.kind)).toEqual(["user"]);
  });

  test("a note with its own base reads its own (empty) list, not the folder's", async () => {
    const w = await world();
    await save(w, FOLDER, [{ userId: w.kola, role: "edit" }], "team");
    await save(w, PLAN, [], "private");
    expect(await list(w, w.owner, PLAN)).toMatchObject({ base: "private", tier: "private", from: null, grantees: [] });
  });

  test("the domains that let people join are listed, switched-off ones are not", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workspaceDomains", { workspaceId: w.ws, domain: "acme.example", role: "member", enabled: true, addedBy: w.owner, addedAt: 1 } as never);
      await ctx.db.insert("workspaceDomains", { workspaceId: w.ws, domain: "old.example", role: "member", enabled: false, addedBy: w.owner, addedAt: 1 } as never);
    });
    expect((await list(w, w.owner, PLAN))?.domains).toEqual(["acme.example"]);
  });

  test("only the owner reads the list: a member, another tenant's owner and a missing path all get null", async () => {
    const w = await world();
    await save(w, PLAN, [{ email: "pat@example.test", role: "view" }], "private");
    expect(await list(w, w.member, PLAN)).toBeNull();
    expect(await list(w, w.ownerB, PLAN)).toBeNull();
    expect(await list(w, w.owner, "9-none/none.md")).toBeNull();
  });
});

describe("writing a list and its base together", () => {
  test("adding someone to a note in a team folder can keep the workspace in, in the same write", async () => {
    const w = await world();
    await save(w, FOLDER, [], "team");
    expect(await save(w, PLAN, [{ email: "pat@example.test", role: "view" }], "team")).toMatchObject({ ok: true });
    expect(await accessOn(w, PLAN)).toEqual({ base: "team" });
    expect(await list(w, w.owner, PLAN)).toMatchObject({ tier: "team", from: null });
  });

  test("going back to the folder clears the note's list, and a list with inherit is refused", async () => {
    const w = await world();
    await save(w, PLAN, [{ email: "pat@example.test", role: "view" }], "private");
    expect(await save(w, PLAN, [{ email: "pat@example.test", role: "view" }], "inherit")).toEqual({ ok: false, code: "INVALID" });
    expect(await save(w, PLAN, [], "inherit")).toMatchObject({ ok: true });
    expect(await accessOn(w, PLAN) ?? undefined).toBeUndefined();
    expect(await list(w, w.owner, PLAN)).toMatchObject({ base: null, grantees: [] });
  });

  test("a member by id is accepted; a stranger by id gets the one refusal, until some list here names them", async () => {
    const w = await world();
    expect(await save(w, PLAN, [{ userId: w.member, role: "view" }])).toMatchObject({ ok: true });
    const stranger = await save(w, PLAN, [{ userId: w.stranger, role: "view" }]);
    const nobody = await save(w, PLAN, [{ userId: "not-an-id", role: "view" }]);
    expect(stranger).toEqual({ ok: false, code: "GRANTEE_NOT_FOUND" });
    expect(nobody).toEqual(stranger);
    // A list here already names them (an outsider grant made before), so the dialog can send it back by id.
    await w.t.run(async (ctx) => {
      const folder = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", FOLDER)).unique();
      await ctx.db.insert("nodeAccess", { workspaceId: w.ws, nodeId: folder!._id, granteeKind: "user", granteeUserId: w.stranger, role: "view", at: 1, source: "owner" });
    });
    expect(await save(w, PLAN, [{ userId: w.stranger, role: "view" }])).toMatchObject({ ok: true });
    const answer = await list(w, w.owner, PLAN);
    // Someone outside is shown by name, never by their address.
    expect(answer?.grantees).toEqual([{ kind: "user", userId: w.stranger, label: "Stranger", member: false, role: "view" }]);
  });
});

describe("a list written from a stale read", () => {
  test("is refused as CONFLICT, and nothing is written", async () => {
    const w = await world();
    const read = (await list(w, w.owner, PLAN))!.version;
    await save(w, PLAN, [{ email: "first@example.test", role: "view" }], "private");
    const stale = await asUser(w.t, w.owner).mutation(api.functions.nodesAccess.setGrantees, {
      workspaceId: w.ws,
      path: PLAN,
      base: "private",
      grantees: [{ email: "second@example.test", role: "view" }],
      expectedVersion: read,
    });
    expect(stale).toEqual({ ok: false, code: "CONFLICT" });
    expect((await list(w, w.owner, PLAN))?.grantees).toEqual([{ kind: "email", email: "first@example.test", role: "view" }]);
  });
});

describe("the general access control keeps the people named on a note", () => {
  test("letting the workspace in keeps the list, even where the folder is already team", async () => {
    const w = await world();
    await save(w, FOLDER, [], "team");
    await save(w, PLAN, [{ email: "pat@example.test", role: "view" }], "private");
    const answer = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: PLAN,
      kind: "note",
      tier: "team",
    });
    expect(answer).toMatchObject({ ok: true, visibility: "team" });
    expect(await accessOn(w, PLAN)).toEqual({ base: "team" });
    expect((await list(w, w.owner, PLAN))?.grantees).toHaveLength(1);
  });
});
