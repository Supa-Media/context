/**
 * The bucket half of emptying the trash (`functions/trash.ts`): for each
 * erasure the control plane has made, remove the notes' id keys and their
 * collaboration history, then clear the erasure. A failure keeps it, with a
 * fixed label, for the next pass; nothing is logged but codes.
 *
 * The rows are already gone when this runs, so a key here belongs to no note:
 * removing it again after a partial failure is safe, and a key already gone
 * is not an error.
 */

import { eraseDocument, supported as collaborationSupported } from "@context/collaboration";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";

/** Erasures one run claims before it hands the rest to tomorrow's pass. */
export const CLAIMS_PER_RUN = 25;

export interface EraseOutcome {
  claimed: number;
  finished: number;
  failed: number;
}

/** The bucket, opened for one workspace, or `null` when it has none connected. */
export type OpenStore = () => Promise<FileStore | null>;

/** The note ids of the Markdown keys an erasure removes (`notes/<noteId>.md`): only a note has editing history. */
export function historyIdsOf(keys: readonly string[]): string[] {
  const ids: string[] = [];
  for (const key of keys) {
    const match = /^notes\/([A-Za-z0-9-]{1,128})\.md$/.exec(key);
    if (match) ids.push(match[1]!);
  }
  return ids;
}

function codeOf(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "ERASE_FAILED";
}

export async function eraseWorkspaceTrash(ctx: ActionCtx, workspaceId: Id<"workspaces">, open: OpenStore): Promise<EraseOutcome> {
  let claimed = 0;
  while (claimed < CLAIMS_PER_RUN) {
    const id = await ctx.runMutation(internal.functions.trash.claimErasure, { workspaceId });
    if (id === null) break;
    claimed += 1;
  }
  const pending = await ctx.runQuery(internal.functions.trash.pendingErasures, { workspaceId });
  if (pending.length === 0) return { claimed, finished: 0, failed: 0 };

  let store: FileStore | null = null;
  try {
    store = await open();
  } catch (error) {
    for (const erasure of pending) await ctx.runMutation(internal.functions.trash.failErasure, { id: erasure.id, error: codeOf(error) });
    return { claimed, finished: 0, failed: pending.length };
  }
  if (store === null) {
    for (const erasure of pending) await ctx.runMutation(internal.functions.trash.failErasure, { id: erasure.id, error: "NO_BUCKET" });
    return { claimed, finished: 0, failed: pending.length };
  }

  let finished = 0;
  let failed = 0;
  for (const erasure of pending) {
    try {
      for (const key of erasure.keys) await store.delete(key);
      if (collaborationSupported(store)) {
        for (const path of erasure.histories) await eraseDocument(store, path);
        // A note's history is filed by its id (`packages/collaboration/src/address.js`), and the id is its key's.
        for (const noteId of historyIdsOf(erasure.keys)) await eraseDocument(store, null, { noteId });
      }
      await ctx.runMutation(internal.functions.trash.finishErasure, { id: erasure.id });
      finished += 1;
    } catch (error) {
      const code = codeOf(error);
      console.error("trash.erase_failed", { workspaceId, code });
      await ctx.runMutation(internal.functions.trash.failErasure, { id: erasure.id, error: code });
      failed += 1;
    }
  }
  return { claimed, finished, failed };
}
