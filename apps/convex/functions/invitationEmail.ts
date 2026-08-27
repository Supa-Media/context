/**
 * Delivering an invitation — the part that leaves the building.
 *
 * `functions/invitations.ts` writes a row. This module is the only thing that
 * turns a row into a message, and the only thing that mints the credential that
 * makes the link in it sign somebody in. Both halves are shaped by the same
 * threat the invitation module is shaped by, plus one it did not have.
 *
 * ## 1. The send is scheduled, and that is a security boundary
 *
 * `inviteMember` calls `ctx.scheduler.runAfter(0, …)` and never
 * `ctx.runAction`. CLAUDE.md's "Scheduling is not calling" gives the general
 * rule; here is what it buys specifically. The attacker in this threat model is
 * the **inviter** — anybody with an account has an invite box — and the thing
 * they must not learn is whether a typed identifier belongs to a real person. A
 * synchronous send would hand them three separate answers to that:
 *
 *  - a return value that could say "delivered" or "no such mailbox";
 *  - an *exception*, if Resend refused the address;
 *  - a **latency difference**, which needs no API at all to read — a mutation
 *    that sometimes makes an HTTPS round trip and sometimes does not is an
 *    oracle you can time from a browser.
 *
 * A scheduled job is enqueued in a separate transaction whose return value the
 * scheduler discards. There is no channel back. `inviteMember` still returns
 * `null`, still takes the same time, and still cannot be made to say anything
 * else — so every decision in this file, including "does this address already
 * belong to somebody", is safe to make *here* and would not be safe to make
 * there.
 *
 * ## 2. A `@name` invitee gets nothing at all
 *
 * We do not know their address. Looking one up would mean resolving an
 * identifier to a person at invite time, which is precisely what
 * `inviteMember` refuses to do — see the invitation module's docstring. So the
 * scheduler is only invoked for an `email` invitee, and this action re-checks
 * the kind and returns early anyway. Two checks because the cost is a branch
 * and the failure mode is mailing somebody we were never given permission to
 * name.
 *
 * ## 3. The magic link is NOT the invitation token
 *
 * `workspaceInvitations.token` is stored unhashed, deliberately, because it is
 * not a bearer credential: accepting also requires *being* the addressed
 * identity. Making the emailed token sign its holder in would invert that in
 * one step — a forwarded email would hand over an account, and the table would
 * become a set of working credentials that we chose not to hash.
 *
 * So the link carries a second, separate secret in a query parameter: an
 * ordinary `authVerificationCodes` row minted through `auth:store`, stored as
 * `sha256(code)`, single-use, and consumed by the same client code that already
 * handles a `code` parameter. The invitation token stays exactly what it was.
 *
 * Two limits on that code, both in `lib/invitationEmail.ts`:
 *
 *  - **24 hours**, not the invitation's seven days. See `SIGNIN_CODE_TTL_MS`.
 *  - **Never for an address that already owns a personal context.** A magic
 *    link is a credential sitting in an inbox, and the blast radius of one
 *    addressed to a brand-new account with nothing in it is not the blast
 *    radius of one addressed to somebody's established context. Auto-
 *    authentication exists to serve the referral path; an existing owner gets
 *    the plain link and the ordinary sign-in screen, which costs them one
 *    screen and removes a standing credential from their mail archive.
 *
 * ## 4. What stops this being a way to mail strangers
 *
 * "Cause Context to send mail naming me to an arbitrary address" is now a
 * feature, so it is fenced on four sides:
 *
 *  - `INVITE_LIMIT` — 20 successful invitations per account per hour, already
 *    enforced in `inviteMember` and scoped to the account rather than the
 *    workspace.
 *  - **One send per invitation row, ever.** `emailSentAt` is claimed in a
 *    transaction before the HTTP call, so a retry, a double schedule, or a
 *    second operator running the action by hand all find the row already spent.
 *    There is deliberately no resend path.
 *  - **The inviter's own address must be verified.** An unverified account is
 *    an account nobody has proved they hold, and it must not be able to put a
 *    name in a stranger's inbox.
 *  - **Silence on every refusal.** Each of the above drops the send and returns
 *    `null`. Nothing propagates to the inviter, because a refusal that reached
 *    them would be the oracle again by another route.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import {
  invitationUrlFor,
  renderInvitationEmail,
  signInCodeExpiry,
} from "./lib/invitationEmail";

/** Resend's send endpoint. Reached by plain `fetch`; there is no SDK here. */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The from address, sharing the convention `auth.ts` already uses for sign-in
 * codes. One deployment, one sending identity.
 */
const FROM_ENV_VAR = "AUTH_EMAIL_FROM";
const DEFAULT_FROM = "invitations@context.lc";

/** Where the API key lives. Unset means this deployment sends no mail at all. */
const RESEND_API_KEY_ENV_VAR = "RESEND_API_KEY";

/**
 * The provider the minted code belongs to.
 *
 * **Not `"email"`**, which is the OTP provider, and the distinction is the
 * whole reason the link works at all.
 *
 * `Email()` from `@convex-dev/auth` hardcodes an `authorize` that refuses any
 * verification unless `params.email` is supplied and matches the account.
 * That is right for a six-digit code somebody types off a screen and fatal for
 * a link, whose entire premise is that the URL carries everything — a code
 * minted under `"email"` is stored and expires correctly and then throws
 * *"Token verification requires an `email` in params of `signIn`"* the instant
 * anybody clicks it.
 *
 * The fix is upstream, in `@supa-media/convex`, and is a second provider
 * rather than a flag on the first: the rate-limit key in
 * `verifyCodeAndSignIn` is derived from `params.email`, so a verification
 * carrying no email is not rate limited, and clearing the check on the OTP
 * provider would make a six-digit secret guessable without a limiter and
 * without knowing whose mailbox it was sent to. The library resolves which
 * `authorize` to run from the provider recorded **on the row**, so the two
 * cannot be confused.
 *
 * That is also why `SIGNIN_CODE_BYTES` below is not negotiable. This provider
 * has no email check and no rate limit; the token's own entropy is the only
 * thing between a guess and a session.
 */
const SIGNIN_PROVIDER = "magic-link";

/**
 * The literal above is `MAGIC_LINK_PROVIDER_ID` from `@supa-media/convex/auth`,
 * written out rather than imported because **this deployment cannot register
 * that provider yet**. The framework change adding it is committed upstream and
 * not released, so `@supa-media/convex@0.2.0` — what is installed — has neither
 * the export nor the `magicLink` option `auth.ts` would pass.
 *
 * The consequence is deliberate and visible rather than hidden: with no such
 * provider registered, minting the code throws, `mintSignInCode` below catches
 * it, and the invitation is mailed with a plain link. The recipient signs in
 * with a code, exactly as they did before this module existed, and the
 * invitation still works. Nothing is broken and nothing silently half-works.
 *
 * When the framework release lands, two lines finish it: add
 * `magicLink: { maxAge: 24 * 60 * 60 }` to `createSupaAuth` in `auth.ts`, and
 * import this constant instead of spelling it. The tests that assert a `?code=`
 * appears for a new invitee already exist and drive the mint directly, so they
 * do not depend on which of those two states the deployment is in.
 */

/** 32 bytes, hex — 64 characters. Not a six-digit OTP; see `sendInvitationEmail`. */
const SIGNIN_CODE_BYTES = 32;

/** Mirrors `MAX_MEMBERS_SCANNED` in `functions/invitations.ts`. */
const MAX_MEMBERSHIPS_SCANNED = 200;

/**
 * Operator-only logging, with a closed field set — the same discipline as
 * `lib/ingestLog.ts` and for the same reason.
 *
 * Absent, and required to stay absent: the recipient's address, the inviter's
 * address, either display name, the invitation token, and the sign-in code.
 * `reason` is a stable code an operator can grep for, never free text and never
 * derived from a message. `invitationId` is a document id — not a secret, not
 * guessable from outside, and the one handle an operator actually needs to
 * answer "why did no email arrive".
 */
function logInvitationEmail(fields: {
  event: "sent" | "skipped" | "send_failed";
  reason?:
    | "invitee_is_a_name"
    | "resend_unconfigured"
    | "not_sendable"
    | "http_error"
    // Not a failure to send: the mail goes out with a plain link. It is worth
    // a line because it is the difference between an invitation that signs
    // somebody in and one that asks them for a code.
    | "signin_code_unavailable";
  invitationId?: string;
  status?: number;
}): void {
  console.log(JSON.stringify({ controlPlane: "invitation-email", ...fields }));
}

/**
 * Should this address get a link that signs its holder in?
 *
 * `false` for anybody who already owns a personal context — see the module
 * docstring — and `false` for every ambiguity, because this decides whether to
 * put a credential in an inbox and the one thing it must not do is guess. Two
 * accounts on one address resolves to "no", exactly as `resolveInviteeUser`
 * resolves an ambiguity to `null`.
 */
async function shouldMintSignInCode(
  ctx: MutationCtx,
  email: string,
): Promise<boolean> {
  const matches = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(2);
  // No account: the referral path this exists for. More than one: fail closed.
  if (matches.length !== 1) return matches.length === 0;

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", matches[0]._id))
    .take(MAX_MEMBERSHIPS_SCANNED);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace !== null && workspace.kind === "personal") return false;
  }
  return true;
}

/**
 * The inviter's handle, or `null`.
 *
 * The same two-step resolution `resolveInviteeUser` performs in the other
 * direction: a `user` claim if one exists, otherwise the slug of a `personal`
 * workspace they own. An account with neither has no handle, which is a real
 * state and renders as just their name.
 */
async function handleFor(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<string | null> {
  const claims = await ctx.db
    .query("names")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_MEMBERSHIPS_SCANNED);
  for (const claim of claims) {
    if (claim.kind === "user") return claim.name;
  }

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_MEMBERSHIPS_SCANNED);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace !== null && workspace.kind === "personal") return workspace.slug;
  }
  return null;
}

/**
 * Decide whether this invitation may be emailed, and claim the right to do it.
 *
 * Every database read the send needs happens here, in one transaction, so the
 * action itself does nothing but crypto and a `fetch`. The claim is the point:
 * `emailSentAt` is written **before** the HTTP call, not after, so a failed
 * send is not retried and a duplicated job cannot produce a duplicated message.
 *
 * That is at-most-once rather than at-least-once, deliberately. The failure
 * this trades away is "the invitation email did not arrive", which the invitee
 * can still answer through `listMyInvitations` and the inviter can still fix by
 * inviting again — a re-invitation supersedes the row and clears this field.
 * The failure it prevents is "Context mailed the same person four times because
 * a job retried", which is the shape of thing that gets a sending domain
 * blocked and is indistinguishable, from the recipient's side, from us being
 * the abuse.
 *
 * Returns `null` for every refusal, and the refusals are not distinguished:
 * nothing here reaches a caller who could act on the difference.
 */
export const claimInvitationEmail = internalMutation({
  args: { invitationId: v.id("workspaceInvitations") },
  returns: v.union(
    v.null(),
    v.object({
      to: v.string(),
      token: v.string(),
      workspaceName: v.string(),
      inviterName: v.union(v.string(), v.null()),
      inviterHandle: v.union(v.string(), v.null()),
      expiresAt: v.number(),
      mintSignInCode: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const invitation = await ctx.db.get(args.invitationId);
    if (invitation === null) return null;
    // Re-checked here as well as at the scheduler: we have no address for a
    // handle, and inventing one is the enumeration leak `inviteMember` avoids.
    if (invitation.inviteeKind !== "email") return null;
    // Revoked, answered, expired, or superseded between scheduling and running.
    if (invitation.status !== "pending" || invitation.expiresAt <= now) return null;
    // Already spent. One row, one message, no resend path.
    if (invitation.emailSentAt !== undefined) return null;

    const inviter = await ctx.db.get(invitation.invitedBy);
    if (inviter === null) return null;
    // An unverified account is one nobody has proved they hold. It does not get
    // to put a name in a stranger's inbox.
    if (inviter.emailVerificationTime === undefined) return null;

    const workspace = await ctx.db.get(invitation.workspaceId);
    if (workspace === null) return null;

    const inviterHandle = await handleFor(ctx, inviter._id);
    const mintSignInCode = await shouldMintSignInCode(ctx, invitation.invitee);

    await ctx.db.patch(invitation._id, { emailSentAt: now });

    return {
      to: invitation.invitee,
      token: invitation.token,
      workspaceName: workspace.displayName,
      inviterName: inviter.name ?? null,
      inviterHandle,
      expiresAt: invitation.expiresAt,
      mintSignInCode,
    };
  },
});

/**
 * Send one invitation email.
 *
 * INTERNAL ACTION, reached only by the schedule edge from `inviteMember`. It
 * must stay internal and must stay scheduled: a public entry point would be a
 * function whose latency and exceptions answer "does this mailbox exist", which
 * is the whole thing the invitation module is built not to answer.
 *
 * **Never throws for a bad send.** A rejected address, an outage at Resend, and
 * a deployment with no API key are all *outcomes*, logged where an operator can
 * read them, not exceptions — there is nobody to raise them to, and a thrown
 * action would put a stack trace containing the recipient's address in a log.
 *
 * The sign-in code is `randomOpaqueToken(32)` — 64 hex characters from
 * `crypto.getRandomValues` — rather than the six digits the interactive OTP
 * uses. Six digits are fine for a code a person types within ten minutes and
 * are not fine for a secret that sits in a mailbox for a day: the rate limit
 * that makes 10^6 safe protects a form, not a value an attacker can grind
 * against an unauthenticated verification endpoint.
 */
export const sendInvitationEmail = internalAction({
  args: {
    invitationId: v.id("workspaceInvitations"),
    /**
     * Passed through from the row rather than read back here, so the "a handle
     * gets no email" rule is visible at the call site as well as enforced in
     * `claimInvitationEmail`.
     */
    inviteeKind: v.union(v.literal("name"), v.literal("email")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.inviteeKind !== "email") {
      logInvitationEmail({ event: "skipped", reason: "invitee_is_a_name" });
      return null;
    }

    /**
     * Checked before anything is read or written, so a deployment with no key
     * — every test in this repository that is not about email, and every
     * self-hoster who has not configured one — takes no action whatsoever
     * rather than half of one. The link is deliberately *not* logged as a
     * substitute: an invitation token in a log line is a capability in a log
     * line, and `listMyInvitations` is still there.
     */
    const apiKey = process.env[RESEND_API_KEY_ENV_VAR];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      logInvitationEmail({
        event: "skipped",
        reason: "resend_unconfigured",
        invitationId: args.invitationId,
      });
      return null;
    }

    const send = await ctx.runMutation(
      internal.functions.invitationEmail.claimInvitationEmail,
      { invitationId: args.invitationId },
    );
    if (send === null) {
      logInvitationEmail({
        event: "skipped",
        reason: "not_sendable",
        invitationId: args.invitationId,
      });
      return null;
    }

    let code: string | null = null;
    if (send.mintSignInCode) {
      const expirationTime = signInCodeExpiry(Date.now(), send.expiresAt);
      if (expirationTime !== null) {
        const minted = randomOpaqueToken(SIGNIN_CODE_BYTES);
        try {
          // The library's own mutation, so the row is exactly the one the
          // ordinary sign-in flow produces: hashed, single-use, and verified by
          // code this repository does not reimplement. It upserts the user and
          // auth account if the address is new, which is the same thing typing
          // an address into the sign-in form already does.
          await ctx.runMutation(internal.auth.store, {
            args: {
              type: "createVerificationCode",
              provider: SIGNIN_PROVIDER,
              email: send.to,
              code: minted,
              expirationTime,
              allowExtraProviders: false,
            },
          });
          code = minted;
        } catch {
          // A deployment whose auth config has no magic-link provider — which
          // is every deployment until the framework release lands. Degrading to
          // a plain link is the right answer to *any* failure here, not just
          // that one: the invitation is the thing that must arrive, and
          // auto-sign-in is a convenience on top of it. Failing the whole send
          // because a convenience could not be minted would be trading the
          // referral for the shortcut.
          //
          // `code` stays null, so the URL carries no `?code=` and the recipient
          // signs in with a code as they always could. Logged closed-field, as
          // everything here is — never the address, never the token.
          logInvitationEmail({
            event: "skipped",
            reason: "signin_code_unavailable",
            invitationId: args.invitationId,
          });
        }
      }
    }

    const rendered = renderInvitationEmail({
      inviterName: send.inviterName,
      inviterHandle: send.inviterHandle,
      workspaceName: send.workspaceName,
      url: invitationUrlFor(send.token, code),
      expiresAt: send.expiresAt,
    });

    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env[FROM_ENV_VAR] ?? DEFAULT_FROM,
        to: send.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });

    if (!response.ok) {
      // The status and nothing else. Resend's error body quotes the address it
      // refused, and an address in a log is the disclosure this file spends its
      // length avoiding.
      logInvitationEmail({
        event: "send_failed",
        reason: "http_error",
        invitationId: args.invitationId,
        status: response.status,
      });
      return null;
    }

    logInvitationEmail({ event: "sent", invitationId: args.invitationId });
    return null;
  },
});
