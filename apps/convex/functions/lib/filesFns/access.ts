/**
 * Who the caller is, and what they may see: role to clearance, membership
 * resolution, and what an operation does to the file tree.
 *
 * Split out of `functions/files.ts`, which still registers
 * `authorizeFileAccess` and holds the module comment on why an `editor` gets
 * `team` rather than `private`.
 */

import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { PINNED_CONTEXT_ROLE } from "@context/shared";
import type { Scope } from "../privacy";
import type { TreeChange } from "../treeAnnounce";
import { type WorkspaceRole, requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { getAuthUserId } from "@convex-dev/auth/server";
import { grantedNamesFor } from "../grantedNames";
import { reachesPinnedContext } from "../pinnedContext";
import type { FileOperation } from "./operationTypes";

/**
 * A role's visibility clearance. See the module comment for why an `editor`
 * gets `team` rather than `private`.
 */
export function scopeForRole(role: WorkspaceRole): Scope {
  return role === "owner" ? "private" : "team";
}

export function treeChangeOf(operation: FileOperation): TreeChange | null {
  switch (operation.kind) {
    case "write":
      // An edit carries the version it replaces; a create does not.
      return operation.expectedEtag === undefined
        ? { paths: [operation.path], narrows: false }
        : null;
    case "createFolder":
      return { paths: [operation.path], narrows: false };
    case "copy":
      return { paths: [operation.to], narrows: false };
    case "duplicate":
      return { paths: [operation.path], narrows: false };
    case "importVault":
      return { paths: operation.files.map((file) => file.path), narrows: false };
    case "contextMoveImport":
      return {
        paths:
          operation.root !== undefined
            ? [operation.root]
            : operation.objects.map((object) => object.destination),
        narrows: false,
      };
    case "move":
    case "restoreTrash":
      return { paths: [operation.from, operation.to], narrows: true, gone: [operation.from] };
    case "delete":
      return { paths: [operation.path], narrows: true, gone: [operation.path] };
    case "archive":
    case "trash":
    case "setVisibility":
    case "setNoteGroup":
    case "setFolderGroup":
    case "setFolderVisibility":
      return { paths: [operation.path], narrows: true };
    case "contextMoveDelete": {
      const paths = operation.sources.map((source) => source.path);
      return { paths, narrows: true, gone: paths };
    }
    case "contextMoveFinish":
      return { paths: [operation.from], narrows: true, gone: [operation.from] };
    case "clearVault":
      return operation.countOnly ? null : { paths: [], narrows: true, every: true };
    case "resetPrivacy":
    case "ensurePrivacy":
      return { paths: [], narrows: true, every: true };
    default:
      return null;
  }
}

/**
 * `authorizeFileAccess`'s answer, for a query that has to ask it itself — a
 * reactive one cannot `runQuery`. One body, so the two can never disagree
 * about who reaches what.
 */
export async function resolveFileAccess(
  ctx: QueryCtx,
  args: {
    actorUserId: Id<"users">;
    workspaceId: Id<"workspaces">;
    minimum: "member" | "editor" | "owner";
  },
): Promise<{
  role: WorkspaceRole;
  scope: Scope;
  grantedNames: string[];
  actorName: string | null;
}> {
  if (args.minimum === "member") {
    // Tried before the membership read rather than after a caught failure:
    // `requireWorkspaceAccess` throws the same error for "not a member" and
    // "no such workspace", so catching it would mean guessing which one this
    // was. Asking the narrower question first needs no guess.
    if (await reachesPinnedContext(ctx, args.workspaceId, args.actorUserId)) {
      /*
        A PINNED CONTEXT REACHES NO NAMED RULE, AND THAT IS DELIBERATE.

        The pin is *reach* rather than membership — its own decision says so
        — and `grantedNamesFor` answers from `workspaceMembers`, which a
        pinned reader has no row in. So they read at `team` and a folder
        named to a group is absent, which is the same answer they get for a
        private one. Widening this would mean deciding that a pin confers
        group membership, which nobody has decided and which no audit row
        would record.
      */
      return {
        role: PINNED_CONTEXT_ROLE,
        scope: scopeForRole(PINNED_CONTEXT_ROLE),
        grantedNames: [],
        // A pinned reader is read-only, so there is nothing for a name to
        // appear beside. See `personalNameFor`.
        actorName: null,
      };
    }
  }
  const access =
    args.minimum === "member"
      ? await requireWorkspaceAccess(ctx, args.workspaceId, args.actorUserId)
      : await requireWorkspaceRole(
          ctx,
          args.workspaceId,
          args.actorUserId,
          args.minimum,
        );
  return {
    role: access.membership.role,
    scope: scopeForRole(access.membership.role),
    grantedNames: await grantedNamesFor(ctx, args.workspaceId, args.actorUserId),
    /*
      Resolved only for a caller who can change something.

      This query is on the path of every file read, and a name is used by
      exactly one thing: the line `activity.md` writes about a change. The
      five operations that record one all ask for `editor` or `owner`
      (`writeNote`, `moveEntry`, `archiveEntry`, and the two visibility
      actions), and every read asks for `member` — so the tier is already
      the question "could this call write", and a second flag saying the
      same thing would be a second thing to keep in step.
    */
    actorName:
      args.minimum === "member" ? null : await personalNameFor(ctx, args.actorUserId),
  };
}

/**
 * A person's name across every context: their personal workspace's slug.
 *
 * Walked rather than indexed, and bounded by how many contexts somebody owns
 * — one for almost everybody, and the first row is theirs. Called only from
 * the write tiers above, never on a read.
 *
 * The same answer the gateway's `personalNameFor` gives an AI client, computed
 * from the same two facts — a workspace they own, of kind `personal` — so one
 * person reads as one name whichever hand made the change. Two different names
 * for the same person in one list is the bug this shape exists to prevent.
 */
async function personalNameFor(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<string | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace?.kind === "personal" && workspace.slug) return `@${workspace.slug}`;
  }
  return null;
}

/**
 * The signed-in user, or a `ConvexError` a client can act on.
 *
 * A plain `Error` would be scrubbed to "Server Error" and dead-end the person
 * in the root error boundary with nothing to do about it — see the note at the
 * top of `lib/workspaceAuth.ts`.
 */
export async function callerId(ctx: ActionCtx | QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}
