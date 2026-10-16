/**
 * Rows as the truth (privacy-rows plan PR 3, `lib/nodes/setAccess.ts`): once
 * `nodeMigration.accessSource` is `rows`, an owner's change to a row is the
 * row's access, derivations never clobber it, a move carries its narrowing on
 * the row, the console and the gateway write rows, and going back to Off writes
 * the rows back as the rules they describe.
 *
 * Sabotage (run by hand, both must fail):
 *  - drop the delete of the row's owner list in `setAccessRow`: "a list replaces" fails;
 *  - drop the `FORBIDDEN` check on a list change: "an editor may set a base" fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { refreshAccess, deriveAccess } from "../../functions/lib/nodes/accessBackfill";
import { narrowRowForMove, setAccessRow } from "../../functions/lib/nodes/setAccess";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { gatewayPost, errorCode } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "../controlPlane/fixtures.helpers";
import { fixture } from "../files/fixtures.helpers";
import { asUser } from "../fixtures.helpers";
import { ADMIN, boundWorkspace, user } from "../noteIds/noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

interface World {
  t: T;
  ws: Id<"workspaces">;
  other: Id<"workspaces">;
  owner: Id<"users">;
  editor: Id<"users">;
  leads: Id<"workspaceGroups">;
  betaTeam: Id<"workspaceGroups">;
}

/** Two shared workspaces, an owner, an editor, a group here and a group of the other workspace. */
async function world(): Promise<World> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    const editor = await ctx.db.insert("users", { email: "editor@example.test", emailVerificationTime: now } as never);
    const shared = (slug: string) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy: owner,
        kind: "shared",
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await shared("acme");
    const other = await shared("beta");
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: editor, role: "editor", joinedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    const betaTeam = await ctx.db.insert("workspaceGroups", { workspaceId: other, name: "beta-team", createdBy: owner, createdAt: now });
    return { ws, other, owner, editor, leads, betaTeam };
  });
  return { t, ...ids };
}

/** Insert tree rows. A path ending in `/` is a folder; so is one with no dot in its last segment. */
async function addRows(t: T, ws: Id<"workspaces">, paths: string[]): Promise<void> {
  await t.run(async (ctx) => {
    for (const raw of paths) {
      const path = raw.replace(/\/$/, "");
      const last = path.slice(path.lastIndexOf("/") + 1);
      const kind = raw.endsWith("/") || !last.includes(".") ? "folder" : "file";
      await ctx.db.insert("nodes", { workspaceId: ws, path, name: last, kind, observedAt: 1 });
    }
  });
}

async function setSource(t: T, accessSource: "file" | "shadow" | "rows"): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, accessSource, updatedAt: 1 });
    else await ctx.db.patch(row._id, { accessSource });
  });
}

async function rowAt(t: T, ws: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).eq("path", path))
      .unique(),
  );
}

async function grantsOn(t: T, ws: Id<"workspaces">, path: string) {
  const row = await rowAt(t, ws, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return await t.run(async (ctx) =>
    ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row._id))
      .collect(),
  );
}

async function versionOf(t: T, ws: Id<"workspaces">): Promise<number> {
  return await t.run(async (ctx) => {
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
      .unique();
    return state?.version ?? 0;
  });
}

function owner(w: World) {
  return { userId: w.owner, role: "owner" as const };
}

describe("setAccess: the rows are the truth", () => {
  test("a change from a version the caller did not read is a conflict, and nothing changes", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/"]);
    const first = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects", base: "team", actor: owner(w), expectedVersion: 0 }),
    );
    expect(first).toEqual({ ok: true, version: 1 });
    const stale = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects", base: "private", actor: owner(w), expectedVersion: 0 }),
    );
    expect(stale).toEqual({ ok: false, code: "CONFLICT" });
    expect((await rowAt(w.t, w.ws, "1-projects"))?.access).toEqual({ base: "team" });
    expect(await versionOf(w.t, w.ws)).toBe(1);
  });

  test("inherit clears the row's own base, and every change bumps the version", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/", "1-projects/plan.md"]);
    await w.t.run(async (ctx) => setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", actor: owner(w) }));
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toEqual({ base: "private" });
    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "inherit", actor: owner(w) }),
    );
    expect(answer).toEqual({ ok: true, version: 2 });
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toBeUndefined();
  });

  test("a list replaces the owner's list, and a share on the row is left alone", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/", "1-projects/plan.md"]);
    const row = await rowAt(w.t, w.ws, "1-projects/plan.md");
    await w.t.run(async (ctx) =>
      ctx.db.insert("nodeAccess", {
        workspaceId: w.ws,
        nodeId: row!._id,
        granteeKind: "user",
        granteeUserId: w.editor,
        role: "view",
        at: 1,
        source: "share",
      }),
    );
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: w.ws,
        path: "1-projects/plan.md",
        base: "private",
        grantees: [{ kind: "email", email: "  Kola@Example.TEST ", role: "view" }],
        actor: owner(w),
      }),
    );
    const grants = await grantsOn(w.t, w.ws, "1-projects/plan.md");
    const owned = grants.filter((grant) => grant.source === "owner");
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ granteeKind: "email", granteeEmail: "kola@example.test", grantedBy: w.owner });
    expect(grants.filter((grant) => grant.source === "share")).toHaveLength(1);
  });

  test("an editor may set a base, but not change a list", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/", "1-projects/plan.md"]);
    const editor = { userId: w.editor, role: "editor" as const };
    const tier = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "team", actor: editor }),
    );
    expect(tier).toMatchObject({ ok: true });
    const list = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: w.ws,
        path: "1-projects/plan.md",
        base: "private",
        grantees: [{ kind: "group", groupId: w.leads, role: "view" }],
        actor: editor,
      }),
    );
    expect(list).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toHaveLength(0);
  });

  test("a row is never created: a base on a path with no row waits as pending, and a group of another workspace is refused", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/"]);
    // The base waits for the row (`pendingAccess.ts`); no row is made here.
    expect(
      await w.t.run(async (ctx) => setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "2-areas", base: "team", actor: owner(w) })),
    ).toMatchObject({ ok: true });
    expect(await rowAt(w.t, w.ws, "2-areas")).toBeNull();
    expect(
      await w.t.run(async (ctx) =>
        setAccessRow(ctx as MutationCtx, {
          workspaceId: w.ws,
          path: "1-projects",
          base: "private",
          grantees: [{ kind: "group", groupId: w.betaTeam, role: "view" }],
          actor: owner(w),
        }),
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await grantsOn(w.t, w.ws, "1-projects")).toHaveLength(0);
  });

  test("the console's group verb in rows mode gives the row a list of that group, and inherit where a tier is what it inherits", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/", "1-projects/plan.md", "1-projects/other.md"]);
    await setSource(w.t, "rows");
    const named = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: "1-projects/plan.md",
      kind: "note",
      group: "acme-leads",
    });
    expect(named).toEqual({ ok: true, path: "1-projects/plan.md", visibility: "@acme-leads", inherited: "private", exception: true });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toMatchObject([{ granteeKind: "group", granteeGroupId: w.leads, source: "owner" }]);
    const refused = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: "1-projects/other.md",
      kind: "note",
      group: "beta-team",
    });
    expect(refused).toEqual({ ok: false, code: "GROUP_NOT_FOUND" });
    // The folder above is private by default, so "private" on a note is what it inherits: no row of its own.
    const tier = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: "1-projects/other.md",
      kind: "note",
      tier: "private",
    });
    expect(tier).toEqual({ ok: true, path: "1-projects/other.md", visibility: "private", inherited: "private", exception: false });
    expect((await rowAt(w.t, w.ws, "1-projects/other.md"))?.access).toBeUndefined();
  });

  test("a refresh in rows mode keeps an owner's base and list: nothing is derived from the rules", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["1-projects/", "1-projects/plan.md"]);
    await setSource(w.t, "rows");
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: w.ws,
        path: "1-projects",
        base: "team",
        grantees: [{ kind: "group", groupId: w.leads, role: "view" }],
        actor: owner(w),
      }),
    );
    // The rules say the folder is private. In rows mode they are not read to decide the rows.
    await w.t.run(async (ctx) => {
      await ctx.db.insert("nodePrivacy", {
        workspaceId: w.ws,
        etag: "e1",
        invalid: false,
        folders: [{ prefix: "1-projects", visibility: "private" }],
        notes: [],
        observedAt: 1,
      });
      await refreshAccess(ctx as MutationCtx, w.ws);
    });
    expect((await rowAt(w.t, w.ws, "1-projects"))?.access).toEqual({ base: "team" });
    expect(await grantsOn(w.t, w.ws, "1-projects")).toMatchObject([{ granteeKind: "group", source: "owner" }]);
  });

  test("a folder moved into a wider folder keeps its narrowing on its row, and a move that does not widen writes nothing", async () => {
    const w = await world();
    await addRows(w.t, w.ws, ["2-areas/", "2-areas/memo.md", "1-projects/", "3-archive/", "1-projects/sub/"]);
    const folder = await rowAt(w.t, w.ws, "1-projects");
    await w.t.run(async (ctx) => {
      await ctx.db.patch(folder!._id, { access: { base: "team" } });
    });
    // A private folder moved into a team folder: the row takes the narrowing the file used to carry.
    await w.t.run(async (ctx) => narrowRowForMove(ctx as MutationCtx, w.ws, "2-areas", "1-projects/areas"));
    expect((await rowAt(w.t, w.ws, "2-areas"))?.access).toEqual({ base: "private" });
    // A team folder moved into a private one is already narrower where it lands: nothing to write.
    await w.t.run(async (ctx) => narrowRowForMove(ctx as MutationCtx, w.ws, "1-projects", "3-archive/projects"));
    expect((await rowAt(w.t, w.ws, "1-projects"))?.access).toEqual({ base: "team" });
  });
});

describe("the gateway's setAccess op", () => {
  const post = (t: T, body: Record<string, unknown>) => gatewayPost(t, "/gateway/privacy", body);

  async function tenantsWithRows() {
    const tenants = await twoConnectedTenants();
    await tenants.t.run(async (ctx) => {
      const now = Date.now();
      for (const path of ["1-projects", "1-projects/plan.md"]) {
        await ctx.db.insert("nodes", {
          workspaceId: tenants.aliceWs,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          kind: path.endsWith(".md") ? "file" : "folder",
          observedAt: now,
        });
      }
    });
    return tenants;
  }

  test("in rows mode it sets the row for the grant's person, and says the version it made", async () => {
    const { t, aliceWs } = await tenantsWithRows();
    await setSource(t, "rows");
    const answer = await bodyOf(
      await post(t, { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "team" }),
    );
    expect(answer).toEqual({ ok: true, version: 1 });
    expect((await rowAt(t, aliceWs, "1-projects"))?.access).toEqual({ base: "team" });
    const stale = await bodyOf(
      await post(t, { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "private", expectedVersion: 0 }),
    );
    expect(stale).toEqual({ ok: false, code: "CONFLICT" });
  });

  test("outside rows mode it writes nothing", async () => {
    const { t, aliceWs } = await tenantsWithRows();
    const answer = await bodyOf(
      await post(t, { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "team" }),
    );
    expect(answer).toEqual({ ok: false, code: "NOT_ROWS_MODE" });
    expect((await rowAt(t, aliceWs, "1-projects"))?.access).toBeUndefined();
  });

  test("the rules' writes are refused in rows mode, before anything is read or written", async () => {
    const { t, aliceWs } = await tenantsWithRows();
    await setSource(t, "rows");
    for (const op of ["write", "written", "exported", "owed"]) {
      const answer = await bodyOf(
        await post(t, {
          accessToken: ACCESS_A,
          expectedWorkspaceId: aliceWs,
          op,
          expected: null,
          folders: [],
          notes: [],
          previous: null,
          etag: "e9",
          rendered: "x",
        }),
      );
      expect(answer).toEqual({ ok: false, code: "ROWS_MODE" });
    }
  });

  test("a malformed body and another tenant's workspace are refused", async () => {
    const { t, aliceWs, bobWs } = await tenantsWithRows();
    await setSource(t, "rows");
    expect(
      await bodyOf(await post(t, { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "everyone" })),
    ).toEqual({ ok: false, code: "INVALID" });
    const crossed = await post(t, { accessToken: ACCESS_B, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "team" });
    expect(await bodyOf(crossed)).toEqual({ ok: false });
    expect(bobWs).toBeDefined();
    expect((await rowAt(t, aliceWs, "1-projects"))?.access).toBeUndefined();
  });
});

describe("back to Off from rows", () => {
  /** A bound workspace whose rules are the file's, its rows derived from them, and the rows then taken over. */
  async function rowsWorkspace(): Promise<{ t: T; ws: Id<"workspaces">; leads: Id<"workspaceGroups">; owner: Id<"users"> }> {
    const t = makeTest();
    const ws = await boundWorkspace(t, "acme");
    const owner = await user(t, "owner@example.test");
    const leads = await t.run(async (ctx) =>
      ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: 1 }),
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodePrivacy", {
        workspaceId: ws,
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
        await ctx.db.insert("nodes", { workspaceId: ws, path, name: path.slice(path.lastIndexOf("/") + 1), kind, observedAt: now });
      }
      await deriveAccess(ctx as MutationCtx, ws);
    });
    await setSource(t, "rows");
    return { t, ws, leads, owner };
  }

  async function staff(t: T) {
    return t.withIdentity({ subject: await user(t, ADMIN) });
  }

  test("writes the rows back as rules that answer what the rows answer", async () => {
    const { t, ws, leads, owner } = await rowsWorkspace();
    await t.run(async (ctx) => {
      await setAccessRow(ctx as MutationCtx, {
        workspaceId: ws,
        path: "1-projects/plan.md",
        base: "private",
        grantees: [{ kind: "group", groupId: leads, role: "view" }],
        actor: { userId: owner, role: "owner" },
      });
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeMigration").first();
      await ctx.db.patch(row!._id, { privacyAuthority: true });
    });
    await (await staff(t)).mutation(api.functions.privacyRows.backToOff, {});
    const rules = await t.run(async (ctx) =>
      ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).unique(),
    );
    expect(rules?.notes).toEqual(
      expect.arrayContaining([
        { path: "1-projects/plan.md", visibility: "@acme-leads" },
        { path: "2-areas/memo.md", visibility: "team" },
      ]),
    );
    expect(rules?.folders).toEqual(
      expect.arrayContaining([
        { prefix: "1-projects", visibility: "team" },
        { prefix: "2-areas", visibility: "private" },
      ]),
    );
    expect(rules?.exportOwed).toBe(true);
    // Every row answers under the rules as the rows did: the parity check finds no difference.
    const parity = await t.query(internal.functions.nodesPrivacy.accessParity, { workspaceId: ws });
    expect(parity.diffs).toEqual([]);
    expect(parity.checked).toBeGreaterThan(0);
  });

  test("refused, naming the paths, when a row needs an email or an edit grant, and nothing changes", async () => {
    const { t, ws } = await rowsWorkspace();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).eq("path", "1-projects/plan.md")).unique();
      await ctx.db.insert("nodeAccess", { workspaceId: ws, nodeId: row!._id, granteeKind: "email", granteeEmail: "kola@example.test", role: "view", at: 1, source: "owner" });
      const flag = await ctx.db.query("nodeMigration").first();
      await ctx.db.patch(flag!._id, { privacyAuthority: true });
    });
    const error = await (await staff(t))
      .mutation(api.functions.privacyRows.backToOff, {})
      .then(() => null, (caught: unknown) => caught);
    expect(errorCode(error)).toBe("ROWS_NOT_REPRESENTABLE");
    expect((error as { data: { paths: string[] } }).data.paths).toEqual(["1-projects/plan.md"]);
    const source = await t.run(async (ctx) => (await ctx.db.query("nodeMigration").first())?.accessSource);
    expect(source).toBe("rows");
    const rules = await t.run(async (ctx) => ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).unique());
    expect(rules?.etag).toBe("v1");
  });
});

describe("the console in rows mode", () => {
  test("a folder's default and a note's tier are written to the rows, and privacy.md is left as it was", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    });
    const before = f.backend.snapshot()[PRIVACY_KEY];
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      visibility: "private",
    });
    const folder = await rowAt(f.t, f.workspaceId, "1-projects");
    const note = await rowAt(f.t, f.workspaceId, "1-projects/shared.md");
    expect(folder?.access).toEqual({ base: "team" });
    // The folder is team now, so a private note is an exception to it.
    expect(note?.access).toEqual({ base: "private" });
    expect(f.backend.snapshot()[PRIVACY_KEY]).toBe(before);
  });

  test("a path with no row is 'does not exist' in rows mode, where the file mode would have written an exception", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    });
    const error = await asUser(f.t, f.owner)
      .action(api.functions.files.setNoteVisibility, { workspaceId: f.workspaceId, path: "9-missing/none.md", visibility: "team" })
      .then(() => null, (caught: unknown) => caught);
    expect(errorCode(error)).toBe("FILE_NOT_FOUND");
  });

  test("the rules' privacy-reset is refused in rows mode, since there is no file to repair", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    });
    const error = await asUser(f.t, f.owner)
      .action(api.functions.files.resetPrivacy, { workspaceId: f.workspaceId })
      .then(() => null, (caught: unknown) => caught);
    expect(errorCode(error)).toBe("PRIVACY_MANIFEST_USABLE");
  });
});
