/**
 * Paths under a built-in folder's default name, carried to the folder doing
 * that job (`lib/nodes/folderJobs.ts`, `canonicalJobPath`). Asked by the
 * credential barrier's job lens (`lib/filesFns/jobLens.ts`).
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { canonicalJobPath } from "./lib/nodes/folderJobs";

/** Paths one call carries: a `readMany` page, with room. */
const MAX_PATHS = 200;

export const carry = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, paths }) => {
    const out: string[] = [];
    for (const path of paths.slice(0, MAX_PATHS)) out.push(await canonicalJobPath(ctx.db, workspaceId, path));
    return [...out, ...paths.slice(MAX_PATHS)];
  },
});
