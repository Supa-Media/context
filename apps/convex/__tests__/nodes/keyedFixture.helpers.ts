/**
 * The keyed fixture and row readers shared by the keyed move and keyed trash
 * tests (`keyedRowMove.test.ts`, `keyedTrash.test.ts`): a workspace whose
 * switch is at `keys` with every live file row keyed at its id, so a move or
 * trash changes rows and never bytes.
 */

import { expect } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { fixture, type Fixture } from "./moveFixture.helpers";

export const NOTE_ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A keyed fixture: the switch is at `keys`, the flip has started, and every live file row is keyed at its id. */
export async function keyedFixture(): Promise<Fixture> {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    await ctx.db.insert("noteIdCopies", {
      workspaceId: f.ws,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      keyedAt: 1,
    });
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    for (const row of rows) {
      if (row.kind !== "file" || row.noteId === undefined) continue;
      await ctx.db.patch(row._id, { storageKey: `notes/${row.noteId}.md` });
    }
  });
  // The bytes live at the keys. The path objects the bucket still holds are frozen copies nothing reads.
  for (const path of ["1-projects/launch/brief.md", "1-projects/launch/plan.md", "1-projects/keep.md", "1-projects/secret/codes.md"]) {
    const row = await rowOf(f, path);
    f.store.seed(row.storageKey as string, `bytes of ${path}\n`);
  }
  return f;
}

export interface RawRow {
  _id: Id<"nodes">;
  path: string;
  kind: "file" | "folder";
  name: string;
  parentId?: Id<"nodes">;
  noteId?: string;
  storageKey?: string;
  etag?: string;
  goneAt?: number;
  props?: string;
}

/** The row at exactly `path`, live or not. */
export async function rowOf(f: Fixture, path: string): Promise<RawRow> {
  const row = await f.t.run(async (ctx) =>
    await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", path))
      .unique(),
  );
  if (row === null) throw new Error(`no row at ${path}`);
  return row as RawRow;
}

/** Every row of the workspace, with its parent as a path, so a test can read the tree's shape. */
export async function treeOf(f: Fixture) {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    const pathOf = new Map(rows.map((row) => [row._id as string, row.path]));
    return rows
      .map((row) => ({
        path: row.path,
        kind: row.kind,
        name: row.name,
        parent: row.parentId === undefined ? null : (pathOf.get(row.parentId as string) ?? "?"),
        live: row.goneAt === undefined,
        noteId: row.noteId,
        storageKey: row.storageKey,
        etag: row.etag,
        props: row.props,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
}

export async function liveAt(f: Fixture, path: string): Promise<boolean> {
  return (await treeOf(f)).some((row) => row.path === path && row.live);
}

/** The bucket's objects other than the rules file and the plumbing (`.context/`), which a move may write. */
export function bytesOf(f: Fixture): Record<string, string> {
  return Object.fromEntries(
    Object.entries(f.store.snapshot()).filter(([key]) => key !== PRIVACY_KEY && !key.startsWith(".")),
  );
}

export async function logOf(f: Fixture): Promise<{ path: string; gone: boolean }[]> {
  return await f.t.run(async (ctx) =>
    (await ctx.db.query("nodeLog").withIndex("by_workspace_seq", (q) => q.eq("workspaceId", f.ws)).collect()).map((row) => ({
      path: row.path,
      gone: row.gone,
    })),
  );
}

/** A folder at `path` with `count` keyed files beneath it, so it holds `count + 1` live rows. */
export async function bigFolder(f: Fixture, path: string, count: number, idBase = 1000): Promise<void> {
  await f.t.run(async (ctx) => {
    const folder = await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      noteId: NOTE_ID(idBase - 1),
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "folder",
      observedAt: 1,
    });
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(idBase + index),
        path: `${path}/n${index}.md`,
        parentId: folder,
        name: `n${index}.md`,
        kind: "file",
        etag: "e",
        observedAt: 1,
        storageKey: `notes/${NOTE_ID(idBase + index)}.md`,
      });
    }
  });
}

export async function privacyEtag(f: Fixture): Promise<string | null> {
  return await f.t.run(async (ctx) => {
    const mirror = await ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique();
    return mirror?.etag ?? null;
  });
}
