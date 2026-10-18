/**
 * The access a note moved in from another workspace lands with, in rows mode
 * (`fileOps/contextMoveImport.ts`, `prepareContextMoveLanding`).
 *
 * The landing tier is never wider than either end (`landingVisibility`). With
 * the rules file as the truth that narrowing is an exception written to it; in
 * rows mode the readers judge by the rows, so an exception in the file would be
 * read by nobody and a private note would land readable by the destination's
 * team. Here each such note is asked to be private before it is written, and
 * its row is born private (`pendingAccess.ts`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { FileOpError } from "../fileOps/errors";
import type { FileStore } from "../fileOps/store";

const LANDING_OPERATIONS = new Set(["contextMoveImport", "contextMovePrepare"]);

/** Give a landing's store `narrowArrivals` in rows mode. Nothing is attached in file mode. */
export async function attachArrivalAccess(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; operation: { kind: string } },
  store: FileStore,
): Promise<void> {
  if (!LANDING_OPERATIONS.has(args.operation.kind)) return;
  if (!(await ctx.runQuery(internal.functions.nodesAccess.rowsMode, {}))) return;
  Object.defineProperty(store, "narrowArrivals", {
    value: async (paths: string[]) => {
      const kept = await ctx.runMutation(internal.functions.nodesAccess.narrowArrivals, { workspaceId: args.workspaceId, paths });
      // Fail closed: a note that cannot be kept private is not landed at all.
      if (!kept) {
        throw new FileOpError(
          "PRIVACY_MANIFEST_BUSY",
          "The notes could not be kept private where they are going, so nothing was moved. Try again.",
        );
      }
    },
    enumerable: false,
    configurable: true,
  });
}
