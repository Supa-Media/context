/**
 * Telling somebody an answer arrived — the part that leaves the building.
 *
 * `lib/formOps.ts` writes a response into a customer's bucket. This module is
 * the only thing that turns one into a message, and it is shaped by the threat
 * `functions/invitationEmail.ts` is shaped by, plus one that module does not
 * have: **the sender may be a stranger.** A form published with a collect link
 * takes answers from people with no account, so the content of this mail is
 * supplied by whoever found the link.
 *
 * ## 1. A form names a person, never an address
 *
 * `notify: owner` or `notify: @dan`, and `apps/mcp/src/forms.js` refuses
 * anything else — the reasoning is there, beside the grammar that enforces it.
 * What it means here is that this module never sends anywhere a form block
 * chose. It resolves an identity, requires a **live membership** in the
 * workspace the answer landed in, and reads the address off the account.
 *
 * So Context can mail a member of this workspace and nobody else. Removing
 * somebody's membership stops their mail without anybody editing a note, and
 * there is no value an editor can write into a code fence that makes a message
 * go somewhere new. That is the whole of the anti-relay story, and it is a
 * property of the *grammar* rather than of a check that could be forgotten.
 *
 * ## 2. The answers are in the mail, so the recipient must be able to read them
 *
 * Decided with the owner, 2026-09-21: a notification carries the answers,
 * because a bug report or a client brief you have to click through to is a
 * notification you act on tomorrow. The cost is that content leaves the bucket,
 * and the bound on it is that it only ever leaves *to somebody it had already
 * been shown to*.
 *
 * `canSee` answers that, through `files.runFileOperation`'s
 * `formNotifyVisible`, **at delivery and against the live manifest**. Not at
 * the write: an answer computed when the form was authored goes stale the
 * moment an owner changes their mind in `privacy.md`, and mail is the copy
 * that cannot be recalled. A recipient who may not read the responses note is
 * not mailed at all — not mailed a contentless notice, because "an answer
 * arrived on a form whose answers you cannot see" is itself a disclosure about
 * a file the manifest is holding back.
 *
 * ## 3. Nothing here can be timed, and nothing here can fail a submission
 *
 * Every entry point is a scheduled job. `files.ts` schedules `deliver` with
 * `runAfter(0, …)` and discards it; the submission has already returned by the
 * time any of this runs. A synchronous send would have made the time a
 * submission takes depend on whether the form notifies and on whether the
 * address accepted — an oracle readable with a stopwatch, by a stranger, on a
 * published URL.
 *
 * The same property is what makes a failure safe. The answer is in the
 * customer's bucket before this module exists; mail is a derivative of it, and
 * a derivative never rolls back the canonical write.
 *
 * ## 4. What bounds the volume
 *
 * `NOTIFY_LIMIT` per recipient per window, and over it the answers are counted
 * into `formNotifyDigests` and announced once. A published form's collect cap
 * is in the hundreds; nobody wants hundreds of messages, and dropping them
 * silently would make "a burst arrived" invisible to the person the form
 * belongs to.
 *
 * There is deliberately **no second limiter keyed on the address**, which is
 * the fence `invitationEmail.ts` needs and this does not. There, any account
 * could name any stranger's mailbox. Here the recipient is always a member of
 * the workspace doing the sending, so flooding somebody first requires them to
 * have granted you membership — and the lever they already hold is removing it.
 *
 * ## 5. What is logged, and what is not
 *
 * A closed field set, the discipline `logInvitationEmail` sets out. Absent and
 * required to stay absent: the recipient's address, the submitter's, any field
 * value, and the form's other responses. `workspaceId` and a stable reason code
 * are what an operator needs to answer "why did no mail arrive", and they are
 * all it gets.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { grantedNamesFor } from "./lib/grantedNames";
import { resolveAddressedUser } from "./lib/identities";
import { parseInvitee } from "./lib/invitees";
import { validAppOrigin } from "./lib/invitationEmail";
import { renderFormDigest, renderFormNotification } from "./lib/formNotifyEmail";
import type { RenderedEmail } from "./lib/invitationEmail";
import { tryConsumeRateLimit, windowEndsAt } from "./lib/rateLimit";
import type { RateLimitPolicy } from "./lib/rateLimit";

/** Resend's send endpoint. Reached by plain `fetch`; there is no SDK here. */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Where the API key lives. Unset means this deployment sends no mail at all. */
const RESEND_API_KEY_ENV_VAR = "RESEND_API_KEY";

/**
 * The from address.
 *
 * Its own variable rather than `AUTH_EMAIL_FROM`, because these are not
 * invitations and an operator should be able to give them their own subdomain,
 * their own reputation and their own unsubscribe handling without touching the
 * address that sign-in codes come from. Falls back to the same default shape.
 */
const FROM_ENV_VAR = "FORM_NOTIFY_EMAIL_FROM";
const DEFAULT_FROM = "forms@context.lc";

/**
 * How many notifications one member may get from one context in a window.
 *
 * Twenty an hour is "a busy morning on a bug tracker", not "a published form
 * being hammered". Over it the count goes to a digest rather than to the floor,
 * so the number can be conservative without anything being lost: the cost of
 * being wrong low is one summary message, and the cost of being wrong high is
 * somebody's inbox.
 *
 * Keyed on `(workspace, recipient)` so a person in six contexts is not throttled
 * in one because another is busy — the contexts are separate boundaries and
 * their mail should be too.
 */
const NOTIFY_LIMIT = 20;
const NOTIFY_WINDOW_MS = 60 * 60 * 1000;

function notifyPolicy(
  workspaceId: Id<"workspaces">,
  recipientUserId: Id<"users">,
): RateLimitPolicy {
  return {
    key: `form.notify:${String(workspaceId)}:${String(recipientUserId)}`,
    limit: NOTIFY_LIMIT,
    windowMs: NOTIFY_WINDOW_MS,
  };
}

/**
 * Operator-only logging, with a closed field set.
 *
 * `reason` is a stable code to grep for, never free text and never derived from
 * a provider's message — the rule `logInvitationEmail` states and the reason it
 * states it: free text is how an address ends up in a log.
 */
function logFormNotify(fields: {
  event: "sent" | "skipped" | "digested" | "send_failed";
  reason?:
    | "resend_unconfigured"
    | "no_such_recipient"
    | "not_a_member"
    | "no_verified_address"
    | "answers_not_visible"
    | "nothing_pending"
    | "http_error"
    | "transport_error";
  workspaceId?: string;
  formId?: string;
  status?: number;
  count?: number;
}): void {
  console.log(JSON.stringify({ controlPlane: "form-notify", ...fields }));
}

/**
 * Who a `notify:` value names, if anybody, and whether they may be told.
 *
 * INTERNAL, and every refusal is `null`. There is nothing to distinguish for a
 * caller — this runs in a scheduled job with no channel back to the person who
 * submitted, and the reasons ("no such handle", "not a member here", "no
 * verified address") are exactly the facts about other people that the control
 * plane's byte-identical errors exist to withhold. They reach the operator log
 * and stop there.
 *
 * `owner` resolves through the membership table rather than through a stored
 * "owner" field, so a context whose ownership moved tells the person who owns
 * it now. More than one owner resolves to `null` rather than to a pick, which
 * is `resolveAddressedUser`'s own rule applied here: a function that decides
 * who receives somebody's client briefs must never guess.
 */
export const resolveRecipient = internalQuery({
  args: { workspaceId: v.id("workspaces"), notify: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      recipientUserId: v.id("users"),
      email: v.string(),
      scope: v.union(v.literal("private"), v.literal("team")),
      grantedNames: v.array(v.string()),
      workspaceName: v.string(),
      workspaceSlug: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.slug === undefined) return null;

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_MEMBERS_SCANNED);

    let recipientUserId: Id<"users"> | null = null;
    if (args.notify === "owner") {
      const owners = members.filter((member) => member.role === "owner");
      recipientUserId = owners.length === 1 ? owners[0].userId : null;
    } else {
      const parsed = parseInvitee(args.notify);
      // A `notify` that is not `owner` is a handle, and the grammar in
      // `forms.js` already refused an address. Re-checked rather than assumed:
      // this query is reachable from a scheduled job whose arguments came out
      // of a bucket, and a bucket is a file somebody can edit by hand. The
      // `kind` test is the load-bearing half — `parseInvitee` accepts an
      // address, and accepting one here would be the relay the grammar exists
      // to refuse, reachable by editing a note in Obsidian.
      if (!parsed.ok || parsed.invitee.kind !== "name") return null;
      recipientUserId = await resolveAddressedUser(ctx, parsed.invitee);
    }
    if (recipientUserId === null) {
      logFormNotify({ event: "skipped", reason: "no_such_recipient" });
      return null;
    }

    const membership = members.find(
      (member) => String(member.userId) === String(recipientUserId),
    );
    if (membership === undefined) {
      // The anti-relay rule, enforced rather than described. A handle that
      // resolves to a real person who is not a member here gets nothing: the
      // form's author may name anybody, and naming is not granting.
      logFormNotify({ event: "skipped", reason: "not_a_member" });
      return null;
    }

    const user = await ctx.db.get(recipientUserId);
    if (
      user === null ||
      user.email === undefined ||
      user.emailVerificationTime === undefined
    ) {
      // An unverified address proves nothing about who holds the mailbox, and
      // this mail carries a stranger's answers. `resolveAddressedUser` holds
      // the same line for the same reason.
      logFormNotify({ event: "skipped", reason: "no_verified_address" });
      return null;
    }

    return {
      recipientUserId,
      email: user.email,
      /*
        An owner reads at `private` and everybody else at `team`, which is
        `scopeForRole`'s rule and not a second one. It matters here because it
        is the difference between "the owner is told about answers in a private
        folder" and "the owner is not told about their own client intake".
      */
      scope: membership.role === "owner" ? ("private" as const) : ("team" as const),
      grantedNames: await grantedNamesFor(ctx, args.workspaceId, recipientUserId),
      workspaceName: workspace.displayName ?? workspace.slug,
      workspaceSlug: workspace.slug,
    };
  },
});

/** Mirrors `MAX_MEMBERS_SCANNED` in `functions/invitations.ts`. */
const MAX_MEMBERS_SCANNED = 200;

/**
 * Deliver one notification, or count it into a digest. INTERNAL.
 *
 * Scheduled from the `form` branch of `runFileOperation`, which is the single
 * place a submission is written — so the console, a published collect link and
 * the gateway's `submit_form` all arrive here, and there is one answer to "does
 * this form tell anybody" rather than three.
 */
export const deliver = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    responseId: v.string(),
    to: v.string(),
    formId: v.string(),
    notePath: v.string(),
    responsesPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const recipient = await ctx.runQuery(internal.functions.formNotify.resolveRecipient, {
      workspaceId: args.workspaceId,
      notify: args.to,
    });
    if (recipient === null) return null;

    const room = await ctx.runMutation(internal.functions.formNotify.claimSlot, {
      workspaceId: args.workspaceId,
      recipientUserId: recipient.recipientUserId,
      formId: args.formId,
      responsesPath: args.responsesPath,
      notePath: args.notePath,
      responseId: args.responseId,
      notify: args.to,
    });
    if (!room) {
      /*
        Claimed before the bucket is opened, not after. Reading the answers and
        then discovering there was no room would let a stranger with a
        published link spend a bucket read per submission on work that is
        thrown away — the same reasoning `spendCollectSlot` gives for taking a
        slot before the write rather than after it.

        The cost of this order, stated: a slot spent on a notification the
        manifest then refuses is one fewer message in that window. It errs
        towards sending less, which is the direction to err in here.
      */
      logFormNotify({
        event: "digested",
        workspaceId: String(args.workspaceId),
        formId: args.formId,
      });
      return null;
    }

    /*
      THE ANSWERS ARE FETCHED AS THE RECIPIENT, AND THAT IS THE PRIVACY CHECK.

      Not "check a boolean, then render content we carried here" — those are
      two facts about one file that can disagree, and this is the place where
      being wrong means the content has already been sent. The read that
      produces the answers is the read `canSee` authorised, against the live
      manifest, for this person. There is no ordering of that which mails
      something the manifest refuses.

      It is also why nothing about the answers travelled in this job's
      arguments: a scheduled job's arguments are persisted until it runs, and
      note content in our database is the one thing non-negotiable #1 says
      never happens.

      `null` covers the manifest refusing, the response having been retracted
      in the meantime, and the block having stopped parsing. None of them is
      distinguished, because none of them has anybody to be distinguished to.
    */
    const read = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: recipient.scope,
      grantedNames: recipient.grantedNames,
      operation: {
        kind: "formNotifyRead" as const,
        notePath: args.notePath,
        formId: args.formId,
        responsesPath: args.responsesPath,
        responseId: args.responseId,
        to: args.to,
      },
    });
    if (read.kind !== "formNotifyRead" || read.response === null) {
      logFormNotify({
        event: "skipped",
        reason: "answers_not_visible",
        workspaceId: String(args.workspaceId),
        formId: args.formId,
      });
      return null;
    }


    const rendered = renderFormNotification({
      workspaceName: recipient.workspaceName,
      workspaceSlug: recipient.workspaceSlug,
      formId: args.formId,
      notePath: args.notePath,
      responsesPath: args.responsesPath,
      by: read.response.by,
      at: read.response.at,
      answers: read.response.answers,
    });

    await send(ctx, {
      workspaceId: args.workspaceId,
      recipientUserId: recipient.recipientUserId,
      formId: args.formId,
      responsesPath: args.responsesPath,
      to: recipient.email,
      rendered,
      action: "form.notify.sent",
      count: 1,
    });
    return null;
  },
});

/**
 * Take one off this recipient's allowance, or start a digest. INTERNAL.
 *
 * One mutation for both because they are one decision and must commit
 * together: a notification counted into the digest *and* mailed is the burst
 * announced twice, and one that is neither is the answer lost.
 *
 * The digest job is scheduled at the end of the window the limiter is already
 * in, read from the limiter rather than computed here — two clocks for one
 * window is how a digest fires while the limit is still closed and is
 * immediately refused by it.
 */
export const claimSlot = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    recipientUserId: v.id("users"),
    formId: v.string(),
    responsesPath: v.string(),
    notePath: v.string(),
    responseId: v.string(),
    notify: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const policy = notifyPolicy(args.workspaceId, args.recipientUserId);
    if (await tryConsumeRateLimit(ctx, policy)) return true;

    const existing = await ctx.db
      .query("formNotifyDigests")
      .withIndex("by_recipient_form", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("recipientUserId", args.recipientUserId)
          .eq("formId", args.formId),
      )
      .unique();

    const firesAt = await windowEndsAt(ctx, policy);
    if (existing === null) {
      const id = await ctx.db.insert("formNotifyDigests", {
        workspaceId: args.workspaceId,
        recipientUserId: args.recipientUserId,
        formId: args.formId,
        responsesPath: args.responsesPath,
        notePath: args.notePath,
        responseId: args.responseId,
        notify: args.notify,
        pending: 1,
        scheduledFor: firesAt,
      });
      await ctx.scheduler.runAt(firesAt, internal.functions.formNotify.sendDigest, {
        digestId: id,
      });
      return false;
    }

    await ctx.db.patch(existing._id, {
      pending: existing.pending + 1,
      // The newest held-back answer decides where the digest points and which
      // response it re-checks. A form whose `responses:` moved mid-burst
      // should send the reader to the file the last answer went into, and a
      // response that has since been retracted should not be the one the
      // digest's authorization hangs on.
      responsesPath: args.responsesPath,
      notePath: args.notePath,
      responseId: args.responseId,
    });
    // Already scheduled: one job per window, however many answers land in it.
    // This is what stops a burst of five hundred scheduling five hundred jobs.
    if (existing.scheduledFor === undefined) {
      await ctx.db.patch(existing._id, { scheduledFor: firesAt });
      await ctx.scheduler.runAt(firesAt, internal.functions.formNotify.sendDigest, {
        digestId: existing._id,
      });
    }
    return false;
  },
});

/** What the digest job needs, and the reset, in one transaction. INTERNAL. */
export const takeDigest = internalMutation({
  args: { digestId: v.id("formNotifyDigests") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      recipientUserId: v.id("users"),
      formId: v.string(),
      responsesPath: v.string(),
      notePath: v.string(),
      responseId: v.string(),
      to: v.string(),
      count: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.digestId);
    if (row === null) return null;
    /*
      Cleared before the send, never after. A digest that reset itself once the
      mail had gone would, on a retry or a second job, announce the same burst
      twice; one that fails after clearing loses a count nobody can act on
      anyway, because the answers it counted are in the note either way.
    */
    await ctx.db.patch(args.digestId, { pending: 0, scheduledFor: undefined });
    if (row.pending <= 0) return null;
    return {
      workspaceId: row.workspaceId,
      recipientUserId: row.recipientUserId,
      formId: row.formId,
      responsesPath: row.responsesPath,
      notePath: row.notePath,
      responseId: row.responseId,
      to: row.notify,
      count: row.pending,
    };
  },
});

/**
 * Say once how many answers the limit held back. INTERNAL.
 *
 * Re-resolves the recipient and re-checks that they may read the answers,
 * rather than trusting what was true when the burst started. A digest fires up
 * to a window after the answers landed, and a membership or a `privacy.md` rule
 * can change inside one — the mail must reflect the manifest at the moment it
 * is sent, which is the same rule `deliver` follows and the reason neither of
 * them caches an answer.
 *
 * It carries no answers, so the visibility check is about the *link* and the
 * fact rather than about content: telling somebody answers arrived on a file
 * they may no longer read is still telling them something about that file.
 */
export const sendDigest = internalAction({
  args: { digestId: v.id("formNotifyDigests") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const taken = await ctx.runMutation(internal.functions.formNotify.takeDigest, {
      digestId: args.digestId,
    });
    if (taken === null) {
      logFormNotify({ event: "skipped", reason: "nothing_pending" });
      return null;
    }

    const recipient = await ctx.runQuery(
      internal.functions.formNotify.resolveRecipientById,
      { workspaceId: taken.workspaceId, recipientUserId: taken.recipientUserId },
    );
    if (recipient === null) return null;

    const seen = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: taken.workspaceId,
      scope: recipient.scope,
      grantedNames: recipient.grantedNames,
      /*
        The last held-back response, read as this recipient — and its content
        thrown away. A digest carries no answers, so what is wanted here is the
        authorization and not the payload; asking for it through the same
        operation means a digest is gated by exactly what a notification is
        gated by, rather than by a second predicate that could drift from it.
      */
      operation: {
        kind: "formNotifyRead" as const,
        notePath: taken.notePath,
        formId: taken.formId,
        responsesPath: taken.responsesPath,
        responseId: taken.responseId,
        to: taken.to,
      },
    });
    if (seen.kind !== "formNotifyRead" || seen.response === null) {
      logFormNotify({
        event: "skipped",
        reason: "answers_not_visible",
        workspaceId: String(taken.workspaceId),
        formId: taken.formId,
      });
      return null;
    }

    await send(ctx, {
      workspaceId: taken.workspaceId,
      recipientUserId: taken.recipientUserId,
      formId: taken.formId,
      responsesPath: taken.responsesPath,
      to: recipient.email,
      rendered: renderFormDigest({
        workspaceName: recipient.workspaceName,
        workspaceSlug: recipient.workspaceSlug,
        formId: taken.formId,
        responsesPath: taken.responsesPath,
        count: taken.count,
      }),
      action: "form.notify.digest",
      count: taken.count,
    });
    return null;
  },
});

/**
 * The same checks as `resolveRecipient`, from an id rather than a name.
 * INTERNAL.
 *
 * A digest already knows who it is for, but must not assume they are still a
 * member or still verified — so the membership read, the verification read and
 * the granted names are asked again here rather than carried on the row. A row
 * that carried an address would be a stored answer to a question that changes.
 */
export const resolveRecipientById = internalQuery({
  args: { workspaceId: v.id("workspaces"), recipientUserId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      scope: v.union(v.literal("private"), v.literal("team")),
      grantedNames: v.array(v.string()),
      workspaceName: v.string(),
      workspaceSlug: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.slug === undefined) return null;
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", args.recipientUserId),
      )
      .unique();
    if (membership === null) {
      logFormNotify({ event: "skipped", reason: "not_a_member" });
      return null;
    }
    const user = await ctx.db.get(args.recipientUserId);
    if (
      user === null ||
      user.email === undefined ||
      user.emailVerificationTime === undefined
    ) {
      logFormNotify({ event: "skipped", reason: "no_verified_address" });
      return null;
    }
    return {
      email: user.email,
      scope: membership.role === "owner" ? ("private" as const) : ("team" as const),
      grantedNames: await grantedNamesFor(ctx, args.workspaceId, args.recipientUserId),
      workspaceName: workspace.displayName ?? workspace.slug,
      workspaceSlug: workspace.slug,
    };
  },
});

/**
 * The one HTTPS call, and the audit line beside it.
 *
 * Every refusal is silent to everybody but the operator log, and none of them
 * throws: this runs in a scheduled job, so a throw would be a retry that mails
 * the same answer twice rather than an error anybody sees.
 */
async function send(
  ctx: ActionCtx,
  input: {
    workspaceId: Id<"workspaces">;
    recipientUserId: Id<"users">;
    formId: string;
    responsesPath: string;
    to: string;
    rendered: RenderedEmail;
    action: "form.notify.sent" | "form.notify.digest";
    count: number;
  },
): Promise<void> {
  const apiKey = process.env[RESEND_API_KEY_ENV_VAR];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    logFormNotify({
      event: "skipped",
      reason: "resend_unconfigured",
      workspaceId: String(input.workspaceId),
      formId: input.formId,
    });
    return;
  }
  // No usable origin is not a refusal: the renderers fall back to naming the
  // path. An email saying an answer landed is worth more than none, which is
  // the opposite of an invitation, where the link IS the message.
  void validAppOrigin();

  let status: number;
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env[FROM_ENV_VAR] ?? DEFAULT_FROM,
        to: input.to,
        subject: input.rendered.subject,
        html: input.rendered.html,
        text: input.rendered.text,
      }),
    });
    status = response.status;
  } catch (error) {
    // The caught error may quote the request — headers and recipient included.
    // Dropped on the floor rather than wrapped, which is `controlPlane.js`'s
    // rule for the same reason.
    void error;
    logFormNotify({
      event: "send_failed",
      reason: "transport_error",
      workspaceId: String(input.workspaceId),
      formId: input.formId,
    });
    return;
  }

  if (status < 200 || status >= 300) {
    logFormNotify({
      event: "send_failed",
      reason: "http_error",
      status,
      workspaceId: String(input.workspaceId),
      formId: input.formId,
    });
    return;
  }

  logFormNotify({
    event: "sent",
    workspaceId: String(input.workspaceId),
    formId: input.formId,
    count: input.count,
  });
  await ctx.runMutation(internal.functions.formNotify.recordSent, {
    workspaceId: input.workspaceId,
    recipientUserId: input.recipientUserId,
    formId: input.formId,
    responsesPath: input.responsesPath,
    action: input.action,
    count: input.count,
  });
}

/**
 * The audit line for a notification that went out. INTERNAL.
 *
 * `paths` holds the responses note, which is metadata and is what a member
 * reading the trail needs to know *which* form told somebody. `details` holds
 * a count and nothing else — no address, no field value, no submitter. "When
 * did this form start mailing somebody" is a question the trail has to be able
 * to answer on its own, which is why this is its own action rather than a
 * detail on the submission's line.
 */
export const recordSent = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    recipientUserId: v.id("users"),
    formId: v.string(),
    responsesPath: v.string(),
    action: v.union(v.literal("form.notify.sent"), v.literal("form.notify.digest")),
    count: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      // The recipient, not the submitter. A submission through a collect link
      // has no acting identity at all, and the identity this row is about is
      // the person the content was sent to.
      actorUserId: args.recipientUserId,
      action: args.action,
      paths: [args.responsesPath],
      details: { formId: args.formId, count: args.count },
    });
    return null;
  },
});
