/**
 * Account deletion.
 *
 * One public mutation: the caller deletes *themself*. There is deliberately no
 * "delete this user" argument — an account is not something one person removes
 * for another, and an args-free mutation structurally cannot be aimed at
 * anybody but the identity on the request.
 *
 * ## What "delete my account" means for a workspace
 *
 * A workspace is the unit that owns a context (see CLAUDE.md, "The workspace
 * model"), so the question per membership is: does this context still have an
 * owner once I am gone?
 *
 *  - **I am the only owner** → the context dies with me. Everything hanging
 *    off the workspace goes: the storage binding (the customer's bucket is
 *    untouched — we only forget the credential), connect attempts, ingestion
 *    policy and tickets, invitations, grants, the audit trail, every
 *    membership, the slug's row in `names`, and the workspace row itself.
 *    Freeing the slug is the point, not a nicety: the shared namespace has no
 *    other release path, and a deleted account must not squat a name forever —
 *    the person may well re-onboard under it.
 *  - **Somebody else also owns it, or I am not an owner at all** → the context
 *    is not mine to take down. Only my own membership row goes.
 *
 * ## The rule this file must not break
 *
 * This is a public mutation and it must never touch `decryptSecret` — see
 * `__tests__/structure.test.ts`. A Dropbox binding's grant still has to be
 * revoked at Dropbox (otherwise our copy of the credential is forgotten while
 * the authorization lives on in the person's account), and that is done the
 * way `disconnectStorage` does it: the revocation is *scheduled*, envelope in
 * the args because the row is deleted in this transaction, and scheduling is
 * not calling — the scheduler discards the job's result, so no credential can
 * flow back here.
 *
 * Deletion is idempotent-safe within the call: absent optional rows are simply
 * skipped, never a throw. A half-set-up account (no binding, no name, no
 * sessions) deletes as cleanly as a fully onboarded one.
 */

import { v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import { mutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * `workspaceInvitations` deliberately has no plain `by_workspace` index (the
 * schema explains why), so a full teardown walks the statuses through
 * `by_workspace_status`. Spelled out rather than derived so a new status is a
 * conscious addition here too.
 */
const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "revoked",
] as const;

/**
 * Delete the calling user's account, entirely.
 *
 * Args-free on purpose: the identity on the request is the only account this
 * can remove. Returns a bare `{ deleted: true }` — no email, no name, no
 * credential-shaped anything, because a deletion receipt is a published
 * surface like any other return value.
 */
export const deleteAccount = mutation({
  args: {},
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    // Workspaces first, membership by membership. The cascade deletes the
    // membership row along with everything else, so the two branches converge
    // on "this membership no longer exists".
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const membership of memberships) {
      let soleOwner = false;
      if (membership.role === "owner") {
        const others = await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace", (q) =>
            q.eq("workspaceId", membership.workspaceId),
          )
          .collect();
        soleOwner = !others.some(
          (other) => other.role === "owner" && other.userId !== userId,
        );
      }
      if (soleOwner) {
        // Note the edge this deliberately includes: a workspace whose only
        // owner leaves dies even if editors or members remain. An ownerless
        // context has nobody who can rebind storage or revoke a grant, which
        // is not a state to leave anybody in.
        await deleteWorkspaceCascade(ctx, membership.workspaceId);
      } else {
        await ctx.db.delete(membership._id);
      }
    }

    // The address, which `deleteAccount` frees exactly as it frees a handle —
    // the `users` row goes below, and `resolveAddressedUser` then resolves the
    // address to whoever verifies it next. There is no claim date to pin an
    // email share against (`emailVerificationTime` is re-stamped on every
    // verifying sign-in), so unlike a handle this sweep is the whole control,
    // and the residue — a mailbox changing hands outside Context — is recorded
    // in `shares.ts` and pinned by a test rather than left to a comment.
    //
    // Unverified addresses are skipped because they are not identifiers:
    // `resolveAddressedUser` refuses them, so nothing was ever addressed here.
    const me = await ctx.db.get(userId);
    if (me?.email !== undefined && me.emailVerificationTime !== undefined) {
      await revokeSharesAddressedTo(ctx, "email", me.email.toLowerCase());
    }

    // The user's own name claims. Nothing writes a `kind: "user"` row today
    // (see functions/invitations.ts), so this is usually a no-op — but the
    // schema supports them and a claimed username must not outlive the person.
    const nameRows = await ctx.db
      .query("names")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of nameRows) {
      // Same rule as the workspace slugs below: a freed name inherits
      // nothing, so its pending invitations go before the row does.
      await voidCapabilitiesAddressedTo(ctx, row.name);
      await ctx.db.delete(row._id);
    }

    // Grants the user holds on *surviving* workspaces — a membership they gave
    // up above, or a co-owned context that lives on. The cascade already took
    // the ones on destroyed workspaces; this index walk is what makes revoking
    // the person's authority complete rather than incidental.
    const grants = await ctx.db
      .query("oauthGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const grant of grants) {
      await ctx.db.delete(grant._id);
    }

    // Parked authorization requests the person approved. `userId` here is a
    // field, not an index — the table is keyed by request id and code — but
    // rows live ten minutes and are swept hourly (see crons.ts), so the
    // unindexed walk is over a table that is small by construction, and an
    // approved-but-unredeemed code must not mint a grant for a deleted user.
    const authorizations = await ctx.db
      .query("oauthAuthorizations")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    for (const authorization of authorizations) {
      await ctx.db.delete(authorization._id);
    }

    // Auth material, leaves first: each account's verification codes, then the
    // account; each session's refresh tokens, then the session. Order matters
    // only for legibility — everything commits in one transaction — but the
    // grouping mirrors how @convex-dev/auth keys the rows.
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    for (const account of accounts) {
      const codes = await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .collect();
      for (const code of codes) {
        await ctx.db.delete(code._id);
      }
      await ctx.db.delete(account._id);
    }
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
    for (const session of sessions) {
      const refreshTokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const token of refreshTokens) {
        await ctx.db.delete(token._id);
      }
      await ctx.db.delete(session._id);
    }

    // Finally, the person. `requireAuthId` proved the row existed moments ago,
    // but the guard keeps this safe against a concurrent deletion rather than
    // throwing over a row that is already gone.
    if ((await ctx.db.get(userId)) !== null) {
      await ctx.db.delete(userId);
    }

    return { deleted: true };
  },
});

/**
 * Remove a workspace and everything that hangs off it.
 *
 * Called only for a workspace whose sole owner is the account being deleted.
 * The customer's bucket is never touched: what is deleted here is our metadata
 * about it, credential included, which is exactly the "revoke the key and
 * we're gone" promise `disconnectStorage` makes — extended to the whole row
 * set because the context itself is going away.
 *
 * Deliberately placed BELOW the export rather than above it (hoisting makes
 * both work): `__tests__/structure.test.ts` attributes everything before the
 * first `export const` to every export in the module, with no schedule
 * exemption — a preamble helper "cannot hide a call to the decrypt path".
 * Down here the scheduler reference sits inside `deleteAccount`'s analyzed
 * block, where the analyzer can see it is a schedule edge, not a call edge.
 */
async function deleteWorkspaceCascade(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  // The storage binding, with the same Dropbox care `disconnectStorage`
  // takes: schedule the revocation first, envelope in the args, because the
  // row it lives on is deleted on the next line. Scheduled, not called — this
  // public mutation must not reach the decrypt.
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (binding !== null) {
    if (
      binding.provider === "dropbox" &&
      binding.encryptedRefreshToken !== undefined
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.dropboxConnect.revokeDropboxGrant,
        {
          workspaceId,
          encryptedRefreshToken: binding.encryptedRefreshToken,
        },
      );
    }
    await ctx.db.delete(binding._id);
  }

  // In-flight Dropbox connects. No workspace index exists — the table is keyed
  // by state for the callback — but rows live minutes (`expiresAt` is short by
  // design), so the unindexed walk is over a table that is small by
  // construction, and a parked verifier must not outlive its workspace.
  const connectAttempts = await ctx.db
    .query("dropboxConnectAttempts")
    .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
    .collect();
  for (const attempt of connectAttempts) {
    await ctx.db.delete(attempt._id);
  }

  // The ingestion policy. `unique()` would also work — one row per personal
  // context — but a shared context has none, and collect-then-delete treats
  // "no row" as the ordinary case it is.
  const ingestionSettings = await ctx.db
    .query("ingestionSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const settings of ingestionSettings) {
    await ctx.db.delete(settings._id);
  }

  // Outstanding ingestion tickets. Same shape as the connect attempts: keyed
  // by ticket hash, short-lived and swept, so the unindexed walk is bounded by
  // the table's own TTL — and a live ticket for a deleted context would
  // otherwise still buy one credential fetch.
  const tickets = await ctx.db
    .query("ingestionTickets")
    .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
    .collect();
  for (const ticket of tickets) {
    await ctx.db.delete(ticket._id);
  }

  // A provisioning row, pending or failed. A pending one may still hold the
  // sealed account-level Cloudflare credential; a workspace being destroyed is
  // the strongest possible version of "this attempt is over".
  const provisioningRows = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of provisioningRows) {
    await ctx.db.delete(row._id);
  }

  // Invitations, in every status — a teardown is the one read the
  // status-narrowed index shape has to serve in full.
  for (const status of INVITATION_STATUSES) {
    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", status),
      )
      .collect();
    for (const invitation of invitations) {
      await ctx.db.delete(invitation._id);
    }
  }

  // Every AI-client grant on this context, whoever holds it. A grant is
  // authority over a workspace; the workspace is ceasing to exist, so an
  // editor's still-active grant must not survive as a dangling credential.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }

  // Every note share this context handed out, in both statuses. A share is a
  // standing capability addressed to somebody who is NOT a member, so it is
  // reachable by a person the sweeps above never touch, and — unlike an
  // invitation — it does not expire by default. Revoked rows go too: nothing
  // can read them once the context is gone, and leaving them would be keeping
  // rows about a workspace that no longer exists.
  //
  // Unbounded, like every sibling sweep in this function, and for the same
  // reason: a teardown that stops early leaves rows behind. `MAX_ACTIVE_SHARES`
  // caps only *active* rows, so this range can be larger than that cap — but
  // paging it would not change what the transaction has to read and write, only
  // how much is held at once, and `auditEvents` below is unbounded and larger
  // per context. If a teardown ever outgrows one transaction the answer is a
  // scheduled continuation, not a smaller page.
  for (const status of ["active", "revoked"] as const) {
    const shares = await ctx.db
      .query("noteShares")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", status),
      )
      .collect();
    for (const share of shares) {
      await ctx.db.delete(share._id);
    }
  }

  // The audit trail. Unlike a disconnect — where "storage was disconnected"
  // must remain visible — there is nobody left to read this one: the context
  // and its only owner are both going.
  const events = await ctx.db
    .query("auditEvents")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const event of events) {
    await ctx.db.delete(event._id);
  }

  // Every membership, the deleting owner's included.
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const membership of memberships) {
    await ctx.db.delete(membership._id);
  }

  // The slug's row in the shared namespace. This is what frees the name for
  // anyone — including the departing person, should they return.
  const nameRows = await ctx.db
    .query("names")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of nameRows) {
    await voidCapabilitiesAddressedTo(ctx, row.name);
    await ctx.db.delete(row._id);
  }

  await ctx.db.delete(workspaceId);
}

/**
 * A freed name must inherit nothing.
 *
 * Invitations are addressed to an identifier and resolved only at accept
 * time — deliberately, so `listInvitations` cannot be a username oracle and
 * so an email invitation follows whoever holds the mailbox. That design is
 * exactly why freeing a name is dangerous: a pending invitation to `@agent`
 * sitting in somebody else's workspace would be acceptable by the name's
 * NEXT owner — a stranger walking into a context that was shared with a
 * person who no longer exists. So every name this deletion releases takes
 * its pending invitations with it, across all workspaces, before the row is
 * freed.
 *
 * Pending only. `accepted`, `declined` and `expired` rows are other
 * workspaces' history, none of them can mint access (accepting requires
 * `pending`), and deleting them would be erasing somebody else's audit trail.
 *
 * **And note shares, which are the same shape and worse.** A share is
 * addressed to a `@handle` the same way and resolved the same way, but where an
 * invitation is a one-time offer that dies when it is answered, a share is
 * standing and by default never expires — so the window in which a freed name
 * can inherit one is not bounded by anything. Measured before this covered
 * them: the successor claimed the handle and `listSharedWithMe`, their own
 * inbox, handed them a live token for a note in a stranger's context, with no
 * link involved.
 *
 * This is the sweep half. `shareStillStands` in `functions/shares.ts` is the
 * re-check half, and it is not redundant — it is what makes the next table
 * somebody forgets to add here inert instead of exploitable.
 */
async function voidCapabilitiesAddressedTo(ctx: MutationCtx, name: string): Promise<void> {
  const pending = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", name))
    .filter((q) => q.eq(q.field("status"), "pending"))
    .collect();
  for (const invitation of pending) {
    await ctx.db.delete(invitation._id);
  }

  await revokeSharesAddressedTo(ctx, "name", name);
}

/**
 * Every standing note share addressed to one identifier, revoked.
 *
 * Revoked rather than deleted, which is the one place this differs from the
 * invitations above — and the honest statement of why is that **neither reason
 * previously given here was true.** It was first justified as preserving the
 * owner's disclosure record: nothing reads a revoked row, so there is no
 * record. It was then justified as required by the re-share path: measured,
 * and false — `findShareFor` is a `.unique()` on
 * `by_workspace_entry_recipient`, so deleting the row *frees* the tuple and a
 * later re-share simply inserts, with the same one-row outcome.
 *
 * What is left is a preference with one real property behind it: `revoked` is
 * this table's own word for "no longer live", so the sweep says the thing
 * `revokeShare` says, in the same field the three recipient channels already
 * check. Deleting would work identically and shrink the table. If that is
 * preferred later it is a safe change, and no comment here should be read as
 * an argument against it.
 *
 * No audit event is written. Whether an account deletion should write
 * `share.revoked` into a workspace whose owner is not the acting person is a
 * question about what a deletion may tell third parties, and it is left open
 * rather than answered in passing.
 *
 * **Complete, and therefore unbounded — like every sibling sweep here.** An
 * earlier version of this drained in pages and called that a bound, citing
 * `MAX_SHARES_RETURNED`'s rule that a read whose cost is set by other people's
 * rows gets a ceiling. Two reviews took that apart and both were right:
 * `.take()` in a loop reads and writes exactly the same total documents as
 * `.collect()`, so it bounded nothing, and it added a hazard no sibling has —
 * a mutation that stopped removing rows from the range would spin forever
 * rather than fail.
 *
 * A sweep that stops early **leaves a live capability addressed to an
 * identifier somebody else is about to hold**, so completeness is not
 * negotiable and the ceiling has to come from somewhere else. It is available:
 * a scheduled continuation, whose "scheduling is not calling" property this
 * codebase already relies on, would give completeness *and* a per-transaction
 * bound. It is not built. That is the accurate sentence — not that no ceiling
 * exists.
 *
 * So what stays open is real: `createShare` has no rate limit, and one account
 * can aim `MAX_WORKSPACES_PER_USER` × `MAX_ACTIVE_SHARES` rows at a single
 * identifier — multiplied by however many accounts an attacker makes, since
 * accounts are free.
 *
 * `deleteWorkspaceCascade` sweeps `auditEvents` unbounded too, and for an
 * established account that is the larger read. **That is not a reason to think
 * this one is handled**, and an earlier version of this comment came close to
 * saying so: the audit trail grows with the victim's own history, while these
 * rows are written by strangers, so for a new account they are the only
 * attacker-controlled term in the sum.
 */
async function revokeSharesAddressedTo(
  ctx: MutationCtx,
  kind: "name" | "email",
  value: string,
): Promise<void> {
  const now = Date.now();
  const standing = await ctx.db
    .query("noteShares")
    .withIndex("by_recipient", (q) =>
      q.eq("recipientKind", kind).eq("recipient", value).eq("status", "active"),
    )
    .collect();
  for (const share of standing) {
    await ctx.db.patch(share._id, { status: "revoked", revokedAt: now });
  }
}

/**
 * More rows than any sweep here would ever page over, for the tests that prove
 * these sweeps are complete.
 *
 * The sweeps are plain `.collect()` loops now, so there is no page boundary to
 * cross — but the failure they guard against is "stopped early", and a test
 * that seeds one share cannot see it. Exported and used by `shares.test.ts` so
 * the seeding count and this reasoning stay in one place.
 */
export const SWEEP_COMPLETENESS_ROWS = 101;
