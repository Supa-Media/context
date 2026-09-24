/**
 * Changing who can see a note or a folder: a visibility, a named group or
 * person, and resetting the privacy manifest. Each is authorized through
 * `authorizeFileAccess` before the credential barrier `runFileOperation` is
 * reached.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { ConvexError, type Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";
import { visibilityValidator } from "./validators";

/**
 * Resolve the name an owner typed to the one that may go in `privacy.md`.
 *
 * Two kinds of subject, and the manifest cannot tell them apart — which is the
 * point. `@atlas-leads` and `@kola` are the same token to the parser, because
 * usernames, workspace slugs and group names share one global namespace
 * precisely so an addressing scheme that gates access is never ambiguous.
 *
 * **Both are resolved against THIS workspace before anything is written.** A
 * group name that exists in somebody else's context must be as unusable here as
 * one that exists nowhere, and a handle must belong to somebody who is actually
 * a member. Writing an unresolvable name would not leak — `grantedNamesFor`
 * reads it as reaching nobody — but it would put a rule in the customer's
 * manifest that no owner can account for, and it would read on screen as though
 * somebody had been given access.
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
  // because that is what the manifest shows, and a caller pasting what they see
  // should not be a refusal. Stored without it, because the manifest's own
  // grammar supplies the `@`.
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

export async function setNoteVisibilityHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    visibility: Infer<typeof visibilityValidator>;
  },
): Promise<Extract<OperationResult, { kind: "visibility" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    actorName,
    operation: {
      kind: "setVisibility",
      path: args.path,
      visibility: args.visibility,
    },
  })) as Extract<OperationResult, { kind: "visibility" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.note",
    paths: [result.path],
    details: { visibility: result.visibility, exception: result.exception },
  });
  return result;
}

export async function setNoteGroupHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    group: string;
  },
): Promise<Extract<OperationResult, { kind: "visibility" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });

  // One resolver for the note and the folder alike, so the two cannot start
  // answering differently about the same name — which is how a folder
  // accepts an audience a note refuses, or the reverse. It also taught this
  // path to accept a person's handle, which it did not before: a rule may
  // name one person, and requiring a group of one to share with a colleague
  // was the friction that made the feature unusable.
  const name = await resolveNamedAudience(ctx, args.workspaceId, args.group);

  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "setNoteGroup", path: args.path, group: name },
  })) as Extract<OperationResult, { kind: "visibility" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.note",
    paths: [result.path],
    details: { visibility: result.visibility, exception: result.exception },
  });
  return result;
}

export async function setFolderGroupHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    group: string;
  },
): Promise<Extract<OperationResult, { kind: "visibility" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });

  const name = await resolveNamedAudience(ctx, args.workspaceId, args.group);

  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "setFolderGroup", path: args.path, group: name },
  })) as Extract<OperationResult, { kind: "visibility" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.folder.named",
    paths: [result.path],
    details: { visibility: result.visibility },
  });
  return result;
}

export async function setDirectoryVisibilityHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    visibility: Infer<typeof visibilityValidator>;
  },
): Promise<Extract<OperationResult, { kind: "visibility" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    actorName,
    operation: {
      kind: "setFolderVisibility",
      path: args.path,
      visibility: args.visibility,
    },
  })) as Extract<OperationResult, { kind: "visibility" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "visibility.folder",
    paths: [result.path],
    details: { visibility: result.visibility },
  });
  return result;
}

export async function resetPrivacyHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Extract<OperationResult, { kind: "privacyReset" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "resetPrivacy" },
  })) as Extract<OperationResult, { kind: "privacyReset" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "privacy.reset",
    paths: [result.path],
    // The folder *names* are metadata the audit log already records for every
    // other operation, and the count is what says how much of a map was
    // rebuilt. No rule is recorded because there is only one: private.
    details: {
      folders: result.folders.length,
      partial: result.partial,
      restored: result.backedUpTo !== null,
    },
  });
  return result;
}
