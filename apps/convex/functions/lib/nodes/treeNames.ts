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
 * the store, and a tree that does not serve (not proved, failing, paused)
 * leaves the bucket's listing in place.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { NO_BUCKET } from "./gatewayManifest";
import { servedNodesStore } from "./manifestStore";

/**
 * Give `store` a `treeListing` the walks read (`namesListing`, `walk.ts`).
 * Looked up the first time a walk lists, so an operation that walks nothing
 * asks nothing. Non-enumerable, as the barrier's other seams are.
 */
export function attachTreeListing(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore): void {
  let served: Promise<FileStore | null> | null = null;
  const tree = () => {
    served ??= servedNodesStore(ctx, workspaceId, NO_BUCKET).catch(() => null);
    return served;
  };
  const listing: Pick<FileStore, "list"> = {
    list: async (options) => {
      const rows = await tree();
      return rows === null ? await store.list(options) : await rows.list(options);
    },
  };
  Object.defineProperty(store, "treeListing", { value: listing, enumerable: false, configurable: true });
}
