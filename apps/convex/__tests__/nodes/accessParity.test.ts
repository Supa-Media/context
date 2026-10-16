/**
 * Shadow parity for the access rows (PR 1 of the privacy-rows plan,
 * `lib/nodes/accessParity.ts`): every live row, compared under each clearance
 * the rules can name. Old `canSee` over the rules is set against new `canSee`
 * over the rows as `renderAccess` renders them.
 *
 * Sabotage: corrupt one row's base directly and parity reports exactly that
 * path; delete one derived grant and parity reports the one row it held.
 * Dropping the case fold from `overrideFor`, or the membership intersection
 * from the parity caller, makes the fixture below report diffs.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { accessParityPage, type ParityDiff, type ParityPage } from "../../functions/lib/nodes/accessParity";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;
type Folder = { prefix: string; visibility: string };
type Note = { path: string; visibility: string };

interface World {
  t: T;
  ws: Id<"workspaces">;
}

async function setup(): Promise<World> {
  const t = makeTest();
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const owner = await user("owner@example.test");
    const kola = await user("kola@example.test");
    const outsider = await user("outsider@example.test");
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
    const acme = await workspace("acme", "shared", owner);
    const kolaWs = await workspace("kola", "personal", kola);
    const outsiderWs = await workspace("outsider", "personal", outsider);
    await ctx.db.insert("workspaceMembers", { workspaceId: acme, userId: owner, role: "owner", joinedAt: now });
    // Kola is a live member of acme. The outsider is not, so their handle grants nothing here.
    await ctx.db.insert("workspaceMembers", { workspaceId: acme, userId: kola, role: "member", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: kolaWs, userId: kola, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: outsiderWs, userId: outsider, role: "owner", joinedAt: now });
    await ctx.db.insert("names", { name: "kola", kind: "workspace", workspaceId: kolaWs, claimedBy: kola, claimedAt: now });
    await ctx.db.insert("names", { name: "outsider", kind: "workspace", workspaceId: outsiderWs, claimedBy: outsider, claimedAt: now });
    const acmeLeads = await ctx.db.insert("workspaceGroups", { workspaceId: acme, name: "acme-leads", createdBy: owner, createdAt: now });
    await ctx.db.insert("names", { name: "acme-leads", kind: "group", groupId: acmeLeads, claimedBy: owner, claimedAt: now });
    return acme;
  });
  return { t, ws };
}

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

/** Insert tree rows; a path ending in `/` (or with no dot in its last segment) is a folder. Returns the count. */
async function addRows(w: World, paths: string[]): Promise<number> {
  return await w.t.run(async (ctx) => {
    for (const raw of paths) {
      const path = raw.replace(/\/$/, "");
      const last = path.slice(path.lastIndexOf("/") + 1);
      const kind = raw.endsWith("/") || !last.includes(".") ? "folder" : "file";
      await ctx.db.insert("nodes", { workspaceId: w.ws, path, name: last, kind, observedAt: 1 });
    }
    return paths.length;
  });
}

/** Derive the rows now, as staff's switch does (`nodesPrivacy.setAccessSource`). */
async function shadow(w: World): Promise<void> {
  await w.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: w.ws, source: "shadow" });
}

/** Every page of the parity query, joined. */
async function parity(w: World): Promise<{ diffs: ParityDiff[]; checked: number }> {
  const diffs: ParityDiff[] = [];
  let checked = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const step = await w.t.query(internal.functions.nodesPrivacy.accessParity, { workspaceId: w.ws, cursor });
    diffs.push(...step.diffs);
    checked += step.checked;
    if (step.next === null) return { diffs, checked };
    cursor = step.next;
  }
  throw new Error("parity did not finish");
}

async function rowAt(w: World, path: string) {
  return await w.t.run(async (ctx) =>
    await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", path))
      .unique(),
  );
}

/**
 * The fixture: team and private folders, a private folder inside a team one,
 * a team folder inside that, a group folder, a person folder, note overrides
 * of each tier (one inside a private folder), a case-fold twin private
 * override, a group and a person on a note, an unresolvable handle, and a
 * person who is not a member of the workspace.
 */
async function fixture(): Promise<{ w: World; live: number }> {
  const w = await setup();
  await setRules(
    w,
    [
      { prefix: "1-projects", visibility: "team" },
      { prefix: "2-areas", visibility: "team" },
      { prefix: "2-areas/hr", visibility: "private" },
      { prefix: "2-areas/hr/deep", visibility: "team" },
      { prefix: "2-areas/feedback", visibility: "@acme-leads" },
      { prefix: "3-resources", visibility: "private" },
      { prefix: "3-resources/shared", visibility: "@kola" },
      { prefix: "4-archive/ghost", visibility: "@nobody-here" },
      { prefix: "5-outside", visibility: "@outsider" },
    ],
    [
      { path: "1-projects/secret.md", visibility: "private" },
      { path: "1-projects/Plan.md", visibility: "private" },
      { path: "1-projects/ghost.md", visibility: "@nobody-here" },
      { path: "2-areas/memo.md", visibility: "@acme-leads" },
      { path: "2-areas/feedback/brief.md", visibility: "@kola" },
      { path: "3-resources/public.md", visibility: "team" },
    ],
  );
  const live = await addRows(w, [
    "1-projects/",
    "1-projects/secret.md",
    "1-projects/Plan.md",
    "1-projects/plan.md",
    "1-projects/ghost.md",
    "1-projects/open.md",
    "2-areas/",
    "2-areas/memo.md",
    "2-areas/hr/",
    "2-areas/hr/y.md",
    "2-areas/hr/deep/",
    "2-areas/hr/deep/x.md",
    "2-areas/feedback/",
    "2-areas/feedback/x.md",
    "2-areas/feedback/brief.md",
    "3-resources/",
    "3-resources/public.md",
    "3-resources/shared/",
    "3-resources/shared/notes.md",
    "3-resources/plain.md",
    "4-archive/",
    "4-archive/ghost/",
    "4-archive/ghost/g.md",
    "5-outside/",
    "5-outside/o.md",
  ]);
  await shadow(w);
  return { w, live };
}

describe("parity over the fixture", () => {
  test("the rows and the rules agree under every clearance", async () => {
    const { w, live } = await fixture();
    // Not vacuous: the rows really carry derived access, and the grant is there.
    expect((await rowAt(w, "2-areas/feedback/brief.md"))?.access).toEqual({ base: "private" });
    const result = await parity(w);
    expect(result.diffs).toEqual([]);
    expect(result.checked).toBe(live);
  });

  test("paging visits every live row once, whatever the page size", async () => {
    const { w, live } = await fixture();
    for (const pageSize of [1, 3, 7]) {
      let checked = 0;
      let cursor: string | null = null;
      for (let page = 0; page < 200; page += 1) {
        const step: ParityPage = await w.t.run(async (ctx) => await accessParityPage(ctx, w.ws, cursor, pageSize));
        expect(step.diffs).toEqual([]);
        checked += step.checked;
        if (step.next === null) break;
        cursor = step.next;
      }
      expect(checked).toBe(live);
    }
  });

  test("an unresolvable handle and a non-member's handle grant nothing, and parity agrees", async () => {
    const { w } = await fixture();
    expect((await parity(w)).diffs).toEqual([]);
    expect((await rowAt(w, "4-archive/ghost"))?.access).toEqual({ base: "private" });
    expect((await rowAt(w, "5-outside/o.md"))).not.toBeNull();
  });
});

describe("sabotage", () => {
  test("corrupting a base directly reports exactly that path", async () => {
    const { w } = await fixture();
    // `2-areas/hr` is private, so `2-areas/hr/y.md` inherits private. Set it to team behind the rules.
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", "2-areas/hr/y.md"))
        .unique();
      await ctx.db.patch(row!._id, { access: { base: "team" } });
    });
    const { diffs } = await parity(w);
    expect(diffs.length).toBeGreaterThan(0);
    expect([...new Set(diffs.map((diff) => diff.path))]).toEqual(["2-areas/hr/y.md"]);
    for (const diff of diffs) {
      expect(diff.old).toBe(false);
      expect(diff.new).toBe(true);
    }
    expect(diffs.map((diff) => diff.clearance)).toContain("member");
  });

  test("deleting a derived grant reports the one row it held, under the one name it granted", async () => {
    const { w } = await fixture();
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", "2-areas/feedback/brief.md"))
        .unique();
      const grants = await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", row!._id))
        .collect();
      expect(grants.length).toBe(1);
      await ctx.db.delete(grants[0]._id);
    });
    const { diffs } = await parity(w);
    expect(diffs).toEqual([{ path: "2-areas/feedback/brief.md", clearance: "member:@kola", old: true, new: false }]);
  });
});
