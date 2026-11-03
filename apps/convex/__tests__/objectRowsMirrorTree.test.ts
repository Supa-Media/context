/**
 * The object's tree changes, mirrored into Convex (`functions/objectRowsMirror.ts` `tree`, `lib/nodes/mirrorTree.ts`,
 * the route `POST /gateway/rows/mirror` with op `tree`). The shape of `objectRowsMirror.test.ts`.
 *
 * Sabotage, confirmed to fail the outbox case: build `tree` with the plain rowWatch `internalMutation`, so the mirror
 * bounces each change back to the object.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gatewayPost } from "./fixtures.helpers";
import { boundWorkspace, tester, type T } from "./noteIds/noteIds.helpers";
import { nodePaths } from "../functions/lib/nodes/paths";
import { MIRROR_TREE_MAX } from "../functions/lib/nodes/mirrorTree";

const FOLDER_TRASH = "o_0123456789abcdef0123456789abcdef";
const FOLDER_STAMP = "o_1123456789abcdef0123456789abcdef";
const FOLDER_CONTEXT = "o_2123456789abcdef0123456789abcdef";
const FOLDER_OTHER = "o_3123456789abcdef0123456789abcdef";

const TRASH_PATH = ".context/trash/s1/plan.md";

/** A `1-projects` folder with `plan.md` inside it, both made by Convex (the rows a move starts from). */
async function seedTree(t: T, ws: Id<"workspaces">, extra: Partial<Doc<"nodes">> = {}) {
  return await t.run(async (ctx) => {
    const projects = await ctx.db.insert("nodes", { workspaceId: ws, path: "1-projects", name: "1-projects", kind: "folder", observedAt: 1 });
    const plan = await ctx.db.insert("nodes", {
      workspaceId: ws,
      path: "1-projects/plan.md",
      parentId: projects,
      name: "plan.md",
      kind: "file",
      etag: "e1",
      observedAt: 1,
      ...extra,
    });
    return { projects, plan };
  });
}

async function rowById(t: T, id: Id<"nodes">) {
  return await t.run((ctx) => ctx.db.get(id));
}

/** The row an object id names, as Convex keeps it (`nodes.objectId`). */
async function rowByObjectId(t: T, ws: Id<"workspaces">, objectId: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").collect();
    return rows.find((row) => row.workspaceId === ws && row.objectId === objectId) ?? null;
  });
}

/** The path the row is at, built through its parents (`paths.ts`), whatever its stored `path` says. */
async function builtPath(t: T, ws: Id<"workspaces">, row: Doc<"nodes">) {
  return await t.run(async (ctx) => (await nodePaths(ctx.db, ws)).pathOf(row));
}

/** Marks `ws` as an object-home workspace, as the flip does. */
async function objectHome(t: T, ws: Id<"workspaces">) {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId: ws, home: "object", since: 0 }));
}

const outbox = (t: T) => t.run((ctx) => ctx.db.query("workspaceObjectOutbox").collect());

const change = (overrides: Record<string, unknown> = {}) => ({
  moves: [],
  folders: [],
  removed: [],
  trash: false,
  ...overrides,
});

const trashFolders = (at: number) => [
  { id: FOLDER_CONTEXT, noteId: null, path: ".context", role: null, at },
  { id: FOLDER_TRASH, noteId: null, path: ".context/trash", role: null, at },
  { id: FOLDER_STAMP, noteId: null, path: ".context/trash/s1", role: null, at },
];

describe("objectRowsMirror.tree, trash and restore", () => {
  test("a trash move stands up its folder chain under the object's ids and moves the row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-trash");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: change({
        folders: trashFolders(100),
        moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }],
        trash: true,
      }),
    });
    expect(answer).toEqual({ applied: true });
    const stamp = await rowByObjectId(t, ws, FOLDER_STAMP);
    expect(stamp).toMatchObject({ kind: "folder", name: "s1", objectAt: 100, observedAt: 100 });
    expect(await rowByObjectId(t, ws, FOLDER_CONTEXT)).toMatchObject({ path: ".context", name: ".context" });
    const moved = await rowById(t, plan);
    expect(moved).toMatchObject({ name: "plan.md", parentId: stamp?._id, objectAt: 100 });
    expect(await builtPath(t, ws, moved as Doc<"nodes">)).toBe(TRASH_PATH);
  });

  test("a restore moves the row back to its original folder, with no folders", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-restore");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: change({ folders: trashFolders(100), moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }], trash: true }),
    });
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 200,
      record: change({ moves: [{ id: plan, kind: "file", from: TRASH_PATH, to: "1-projects/plan.md", at: 200 }] }),
    });
    expect(answer).toEqual({ applied: true });
    const back = await rowById(t, plan);
    expect(back).toMatchObject({ name: "plan.md", objectAt: 200 });
    expect(await builtPath(t, ws, back as Doc<"nodes">)).toBe("1-projects/plan.md");
  });

  test("a folder already live at the path is adopted, not duplicated", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-adopt");
    await objectHome(t, ws);
    const { projects } = await seedTree(t, ws);
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 50,
      record: change({ folders: [{ id: FOLDER_OTHER, noteId: null, path: "1-projects", role: null, at: 50 }] }),
    });
    expect(answer).toEqual({ applied: true });
    const live = await t.run((ctx) => ctx.db.query("nodes").collect());
    expect(live.filter((row) => row.workspaceId === ws && row.path === "1-projects" && row.goneAt === undefined)).toHaveLength(1);
    expect(await rowById(t, projects)).toMatchObject({ objectAt: 50 });
    expect(await rowByObjectId(t, ws, FOLDER_OTHER)).toBeNull();
  });
});

describe("objectRowsMirror.tree, removals", () => {
  test("a retired folder in removed gets goneAt", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-retire");
    await objectHome(t, ws);
    const { projects } = await seedTree(t, ws);
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 300,
      record: change({ removed: [{ id: projects, at: 300 }] }),
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowById(t, projects)).toMatchObject({ goneAt: 300, objectAt: 300 });
  });

  test("erase deletes the row and its access rows", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-erase");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    await t.run((ctx) =>
      ctx.db.insert("nodeAccess", { workspaceId: ws, nodeId: plan, granteeKind: "members", role: "view", at: 1, source: "owner" }),
    );
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 400,
      record: change({ removed: [{ id: plan, at: 400 }], erase: true }),
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowById(t, plan)).toBeNull();
    const grants = await t.run(async (ctx) => (await ctx.db.query("nodeAccess").collect()).filter((grant) => grant.nodeId === plan));
    expect(grants).toEqual([]);
  });
});

describe("objectRowsMirror.tree, refusals write nothing", () => {
  test("a move naming an unknown id applies nothing: no_row, and no folder is stood up", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-no-row");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: change({
        folders: trashFolders(100),
        moves: [{ id: FOLDER_OTHER, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }],
        trash: true,
      }),
    });
    expect(answer).toEqual({ applied: false, reason: "no_row" });
    expect(await rowByObjectId(t, ws, FOLDER_CONTEXT)).toBeNull();
    expect(await rowById(t, plan)).toMatchObject({ path: "1-projects/plan.md", name: "plan.md" });
  });

  test("a change over the cap is bad_record, with nothing written", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-cap");
    await objectHome(t, ws);
    const folders = Array.from({ length: MIRROR_TREE_MAX + 1 }, (_, index) => ({
      id: `o_${index.toString(16).padStart(32, "0")}`,
      noteId: null,
      path: `f${index}`,
      role: null,
      at: 1,
    }));
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, { workspaceId: ws, objectAt: 1, record: change({ folders }) });
    expect(answer).toEqual({ applied: false, reason: "bad_record" });
    expect(await rowByObjectId(t, ws, folders[0].id)).toBeNull();
  });

  test("an o_ id that belongs to another workspace is no_row, and that row is untouched", async () => {
    const t = tester();
    const a = await boundWorkspace(t, "tree-cross-a");
    const b = await boundWorkspace(t, "tree-cross-b");
    await objectHome(t, a);
    const other = await t.run((ctx) =>
      ctx.db.insert("nodes", { workspaceId: b, path: "keep.md", name: "keep.md", kind: "file", observedAt: 1, objectId: FOLDER_OTHER }),
    );
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: a,
      objectAt: 100,
      record: change({ moves: [{ id: FOLDER_OTHER, kind: "file", from: "keep.md", to: "moved.md", at: 100 }] }),
    });
    expect(answer).toEqual({ applied: false, reason: "no_row" });
    expect(await rowById(t, other)).toMatchObject({ path: "keep.md", name: "keep.md", workspaceId: b });
    expect(await rowById(t, other)).not.toHaveProperty("objectAt");
  });
});

describe("objectRowsMirror.tree, clocks and outbox", () => {
  test("objectAt never goes backwards", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-clock");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws, { objectAt: 200 });
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 50,
      record: change({ moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: "1-projects/renamed.md", at: 50 }] }),
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowById(t, plan)).toMatchObject({ name: "renamed.md", path: "1-projects/renamed.md", objectAt: 200 });
  });

  test("the mirror opens no workspaceObjectOutbox entry for the workspace", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-no-outbox");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const before = (await outbox(t)).length;
    await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: change({
        folders: trashFolders(100),
        moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }],
        trash: true,
        removed: [],
      }),
    });
    expect((await outbox(t)).length).toBe(before);
    expect(await outbox(t)).not.toContainEqual(expect.objectContaining({ workspaceId: ws }));
  });
});

describe("POST /gateway/rows/mirror, op tree", () => {
  test("op tree reaches the tree handler, and a refused change is skipped with its reason", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-route");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const response = await gatewayPost(t, "/gateway/rows/mirror", {
      workspaceId: ws,
      changes: [
        {
          seq: 1,
          op: "tree",
          objectAt: 100,
          record: change({ folders: trashFolders(100), moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }], trash: true }),
        },
        { seq: 2, op: "tree", objectAt: 101, record: change({ moves: [{ id: FOLDER_OTHER, kind: "file", from: "x.md", to: "y.md", at: 101 }] }) },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: [1], skipped: [{ seq: 2, reason: "no_row" }] });
    expect(await rowById(t, plan)).toMatchObject({ path: TRASH_PATH });
  });
});

describe("objectRowsMirror.tree, the audit line of a change made for a person", () => {
  const events = (t: T, ws: Id<"workspaces">) =>
    t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.workspaceId === ws));

  test("a trash made for a person writes the line the control plane's own trash writes; one made for nobody writes none", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-audit");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const actor = await t.run((ctx) => ctx.db.query("users").first());
    const before = (await events(t, ws)).length;
    await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: {
        ...change({ folders: trashFolders(100), moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }], trash: true }),
        audit: { actorUserId: String(actor?._id), action: "trash", files: 1 },
      },
    });
    const written = (await events(t, ws)).slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actorUserId: actor?._id,
      action: "file.archive",
      paths: ["1-projects/plan.md", TRASH_PATH],
      details: { files: 1, recoverable: true, trash: true },
    });

    await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 200,
      record: change({ moves: [{ id: plan, kind: "file", from: TRASH_PATH, to: "1-projects/plan.md", at: 200 }] }),
    });
    expect((await events(t, ws)).slice(before)).toHaveLength(1);
  });

  test("a restore made for a person is a file.move restored from the trash; an actor id that is not a user is left off", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-audit-restore");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws, { path: TRASH_PATH });
    const before = (await events(t, ws)).length;
    await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: {
        ...change({ moves: [{ id: plan, kind: "file", from: TRASH_PATH, to: "1-projects/plan.md", at: 100 }] }),
        audit: { actorUserId: "not-a-user", action: "restore", files: 1 },
      },
    });
    const [line] = (await events(t, ws)).slice(before);
    expect(line).toMatchObject({ action: "file.move", details: { files: 1, restoredFromTrash: true } });
    expect(line.actorUserId).toBeUndefined();
  });
});

describe("objectRowsMirror.tree, a move made for a person", () => {
  test("is a file.move audit line with its file count, and the row moves", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-audit-move");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const actor = await t.run((ctx) => ctx.db.query("users").first());
    const before = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.workspaceId === ws).length);
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: {
        ...change({ moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: "1-projects/renamed.md", at: 100 }] }),
        audit: { actorUserId: String(actor?._id), action: "move", files: 1 },
      },
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowById(t, plan)).toMatchObject({ name: "renamed.md" });
    const lines = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.workspaceId === ws));
    expect(lines.slice(before)).toEqual([
      expect.objectContaining({ actorUserId: actor?._id, action: "file.move", paths: ["1-projects/plan.md", "1-projects/renamed.md"], details: { files: 1 } }),
    ]);
  });
});

describe("objectRowsMirror.tree, a move into Archive", () => {
  const FOLDER_ARCHIVE = "o_4123456789abcdef0123456789abcdef";
  const FOLDER_ARCHIVED_PROJECTS = "o_5123456789abcdef0123456789abcdef";

  test("marks the Archive twin of the built-in folder it came from, as a row move into Archive does", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-archive-twins");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    const answer = await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: change({
        folders: [
          { id: FOLDER_ARCHIVE, noteId: null, path: "4-archive", role: null, at: 100 },
          { id: FOLDER_ARCHIVED_PROJECTS, noteId: null, path: "4-archive/1-projects", role: null, at: 100 },
        ],
        moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: "4-archive/1-projects/plan.md", at: 100 }],
      }),
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowByObjectId(t, ws, FOLDER_ARCHIVED_PROJECTS)).toMatchObject({ archiveOf: "projects" });
  });

  test("a trash marks nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tree-archive-trash");
    await objectHome(t, ws);
    const { plan } = await seedTree(t, ws);
    await t.mutation(internal.functions.objectRowsMirror.tree, {
      workspaceId: ws,
      objectAt: 100,
      record: change({ folders: trashFolders(100), moves: [{ id: plan, kind: "file", from: "1-projects/plan.md", to: TRASH_PATH, at: 100 }], trash: true }),
    });
    const rows = await t.run(async (ctx) => (await ctx.db.query("nodes").collect()).filter((row) => row.workspaceId === ws));
    expect(rows.filter((row) => row.archiveOf !== undefined)).toEqual([]);
  });
});
