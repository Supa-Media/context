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
import { accessRowsOf, accessVersionOf } from "./accessRows";
import { mirrorRules, type Rules } from "./log";
import { readMirror } from "./privacyMirror";
import { renderAccess, type Audience } from "./rowAccess";
import type { PrivacyMirror } from "./table";

/**
 * The rules the access rows give an audience, as `renderAccess` renders them. A member's unless the reader's names
 * say they read as a guest (`lib/pinnedReaders.ts`, `audienceOfNames`): somebody who reaches the pinned workspace
 * through the pin. Every function below takes that audience, and a reader that does not pass one gets the member's
 * rules, under which a guest's names see no `team` note at all (`READS_AS_GUEST`): fewer notes, never more.
 */
async function rowRules(ctx: QueryCtx, workspaceId: Id<"workspaces">, audience: Audience): Promise<Rules> {
  const { rules, overrides } = renderAccess(await accessRowsOf(ctx, workspaceId), audience);
  return { rules, overrides };
}

/**
 * The rules a Convex reader judges this workspace by, under the deployment's
 * `accessSource`. In `file` and `shadow` this is exactly what readers judged
 * by before the switch existed.
 */
export async function rulesForReaders(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<Rules> {
  const source = await accessSourceOf(ctx.db);
  if (source === "rows") return await rowRules(ctx, workspaceId, audience);
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
export async function readerMirror(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<PrivacyMirror | null> {
  if ((await accessSourceOf(ctx.db)) !== "rows") return await readMirror(ctx.db, workspaceId);
  return rowsMirror(await rowRules(ctx, workspaceId, audience));
}

/**
 * `readerMirror` and `rulesForReaders` together, from one read of the rules. A
 * reader that needs both (a folder listing, a feed head) reruns on every change
 * it depends on, and the access snapshot it reads is one document that can be
 * large, so it is read once rather than twice.
 */
export async function readerView(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<{ mirror: PrivacyMirror | null; judged: Rules }> {
  if ((await accessSourceOf(ctx.db)) === "rows") {
    const judged = await rowRules(ctx, workspaceId, audience);
    return { mirror: rowsMirror(judged), judged };
  }
  const mirror = await readMirror(ctx.db, workspaceId);
  return { mirror, judged: await mirrorRules(mirror) };
}

/** The mirror view of the rows' member rules (`readerMirror`). */
function rowsMirror({ rules, overrides }: Rules): PrivacyMirror {
  const folders = rules
    .map((rule) => ({ prefix: rule.prefix, visibility: rule.vis as string }))
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const notes = [...overrides]
    .map(([path, visibility]) => ({ path, visibility: visibility as string }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { etag: rowsEtag(folders, notes), invalid: false, folders, notes, rows: true };
}

/**
 * The version a move is judged under, as its handout and its guard both compare it. File mode: the mirror's
 * etag, as it has always been. Rows mode: the rows' rules plus the access version, so a grant (which changes no
 * rendered rule) also refuses a move that was judged before it. Feed tokens keep the rules-only etag.
 */
export async function privacyEtagOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<string | null> {
  const mirror = await readerMirror(ctx, workspaceId);
  if (mirror === null || mirror.rows !== true) return mirror?.etag ?? null;
  return `${mirror.etag}.${await accessVersionOf(ctx, workspaceId)}`;
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
