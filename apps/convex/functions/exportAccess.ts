/**
 * The archive's note list and `access.md` in rows mode (`lib/filesFns/exportAccess.ts`).
 *
 * A module of its own rather than a line in `files.ts`, which is already past
 * the file-size guideline. Public: the console calls it for "Download as folders".
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import {
  exportAccessHandler,
  exportAccessValidator,
  type ExportAccessAnswer,
} from "./lib/filesFns/exportAccess";

/** See `exportAccessHandler` in `lib/filesFns/exportAccess.ts`. */
export const exportAccess = action({
  args: { workspaceId: v.id("workspaces"), folder: v.string() },
  returns: exportAccessValidator,
  handler: async (ctx, args): Promise<ExportAccessAnswer> => await exportAccessHandler(ctx, args),
});
