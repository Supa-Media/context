/**
 * Phase 3 of `docs/decisions/app-and-console/convex-tree.md`: a workspace's
 * privacy rules held in `nodePrivacy` as the authority, and `privacy.md`
 * written from them.
 *
 * The rules decide who sees what, so every change to them here is a
 * compare-and-swap on one version, and nothing is ever read back from the
 * bucket's file once they are the authority. The store side, which every
 * reader and writer of `privacy.md` goes through, is
 * `apps/mcp/src/store/privacyAuthority.js`.
 *
 * **When the rules are the authority.** Staff turn it on for the deployment
 * (`nodeMigration.privacyAuthority`), and then it holds for each workspace
 * whose rules were read from a `privacy.md` that parsed. A workspace with no
 * file, or one that will not parse, keeps the file as its authority, so the
 * fail-closed answers a broken file gives (everything private) stay exactly
 * as they were.
 */

import { internal } from "../../../_generated/api";
import { PRIVACY_KEY } from "../privacy";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";

/** How long an owed export waits before it is tried again. */
export const EXPORT_RETRY_MS = 60_000;

/** The privacy rules as the store side carries them. */
export interface HeldRules {
  etag: string;
  folders: { prefix: string; visibility: string }[];
  notes: { path: string; visibility: string }[];
}

/** Whether staff turned the rules into the authority for this deployment. */
export async function privacyAuthorityOn(db: DatabaseReader): Promise<boolean> {
  const row = await db.query("nodeMigration").first();
  return row?.privacyAuthority === true;
}

/** Whether these rules are the authority, given the deployment's switch. */
export function isAuthority(row: Doc<"nodePrivacy"> | null, on: boolean): row is Doc<"nodePrivacy"> & { etag: string } {
  return on && row !== null && row.etag !== undefined && !row.invalid && row.fileAhead !== true;
}

/**
 * The prefix every version minted here carries, and no bucket etag can.
 * `newRulesVersion` writes it; `rulesAuthoredHere` reads it back.
 */
export const RULES_VERSION_PREFIX = "ctx-";

/**
 * Whether this deployment has ever decided these rules, rather than copied
 * them: a version it minted, or a `privacy.md` it wrote itself.
 *
 * A row that is neither is a copy of a file and nothing more. The switch
 * turning the rules into the authority writes nothing, on the reasoning that
 * "each workspace's file is already its rules' export" — true only while the
 * copy is current, and a `privacy.md` edited in the customer's own bucket is
 * copied no sooner than the next sweep (up to an hour). So a copy that the
 * file has moved past must not be the authority, or the first listing that
 * noticed would put it back over the owner's newer file — and a note they
 * withheld by hand would be readable again, for good and in silence.
 */
export function rulesAuthoredHere(row: Doc<"nodePrivacy">): boolean {
  return row.exportedEtag !== undefined || row.etag?.startsWith(RULES_VERSION_PREFIX) === true;
}

/** The rules as the store side holds them. */
export function heldRules(row: Doc<"nodePrivacy"> & { etag: string }): HeldRules {
  return { etag: row.etag, folders: row.folders, notes: row.notes };
}

/**
 * A version no `privacy.md` in a bucket can have. Distinct from every bucket
 * etag on purpose, so a version read from a listing can never pass for one of
 * these, and the other way round.
 */
export function newRulesVersion(now: number, random: () => number): string {
  return `${RULES_VERSION_PREFIX}${now.toString(36)}-${Math.floor(random() * 2 ** 48).toString(36)}`;
}

/** Bucket etags compared as the store compares them: quotes and a weak prefix dropped. */
export function sameEtag(a: string | undefined | null, b: string | undefined | null): boolean {
  const bare = (value: string) => value.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
  return typeof a === "string" && typeof b === "string" && bare(a) === bare(b);
}

/** One workspace's rules row. */
export async function privacyRowOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<Doc<"nodePrivacy"> | null> {
  return await ctx.db
    .query("nodePrivacy")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** Ask for the export to be written again: now when `delay` is 0, else after it. */
export async function scheduleExport(ctx: MutationCtx, workspaceId: Id<"workspaces">, delay: number): Promise<void> {
  await ctx.scheduler.runAfter(delay, internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "nodesPrivacyExport" },
  });
}

/**
 * A listing saw `privacy.md` at `etag`. While the rules are the authority, a
 * version that is not the last one written from them is the file edited past
 * us, and the rules are written over it. Called from the tree's own
 * observations (`nodes.observe`), so it costs nothing extra.
 */
export async function noticePrivacyListing(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  etag: string | undefined,
): Promise<void> {
  // A store that lists no versions (Dropbox) cannot tell; its next change writes the file.
  if (etag === undefined) return;
  const row = await privacyRowOf(ctx, workspaceId);
  if (!isAuthority(row, await privacyAuthorityOn(ctx.db))) return;
  // Before the first export the file is the one the rules were read from, at their own version.
  if (row.exportOwed === true || sameEtag(etag, row.exportedEtag ?? row.etag)) return;
  // Rules nobody here decided are a copy, and a copy the file has moved past
  // is not an authority: the file decides again until it is read once more.
  if (!rulesAuthoredHere(row)) {
    await ctx.db.patch(row._id, { fileAhead: true });
    // Read the file again now, from a run that opens the bucket as it is
    // (the authority is off for this row), rather than at the next sweep.
    await scheduleMirrorRead(ctx, workspaceId);
    return;
  }
  await ctx.db.patch(row._id, { exportOwed: true });
  await scheduleExport(ctx, workspaceId, 0);
}

/** Re-read `privacy.md` into the mirror: a touch naming it (`lib/nodes/touch.ts`). */
async function scheduleMirrorRead(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "nodesTouch", paths: [], files: [PRIVACY_KEY] },
  });
}

/** Whether a mirror refresh read from the file may be stored: never while the rules are the authority. */
export async function mirrorFollowsFile(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const row = await privacyRowOf(ctx, workspaceId);
  return !isAuthority(row, await privacyAuthorityOn(ctx.db));
}
