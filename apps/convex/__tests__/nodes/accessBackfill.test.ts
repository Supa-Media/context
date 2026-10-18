/**
 * The access rows derived from a workspace's privacy rules (phase 1 of
 * `docs/decisions/app-and-console/convex-tree.md`, PR 1: inert, nothing reads
 * `nodes.access` yet). The derivation is checked against the rules the
 * engine already enforces: a folder rule sets its folder row, a note override
 * (with its case-fold twins, `overrideFor`) sets its note row, a group or a
 * person sets a view grant on top of a private base, and a handle that
 * resolves to nothing fails closed.
 *
 * Sabotage: replace `overrideFor` in `accessBackfill.ts` with an exact-key
 * lookup and the case-fold test fails; drop the `source` filter in the grant
 * sync and the share-row test fails; remove the `access` filter from
 * `observedBefore` and the prune test fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { deriveAccess, deriveAccessPage } from "../../functions/lib/nodes/accessBackfill";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";
import { pruneUnobserved } from "../../functions/lib/nodes/observe";
import { forgetWorkspaceTree } from "../../functions/nodesPurge";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { keyedFixture } from "./keyedFixture.helpers";
import { start } from "./moveFixture.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;
type Folder = { prefix: string; visibility: string };
type Note = { path: string; visibility: string };

interface World {
  t: T;
  ws: Id<"workspaces">;
  owner: Id<"users">;
  kola: Id<"users">;
  acmeLeads: Id<"workspaceGroups">;
}

async function setup(): Promise<World> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const owner = await user("owner@example.test");
    const kola = await user("kola@example.test");
    const workspace = (slug: string, kind: "shared" | "personal", createdBy: Id<"users">) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy,
        kind,
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await workspace("acme", "shared", owner);
    const beta = await workspace("beta", "shared", owner);
    const personal = await workspace("kola", "personal", kola);
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: personal, userId: kola, role: "owner", joinedAt: now });
    // `@kola` names a person through their personal context's slug (`identities.ts`).
    await ctx.db.insert("names", { name: "kola", kind: "workspace", workspaceId: personal, claimedBy: kola, claimedAt: now });
    const acmeLeads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    await ctx.db.insert("names", { name: "acme-leads", kind: "group", groupId: acmeLeads, claimedBy: owner, claimedAt: now });
    // A group of another workspace, named in this one's rules: it must resolve to nothing here.
    const betaTeam = await ctx.db.insert("workspaceGroups", { workspaceId: beta, name: "beta-team", createdBy: owner, createdAt: now });
    await ctx.db.insert("names", { name: "beta-team", kind: "group", groupId: betaTeam, claimedBy: owner, claimedAt: now });
    return { ws, owner, kola, acmeLeads };
  });
  return { t, ...ids };
}

/** Write the workspace's rules, as `nodePrivacy` holds them. */
async function setRules(w: World, folders: Folder[], notes: Note[] = []): Promise<void> {
  await w.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws))
      .unique();
    const fields = { etag: "v1", invalid: false, folders, notes, observedAt: 1 };
    if (row === null) await ctx.db.insert("nodePrivacy", { workspaceId: w.ws, ...fields });
    else await ctx.db.patch(row._id, fields);
  });
}

/** Insert tree rows. A path ending in `/` is a folder; so is one with no dot in its last segment. */
async function addRows(w: World, paths: string[]): Promise<void> {
  await w.t.run(async (ctx) => {
    for (const raw of paths) {
      const path = raw.replace(/\/$/, "");
      const last = path.slice(path.lastIndexOf("/") + 1);
      const kind = raw.endsWith("/") || !last.includes(".") ? "folder" : "file";
      await ctx.db.insert("nodes", { workspaceId: w.ws, path, name: last, kind, observedAt: 1 });
    }
  });
}

async function derive(w: World): Promise<void> {
  await w.t.run(async (ctx) => {
    await deriveAccess(ctx as MutationCtx, w.ws);
  });
}

async function rowAt(w: World, path: string): Promise<Doc<"nodes"> | null> {
  return await w.t.run(async (ctx) =>
    await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", path))
      .unique(),
  );
}

async function accessOf(w: World, path: string): Promise<{ base: string } | null> {
  const row = await rowAt(w, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return row.access ?? null;
}

async function grantsAt(w: World, path: string) {
  const row = await rowAt(w, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return await w.t.run(async (ctx) =>
    (await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect()).map((grant) => ({
      kind: grant.granteeKind,
      userId: grant.granteeUserId,
      groupId: grant.granteeGroupId,
      role: grant.role,
      source: grant.source,
    })),
  );
}

async function stateOf(w: World) {
  return await w.t.run(async (ctx) =>
    await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws))
      .unique(),
  );
}

/** Every row's access and every grant, sorted, so two runs can be compared. */
async function snapshot(w: World) {
  return await w.t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws)).collect();
    const grants = await ctx.db.query("nodeAccess").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).collect();
    return {
      access: rows.map((row) => JSON.stringify([row.path, row.access ?? null])).sort(),
      grants: grants
        .map((grant) =>
          JSON.stringify([grant.nodeId, grant.granteeKind, grant.granteeUserId ?? null, grant.granteeGroupId ?? null, grant.role, grant.source]),
        )
        .sort(),
    };
  });
}

describe("folder rules", () => {
  test("a team folder and a private folder set their own rows, and files inherit", async () => {
    const w = await setup();
    await setRules(w, [
      { prefix: "2-areas", visibility: "team" },
      { prefix: "1-projects", visibility: "private" },
    ]);
    await addRows(w, ["2-areas/", "2-areas/a.md", "1-projects/", "1-projects/b.md"]);
    await derive(w);
    expect(await accessOf(w, "2-areas")).toEqual({ base: "team" });
    expect(await accessOf(w, "1-projects")).toEqual({ base: "private" });
    expect(await accessOf(w, "2-areas/a.md")).toBeNull();
    expect(await accessOf(w, "1-projects/b.md")).toBeNull();
  });

  test("nested private inside team inside private: each folder carries its own rule", async () => {
    const w = await setup();
    await setRules(w, [
      { prefix: "2-areas", visibility: "team" },
      { prefix: "2-areas/hr", visibility: "private" },
      { prefix: "2-areas/hr/deep", visibility: "team" },
    ]);
    await addRows(w, ["2-areas/", "2-areas/hr/", "2-areas/hr/deep/", "2-areas/hr/deep/x.md", "2-areas/hr/y.md"]);
    await derive(w);
    expect(await accessOf(w, "2-areas")).toEqual({ base: "team" });
    expect(await accessOf(w, "2-areas/hr")).toEqual({ base: "private" });
    expect(await accessOf(w, "2-areas/hr/deep")).toEqual({ base: "team" });
    expect(await accessOf(w, "2-areas/hr/deep/x.md")).toBeNull();
    expect(await accessOf(w, "2-areas/hr/y.md")).toBeNull();
  });

  test("a folder rule that names a note (a move's carry rule) sets that note's row; with no row it is an orphan, not a folder", async () => {
    const w = await setup();
    await setRules(w, [
      { prefix: "3-resources", visibility: "team" },
      { prefix: "3-resources/codes.md", visibility: "private" },
    ]);
    await addRows(w, ["3-resources/", "3-resources/codes.md"]);
    await derive(w);
    expect(await accessOf(w, "3-resources/codes.md")).toEqual({ base: "private" });
    expect(await accessOf(w, "3-resources")).toEqual({ base: "team" });
    // A carry rule naming a note with no row yet makes no row where the note will land.
    await setRules(w, [{ prefix: "3-resources/later.md", visibility: "private" }]);
    await derive(w);
    expect(await rowAt(w, "3-resources/later.md")).toBeNull();
    expect((await stateOf(w))?.orphans).toEqual([{ kind: "folder", path: "3-resources/later.md", visibility: "private" }]);
  });

  test("a folder rule with no folder row makes no row: it is an orphan, so no empty folder shows in the tree", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "4-archive/deep", visibility: "team" }]);
    await derive(w);
    expect(await rowAt(w, "4-archive/deep")).toBeNull();
    expect(await rowAt(w, "4-archive")).toBeNull();
    expect((await stateOf(w))?.orphans).toEqual([{ kind: "folder", path: "4-archive/deep", visibility: "team" }]);
  });
});

describe("note overrides", () => {
  test("a note override sets its own row over the folder default", async () => {
    const w = await setup();
    await setRules(
      w,
      [{ prefix: "1-projects", visibility: "team" }],
      [
        { path: "1-projects/secret.md", visibility: "private" },
        { path: "1-projects/open.md", visibility: "team" },
      ],
    );
    await addRows(w, ["1-projects/", "1-projects/secret.md", "1-projects/open.md", "1-projects/other.md"]);
    await derive(w);
    expect(await accessOf(w, "1-projects")).toEqual({ base: "team" });
    expect(await accessOf(w, "1-projects/secret.md")).toEqual({ base: "private" });
    expect(await accessOf(w, "1-projects/open.md")).toEqual({ base: "team" });
    expect(await accessOf(w, "1-projects/other.md")).toBeNull();
  });

  test("case-fold twins: a private override reaches every spelling, a team override reaches only its own", async () => {
    const w = await setup();
    await setRules(
      w,
      [{ prefix: "1-projects", visibility: "team" }],
      [
        { path: "1-projects/Secret.md", visibility: "private" },
        { path: "1-projects/Plan.md", visibility: "team" },
      ],
    );
    await addRows(w, [
      "1-projects/",
      "1-projects/Secret.md",
      "1-projects/secret.md",
      "1-projects/Plan.md",
      "1-projects/plan.md",
      "1-projects/other.md",
    ]);
    await derive(w);
    expect(await accessOf(w, "1-projects/Secret.md")).toEqual({ base: "private" });
    expect(await accessOf(w, "1-projects/secret.md")).toEqual({ base: "private" });
    expect(await accessOf(w, "1-projects/Plan.md")).toEqual({ base: "team" });
    expect(await accessOf(w, "1-projects/plan.md")).toBeNull();
    expect(await accessOf(w, "1-projects/other.md")).toBeNull();
  });

  test("an override naming no row is an orphan, and the rest of the rules still derive", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "1-projects", visibility: "team" }], [{ path: "1-projects/missing.md", visibility: "team" }]);
    await addRows(w, ["1-projects/", "1-projects/a.md"]);
    await derive(w);
    expect(await accessOf(w, "1-projects")).toEqual({ base: "team" });
    expect((await stateOf(w))?.orphans).toEqual([{ kind: "override", path: "1-projects/missing.md" }]);
  });
});

describe("handles", () => {
  test("@group: base private and a view grant on the group, on the folder row", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "2-areas/feedback", visibility: "@acme-leads" }]);
    await addRows(w, ["2-areas/", "2-areas/feedback/", "2-areas/feedback/x.md"]);
    await derive(w);
    expect(await accessOf(w, "2-areas/feedback")).toEqual({ base: "private" });
    expect(await grantsAt(w, "2-areas/feedback")).toEqual([
      { kind: "group", userId: undefined, groupId: w.acmeLeads, role: "view", source: "privacy.md" },
    ]);
    expect(await accessOf(w, "2-areas/feedback/x.md")).toBeNull();
  });

  test("@person: base private and a view grant on the person, on the note row", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "1-projects", visibility: "team" }], [{ path: "1-projects/kola-only.md", visibility: "@kola" }]);
    await addRows(w, ["1-projects/", "1-projects/kola-only.md"]);
    await derive(w);
    expect(await accessOf(w, "1-projects/kola-only.md")).toEqual({ base: "private" });
    expect(await grantsAt(w, "1-projects/kola-only.md")).toEqual([
      { kind: "user", userId: w.kola, groupId: undefined, role: "view", source: "privacy.md" },
    ]);
  });

  test("a handle that resolves to nobody is an orphan: base private, no grant", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "2-areas/ghost", visibility: "@nobody-here" }]);
    await addRows(w, ["2-areas/", "2-areas/ghost/"]);
    await derive(w);
    expect(await accessOf(w, "2-areas/ghost")).toEqual({ base: "private" });
    expect(await grantsAt(w, "2-areas/ghost")).toEqual([]);
    expect((await stateOf(w))?.orphans).toEqual([{ kind: "unresolved", path: "2-areas/ghost", handle: "@nobody-here" }]);
  });

  test("a group of another workspace resolves to nothing", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "2-areas/beta", visibility: "@beta-team" }]);
    await addRows(w, ["2-areas/", "2-areas/beta/"]);
    await derive(w);
    expect(await accessOf(w, "2-areas/beta")).toEqual({ base: "private" });
    expect(await grantsAt(w, "2-areas/beta")).toEqual([]);
    expect((await stateOf(w))?.orphans).toEqual([{ kind: "unresolved", path: "2-areas/beta", handle: "@beta-team" }]);
  });
});

describe("re-running the derivation", () => {
  test("is idempotent on the rows, and each run bumps the version once", async () => {
    const w = await setup();
    await setRules(
      w,
      [
        { prefix: "2-areas", visibility: "team" },
        { prefix: "2-areas/feedback", visibility: "@acme-leads" },
      ],
      [{ path: "2-areas/a.md", visibility: "private" }],
    );
    await addRows(w, ["2-areas/", "2-areas/feedback/", "2-areas/a.md"]);
    await derive(w);
    const first = await snapshot(w);
    expect((await stateOf(w))?.version).toBe(1);
    await derive(w);
    expect(await snapshot(w)).toEqual(first);
    expect((await stateOf(w))?.version).toBe(2);
  });

  test("replaces the derived grants when the rules change, and leaves share rows alone", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "2-areas/feedback", visibility: "@acme-leads" }]);
    await addRows(w, ["2-areas/", "2-areas/feedback/"]);
    await derive(w);
    const folder = await rowAt(w, "2-areas/feedback");
    await w.t.run(async (ctx) => {
      await ctx.db.insert("nodeAccess", {
        workspaceId: w.ws,
        nodeId: folder!._id,
        granteeKind: "user",
        granteeUserId: w.owner,
        role: "view",
        at: 1,
        source: "share",
      });
    });
    await setRules(w, [{ prefix: "2-areas/feedback", visibility: "team" }]);
    await derive(w);
    expect(await accessOf(w, "2-areas/feedback")).toEqual({ base: "team" });
    expect(await grantsAt(w, "2-areas/feedback")).toEqual([
      { kind: "user", userId: w.owner, groupId: undefined, role: "view", source: "share" },
    ]);
  });

  test("the paged derivation gives the same rows as the one-shot one", async () => {
    const w = await setup();
    await setRules(
      w,
      [
        { prefix: "2-areas", visibility: "team" },
        { prefix: "2-areas/feedback", visibility: "@acme-leads" },
      ],
      [{ path: "2-areas/Note.md", visibility: "private" }],
    );
    await addRows(w, [
      "2-areas/",
      "2-areas/feedback/",
      "2-areas/feedback/x.md",
      "2-areas/note.md",
      "2-areas/Note.md",
      "2-areas/z.md",
      "3-resources/",
      "3-resources/r.md",
    ]);
    await derive(w);
    const oneShot = await snapshot(w);
    // Clear the derived state, then derive again two rows at a time.
    await w.t.run(async (ctx) => {
      const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws)).collect();
      for (const row of rows) if (row.access !== undefined) await ctx.db.patch(row._id, { access: undefined });
      const grants = await ctx.db.query("nodeAccess").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).collect();
      for (const grant of grants) await ctx.db.delete(grant._id);
    });
    let after: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const step: { next: string | null; done: boolean } = await w.t.run(async (ctx) =>
        await deriveAccessPage(ctx as MutationCtx, w.ws, { after, pageSize: 2 }),
      );
      if (step.done) break;
      after = step.next;
    }
    expect(await snapshot(w)).toEqual(oneShot);
    expect((await stateOf(w))?.version).toBe(2);
  });
});

describe("dual write", () => {
  test("a write of the rules, through the real mutation, derives the rows while they are the authority", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, privacyAuthority: true, accessSource: "shadow", updatedAt: 1 });
      await ctx.db.insert("nodePrivacy", { workspaceId: w.ws, etag: "ctx-0", invalid: false, folders: [], notes: [], observedAt: 1 });
    });
    await addRows(w, ["2-areas/", "2-areas/a.md"]);
    await w.t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: w.ws,
      expected: null,
      folders: [{ prefix: "2-areas", visibility: "team" }],
      notes: [{ path: "2-areas/a.md", visibility: "private" }],
    });
    expect(await accessOf(w, "2-areas")).toEqual({ base: "team" });
    expect(await accessOf(w, "2-areas/a.md")).toEqual({ base: "private" });
  });

  test("a write the authority refuses changes no rows", async () => {
    const w = await setup();
    await addRows(w, ["2-areas/"]);
    const result = await w.t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: w.ws,
      expected: null,
      folders: [{ prefix: "2-areas", visibility: "team" }],
      notes: [],
    });
    expect(result).toBeNull();
    expect(await accessOf(w, "2-areas")).toBeNull();
  });

  test("a mirror refresh of the file derives the rows", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "shadow", updatedAt: 1 });
    });
    await addRows(w, ["2-areas/", "2-areas/a.md"]);
    await w.t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: w.ws,
      mirror: {
        etag: "file-v2",
        invalid: false,
        folders: [{ prefix: "2-areas", visibility: "team" }],
        notes: [{ path: "2-areas/a.md", visibility: "@kola" }],
      },
      at: 2,
    });
    expect(await accessOf(w, "2-areas")).toEqual({ base: "team" });
    expect(await accessOf(w, "2-areas/a.md")).toEqual({ base: "private" });
    expect(await grantsAt(w, "2-areas/a.md")).toEqual([
      { kind: "user", userId: w.kola, groupId: undefined, role: "view", source: "privacy.md" },
    ]);
  });
});

describe("the access switch", () => {
  /** What the derivation has written: grants, state rows, and rows carrying access. */
  async function derivedCounts(t: T, ws: Id<"workspaces">) {
    return await t.run(async (ctx) => ({
      grants: (await ctx.db.query("nodeAccess").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).collect()).length,
      states: (await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).collect()).length,
      accessRows: (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws)).collect()).filter(
        (row) => row.access !== undefined,
      ).length,
    }));
  }

  test("with the switch unset, a rules write and a move derive nothing", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, privacyAuthority: true, updatedAt: 1 });
      await ctx.db.insert("nodePrivacy", { workspaceId: w.ws, etag: "ctx-0", invalid: false, folders: [], notes: [], observedAt: 1 });
    });
    await addRows(w, ["2-areas/", "2-areas/a.md"]);
    await w.t.mutation(internal.functions.nodesPrivacy.write, {
      workspaceId: w.ws,
      expected: null,
      folders: [{ prefix: "2-areas", visibility: "team" }],
      notes: [{ path: "2-areas/a.md", visibility: "private" }],
    });
    expect(await derivedCounts(w.t, w.ws)).toEqual({ grants: 0, states: 0, accessRows: 0 });

    const f = await keyedFixture();
    expect(await derivedCounts(f.t, f.ws)).toEqual({ grants: 0, states: 0, accessRows: 0 });
    await start(f, "1-projects/launch", "3-resources/launch");
    expect(await derivedCounts(f.t, f.ws)).toEqual({ grants: 0, states: 0, accessRows: 0 });
  });

  test("with the switch on, the backfill derives a workspace that already has rules", async () => {
    const f = await keyedFixture();
    await f.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: f.ws, source: "shadow" });
    const after = await derivedCounts(f.t, f.ws);
    expect(after.states).toBe(1);
    expect(after.accessRows).toBeGreaterThan(0);
    const folder = await f.t.run(async (ctx) =>
      await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects"))
        .unique(),
    );
    expect(folder?.access).toEqual({ base: "team" });
  });
});

describe("prune and purge leave access rows", () => {
  test("a sweep's prune removes unobserved rows that carry no access, and keeps those that do", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      const table = convexNodeTable(ctx as MutationCtx, w.ws);
      const anchor = await ctx.db.insert("nodes", {
        workspaceId: w.ws,
        path: "4-archive",
        name: "4-archive",
        kind: "folder",
        observedAt: 0,
        goneAt: 0,
        access: { base: "team" },
      });
      await ctx.db.insert("nodes", {
        workspaceId: w.ws,
        path: "4-archive/keep.md",
        name: "keep.md",
        kind: "file",
        observedAt: 0,
        parentId: anchor,
        access: { base: "private" },
      });
      await ctx.db.insert("nodes", { workspaceId: w.ws, path: "stale", name: "stale", kind: "folder", observedAt: 0, goneAt: 0 });
      await ctx.db.insert("nodes", { workspaceId: w.ws, path: "stale.md", name: "stale.md", kind: "file", observedAt: 0 });
      for (let pass = 0; pass < 5; pass += 1) {
        const step = await pruneUnobserved(table, Date.now());
        if (!step.more) break;
      }
    });
    expect(await rowAt(w, "4-archive")).not.toBeNull();
    expect(await rowAt(w, "4-archive/keep.md")).not.toBeNull();
    expect(await rowAt(w, "stale")).toBeNull();
    expect(await rowAt(w, "stale.md")).toBeNull();
  });

  test("a prune batch full of access rows does not stall the rows behind it", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      // More access rows than one prune batch, all older than the sweep, then one stale row behind them.
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("nodes", {
          workspaceId: w.ws,
          path: `kept/${index}.md`,
          name: `${index}.md`,
          kind: "file",
          observedAt: 0,
          access: { base: "private" },
        });
      }
      await ctx.db.insert("nodes", { workspaceId: w.ws, path: "stale.md", name: "stale.md", kind: "file", observedAt: 0 });
    });
    const passes: boolean[] = [];
    await w.t.run(async (ctx) => {
      const table = convexNodeTable(ctx as MutationCtx, w.ws);
      for (let pass = 0; pass < 5; pass += 1) {
        const step = await pruneUnobserved(table, Date.now());
        passes.push(step.more);
        if (!step.more) break;
      }
    });
    expect(passes[passes.length - 1]).toBe(false);
    expect(await rowAt(w, "stale.md")).toBeNull();
    expect(await rowAt(w, "kept/0.md")).not.toBeNull();
  });

  test("a move that replaces a tombstone a rule named leaves no grant on the row it removed", async () => {
    const f = await keyedFixture();
    // The rule names a group at the destination, in the file and in the mirror, so the tombstone a move
    // replaces is an anchor that carries a grant.
    const manifest = f.store.snapshot()[PRIVACY_KEY];
    f.store.seed(PRIVACY_KEY, manifest.replace("folder_defaults:\n", "folder_defaults:\n  3-resources/launch: @launch-crew\n"));
    const group = await f.t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("workspaceGroups", { workspaceId: f.ws, name: "launch-crew", createdBy: f.ownerId, createdAt: now });
      await ctx.db.insert("names", { name: "launch-crew", kind: "group", groupId: id, claimedBy: f.ownerId, claimedAt: now });
      const privacy = await ctx.db
        .query("nodePrivacy")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws))
        .unique();
      await ctx.db.patch(privacy!._id, {
        folders: [...privacy!.folders, { prefix: "3-resources/launch", visibility: "@launch-crew" }],
      });
      const parent = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "3-resources"))
        .unique();
      const anchor = await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        path: "3-resources/launch",
        parentId: parent?._id,
        name: "launch",
        kind: "folder",
        observedAt: 0,
        goneAt: 0,
        access: { base: "private" },
      });
      await ctx.db.insert("nodeAccess", {
        workspaceId: f.ws,
        nodeId: anchor,
        granteeKind: "group",
        granteeGroupId: id,
        role: "view",
        at: 1,
        source: "privacy.md",
      });
      return id;
    });
    expect(group).toBeDefined();
    await start(f, "1-projects/launch", "3-resources/launch");
    const orphaned = await f.t.run(async (ctx) => {
      const nodes = new Set(
        (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect()).map(
          (row) => row._id as string,
        ),
      );
      const grants = await ctx.db.query("nodeAccess").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).collect();
      return grants.filter((grant) => !nodes.has(grant.nodeId as string)).length;
    });
    expect(orphaned).toBe(0);
  });

  test("forgetting the tree removes its access rows and state with it", async () => {
    const w = await setup();
    await setRules(w, [{ prefix: "2-areas/feedback", visibility: "@acme-leads" }]);
    await addRows(w, ["2-areas/", "2-areas/feedback/"]);
    await derive(w);
    expect(await stateOf(w)).not.toBeNull();
    await w.t.run(async (ctx) => {
      await forgetWorkspaceTree(ctx as MutationCtx, w.ws);
    });
    const left = await w.t.run(async (ctx) => ({
      grants: (await ctx.db.query("nodeAccess").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).collect()).length,
      states: (await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).collect()).length,
    }));
    expect(left).toEqual({ grants: 0, states: 0 });
  });
});
