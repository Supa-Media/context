/**
 * Parity between the access rules Convex pushes with a workspace's rows (`nodesPrivacy.authority`, beside `nodesPrivacy.accessSet`) and the rules
 * the workspace object renders from the same access set itself (`apps/mcp/src/workspaceStore/accessRows.js`, the
 * `check` the push's answer is compared with). The object judges reads by the rules Convex sent; this proves that
 * its own rendering of the set agrees with them, for a workspace whose grants were made through the real owner
 * mutation (`nodesAccess.setGrantees`), after a folder move, and with no snapshot held (the readers scan the rows).
 *
 * Sabotage, confirmed to fail four cases here: send the access set with every grantee list emptied
 * (`lib/nodes/accessSet.ts`).
 */

import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { located, nodePaths } from "../../functions/lib/nodes/paths";
import { objectRowOf } from "../../functions/lib/workspaceObjects/rows";
import { asUser, addMember, createUser, createWorkspace } from "../fixtures.helpers";
import { parentRows } from "./treeRows.helpers";
import { workspaceRows } from "../../../mcp/src/workspaceStore/rows.js";
import { workspaceAccess } from "../../../mcp/src/workspaceStore/accessRows.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The Durable Object's SQL, as `workspaceMarks.test.mjs` builds it: `exec` runs a query and reads its rows back. */
function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

type T = ReturnType<typeof convexTest>;

const NOTE_BRIEF = "0199a000-0000-7000-8000-00000000000a";
const NOTE_OLD = "0199a000-0000-7000-8000-00000000000b";
const NOTE_DOC = "0199a000-0000-7000-8000-00000000000c";
const NOTE_GUIDE = "0199a000-0000-7000-8000-00000000000d";
const PARTNER = "partner@example.test";

/**
 * A shared workspace with an owner and a member, a group, and a tree: a team folder `plans` with a private subfolder
 * `plans/archive` and a private note `plans/brief.md`, a folder `shared`, and a note `handbook/guide.md`.
 */
async function world() {
  const t = convexTest(schema, modules);
  const owner = await createUser(t, "owner@example.test");
  const kola = await createUser(t, "kola@example.test");
  const ws = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  await addMember(t, ws, kola, "member", owner);
  const leads = (await asUser(t, owner).mutation(api.functions.groups.createGroup, { workspaceId: ws, label: "leads" })).groupId;
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    const seed: Array<{ path: string; kind: "file" | "folder"; noteId?: string }> = [
      { path: "plans", kind: "folder" },
      { path: "plans/brief.md", kind: "file", noteId: NOTE_BRIEF },
      { path: "plans/archive", kind: "folder" },
      { path: "plans/archive/old.md", kind: "file", noteId: NOTE_OLD },
      { path: "shared", kind: "folder" },
      { path: "shared/doc.md", kind: "file", noteId: NOTE_DOC },
      { path: "handbook", kind: "folder" },
      { path: "handbook/guide.md", kind: "file", noteId: NOTE_GUIDE },
    ];
    for (const row of seed) {
      const name = row.path.slice(row.path.lastIndexOf("/") + 1);
      await ctx.db.insert("nodes", {
        workspaceId: ws,
        path: row.path,
        name,
        kind: row.kind,
        observedAt: 1,
        ...(row.noteId !== undefined ? { noteId: row.noteId } : {}),
      });
    }
    await parentRows(ctx, ws);
  });
  return { t, ws, owner, kola, leads };
}

type World = Awaited<ReturnType<typeof world>>;

/** The grants the cases compare: a team folder, a private note with a user (edit) and an email (view) grant, a private
 *  subfolder, a folder with a group grant and no base, and a note with a `members` grant. */
async function grantTheTree(w: World): Promise<void> {
  const owner = asUser(w.t, w.owner);
  const set = (path: string, grantees: unknown[], base?: "private" | "team") =>
    owner.mutation(api.functions.nodesAccess.setGrantees, { workspaceId: w.ws, path, grantees: grantees as never, ...(base ? { base } : {}) });
  expect(await set("plans", [], "team")).toMatchObject({ ok: true });
  expect(await set("plans/brief.md", [{ userId: w.kola, role: "edit" }, { email: PARTNER, role: "view" }], "private")).toMatchObject({ ok: true });
  expect(await set("plans/archive", [], "private")).toMatchObject({ ok: true });
  expect(await set("shared", [{ groupId: w.leads, role: "view" }])).toMatchObject({ ok: true });
  expect(await set("handbook/guide.md", [{ members: true, role: "view" }])).toMatchObject({ ok: true });
}

/** Convex's pushed rules and access set for the workspace, read as the push reads them. */
const authorityOf = async (w: World) => {
  const [member, guest, access] = await Promise.all([
    w.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: w.ws, audience: "member" }),
    w.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: w.ws, audience: "guest" }),
    w.t.query(internal.functions.nodesPrivacy.accessSet, { workspaceId: w.ws }),
  ]);
  return { member, guest, access };
};

/** A fresh workspace object, holding nothing yet. */
function objectHere() {
  const sql = durableSql();
  return { rows: workspaceRows(sql), access: workspaceAccess(sql) };
}

/** Every live tree row of the workspace, as the object row at the built path, stamped `at`. */
async function liveRowsOf(w: World, at: number) {
  return await w.t.run(async (ctx) => {
    const paths = await nodePaths(ctx.db, w.ws);
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws)).collect();
    const out = [];
    for (const row of rows) {
      const placed = await located(ctx.db, row, paths);
      const object = placed === null ? null : objectRowOf(placed, at);
      if (object !== null) out.push(object);
    }
    return out;
  });
}

/** The object's own check of Convex's set against the rules Convex rendered from it. */
interface Compared {
  equal: boolean;
  skipped?: string;
}
function checkParity(
  object: ReturnType<typeof objectHere>,
  authority: Awaited<ReturnType<typeof authorityOf>>,
): { version: number; skipped?: string; audiences: { member: Compared; guest: Compared } } {
  return object.access.check(authority.access as never, { member: authority.member, guest: authority.guest }) as never;
}

describe("the workspace object renders the access rules Convex pushes, the same way", () => {
  test("after the owner's grants, the object's rendering of the set equals Convex's member and guest rules", async () => {
    const w = await world();
    await grantTheTree(w);
    await w.t.run(async (ctx) => {
      const state = await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).unique();
      expect(state?.snapshot).toBeDefined();
    });
    const authority = await authorityOf(w);
    // The rules are not trivially empty: the team folder and the note's own rule are both there.
    expect(authority.member.folders).toEqual(expect.arrayContaining([expect.objectContaining({ prefix: "plans", visibility: "team" })]));
    expect(authority.member.notes.length).toBeGreaterThan(0);

    const object = objectHere();
    await object.rows.put(await liveRowsOf(w, 1));
    object.access.put(authority.access);
    const answer = checkParity(object, authority);
    expect(answer.skipped).toBeUndefined();
    expect(answer.audiences.member).toMatchObject({ equal: true });
    expect(answer.audiences.guest).toMatchObject({ equal: true });
  });

  test("after the team folder is moved to a new name, the object's rendering still equals Convex's rules", async () => {
    vi.stubEnv("CONTEXT_TREE_PATHS", "built");
    const w = await world();
    await grantTheTree(w);
    const before = await authorityOf(w);
    const object = objectHere();
    await object.rows.put(await liveRowsOf(w, 1));
    object.access.put(before.access);
    expect(checkParity(object, before).audiences.member).toMatchObject({ equal: true });

    // A move is refused unless the tree serves (`treeServesNow`) and every file it renames is keyed (`unkeyed`): a
    // ready tree on built paths, with each file at its key, as production has it.
    await w.t.run(async (ctx) => {
      await ctx.db.insert("nodeTrees", { workspaceId: w.ws, status: "ready", dirty: false, files: 4, paths: "built" });
      const files = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws)).collect();
      for (const row of files) {
        if (row.kind === "file" && row.noteId !== undefined) await ctx.db.patch(row._id, { storageKey: `notes/${row.noteId}.md` });
      }
    });
    const moved = await w.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: w.ws,
      from: "plans",
      to: "strategy",
      privacyEtag: before.member.etag,
      now: Date.now(),
    });
    expect(moved).toMatchObject({ ok: true });

    // The object takes the moved rows with a newer clock, then the set Convex now holds.
    await object.rows.put(await liveRowsOf(w, 2));
    const after = await authorityOf(w);
    object.access.put(after.access);
    const answer = checkParity(object, after);
    expect(answer.skipped).toBeUndefined();
    expect(answer.audiences.member).toMatchObject({ equal: true });
    expect(answer.audiences.guest).toMatchObject({ equal: true });
    // The team rule moved with the folder: it is judged at the new name, in the object's own rendering.
    expect(object.access.render("member")?.folders.map((rule) => rule.prefix)).toEqual(expect.arrayContaining(["strategy"]));
  });

  test("with no snapshot held, the readers scan the rows and the object's rendering still equals Convex's rules", async () => {
    const w = await world();
    await grantTheTree(w);
    await w.t.run(async (ctx) => {
      const state = await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).unique();
      expect(state).not.toBeNull();
      await ctx.db.patch(state!._id, { snapshot: undefined });
    });
    await w.t.run(async (ctx) => {
      const state = await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws)).unique();
      expect(state?.snapshot).toBeUndefined();
    });
    const authority = await authorityOf(w);
    const object = objectHere();
    await object.rows.put(await liveRowsOf(w, 1));
    object.access.put(authority.access);
    const answer = checkParity(object, authority);
    expect(answer.skipped).toBeUndefined();
    expect(answer.audiences.member).toMatchObject({ equal: true });
    expect(answer.audiences.guest).toMatchObject({ equal: true });
  });

  test("a revoked user grant leaves the object's set, and once every grant on the note is gone its visibility is private again", async () => {
    const w = await world();
    await grantTheTree(w);
    const owner = asUser(w.t, w.owner);
    const briefToken = async () => {
      const set = (await authorityOf(w)).access;
      return set.rows.find((row) => row.path === "plans/brief.md");
    };
    const before = await authorityOf(w);
    const object = objectHere();
    await object.rows.put(await liveRowsOf(w, 1));
    object.access.put(before.access);
    const noteVisibility = (rendered: ReturnType<typeof object.access.render>, path: string) =>
      rendered?.notes.find((note) => note.path === path)?.visibility;
    const grantedVisibility = noteVisibility(object.access.render("member"), "plans/brief.md");
    expect(grantedVisibility).toBeDefined();
    expect(grantedVisibility).not.toBe("private");
    const grantedToken = grantedVisibility as string;

    // Revoke the user's grant, keeping the email grant.
    expect(await owner.mutation(api.functions.nodesAccess.setGrantees, {
      workspaceId: w.ws,
      path: "plans/brief.md",
      grantees: [{ email: PARTNER, role: "view" }] as never,
      base: "private",
    })).toMatchObject({ ok: true });
    const afterUser = await authorityOf(w);
    const heldUser = (await briefToken())?.grantees ?? [];
    expect(heldUser.some((grantee) => grantee.kind === "user")).toBe(false);
    object.access.put(afterUser.access);
    expect(checkParity(object, afterUser).audiences.member).toMatchObject({ equal: true });

    // Revoke the email grant too: the note is held by its own base alone, and its token is gone from both audiences.
    expect(await owner.mutation(api.functions.nodesAccess.setGrantees, {
      workspaceId: w.ws,
      path: "plans/brief.md",
      grantees: [] as never,
      base: "private",
    })).toMatchObject({ ok: true });
    const none = await authorityOf(w);
    object.access.put(none.access);
    const answer = checkParity(object, none);
    expect(answer.audiences.member).toMatchObject({ equal: true });
    expect(answer.audiences.guest).toMatchObject({ equal: true });
    expect(noteVisibility(object.access.render("member"), "plans/brief.md")).toBe("private");
    expect(noteVisibility(object.access.render("guest"), "plans/brief.md")).toBe("private");
    expect(JSON.stringify(object.access.render("member"))).not.toContain(grantedToken);
    expect(JSON.stringify(object.access.render("guest"))).not.toContain(grantedToken);
    expect((await briefToken())?.grantees ?? []).toEqual([]);
  });
});

test("the object's chat homes folder is the control plane's", async () => {
  const { CHAT_HOMES_FOLDER } = await import("@context/shared");
  const object = await import("../../../mcp/src/workspaceStore/accessRows.js");
  expect(object.CHAT_HOMES_FOLDER).toBe(CHAT_HOMES_FOLDER);
});
