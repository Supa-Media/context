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
 *  - **The invitation's own seven days**, and dead on first claim. See
 *    `SIGNIN_CODE_TTL_MS` for why the clock is not the thing bounding it.
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
 *  - **One send per *offer*, and a hard cap per *recipient*.** These are two
 *    fences, and the first is smaller than it used to be advertised as.
 *    `emailSentAt` is claimed in a transaction before the HTTP call, so a
 *    retry, a double schedule, or a second operator running the action by hand
 *    all find the row already spent, and there is deliberately no resend path
 *    for a spent offer. What it does **not** bound is the recipient:
 *    `inviteMember` supersedes the row for a `(workspace, invitee)` and clears
 *    `emailSentAt` on purpose, because otherwise re-inviting somebody would be
 *    a no-op in their inbox — so re-inviting is a resend, and a second
 *    workspace or a second free account sidesteps the row entirely. The bound
 *    that survives all four is `RECIPIENT_MAIL_LIMIT`, consumed against the
 *    address in `claimInvitationEmail`. Read the two together: the row stops a
 *    *duplicate*, the limiter stops a *flood*.
 *  - **The inviter's own address must be verified.** An unverified account is
 *    an account nobody has proved they hold, and it must not be able to put a
 *    name in a stranger's inbox.
 *  - **Silence on every refusal.** Each of the above drops the send and returns
 *    `null`. Nothing propagates to the inviter, because a refusal that reached
 *    them would be the oracle again by another route.
 */

import { v } from "convex/values";
import { MAGIC_LINK_PROVIDER_ID } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { APP_ORIGIN_ENV_VAR, randomOpaqueToken } from "./lib/gatewayAuth";
import { consumeRateLimit } from "./lib/rateLimit";
import {
  invitationUrlFor,
  renderInvitationEmail,
  signInCodeExpiry,
  validAppOrigin,
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
const SIGNIN_PROVIDER = MAGIC_LINK_PROVIDER_ID;

/**
 * Imported rather than spelled, since `@supa-media/convex@1.2.0` exports it and
 * `auth.ts` registers the provider. It was a literal for as long as this
 * deployment could not register one; the id has to match the provider on the
 * row exactly, and two copies of a string that must agree is a class of bug
 * worth not having.
 *
 * The degradation below is no longer the expected path, but it is still the
 * right answer to *any* mint failure, and the `provider_not_configured` detail
 * still earns its place: it is what an operator sees if `auth.ts` ever loses
 * the `magicLink` option again.
 */

/** 32 bytes, hex — 64 characters. Not a six-digit OTP; see `sendInvitationEmail`. */
const SIGNIN_CODE_BYTES = 32;

/** Mirrors `MAX_MEMBERS_SCANNED` in `functions/invitations.ts`. */
const MAX_MEMBERSHIPS_SCANNED = 200;

/**
 * How much invitation mail one address may receive, however many people invite
 * it and from however many contexts.
 *
 * **The bound that actually holds**, now that "one send per invitation row,
 * ever" has been read carefully. `emailSentAt` spends an *offer*, not a
 * recipient: `inviteMember` supersedes the row for a `(workspace, invitee)` and
 * clears the field, deliberately, so that re-inviting somebody is not a no-op
 * in their inbox. Re-inviting is therefore a resend, one button press at a
 * time, and nothing below `INVITE_LIMIT` (20/hour, per *account*, and accounts
 * are free) stood between one address and as much of that as anybody cared to
 * send. A workspace `displayName` is up to 80 sender-chosen characters and
 * lands in the Subject line of mail from our own domain, with a real app link
 * under it; escaping is correct, so the exposure is deliverability and sending
 * reputation rather than confidentiality, and those are the things a mail bomb
 * costs you.
 *
 * Keyed on the recipient, so it survives supersession, a second inviter, a
 * second workspace and a second account — the four ways round the per-row
 * field. Ten a day leaves ordinary onboarding alone (being invited to several
 * contexts on your first day is a real thing) and takes the worst case from
 * ~480 messages a day per account to ten, whoever is asking. The window is
 * fixed rather than sliding, so the true burst ceiling is twice this over a
 * short span; see `lib/rateLimit.ts`.
 *
 * Consumed inside `claimInvitationEmail` — which runs in the scheduled action,
 * where a refusal has nowhere to go. Enforcing it in `inviteMember` instead
 * would have thrown an error at the inviter whose presence depended on *other
 * people's* invitations to that address, which is a cross-tenant oracle.
 */
const RECIPIENT_MAIL_LIMIT = 10;
const RECIPIENT_MAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The limiter key for one recipient.
 *
 * Hashed, and honestly: an email address is low-entropy and guessable, so this
 * is not confidentiality and must not be described as such. It is footprint —
 * `rateLimits` is a table with no owner and no audit story, and there is no
 * reason for it to accumulate a second plaintext list of everybody anybody has
 * ever tried to invite when a digest limits just as well.
 */
async function recipientMailKey(address: string): Promise<string> {
  return `invitation.mail:${await hashToken(address.toLowerCase())}`;
}

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
    // No `APP_ORIGIN`, or one that is not an https URL. Checked *before* the
    // row is claimed, so this refusal costs the invitation nothing: it is a
    // fact about the deployment, identical for every row, and the same
    // invitation mails fine once an operator sets the variable.
    | "app_origin_unusable"
    | "not_sendable"
    // Resend answered, and said no. `status` carries which no.
    | "http_error"
    // Resend did not answer at all — DNS, TLS, a dropped connection. A
    // different fact from `http_error` and deliberately a different code: one
    // says our request was rejected, the other that it never arrived, and an
    // operator chasing "no mail is going out" needs to know which.
    | "transport_error"
    // Not a failure to send: the mail goes out with a plain link. It is worth
    // a line because it is the difference between an invitation that signs
    // somebody in and one that asks them for a code.
    | "signin_code_unavailable";
  invitationId?: string;
  status?: number;
  /**
   * Which flavour of a `reason` that has more than one cause.
   *
   * Closed by construction, not by convention: every value comes from
   * `classify` below, which emits either a fixed literal of its own or a
   * constructor name run through an identifier filter. A provider message, an
   * address, a token, or a code cannot reach this field, because none of them
   * is ever passed to it.
   */
  detail?: string;
}): void {
  console.log(JSON.stringify({ controlPlane: "invitation-email", ...fields }));
}

/**
 * The one thing an error is allowed to contribute to a log line: the name of
 * whatever was thrown.
 *
 * A constructor name (`TypeError`, `ConvexError`) is a stable, greppable
 * discriminator; a message is free text an upstream library composed, and in
 * this file free text is how a recipient's address ends up in a log. Filtered
 * to identifier characters and bounded anyway, so even a name somebody managed
 * to assign a sentence to arrives as a short token rather than as prose.
 */
function errorName(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * The message `@convex-dev/auth` throws when the provider named on a
 * `createVerificationCode` is not in the deployment's auth config.
 *
 * Built here from `SIGNIN_PROVIDER` rather than copied, so it cannot describe a
 * provider other than the one we asked for. Used **only** to choose between two
 * constants — nothing derived from the message itself is ever logged.
 */
const PROVIDER_MISSING_MARKER = `Provider \`${SIGNIN_PROVIDER}\` is not configured`;

/**
 * Why the mint failed, as a value an operator can act on.
 *
 * The expected answer is `provider_not_configured`, which is true of every
 * deployment until the framework release lands and means "nothing is wrong,
 * this is the documented degraded state". Anything else — a renamed argument,
 * a validator change in `auth:store`, an `expirationTime` the library rejects —
 * is a defect, and before this existed the two produced a byte-identical log
 * line, so an operator had no way to tell "still waiting on upstream" from
 * "the provider is registered and minting is broken".
 *
 * Matching a library's prose is brittle on purpose-limited terms: it can only
 * ever mistake a real defect for the expected condition if that defect throws
 * this exact sentence about this exact provider, and the fallback is the
 * conservative one — an unrecognised failure classifies as a defect, never as
 * "expected".
 */
function classifyMintFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes(PROVIDER_MISSING_MARKER)) return "provider_not_configured";
  return `mint_threw_${errorName(error)}`;
}

/**
 * Should this address get a link that signs its holder in?
 *
 * **Only an address that is not in the product yet.** A magic link is a
 * standing credential in a mailbox; minting one is defensible for a stranger
 * whose account does not exist or holds nothing, and is not defensible for
 * somebody who is already using Context, because there it is a 24-hour key to
 * whatever they have.
 *
 * This used to ask a narrower question — "do they *own a personal context*" —
 * and the gap between that and the stated rule was reachable. `listMembers`
 * hands every member of a context the addresses of the others. A co-member
 * could take one, make a throwaway workspace, invite it, and cause Context to
 * mail that person an unrequested auto-sign-in link into their own established
 * account — because holding `editor` on three of somebody else's contexts and
 * owning nothing passed the old test. So did owning only shared contexts.
 *
 * The question asked now is "does this address already have an account with any
 * membership at all", which is the set the rationale was always describing. An
 * account with no memberships still mints: `auth:store` upserts a user row the
 * first time a code is minted, so refusing on the mere existence of an account
 * would make the second invitation to the same never-registered stranger
 * silently degrade.
 *
 * `false` for every ambiguity, because this decides whether to put a credential
 * in an inbox and the one thing it must not do is guess. Two accounts on one
 * address resolves to "no", exactly as `resolveInviteeUser` resolves an
 * ambiguity to `null`.
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

  // One row is enough. What matters is "already in the product", not how
  // deeply — the role and the workspace kind are exactly the distinctions that
  // made the old check narrower than the rule it was written for.
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", matches[0]._id))
    .take(1);
  return membership.length === 0;
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
 * Retire the sign-in code an invitation put in somebody's mailbox.
 *
 * Called when an invitation stops being open — accepted, declined, or withdrawn
 * by its owner. Without it, withdrawing an invitation withdrew the *offer* and
 * left the *credential* live for the rest of the invitation's week, which is not
 * what an owner who clicks "revoke" believes they did. Accepting and declining are the same
 * story from the invitee's side: the link in the mailbox has been answered and
 * should stop being a way into an account.
 *
 * Only ever touches rows minted under `SIGNIN_PROVIDER`. The interactive OTP
 * lives on a different provider on a different account row, so somebody in the
 * middle of signing in normally cannot have their code deleted by an unrelated
 * invitation being answered.
 *
 * Two honest imprecisions, both in the safe direction:
 *
 *  - The invitation does not record *which* code it minted, so this deletes the
 *    magic-link code for the address rather than for the row. In practice there
 *    is at most one — `createVerificationCode` deletes the previous row for the
 *    same account before inserting — so the only case where this reaches
 *    further than its own invitation is when a *newer* invitation to the same
 *    address has since minted, and revoking the older one retires it too. That
 *    costs the newer invitation its shortcut, not its validity: it is still
 *    answerable, and `listMyInvitations` is still there.
 *  - It is silent. There is nothing to report and nobody to report it to; the
 *    invitation's own status is the record of what happened.
 */
export async function invalidateInvitationSignInCode(
  ctx: MutationCtx,
  invitation: Doc<"workspaceInvitations">,
): Promise<void> {
  // A handle was never mailed, so nothing was ever minted for it, and we have
  // no address to look one up by even if it had been.
  if (invitation.inviteeKind !== "email") return;
  if (invitation.emailSentAt === undefined) return;

  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q
        .eq("provider", SIGNIN_PROVIDER)
        .eq("providerAccountId", invitation.invitee),
    )
    .take(2);

  for (const account of accounts) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .take(MAX_MEMBERSHIPS_SCANNED);
    for (const row of codes) {
      if (row.provider === SIGNIN_PROVIDER) await ctx.db.delete(row._id);
    }
  }
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
 * Note precisely what that last sentence does and does not cover. A *retry*
 * cannot mail twice; a *person pressing invite again* can, by design, and so
 * can a second workspace or a second account. `RECIPIENT_MAIL_LIMIT`, consumed
 * below against the address itself, is what stops that being unbounded — and it
 * is consumed after every other refusal, so nothing that was never going to be
 * mailed spends any of it.
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

    /**
     * The per-recipient bound, spent last so that none of the refusals above
     * costs an address any of its budget.
     *
     * `consumeRateLimit` throws, which is right where a human is waiting and
     * wrong here — the whole design of this module is that a refusal to mail
     * has nowhere to go. The throw is turned back into the same `null` every
     * other refusal returns, and **must stay** that: an exception escaping this
     * mutation would surface in the scheduler, and its presence would be a
     * function of how much mail *other* people had sent this address.
     *
     * Catching everything, not just `RATE_LIMITED`, is the fail-closed
     * direction. A limiter that cannot answer is a limiter whose budget we
     * cannot prove we are inside of, and the safe move then is not to send.
     */
    try {
      await consumeRateLimit(ctx, {
        key: await recipientMailKey(invitation.invitee),
        limit: RECIPIENT_MAIL_LIMIT,
        windowMs: RECIPIENT_MAIL_WINDOW_MS,
      });
    } catch {
      return null;
    }

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
 * **Never throws for a bad send**, and that is now true rather than intended.
 * A rejected address, a non-2xx from Resend, a transport failure that never
 * reached Resend at all, a deployment with no API key, a deployment with no
 * usable `APP_ORIGIN`, and a row that turns out not to be sendable are all
 * *outcomes*, logged where an operator can read them — there is nobody to raise
 * them to, and a thrown action would put a stack trace containing the
 * recipient's address in a log.
 *
 * What that costs, stated plainly, because the two failures are not paid for
 * the same way. The two deployment-static checks run *before* the claim, so
 * they cost the invitation nothing and it mails normally once the deployment is
 * fixed. Everything after the claim costs the invitation: a transport failure
 * or a 4xx spends the row and there is no resend path, which is at-most-once
 * working as designed rather than a gap to close.
 *
 * What still escapes is a defect rather than a send failure, and there are two.
 * `renderInvitationEmail` would throw on an `expiresAt` that `Date` cannot
 * represent — impossible from a row `inviteMember` wrote, and if it ever
 * happens the right outcome is a loud one. And `ctx.runMutation` can fail on
 * the claim itself; a Convex mutation is transactional, so that is a row that
 * was never spent, which is the safe direction for it to fail in.
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

    /**
     * The second deployment-static precondition, checked in the same place and
     * for the same reason as the first.
     *
     * There is no email without a link, and `invitationUrlFor` refuses to
     * invent an origin — correctly, because a guessed origin is a link with our
     * name on it pointing somewhere we do not own. Asking it *after* the claim
     * meant a deployment with a Resend key and no `APP_ORIGIN` marked every
     * invitation as mailed, threw, and mailed none of them; because the
     * condition is a property of the deployment rather than of the row, that
     * happened to every invitation, identically, and there is no resend path to
     * recover any of them.
     *
     * So it is answered here, before `claimInvitationEmail` writes anything.
     * The invitation stays unspent and is mailed by the ordinary schedule the
     * next time somebody invites — a deployment problem costs the operator a
     * variable, not their users' invitations.
     *
     * This is not a second way to re-send. It reaches no network and writes no
     * row, so nothing about it can put a message in an inbox; an invitation is
     * still spent by exactly one thing, `claimInvitationEmail`.
     */
    const appOrigin = validAppOrigin();
    if (appOrigin === null) {
      logInvitationEmail({
        event: "skipped",
        reason: "app_origin_unusable",
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
        } catch (error) {
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
          //
          // `detail` is the half that was missing: because *any* failure
          // degrades the same way, the expected condition and a real defect in
          // the mint used to produce the same line, and an operator watching
          // for the framework release had no way to tell one from the other.
          logInvitationEmail({
            event: "skipped",
            reason: "signin_code_unavailable",
            invitationId: args.invitationId,
            detail: classifyMintFailure(error),
          });
        }
      }
    }

    const rendered = renderInvitationEmail({
      inviterName: send.inviterName,
      inviterHandle: send.inviterHandle,
      workspaceName: send.workspaceName,
      // The origin validated above, handed back explicitly rather than read
      // from the environment a second time. The check and the build then cannot
      // be looking at different values, and this call provably cannot throw.
      url: invitationUrlFor(send.token, code, {
        [APP_ORIGIN_ENV_VAR]: appOrigin,
      }),
      expiresAt: send.expiresAt,
    });

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
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
    } catch (error) {
      // Resend never answered: DNS, TLS, a connection dropped mid-flight.
      // `!response.ok` below has always been handled as an outcome; this is the
      // same fact arriving as a rejection instead of a status, and it used to
      // be the one thing in this action that escaped as an exception — from
      // *after* the claim, so the invitation was spent, and into a stack trace
      // in a log this file spends its length keeping addresses out of.
      //
      // The row stays spent, deliberately. At-most-once is the rule: an
      // outage that might have delivered is not a licence to send again.
      logInvitationEmail({
        event: "send_failed",
        reason: "transport_error",
        invitationId: args.invitationId,
        detail: errorName(error),
      });
      return null;
    }

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
