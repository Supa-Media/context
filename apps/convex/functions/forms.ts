/**
 * Markdown forms, from the console.
 *
 * Four actions, one operation. The reasoning — why this exists rather than
 * calling the gateway, what is shared with it and what is not, and why the
 * response file is written without being readable — is in `lib/formOps.ts`.
 * This file is the authorization and the wire shape.
 *
 * ## `minimum: "member"`, which is the whole point
 *
 * `files.writeNote` requires `editor`, correctly: it writes arbitrary text to
 * an arbitrary path. These require `member`, because a form exists to collect
 * answers from people who cannot write notes, and a shared workspace whose
 * members can file nothing is the gap the feature was built to close.
 *
 * What keeps that narrow is not this file. It is that the only thing these can
 * write is one response, rendered by `apps/mcp/src/forms.js` from values
 * checked against the form's own declared fields, into a file an **editor**
 * named and that already carries this form's marker. There is no argument on
 * any action below that reaches a bucket as text, and no argument that names a
 * path except the form's own note.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { action, internalQuery, type ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";
import type { FormAction } from "./lib/formOps";

const answerValidator = v.object({ field: v.string(), value: v.string() });

/**
 * What every one of these takes.
 *
 * `path` is the note the block is on, never the response file: the caller
 * names the form they are looking at, and where its answers go is the block's
 * business. A caller that could name the destination could aim a submission at
 * any note in the workspace.
 */
const formArgs = {
  workspaceId: v.id("workspaces"),
  path: v.string(),
  formId: v.optional(v.string()),
};

const resultValidator = v.object({
  responseId: v.string(),
  formId: v.string(),
  responsesPath: v.string(),
  votes: v.optional(v.number()),
});

/**
 * The caller's username, and their role in the workspace they are acting in.
 *
 * The username is their own brain's slug — the name in the global namespace
 * that means anything to the other people reading the response file. It is
 * read here, from their membership, and never taken from an argument: that is
 * what makes `by` a stamp rather than a claim, and it is the same rule the
 * gateway's `personalNameFor` follows.
 *
 * A person with no personal context has no name to record under. That is not a
 * state onboarding produces, but a stale membership or a self-hosted
 * deployment can, and the refusal says what to do rather than inventing one.
 */
export const formActor = internalQuery({
  args: { actorUserId: v.id("users"), workspaceId: v.id("workspaces") },
  returns: v.object({
    name: v.string(),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
  }),
  handler: async (ctx, args) => {
    const access = await requireWorkspaceAccess(ctx, args.workspaceId, args.actorUserId);

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.actorUserId))
      .collect();
    for (const membership of memberships) {
      if (membership.role !== "owner") continue;
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace?.kind !== "personal" || !workspace.slug) continue;
      return { name: `@${workspace.slug}`, role: access.membership.role };
    }
    throw new ConvexError({
      code: "NO_USERNAME",
      message: "You have no username to record a response under; create your brain first.",
    });
  },
});

async function callerId(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

/**
 * One form action, through the credential barrier.
 *
 * Every public action below is this with a different `action` payload, which is
 * deliberate: the authorization, the identity and the single bucket-opening
 * call are written once. Four copies of this is how one of them ends up without
 * the `formActor` call and takes a name from its arguments.
 */
async function runForm(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; path: string; formId?: string },
  formAction: FormAction,
) {
  const actorUserId = await callerId(ctx);
  /*
    `minimum: "member"` — see the module comment. `authorizeFileAccess` also
    hands back the visibility scope, which is what decides whether the caller
    can see the form's note at all: `resolveForm` refuses one they cannot,
    with the same "does not exist" every other read gives.
  */
  const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const actor = await ctx.runQuery(internal.functions.forms.formActor, {
    actorUserId,
    workspaceId: args.workspaceId,
  });

  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    operation: {
      kind: "form" as const,
      path: args.path,
      formId: args.formId,
      actorName: actor.name,
      actorRole: actor.role,
      action: formAction,
    },
  });
  const applied = result as {
    responseId: string;
    formId: string;
    responsesPath: string;
    votes?: number;
  };
  return {
    responseId: applied.responseId,
    formId: applied.formId,
    responsesPath: applied.responsesPath,
    ...(applied.votes === undefined ? {} : { votes: applied.votes }),
  };
}

/** Send an answer to a form. */
export const submitForm = action({
  args: { ...formArgs, values: v.array(answerValidator) },
  returns: resultValidator,
  handler: (ctx, args) =>
    runForm(ctx, args, { kind: "submit", values: args.values }),
});

/** Replace the answers on a response you submitted. */
export const updateSubmission = action({
  args: { ...formArgs, responseId: v.string(), values: v.array(answerValidator) },
  returns: resultValidator,
  handler: (ctx, args) =>
    runForm(ctx, args, { kind: "update", responseId: args.responseId, values: args.values }),
});

/** Delete a response you submitted; an editor may delete anybody's. */
export const retractSubmission = action({
  args: { ...formArgs, responseId: v.string() },
  returns: resultValidator,
  handler: (ctx, args) =>
    runForm(ctx, args, { kind: "retract", responseId: args.responseId }),
});

/** Add or take back your upvote on one response. */
export const voteForm = action({
  args: {
    ...formArgs,
    responseId: v.string(),
    vote: v.optional(v.union(v.literal("up"), v.literal("none"))),
  },
  returns: resultValidator,
  handler: (ctx, args) =>
    runForm(ctx, args, {
      kind: "vote",
      responseId: args.responseId,
      vote: args.vote ?? "up",
    }),
});
