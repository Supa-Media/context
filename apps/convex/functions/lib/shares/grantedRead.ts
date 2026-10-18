/**
 * An outsider reads what was granted to them, through the share read path.
 *
 * The decision is `authorizeGrant` in `lib/grants/outsider.ts`: the caller is
 * an account that is not a member, the node is live, and `canSee` at `team`
 * scope with the caller's names opens it. This file is the reading half. It
 * reuses `readThroughShare` (`./readPath.ts`) in its one-path mode, so the note
 * comes through the same credential barrier and the same comment stripping as a
 * share does, and never a second one.
 *
 * ## One answer for every refusal
 *
 * Not granted, not there, trashed, granted in another workspace, a member, and
 * a grant the live rows no longer name all end in `SHARE_UNAVAILABLE`, and the
 * message is the one `shareUnavailable()` gives. The only other refusal is
 * `NOT_AUTHENTICATED` for a caller with no session, which is the same for every
 * target. A storage failure is passed through, as it is for shares: an outage
 * is not a withdrawn grant.
 *
 * ## Writing, for an outsider who holds edit
 *
 * `writeGrantedNote` saves one note's body for an outsider whose grant on the
 * governing row is `edit` (`guestCanEdit`). It is a body write over a version
 * they read, and nothing else: an `expectedEtag` is required (no etag would be a
 * create), a form block is refused (its responses are a creation), and the path
 * written is the one `authorizeGrant` resolved, never the one the caller typed.
 * It goes through `runFileOperation` at `team` scope with the outsider's names,
 * the same barrier a member's edit grant writes through. A conflict is passed
 * through as the editor's own `CONFLICT`: the caller can already read the note,
 * so telling them it changed says nothing new. Every other refusal is
 * `SHARE_UNAVAILABLE`.
 *
 * An editor reads the note with its comments (`readGrantedNote` with
 * `canEdit`), because the save writes the whole text back. A reader still gets
 * them stripped, as a link does.
 *
 * The actions are registered in `functions/shares.ts`, which is where a share's
 * API path comes from.
 */

import { ConvexError, v, type Infer, type ObjectType } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../../../_generated/api";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { parseFormBlocks } from "../../../../mcp/src/forms.js";
import { personalNameFor } from "../filesFns/access";
import type { OperationResult } from "../filesFns/operationTypes";
import { authorizeGrant, visibleGrantedPaths } from "../grants/outsider";
import { grantFormRefused, notAuthenticated, shareUnavailable } from "./errors";
import { readThroughShare } from "./readPath";

/** The locator an outsider names a grant by: its stable note id, or a path under it. Exactly one. */
const locatorArgs = {
  workspaceId: v.id("workspaces"),
  /** The row's stable id, as the grant names it (`rowAccess.ts`). */
  noteId: v.optional(v.string()),
  /** A path the grant reaches: the granted row itself, or a note or folder beneath a granted folder. */
  path: v.optional(v.string()),
};

export const readGrantedNoteArgs = locatorArgs;
export const readGrantedNoteReturns = v.object({
  path: v.string(),
  text: v.string(),
  /** Whether this caller may save the note (`writeGrantedNote`). */
  canEdit: v.boolean(),
  /** The version read, to pass back as `expectedEtag`. `null` unless `canEdit`. */
  etag: v.union(v.string(), v.null()),
});

export const writeGrantedNoteArgs = {
  ...locatorArgs,
  text: v.string(),
  /** The version the editor read. Required: a write with none would create a note, and that stays a member's. */
  expectedEtag: v.string(),
};
export const writeGrantedNoteReturns = v.object({
  path: v.string(),
  etag: v.string(),
  conflictCheck: v.union(v.literal("conditional"), v.literal("read-compare")),
});

export const listGrantedFolderArgs = locatorArgs;
export const listGrantedFolderReturns = v.object({
  path: v.string(),
  entries: v.array(
    v.object({
      path: v.string(),
      name: v.string(),
      kind: v.union(v.literal("file"), v.literal("folder")),
    }),
  ),
});

export const authorizeGrantReadArgs = {
  userId: v.id("users"),
  ...locatorArgs,
};
export const authorizeGrantReadReturns = v.union(
  v.null(),
  v.object({
    path: v.string(),
    kind: v.union(v.literal("file"), v.literal("folder")),
    names: v.array(v.string()),
    canEdit: v.boolean(),
  }),
);

export const grantWriterArgs = { userId: v.id("users") };
export const grantWriterReturns = v.union(v.string(), v.null());

export const visibleGrantedPathsArgs = {
  userId: v.id("users"),
  workspaceId: v.id("workspaces"),
  paths: v.array(v.string()),
};
export const visibleGrantedPathsReturns = v.array(v.string());

/** The signed-in caller, or the sign-in refusal. Identical whatever they asked for. */
async function signedInUser(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  if (userId === null) throw notAuthenticated();
  return userId;
}

export async function authorizeGrantReadHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof authorizeGrantReadArgs>,
): Promise<Infer<typeof authorizeGrantReadReturns>> {
  return await authorizeGrant(ctx, args);
}

/** The name a history entry is signed with for this writer: their personal workspace's handle. */
export async function grantWriterHandler(ctx: QueryCtx, args: ObjectType<typeof grantWriterArgs>): Promise<string | null> {
  return await personalNameFor(ctx, args.userId);
}

export async function visibleGrantedPathsHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof visibleGrantedPathsArgs>,
): Promise<string[]> {
  return await visibleGrantedPaths(ctx, args);
}

/** Read one granted note. A folder, or anything that is not markdown, is refused. */
export async function readGrantedNoteHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof readGrantedNoteArgs>,
): Promise<Infer<typeof readGrantedNoteReturns>> {
  const userId = await signedInUser(ctx);
  const grant = await ctx.runQuery(internal.functions.shares.authorizeGrantRead, {
    userId,
    workspaceId: args.workspaceId,
    ...(args.noteId === undefined ? {} : { noteId: args.noteId }),
    ...(args.path === undefined ? {} : { path: args.path }),
  });
  if (grant === null || grant.kind !== "file" || !grant.path.toLowerCase().endsWith(".md")) {
    throw shareUnavailable();
  }
  // Scope `team` with the caller's names: the one path `authorizeGrant` has just decided, and no other.
  const note = await readThroughShare(ctx, args.workspaceId, grant.path, userId, false, "team", grant.names, {
    keepComments: grant.canEdit,
  });
  const canEdit = grant.canEdit && note.editable;
  return { path: grant.path, text: note.text, canEdit, etag: canEdit ? note.etag : null };
}

/** Save one granted note's body, for an outsider whose grant on it is `edit`. See the module comment. */
export async function writeGrantedNoteHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof writeGrantedNoteArgs>,
): Promise<Infer<typeof writeGrantedNoteReturns>> {
  const userId = await signedInUser(ctx);
  const grant = await ctx.runQuery(internal.functions.shares.authorizeGrantRead, {
    userId,
    workspaceId: args.workspaceId,
    ...(args.noteId === undefined ? {} : { noteId: args.noteId }),
    ...(args.path === undefined ? {} : { path: args.path }),
  });
  if (grant === null || grant.kind !== "file" || !grant.canEdit || !grant.path.toLowerCase().endsWith(".md")) {
    throw shareUnavailable();
  }
  if (parseFormBlocks(args.text).length > 0) throw grantFormRefused();

  const actorName = await ctx.runQuery(internal.functions.shares.grantWriter, { userId });
  let result: Extract<OperationResult, { kind: "written" }>;
  try {
    result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "team",
      grantedNames: grant.names,
      actorName,
      operation: { kind: "write", path: grant.path, text: args.text, expectedEtag: args.expectedEtag },
    })) as Extract<OperationResult, { kind: "written" }>;
  } catch (error) {
    // Gone or hidden between the decision and the write answers as every other refusal. A conflict, and an
    // outage, travel unchanged: the editor keeps their draft and is told what happened.
    const code = error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined;
    if (code === "FILE_NOT_FOUND" || code === "PATH_INVALID" || code === "ACCESS_DENIED") throw shareUnavailable();
    throw error;
  }

  // The acting identity is the outsider, in the workspace's own trail. Paths and an outcome, never the text.
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "file.write",
    paths: [result.path],
    details: { conflictCheck: result.conflictCheck, via: "grant" },
  });
  return { path: result.path, etag: result.etag, conflictCheck: result.conflictCheck };
}

/**
 * List one granted folder: what the outsider may see inside it.
 *
 * The engine's listing comes first, with the caller's names. Each entry is then
 * judged again by the guest rendering, so a private subfolder or a note held back
 * by name is absent even where the engine would have listed it.
 */
export async function listGrantedFolderHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof listGrantedFolderArgs>,
): Promise<Infer<typeof listGrantedFolderReturns>> {
  const userId = await signedInUser(ctx);
  const grant = await ctx.runQuery(internal.functions.shares.authorizeGrantRead, {
    userId,
    workspaceId: args.workspaceId,
    ...(args.noteId === undefined ? {} : { noteId: args.noteId }),
    ...(args.path === undefined ? {} : { path: args.path }),
  });
  if (grant === null || grant.kind !== "folder") throw shareUnavailable();

  let listing;
  try {
    listing = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "team",
      grantedNames: grant.names,
      operation: { kind: "list", path: grant.path },
    });
  } catch (error) {
    // A folder this caller cannot open answers not-found, as one that does not exist does. Anything else is
    // infrastructure and travels unchanged.
    const code = error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined;
    if (code === "FILE_NOT_FOUND" || code === "PATH_INVALID") throw shareUnavailable();
    throw error;
  }
  if (listing.kind !== "listing") throw shareUnavailable();

  const entries = listing.entries.map((entry: { path: string; name: string; kind: string }) => ({
    path: entry.path,
    name: entry.name,
    kind: entry.kind === "folder" ? ("folder" as const) : ("file" as const),
  }));
  const open = new Set(
    await ctx.runQuery(internal.functions.shares.visibleGrantedPaths, {
      userId,
      workspaceId: args.workspaceId,
      paths: entries.map((entry) => entry.path),
    }),
  );
  return { path: grant.path, entries: entries.filter((entry) => open.has(entry.path)) };
}
