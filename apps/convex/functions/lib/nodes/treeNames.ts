/**
 * The tree's names for the walks inside an operation (phase 4 B2 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Moving, copying and deleting a folder list every key under it
 * (`keysUnder`), and a move's link rewrite lists every note in the workspace
 * (`rewriteReferences`). Where the tree serves the workspace those listings
 * page its rows instead of the bucket: one query per two thousand names rather
 * than one bucket request per thousand, and the names the person is looking
 * at, with pending moves folded in. That second part is a correction as well
 * as a speed-up: while a folder is moving, deleting it at its new name must
 * reach the files the worker has not copied yet, and only the folded tree
 * names them there.
 *
 * Nothing about privacy changes: the walks still judge every name with
 * `canSee` over the rules the operation loaded. Reads and writes still go to
 * the store.
 *
 * **No bucket listing in its place** (step 3 of the convex-only plan, owner
 * 2026-10-13: "I don't want to see even fallbacks"). A workspace whose first
 * copy has not finished is told `TREE_LOADING` and the copy is started; it
 * used to list the bucket. The same seam answers "is this name taken?" for
 * every write's clash check (`taken`, `lib/nodes/treeTaken.ts`,
 * `fileOps/treeChecks.ts`), so none of them GETs a name it is not writing.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import type { FileStore } from "../fileOps/store";
import type { TreeNames } from "../fileOps/treeChecks";
import { servedNodesStore } from "./manifestStore";
import { NO_BUCKET, notServed, readinessAndKick } from "./treeLoading";

/**
 * Give `store` a `treeListing` the walks read (`namesListing`, `walk.ts`).
 * Looked up the first time a walk lists, so an operation that walks nothing
 * asks nothing. Non-enumerable, as the barrier's other seams are.
 */
export function attachTreeListing(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore): void {
  let served: Promise<FileStore> | null = null;
  const tree = () => {
    served ??= servedOrLoading(ctx, workspaceId);
    return served;
  };
  const listing: TreeNames = {
    list: async (options) => await (await tree()).list(options),
    taken: async (paths) => {
      const answer = await ctx.runQuery(internal.functions.nodesGateway.taken, { workspaceId, paths: [...paths] });
      if (answer !== null) return answer;
      throw notServed(await loadingReadiness(ctx, workspaceId));
    },
    jobs: async () => await ctx.runQuery(internal.functions.nodesGateway.folderJobs, { workspaceId }),
    // A move's link rewrite reads only the notes these name (`fileOps/references.ts`).
    links: async ({ sources, names }) => await ctx.runQuery(internal.functions.nodeFacts.candidates, { workspaceId, sources, names }),
    linking: async (paths) => await ctx.runQuery(internal.functions.nodeLinkSources.linking, { workspaceId, paths }),
  };
  Object.defineProperty(store, "treeListing", { value: listing, enumerable: false, configurable: true });
}

/** The tree's store for the walks, or `TREE_LOADING` (the copy started), never the bucket. */
async function servedOrLoading(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<FileStore> {
  const rows = await servedNodesStore(ctx, workspaceId, NO_BUCKET);
  if (rows !== null) return rows;
  throw notServed(await loadingReadiness(ctx, workspaceId));
}

async function loadingReadiness(ctx: ActionCtx, workspaceId: Id<"workspaces">) {
  const readiness = await readinessAndKick(ctx, workspaceId);
  // Served between the two reads: a retry answers, so say "loading" rather than nothing.
  return readiness === "served" ? "loading" : readiness;
}
