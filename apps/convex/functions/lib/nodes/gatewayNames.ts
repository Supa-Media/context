/**
 * `POST /gateway/tree/facts` with `ask: "names"`: what a gateway write asks the Convex tree
 * instead of the bucket (step 3 of the convex-only plan,
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * - `paths` (at most `TAKEN_PATHS`): which of them the tree draws a file at,
 *   and which a folder, through pending moves (`treeTaken.ts`). A move's,
 *   an archive's or a folder move's destination check asks this rather than
 *   GET the name; the write itself stays `onlyIf: { absent: true }`, which is
 *   the truth for a name the tree has not heard of yet.
 * - `count: true`: how many notes the workspace holds, for the free plan's
 *   cap (`apps/mcp/src/store/noteCap.js`), from the rows
 *   (`servedCount.ts`) rather than a walk of the bucket.
 *
 * **The answer is unfiltered**: a name taken by a note this grant may not see
 * is taken, and the count counts every note. That is what the bucket's own
 * answer was, and the gateway's tools decide what to say with `canSee`, as
 * they did over the bucket. So only a grant that may write here may ask: the
 * person's token must reach the workspace as `owner` or `editor`, with
 * `context:write`, the rule `/gateway/moves/start` holds a write to. Every
 * refusal is `{ served: false }`; a writer whose workspace is still on its
 * first copy is told `{ served: false, loading: true }` and the copy starts.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { stringField } from "../gatewayAuth";
import { GATEWAY_PATH_LENGTH, STILL_LOADING } from "./gatewayManifest";
import { servedNoteCount } from "./servedCount";
import { readinessAndKick } from "./treeLoading";
import { TAKEN_PATHS } from "./treeTaken";

const NOT_SERVED = { served: false } as const;
const SCOPE_WRITE = "context:write";

export type GatewayNamesAnswer =
  | { served: true; files: string[]; folders: string[]; notes?: number }
  | { served: false; loading?: true };

/** Paths, each one path, at most `TAKEN_PATHS`; `null` for anything else. */
function pathList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TAKEN_PATHS) return null;
  if (!value.every((entry) => typeof entry === "string" && entry !== "" && entry.length <= GATEWAY_PATH_LENGTH)) return null;
  return value as string[];
}

/** The answer to `ask: "names"` (`gatewayFacts.ts` routes it here). */
export async function namesFor(ctx: ActionCtx, body: Record<string, unknown>): Promise<GatewayNamesAnswer> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const paths = pathList(body.paths);
  const count = body.count === true;
  if (accessToken === null || expected === null || paths === null || (paths.length === 0 && !count)) return NOT_SERVED;
  try {
    const workspaceId = await writableWorkspace(ctx, accessToken, expected);
    if (workspaceId === null) return NOT_SERVED;
    const taken = await ctx.runQuery(internal.functions.nodesGateway.taken, { workspaceId, paths });
    if (taken === null) return (await readinessAndKick(ctx, workspaceId)) === "loading" ? STILL_LOADING : NOT_SERVED;
    if (!count) return { served: true, ...taken };
    const counted = await servedNoteCount(ctx, workspaceId);
    return counted === null ? NOT_SERVED : { served: true, ...taken, notes: counted.notes };
  } catch {
    return NOT_SERVED;
  }
}

/** The workspace this token may write, chosen from its grant's own set, or null. */
export async function writableWorkspace(ctx: ActionCtx, accessToken: string, expected: string): Promise<Id<"workspaces"> | null> {
  return await writableWith(ctx, accessToken, expected, ["owner", "editor"]);
}

/**
 * As `writableWorkspace`, for a write the gateway has already decided and only
 * records: any live member may do it, since members write form answers. A
 * grant that names the workspace with `context:write` and any role, or null.
 */
export async function memberWritableWorkspace(ctx: ActionCtx, accessToken: string, expected: string): Promise<Id<"workspaces"> | null> {
  return await writableWith(ctx, accessToken, expected, ["owner", "editor", "member"]);
}

async function writableWith(
  ctx: ActionCtx,
  accessToken: string,
  expected: string,
  roles: readonly string[],
): Promise<Id<"workspaces"> | null> {
  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null || !session.scopes.includes(SCOPE_WRITE)) return null;
  const entry = session.workspaces.find((workspace) => workspace.workspaceId === expected);
  if (entry === undefined || !roles.includes(entry.role)) return null;
  return entry.workspaceId as Id<"workspaces">;
}
