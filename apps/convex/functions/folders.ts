/**
 * Folder verbs that are not in `functions/files.ts`, which sits at the
 * TypeScript instantiation limit for one module's registrations.
 *
 * Authorization, the credential barrier and the audit row are all
 * `lib/filesFns/entries.ts`'s, exactly as every file action in `files.ts`.
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import { removeNewFolderHandler } from "./lib/filesFns/entries";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { deletedValidator } from "./lib/filesFns/validators";

/**
 * Undo "New folder" while it is still empty. Requires `editor`. Refuses with
 * `FOLDER_NOT_EMPTY` and keeps the folder once anything is in it.
 */
export const undoNewFolder = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: deletedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "deleted" }>> =>
    await removeNewFolderHandler(ctx, args),
});
