/**
 * The Convex tree's store-side work, run inside the credential barrier
 * (`lib/filesFns/fileOperationBarrier.ts`) because each piece needs the
 * store the barrier opened:
 *
 *  - `nodesFactFill`: read the notes that changed and record their links and
 *    front matter (`factFill.ts`).
 *  - `nodesSmallData`: import the icons, emoji and forwarding files once, then
 *    write the files from the Convex rows (`lib/smallData/sync.ts`).
 *
 * Nothing here lists the bucket to decide which names exist: rows are written
 * by the product's seam (`notes-by-id`). The sweep, the re-check and the parity
 * check were that listing, and are gone.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { runFactFill } from "./factFill";
import { runSmallDataSync } from "../smallData/sync";

export type NodesOperation = Extract<FileOperation, { kind: "nodesFactFill" | "nodesSmallData" }>;

export function isNodesOperation(operation: { kind: string }): operation is NodesOperation {
  return operation.kind === "nodesFactFill" || operation.kind === "nodesSmallData";
}

/** Run one of the tree's store-side operations with the store the barrier opened. */
export async function runNodesOperation(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; operation: NodesOperation },
  store: FileStore,
): Promise<OperationResult> {
  const { workspaceId, operation } = args;

  // The icons, emoji and forwarding files: not part of the copy, so a pause never holds them back.
  if (operation.kind === "nodesSmallData") {
    return { kind: "nodesKept", complete: await runSmallDataSync(ctx, workspaceId, store) };
  }

  // Paused by staff: the facts fill stops, and resuming starts what is due.
  if (await ctx.runQuery(internal.functions.nodes.paused, {})) {
    return { kind: "nodesKept", complete: false };
  }
  return await runFactFill(ctx, workspaceId, store, Math.floor(operation.passes ?? 0));
}
