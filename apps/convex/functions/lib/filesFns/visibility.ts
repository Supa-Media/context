/**
 * Changing who can see a note or a folder: a visibility, a named group or
 * person. Each is authorized through `authorizeFileAccess` first, then written
 * to the tree's access rows (`nodesAccess.consoleAccess`). Nothing is written
 * to `privacy.md`: there is no such file any more (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Handler bodies of functions `functions/files.ts` registers; the
 * registrations (names, args, returns) stay there.
 */

import { ConvexError, type Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";
import { visibilityValidator } from "./validators";
import { isPlumbing, type Visibility } from "../privacy";

/**
 * Resolve the name an owner typed to the one an access row may hold.
 *
 * Two kinds of subject, and the rows cannot tell them apart — which is the
 * point. `@atlas-leads` and `@kola` are the same token, because usernames,
 * workspace slugs and group names share one global namespace precisely so an
 * addressing scheme that gates access is never ambiguous.
 *
 * **Both are resolved against THIS workspace before anything is written.** A
 * group name that exists in somebody else's context must be as unusable here as
 * one that exists nowhere, and a handle must belong to somebody who is actually
 * a member.
 *
 * One refusal for every way of failing, in the style `resolveAddressedUser`
 * follows: no such group, a group of another workspace, no such handle, a
 * handle belonging to a shared context rather than a person, and a person who
 * is not a member here are all `GROUP_NOT_FOUND`. An owner who could tell them
 * apart would have an oracle for which names exist on the platform.
 */
async function resolveNamedAudience(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  typed: string,
): Promise<string> {
  // Tolerated on the way in and stripped once: the console renders the `@`
  // because that is what the rules show, and a caller pasting what they see
  // should not be a refusal. Stored without it, because the rows' own grammar supplies the `@`.
  const name = typed.trim().replace(/^@+/, "").toLowerCase();
  const resolved = await ctx.runQuery(internal.functions.files.namedAudience, {
    workspaceId,
    name,
  });
  if (resolved === null) {
    throw new ConvexError({
      code: "GROUP_NOT_FOUND",
      message: "That is not a group or a member of this context.",
    });
  }
  return resolved;
}

type VisibilityOperationResult = Extract<OperationResult, { kind: "visibility" }>;

/**
 * One console change written to the rows (`nodesAccess.consoleAccess`). A note must be `.md`, a folder must not
 * be plumbing. A path with no row is "does not exist": a row is never made here.
 */
async function rowsChange(
  ctx: ActionCtx,
  change: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    path: string;
    kind: "note" | "folder";
    tier?: "private" | "team";
    group?: string;
    members?: boolean;
    accounts?: boolean;
  },
): Promise<VisibilityOperationResult> {
  if (change.kind === "note" && !change.path.endsWith(".md")) {
    throw new ConvexError({
      code: "PATH_INVALID",
      message: "Only markdown notes can have their own visibility. Set the folder's default instead.",
    });
  }
  if (change.kind === "folder" && isPlumbing(change.path)) {
    throw new ConvexError({ code: "PATH_INVALID", message: "That path is reserved." });
  }
  const answer = await ctx.runMutation(internal.functions.nodesAccess.consoleAccess, change);
  if (!answer.ok) {
    if (answer.code === "GROUP_NOT_FOUND") {
      throw new ConvexError({ code: "GROUP_NOT_FOUND", message: "That is not a group or a member of this context." });
    }
    throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
  }
  return {
    kind: "visibility",
    path: answer.path,
    visibility: answer.visibility as Visibility,
    inherited: answer.inherited as Visibility,
    exception: answer.exception,
  };
}

/**
 * Members (`members: true`) is base `private` plus the built-in members grantee.
 * Refused with `team` and with the other flag: a request error.
 */
function refuseMembersWithout(args: { visibility: string; members?: boolean; accounts?: boolean }): void {
  if (args.members !== true && args.accounts !== true) return;
  if (args.members === true && args.accounts === true) {
    throw new ConvexError({ code: "INVALID", message: "A note is shared with members or with every account, not both." });
  }
  if (args.members === true && args.visibility !== "private") {
    throw new ConvexError({ code: "INVALID", message: "Members is written as private plus every member." });
  }
  // All Context users is `team` plus every signed-in account, and only the pinned workspace takes it (`setAccess`).
  if (args.accounts === true && args.visibility !== "team") {
    throw new ConvexError({ code: "INVALID", message: "All Context users is written as team plus every account." });
  }
}

/**
 * The activity line a tier change records on its path. `visibility.note` and `visibility.folder` only; a group
 * records no line. `teamVisible` is the rows' answer for the paths.
 */
export async function recordRowsVisibilityLine(
  ctx: ActionCtx,
  line: {
    workspaceId: Id<"workspaces">;
    action: "visibility.note" | "visibility.folder";
    path: string;
    to: string;
    teamVisible: boolean;
    actorName?: string | null;
  },
): Promise<void> {
  await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: line.workspaceId,
    scope: "private",
    ...(line.actorName === undefined ? {} : { actorName: line.actorName }),
    operation: {
      kind: "visibilityLine",
      action: line.action,
      path: line.path,
      to: line.to,
      teamVisible: line.teamVisible,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                 handlers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Change one note's visibility. Requires `owner` — see `setDirectoryVisibilityHandler` for why.
 *
 * Setting a note to its folder's default removes the exception rather than
 * writing a redundant one (`nodesAccess.consoleAccess`).
 */
export async function setNoteVisibilityHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    visibility: Infer<typeof visibilityValidator>;
    members?: boolean;
    accounts?: boolean;
  },
): Promise<VisibilityOperationResult> {
  const actorUserId = await callerId(ctx);
  const { actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  refuseMembersWithout(args);
  const result = await rowsChange(ctx, {
    workspaceId: args.workspaceId,
    actorUserId,
    path: args.path,
    kind: "note",
    tier: args.visibility,
    ...(args.members === true ? { members: true } : {}),
    ...(args.accounts === true ? { accounts: true } : {}),
  });
  await recordRowsVisibilityLine(ctx, {
    workspaceId: args.workspaceId,
    action: "visibility.note",
    path: result.path,
    to: args.visibility,
    teamVisible: result.visibility === "team",
    actorName,
  });
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.note",
    paths: [result.path],
    details: { visibility: result.visibility, exception: result.exception },
  });
  return result;
}

/**
 * Hand one note to a group, or a person, by name.
 *
 * The share dialog's verb. `setNoteVisibility` takes the two tiers and stays
 * that way — widening its validator would make every caller that sets a
 * visibility a way to mint a rule — so pointing a note at a group is its own
 * action, with its own audit line and its own proof that the group is real.
 *
 * Requires `owner`.
 */
export async function setNoteGroupHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    group: string;
  },
): Promise<VisibilityOperationResult> {
  const actorUserId = await callerId(ctx);
  await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  // One resolver for the note and the folder alike, so the two cannot start answering differently about the same name.
  const name = await resolveNamedAudience(ctx, args.workspaceId, args.group);
  const result = await rowsChange(ctx, { workspaceId: args.workspaceId, actorUserId, path: args.path, kind: "note", group: name });
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.note",
    paths: [result.path],
    details: { visibility: result.visibility, exception: result.exception },
  });
  return result;
}

/**
 * Point a FOLDER at a group or a person, which everything inside it follows.
 *
 * Its own action rather than a third value on `setDirectoryVisibility`, for the
 * reason `setNoteGroup` is its own action.
 *
 * **The audit action is `visibility.folder.named`, not `visibility.folder`.**
 * `visibility.folder` is on `MEMBER_VISIBLE_DETAIL_ACTIONS`: its subject is one a member already sees first-hand.
 * That is false the moment the value is a name, so the split keeps the gate purely per-action.
 *
 * Requires `owner`.
 */
export async function setFolderGroupHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    group: string;
  },
): Promise<VisibilityOperationResult> {
  const actorUserId = await callerId(ctx);
  await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const name = await resolveNamedAudience(ctx, args.workspaceId, args.group);
  const result = await rowsChange(ctx, { workspaceId: args.workspaceId, actorUserId, path: args.path, kind: "folder", group: name });
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.folder.named",
    paths: [result.path],
    details: { visibility: result.visibility },
  });
  return result;
}

/**
 * Change a folder's default, which every note without an exception follows. Requires `owner`.
 *
 * It said `editor` once, and that was a live breach: an invited editor flipped
 * private folders to `team` and read everything behind them — deciding their
 * own clearance. The owner gate is what stops that.
 */
export async function setDirectoryVisibilityHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    visibility: Infer<typeof visibilityValidator>;
    members?: boolean;
    accounts?: boolean;
  },
): Promise<VisibilityOperationResult> {
  const actorUserId = await callerId(ctx);
  const { actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  refuseMembersWithout(args);
  const result = await rowsChange(ctx, {
    workspaceId: args.workspaceId,
    actorUserId,
    path: args.path,
    kind: "folder",
    tier: args.visibility,
    ...(args.members === true ? { members: true } : {}),
    ...(args.accounts === true ? { accounts: true } : {}),
  });
  await recordRowsVisibilityLine(ctx, {
    workspaceId: args.workspaceId,
    action: "visibility.folder",
    path: result.path,
    to: args.visibility,
    teamVisible: args.visibility === "team",
    actorName,
  });
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.folder",
    paths: [result.path],
    details: { visibility: result.visibility },
  });
  return result;
}
