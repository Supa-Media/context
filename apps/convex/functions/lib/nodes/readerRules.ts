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
import type { PrivacyMirror } from "./table";

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

/**
 * The privacy mirror a Convex READER judges by, under `accessSource`. Every reader that decides who may see
 * something takes its mirror from here, never from `readMirror` directly, so that in rows mode no reader can
 * judge by the `privacy.md` the rules were last written to. In `file` and `shadow` it is `readMirror`, unchanged.
 *
 * In rows mode the view carries the rows' member rules (`rows: true`, `loadPrivacyState` takes them parsed),
 * and an etag that changes whenever those rules do, so a check of "the rules I was shown are still current"
 * (`rowMove`, `nodeMoves`) answers from the rows too.
 *
 * Writers and parity checks keep `readMirror`: they are about the file, not about who may see something.
 */
export async function readerMirror(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<PrivacyMirror | null> {
  if ((await accessSourceOf(ctx.db)) !== "rows") return await readMirror(ctx.db, workspaceId);
  const { rules, overrides } = await rowRules(ctx, workspaceId);
  const folders = rules
    .map((rule) => ({ prefix: rule.prefix, visibility: rule.vis as string }))
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const notes = [...overrides]
    .map(([path, visibility]) => ({ path, visibility: visibility as string }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { etag: rowsEtag(folders, notes), invalid: false, folders, notes, rows: true };
}

/** A version of the rows' rules: a 32-bit FNV-1a of what they say, so it moves exactly when they do. */
function rowsEtag(folders: { prefix: string; visibility: string }[], notes: { path: string; visibility: string }[]): string {
  const text = JSON.stringify([folders, notes]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `rows:${hash.toString(16)}`;
}
