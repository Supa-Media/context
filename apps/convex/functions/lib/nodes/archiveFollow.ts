/**
 * What a keyed move does for Archive once it has landed (`archiveTwins.ts`,
 * owner 2026-10-18): a move into Archive marks the twins on its way, and a
 * move of a built-in folder carries its twin in Archive to the matching new
 * place, merging into whatever is already there (`mergeInto`).
 *
 * The twin's move is the Archive keeping step, not the caller's request, so it
 * is made at the owner's clearance: a member who renames Projects moves
 * Archive/Projects too, whether or not they can see everything in it, and is
 * told nothing about it. It carries its rules like any move, so nothing in it
 * is seen by anyone new. A twin that cannot follow (something there is still
 * moving, a name taken by a file) stays where it is; nothing is lost, and
 * Restore still puts its contents back by their built-in folder's old name
 * (`canonicalJobPath`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { mergeInto } from "@context/shared/src/archiveMirror.cjs";

export interface ArchivePlan {
  archive: string | null;
  twins: { from: string; to: string; role: string }[];
}

function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Read before a move of `from` to `to` lands, so the twins are found at the built-in folders' old paths. */
export async function archivePlanFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, from: string, to: string): Promise<ArchivePlan> {
  return await ctx.runQuery(internal.functions.nodeRowMoves.archivePlan, { workspaceId, from, to });
}

/**
 * After the move: mark, then follow. Answers the files the twins carried,
 * each at its old and new path. `moveAsOwner` makes one move as the owner
 * (`startRowMove`), passed in rather than imported so the two files do not
 * import each other.
 */
export async function afterArchiveMove(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  to: string,
  plan: ArchivePlan,
  moveAsOwner: (from: string, to: string) => Promise<{ moved?: { from: string; to: string }[] } | null>,
): Promise<{ from: string; to: string }[]> {
  const carried: { from: string; to: string }[] = [];
  if (plan.archive !== null && under(to, plan.archive) && to !== plan.archive) {
    await ctx.runMutation(internal.functions.nodeRowMoves.markTwins, { workspaceId, path: to });
  }
  for (const twin of plan.twins) {
    try {
      await mergeInto(twin.from, twin.to, {
        kindAt: async (path) => await ctx.runQuery(internal.functions.nodeRowMoves.kindAt, { workspaceId, path }),
        children: async (path) => await ctx.runQuery(internal.functions.nodeRowMoves.childNames, { workspaceId, path }),
        move: async (from, to) => {
          const result = await moveAsOwner(from, to);
          carried.push(...(result?.moved ?? []));
        },
      });
    } catch (error) {
      // Path-free: which twin, by job only.
      console.warn(JSON.stringify({ event: "archive.twin_not_followed", workspaceId, role: twin.role, error: String((error as Error)?.name ?? "Error") }));
    }
  }
  return carried;
}
