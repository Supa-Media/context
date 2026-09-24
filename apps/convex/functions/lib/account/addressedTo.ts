import type { MutationCtx } from "../../../_generated/server";

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
export async function voidCapabilitiesAddressedTo(
  ctx: MutationCtx,
  name: string,
): Promise<void> {
  const pending = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_invitee", (q) =>
      q.eq("inviteeKind", "name").eq("invitee", name),
    )
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
export async function revokeSharesAddressedTo(
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
