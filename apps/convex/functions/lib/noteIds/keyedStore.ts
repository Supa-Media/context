/**
 * Whether a file operation's store belongs to a KEYED workspace, and what a
 * path-based operation does about it (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * In a keyed workspace a note's bytes live only at `notes/<noteId>.md` and the
 * object at its path is a frozen copy nothing reads again. Anything that lists
 * the bucket by name, or moves and retires objects by path, is wrong there.
 * Such an operation asks the store (`isKeyedStore`) and refuses.
 *
 * The barrier attaches the question lazily (`attachWorkspaceKeyed`): nothing is
 * asked until an operation asks, and a store with no question attached is an
 * unkeyed one, as every store was before keys.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { FileOpError } from "../fileOps/errors";

/** What a path-based operation says in a keyed workspace. Nothing is changed. */
export const KEYED_REFUSAL =
  "This workspace keeps its notes under their ids, and this operation works on paths, so it is not available in a keyed workspace yet. Nothing was changed.";

type KeyedProbe = { workspaceKeyed?: () => Promise<boolean> };

/**
 * Attach the keyed question to `store`: `workspaceKeyed()` asks the control
 * plane once per call, on first use. Non-enumerable, as the barrier's other seams are.
 */
export function attachWorkspaceKeyed(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: object): void {
  let keyed: Promise<boolean> | null = null;
  Object.defineProperty(store, "workspaceKeyed", {
    value: () => (keyed ??= ctx.runQuery(internal.functions.nodes.isKeyed, { workspaceId })),
    enumerable: false,
    configurable: true,
  });
}

/** Whether the store's workspace is keyed. A store with no question attached is not. */
export async function isKeyedStore(store: object): Promise<boolean> {
  const probe = (store as KeyedProbe).workspaceKeyed;
  return typeof probe === "function" ? (await probe()) === true : false;
}

/** Refuse, before anything is listed, read or written, a path-based operation in a keyed workspace. */
export async function refuseKeyedStore(store: object): Promise<void> {
  if (await isKeyedStore(store)) throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
}
