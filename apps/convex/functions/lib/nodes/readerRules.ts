/**
 * The `{rules, overrides}` every Convex reader judges by (`canSee`).
 *
 * `nodeMigration.accessSource` decides where they come from:
 *  - `file` (unset): the privacy mirror, as `mirrorRules` reads it. Today's answer.
 *  - `shadow`: the same mirror. The rows are kept up to date beside it, and
 *    staff compare the two with `nodesPrivacy.accessParity`; readers pay
 *    nothing for that, since a full row scan per read would not scale.
 *  - `rows`: `renderAccess(accessRowsOf(...), "member")`. A member's clearance
 *    is then judged against the rows, and names come from `grantedNames.ts`.
 *
 * Every reader that judges privacy in Convex goes through here, so the switch
 * has one place to be read.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { accessSourceOf } from "./accessBackfill";
import { accessRowsOf } from "./accessRows";
import { mirrorRules, type Rules } from "./log";
import { readMirror } from "./privacyMirror";
import { renderAccess } from "./rowAccess";

/** The rules the access rows give a member, as `renderAccess` renders them. */
async function rowRules(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Rules> {
  const { rules, overrides } = renderAccess(await accessRowsOf(ctx, workspaceId), "member");
  return { rules, overrides };
}

/**
 * The rules a Convex reader judges this workspace by, under the deployment's
 * `accessSource`. In `file` and `shadow` this is exactly what readers judged
 * by before the switch existed.
 */
export async function rulesForReaders(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Rules> {
  const source = await accessSourceOf(ctx.db);
  if (source === "rows") return await rowRules(ctx, workspaceId);
  return await mirrorRules(await readMirror(ctx.db, workspaceId));
}
