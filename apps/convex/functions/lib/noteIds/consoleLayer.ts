/**
 * The id layer for the console's own file operations (`filesFns/fileOperationBarrier.ts`).
 *
 * The gateway wraps an MCP session's store with `withIdLayout` while staff
 * have switched reads to the id copies; the console builds its store here, in
 * Convex, so it wraps the same way. The layer is the gateway's own module, so
 * a read or a save from the app follows exactly the rules an AI client's does.
 * The control plane is asked directly rather than over HTTP: the lookup and
 * the record are the same internal functions the gateway's routes call.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { withIdLayout } from "../../../../mcp/src/store/idLayout.js";

/** `store` wrapped with the id layer while reads use the id keys; `store` itself otherwise. */
export async function withConsoleIdLayout<S extends object>(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: S): Promise<S> {
  const layout = await ctx.runQuery(internal.functions.noteIds.idLayout, {});
  if (layout !== "ids") return store;
  return withIdLayout(store, {
    lookup: async (paths: string[]) => {
      const found = await ctx.runQuery(internal.functions.noteIds.copiesFor, { workspaceId, paths });
      return { copies: Object.fromEntries(found.map(({ path, key, etag, keyEtag, fresh }) => [path, { key, etag, keyEtag, fresh }])) };
    },
    wrote: async ({ path, key, etag, keyEtag }: { path: string; key: string; etag: string; keyEtag?: string }) =>
      await ctx.runMutation(internal.functions.noteIds.recordCopy, {
        workspaceId,
        path,
        key,
        etag,
        ...(keyEtag === undefined ? {} : { keyEtag }),
      }),
  }) as S;
}
