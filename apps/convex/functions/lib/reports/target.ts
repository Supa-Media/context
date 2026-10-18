/**
 * What a report or a block is about, resolved on the server for the caller.
 *
 * The client names a target by what it holds — a share's token, an
 * invitation's token, a workspace and a note path, a public page's address —
 * and this turns it into ids, **only** through the checks that already decide
 * whether that caller can reach it:
 *
 *  - a share: `shareStillStands`, the one predicate every share channel uses;
 *  - a grant (a note or folder shared with the caller by name, from a
 *    workspace they are not in): `outsiderGrantsFor`, the one @shared lists
 *    them with, so a grant the list would not show does not resolve;
 *  - an invitation: `invitationForCaller`, the one `acceptInvitation` uses;
 *  - a workspace note: the caller's own membership;
 *  - a public page: a share link through `shareStillStands`, or a website by
 *    the handle in its address, which is public by construction.
 *
 * Anything that fails resolves to `{ resolved: false, ids: {} }`. The caller is
 * never told which: `functions/reports.ts` answers every report with the same
 * receipt, so a guessed token, another tenant's workspace id and a real target
 * are one answer. What leaves here is ids — never a note's text, title or path,
 * never a token.
 */

import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { outsiderGrantsFor } from "../grants/outsider";
import { invitationForCaller } from "../invitations/forCaller";
import { findName } from "../nameClaims";
import { shareStillStands } from "../shares/standing";
import { getMembership } from "../workspaceAuth";

/**
 * Strings, not `v.id`, on purpose: a malformed id would otherwise fail the
 * argument validator with an error a well-formed one does not, and the
 * difference would be an answer.
 */
export const reportTargetValidator = v.union(
  v.object({ kind: v.literal("share"), token: v.string() }),
  v.object({ kind: v.literal("grant"), workspaceId: v.string(), noteId: v.string() }),
  v.object({ kind: v.literal("invitation"), token: v.string() }),
  v.object({ kind: v.literal("workspace_note"), workspaceId: v.string(), path: v.string() }),
  v.object({
    kind: v.literal("public_page"),
    /** A share link's token (`/s/<token>`). */
    token: v.optional(v.string()),
    /** A website's or short link's handle, without the `@`. */
    handle: v.optional(v.string()),
    /** The page's route on that site: `/`, `/about`. */
    path: v.optional(v.string()),
  }),
);
export type ReportTarget = Infer<typeof reportTargetValidator>;

export interface ResolvedTarget {
  resolved: boolean;
  /** What is forwarded with a report: ids only. */
  ids: Record<string, string>;
  /** Who put it in front of the caller, for "and block them"; share and invitation only. */
  personId: Id<"users"> | null;
}

const UNRESOLVED: ResolvedTarget = { resolved: false, ids: {}, personId: null };

const MAX_TOKEN = 200;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A website route: rooted, plain characters, short. Anything else is dropped, not echoed. */
const SITE_PATH = /^\/[A-Za-z0-9/_.-]{0,199}$/;

export async function resolveReportTarget(
  ctx: QueryCtx,
  userId: Id<"users">,
  target: ReportTarget,
): Promise<ResolvedTarget> {
  const now = Date.now();
  switch (target.kind) {
    case "share": {
      const share = await shareByToken(ctx, target.token);
      if (share === null) return UNRESOLVED;
      // Named shares only: @shared lists nothing else, and a person reached
      // the reporter only if the share was addressed to them.
      if (share.recipientKind !== "name" && share.recipientKind !== "email") return UNRESOLVED;
      if ((await shareStillStands(ctx, share, userId, now)) === null) return UNRESOLVED;
      return {
        resolved: true,
        ids: { shareId: share._id, workspaceId: share.workspaceId, personId: share.createdBy },
        personId: share.createdBy,
      };
    }
    case "grant": {
      if (target.noteId.length === 0 || target.noteId.length > MAX_TOKEN) return UNRESOLVED;
      const workspaceId = ctx.db.normalizeId("workspaces", target.workspaceId);
      if (workspaceId === null) return UNRESOLVED;
      // Re-derived from the live rows, exactly as @shared lists it: a revoked grant, a member, a stranger and a
      // note id from another workspace are all the one UNRESOLVED.
      const grant = (await outsiderGrantsFor(ctx, userId)).find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.noteId === target.noteId,
      );
      if (grant === undefined) return UNRESOLVED;
      const ids: Record<string, string> = { workspaceId, noteId: grant.noteId };
      if (grant.grantedBy !== null) ids.personId = grant.grantedBy;
      return { resolved: true, ids, personId: grant.grantedBy };
    }
    case "invitation": {
      if (target.token.length > MAX_TOKEN) return UNRESOLVED;
      const invitation = await invitationForCaller(ctx, target.token, userId, now);
      if (invitation === null) return UNRESOLVED;
      return {
        resolved: true,
        ids: {
          invitationId: invitation._id,
          workspaceId: invitation.workspaceId,
          personId: invitation.invitedBy,
        },
        personId: invitation.invitedBy,
      };
    }
    case "workspace_note": {
      const workspaceId = ctx.db.normalizeId("workspaces", target.workspaceId);
      if (workspaceId === null) return UNRESOLVED;
      if ((await getMembership(ctx, workspaceId, userId)) === null) return UNRESOLVED;
      const ids: Record<string, string> = { workspaceId };
      // The note's stable id, never its path: a name is the owner's words.
      const node = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", target.path))
        .first();
      if (node?.noteId !== undefined) ids.noteId = node.noteId;
      return { resolved: true, ids, personId: null };
    }
    case "public_page": {
      if (target.token !== undefined) {
        const share = await shareByToken(ctx, target.token);
        if (share === null) return UNRESOLVED;
        if ((await shareStillStands(ctx, share, userId, now)) === null) return UNRESOLVED;
        return { resolved: true, ids: { shareId: share._id, workspaceId: share.workspaceId }, personId: null };
      }
      const handle = target.handle?.toLowerCase();
      if (handle === undefined || !HANDLE.test(handle)) return UNRESOLVED;
      const claim = await findName(ctx, handle);
      if (claim === null || claim.workspaceId === undefined) return UNRESOLVED;
      const ids: Record<string, string> = { workspaceId: claim.workspaceId };
      // A website's route is its public address, which the reader is looking at.
      if (target.path !== undefined && SITE_PATH.test(target.path)) ids.sitePath = target.path;
      return { resolved: true, ids, personId: null };
    }
  }
}

async function shareByToken(ctx: QueryCtx, token: string) {
  if (token.length === 0 || token.length > MAX_TOKEN) return null;
  return await ctx.db
    .query("noteShares")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
}
