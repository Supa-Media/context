/** Where Tex's folder is, for the routine signals a file operation sends (`filesFns/fileOperationBarrier.ts`). */

import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { internal } from "../../../_generated/api";

/** Where Tex's folder is now, by its job (`folderJobs`); null when none is, or the read fails. */
export async function texFolderOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<string | null> {
  return await ctx
    .runQuery(internal.functions.nodesGateway.folderJobs, { workspaceId })
    .then((held) => held.jobs.tex ?? null, () => null);
}
