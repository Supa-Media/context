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
import { pinReaderNames } from "../pinnedReaders";
import type { FileOperation } from "./operationTypes";
import { type MemberWrite, memberMayWrite } from "./memberWrite";

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
    // An Obsidian plugin's rename and delete are a move and a delete too: the
    // tree they never told went on drawing the old name, and every name check
    // asks the tree now.
    case "pluginRename":
      return { paths: [operation.from, operation.to], narrows: true, gone: [operation.from] };
    case "delete":
    case "removeNewFolder":
    case "pluginDelete":
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
 * What an operation whose paths are decided inside it did to the tree, read
 * off its answer: a built-in folder's fixed name, chosen by its role. `null`
 * for every other operation, whose change `treeChangeOf` knows beforehand.
 */
export function treeChangeOfResult(operation: FileOperation, result: unknown): TreeChange | null {
  const landed = result as { kind?: unknown; path?: unknown } | null | undefined;
  if (operation.kind === "addBuiltInFolder" && landed?.kind === "folderCreated" && typeof landed.path === "string") {
    return { paths: [landed.path], narrows: false };
  }
  // The tidy moved things around inside Archive (`tidyArchive`), and its answer names the Archive.
  const tidied = result as { kind?: unknown; from?: unknown; paths?: unknown } | null | undefined;
  if (operation.kind === "archiveTidy" && tidied?.kind === "moved" && typeof tidied.from === "string" && tidied.from !== "") {
    return Array.isArray(tidied.paths) && tidied.paths.length > 0 ? { paths: [tidied.from], narrows: true } : null;
  }
  return null;
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
    /**
     * A body write that a `member` may make through an edit grant on the row
     * that governs its path (`memberWrite.ts`). Only `editor` takes it: every
     * other call still needs the role, and a member is refused as before.
     */
    memberWrite?: MemberWrite;
  },
): Promise<{
  role: WorkspaceRole;
  scope: Scope;
  grantedNames: string[];
  actorName: string | null;
}> {
  if (
    args.minimum === "editor" &&
    args.memberWrite !== undefined &&
    (await memberMayWrite(ctx, args.workspaceId, args.actorUserId, args.memberWrite))
  ) {
    return {
      role: "member",
      scope: scopeForRole("member"),
      grantedNames: await grantedNamesFor(ctx, args.workspaceId, args.actorUserId),
      actorName: await personalNameFor(ctx, args.actorUserId),
    };
  }
  if (args.minimum === "member") {
    // Tried before the membership read rather than after a caught failure:
    // `requireWorkspaceAccess` throws the same error for "not a member" and
    // "no such workspace", so catching it would mean guessing which one this
    // was. Asking the narrower question first needs no guess.
    const pinned = await pinReaderNames(ctx, args.workspaceId, args.actorUserId);
    if (pinned !== null) {
      /*
        A PIN READER READS AS A GUEST.

        The pin is *reach* rather than membership, and `team` here means the
        workspace's real members, as everywhere (`lib/pinnedReaders.ts`). So a
        pin reader holds the guest names: the token of every row open to All
        Context users, and `READS_AS_GUEST`, which every reader of these names
        renders the rows for a guest by and which shuts `team` to them. Before
        the migration has run the list is empty and they read at `team`, as
        they did. No group's name and no person's grant reaches them here.
      */
      return {
        role: PINNED_CONTEXT_ROLE,
        scope: scopeForRole(PINNED_CONTEXT_ROLE),
        grantedNames: pinned,
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
export async function personalNameFor(
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

/**
 * The notes an operation left in need of re-indexing, or `null`.
 *
 * `written` holds new text at that path; `gone` is a path that no longer holds
 * a note. Single-note operations only: a folder's worth of paths is a
 * listing's job, and the next full pass does it. Archive and trash name only
 * their source because their destination is chosen inside the operation;
 * the full pass finds it there. `moved`, from the operation's result, is what
 * fast search follows at once (`movedBy`).
 */
export function indexChangeOf(
  operation: FileOperation,
  result?: unknown,
): { written: string[]; gone: string[]; moved?: [string, string][]; queued?: boolean } | null {
  switch (operation.kind) {
    case "write":
    case "removeEncryption":
      return { written: [operation.path], gone: [] };
    case "move":
    case "restoreTrash":
      return { written: [operation.to], gone: [operation.from], ...movedBy(result) };
    case "copy":
      return { written: [operation.to], gone: [] };
    case "archive":
    case "trash":
      return { written: [], gone: [operation.path], ...movedBy(result) };
    case "delete":
    case "removeNewFolder":
      return { written: [], gone: [operation.path] };
    case "form":
    case "addBuiltInFolder": {
      // The note these wrote is decided inside them: a form's response file, a folder's about.md.
      const landed = result as { responsesPath?: unknown; readme?: unknown } | null | undefined;
      const path = operation.kind === "form" ? landed?.responsesPath : landed?.readme;
      return typeof path === "string" && path !== "" ? { written: [path], gone: [] } : null;
    }
    default:
      return null;
  }
}

/**
 * Where a move's result says it went, for fast search to follow
 * (`search/d1/follow.js`): a note re-projected at its new path, a folder
 * renamed in place. A queued folder move has not moved the bucket yet, so it
 * is marked and nothing is followed until its copy lands.
 */
function movedBy(result: unknown): { moved?: [string, string][]; queued?: boolean } {
  const moved = result as { kind?: unknown; from?: unknown; to?: unknown; queued?: unknown } | null | undefined;
  if (!moved || moved.kind !== "moved" || typeof moved.from !== "string" || typeof moved.to !== "string") return {};
  if (moved.queued !== undefined) return { queued: true };
  return { moved: [[moved.from, moved.to]] };
}
