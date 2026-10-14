/**
 * The forwarding ledger and the icons, as the credential barrier hands them
 * to the store it opens: every file operation that records a move, forgets a
 * deleted path's icon or follows a stale path does it through these rows, by
 * way of the shared engines' own hooks (`store.forwardingLedger`,
 * `store.folderIconsHeld`; `apps/mcp/src/forwarding.js`, `folderIcons.cjs`).
 * With them attached nothing reads `.context/forwarding.json` or
 * `.context/folder-icons.json` back; the sync writes both from the rows.
 *
 * Attached as non-enumerable properties, so the stores built over this one
 * (`Object.create`) carry them and no serializer walking a store carries them
 * out.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

type Move = { from: string; to: string; kind: "note" | "folder" };

export function attachSmallData(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  workspaceId: Id<"workspaces">,
  store: object,
): void {
  Object.defineProperty(store, "forwardingLedger", {
    value: {
      read: () => ctx.runQuery(internal.functions.smallData.ledger, { workspaceId }),
      record: (moves: Move[], now: number) =>
        ctx.runMutation(internal.functions.smallData.recordForwarding, { workspaceId, moves, now }),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(store, "folderIconsHeld", {
    value: {
      remap: (moves: Array<{ from: string; to: string }>) =>
        ctx.runMutation(internal.functions.smallData.remapIcons, {
          workspaceId,
          moves: moves.map(({ from, to }) => ({ from, to })),
        }),
      drop: (path: string) => ctx.runMutation(internal.functions.smallData.dropIcons, { workspaceId, path }),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
}
