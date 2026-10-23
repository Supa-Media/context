/**
 * The `{rules, overrides}` every Convex reader judges by (`canSee`).
 *
 * They come from the access rows, rendered for an audience (`renderAccess`). Every reader that judges privacy in
 * Convex goes through here, so the answer has one place to be read. Names come from `grantedNames.ts`.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { accessRowsOf, accessVersionOf } from "./accessRows";
import type { Rules } from "./log";
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

/** The rules a Convex reader judges this workspace by. */
export async function rulesForReaders(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<Rules> {
  return await rowRules(ctx, workspaceId, audience);
}

/**
 * The privacy view a Convex READER judges by: the rows' member rules (`rows: true`), with an etag that changes
 * whenever those rules do, so a check of "the rules I was shown are still current" (`rowMove`, `nodeMoves`)
 * answers from the rows.
 */
export async function readerMirror(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<PrivacyMirror> {
  return rowsMirror(await rowRules(ctx, workspaceId, audience));
}

/** `readerMirror` and `rulesForReaders` together, from one read of the rows. */
export async function readerView(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<{ mirror: PrivacyMirror; judged: Rules }> {
  const judged = await rowRules(ctx, workspaceId, audience);
  return { mirror: rowsMirror(judged), judged };
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
 * The version a move is judged under, as its handout and its guard both compare it: the rows' rules plus the
 * access version, so a grant (which changes no rendered rule) also refuses a move that was judged before it.
 */
export async function privacyEtagOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<string> {
  const mirror = await readerMirror(ctx, workspaceId);
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
