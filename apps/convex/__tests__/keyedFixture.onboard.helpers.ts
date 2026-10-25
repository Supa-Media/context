/**
 * Reading a keyed workspace's scaffold in `onboarding.test.ts`. A workspace
 * born keyed (`applyBinding`) keeps each note's bytes at `notes/<noteId>.md`
 * and its name on a `nodes` row, so the scaffold's `index.md` and folder
 * `about.md`s are read through the tree, never by their path in the bucket.
 * `privacy.md` and the `.context/` plumbing stay at their own keys.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { PARA_FOLDERS, renderFolderReadme } from "../functions/lib/scaffold";
import type { TestConvex } from "./fixtures.helpers";
import type { MemoryS3 } from "./storeStub.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";

/** The live note paths the tree names, sorted. Folders are not notes, so they are left out. */
export async function notePaths(t: TestConvex, workspaceId: Id<"workspaces">): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return rows
      .filter((row) => row.kind === "file" && row.goneAt === undefined)
      .map((row) => row.path)
      .sort();
  });
}

/** The body the bucket holds for the note the tree names at `path`; `undefined` when no such note is there. */
export async function bodyAtPath(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  backend: MemoryS3,
  path: string,
): Promise<string | undefined> {
  const row = await t.run((ctx) => treeNodeAt(ctx.db, workspaceId, path));
  if (row?.storageKey === undefined) return undefined;
  return backend.objects.get(row.storageKey)?.body;
}

/** Bucket keys that are not note bodies: the privacy manifest, and nothing under `.context/`. */
export function objectsOutsideNotes(backend: MemoryS3): string[] {
  return [...backend.objects.keys()].filter((key) => !key.startsWith("notes/") && !key.startsWith(".")).sort();
}

/** The exact bodies the scaffold writes for each PARA folder's `about.md`. */
export function folderNoteBodies(): string[] {
  return PARA_FOLDERS.map((folder) => renderFolderReadme(folder));
}

/**
 * A bucket that refuses the PUT of any of `bodies` while `refusing()` says so.
 *
 * Keyed notes are written under their id, so a key cannot say which folder
 * note it is; the body can. Installed over the fetch stub after the binding
 * is connected, so the refusal is in place before the scaffold writes.
 */
export function refuseNotesWithBodies(backend: MemoryS3, refusing: () => boolean, bodies: readonly string[]): void {
  const inner = backend.fetchImpl;
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const raw = init.body;
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : undefined;
    if ((init.method ?? "GET").toUpperCase() === "PUT" && text !== undefined && bodies.includes(text) && refusing()) {
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>', { status: 403 });
    }
    return await inner(input, init);
  });
}
