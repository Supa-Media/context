/**
 * The row half of emptying the trash where a workspace's notes live in its object: the object is the writer of its
 * rows (`docs/decisions/storage-and-credentials/object-row-writes.md`), so the due stamp folder is removed there, a
 * page at a time (`ws.write.erase`), and Convex's rows follow through the mirror. Each page's files are recorded for
 * the bucket half (`./erase.ts`), which runs after as it always has. No mark is opened: the object is told first by
 * being the one that writes (`docs/decisions/storage-and-credentials/background-tree-writers.md`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

/** The object's erase, as `workspaceClient` (`apps/mcp/src/workspaceStore/api.js`) has it. */
export interface ObjectEraser {
  write: { erase: (body: { path: string }) => Promise<unknown> };
}

type FileOut = { noteId?: string | null; storageKey?: string | null };
export type PageAnswer = { ok: true; count: number; more: boolean; files: FileOut[] };

/** The page the object took: its own answer, or the one beside `MIRROR_PENDING` (the rows are gone; the mirror follows). */
export function pageOf(answer: unknown): PageAnswer | null {
  if (answer === null || typeof answer !== "object") return null;
  const held = answer as { ok?: unknown; code?: unknown; answer?: unknown };
  const page = held.ok === true ? held : held.code === "MIRROR_PENDING" ? (held.answer as typeof held | undefined) : undefined;
  if (page === undefined || page === null || page.ok !== true) return null;
  const { count, more, files } = page as Partial<PageAnswer>;
  if (typeof count !== "number" || typeof more !== "boolean" || !Array.isArray(files)) return null;
  return { ok: true, count, more, files };
}

/** The keys the bucket half deletes for these files: each one's own key, or its note's id key when it has none. */
export function keysOf(files: readonly FileOut[]): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (typeof file.storageKey === "string" && file.storageKey !== "") keys.add(file.storageKey);
    else if (typeof file.noteId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(file.noteId)) keys.add(`notes/${file.noteId}.md`);
  }
  return [...keys];
}

/**
 * Erase what is due, at most `pages` object calls in this run (the rest waits for tomorrow's pass). Answers the pages
 * taken. Each folder's record is made before the object is asked (`trashObject.begin`) and handed to the bucket half
 * only once the erase is known to have happened, so a run that stops anywhere neither loses a key nor deletes a byte a
 * restore could still want. A refusal or a failed call stops the run; the next pass asks again.
 */
export async function eraseInObject(ctx: ActionCtx, workspaceId: Id<"workspaces">, client: ObjectEraser, pages: number): Promise<number> {
  // An erase an earlier run did not live to record, now that the mirror shows its folder gone.
  await ctx.runMutation(internal.functions.trashObject.settle, { workspaceId });
  let taken = 0;
  let folder: string | null = null;
  let record: Id<"trashErasures"> | null = null;
  let files = 0;
  while (taken < pages) {
    folder ??= await ctx.runQuery(internal.functions.trashObject.dueFolder, { workspaceId, now: Date.now() });
    if (folder === null) break;
    record ??= await ctx.runMutation(internal.functions.trashObject.begin, { workspaceId, folder });
    let page: PageAnswer | null;
    try {
      page = pageOf(await client.write.erase({ path: folder }));
    } catch (error) {
      console.error("trash.object_erase_failed", { workspaceId, code: error instanceof Error ? error.name : "ERASE_FAILED" });
      break;
    }
    // Refused, or not there: the mirror is behind the object (already erased) or the folder changed. The next pass asks again.
    if (page === null) break;
    taken += 1;
    files += page.files.length;
    await ctx.runMutation(internal.functions.trashObject.append, { id: record, keys: keysOf(page.files), done: !page.more, audit: true, files });
    if (!page.more) {
      folder = null;
      record = null;
      files = 0;
    }
  }
  return taken;
}
