/**
 * Reading and seeding a workspace's ingestion settings.
 *
 * The in-transaction half of `functions/ingestion.ts`, kept separate for the
 * same reason `lib/audit.ts` is: `functions/workspaces.ts` has to seed the row
 * inside the transaction that creates the workspace, and a mutation cannot call
 * another mutation. Everything here takes a ctx and does one small thing.
 *
 * The *rules* — what a valid address is, which senders are allowed, what a
 * folder path may look like — live in `lib/ingestion.ts`, which has no Convex
 * import at all. Nothing in this file may make a policy decision; it stores and
 * retrieves the settings that `senderIsAllowed` is later evaluated against.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { DEFAULT_TARGET_FOLDER, normalizeSenderEntry } from "./ingestion";

export async function getIngestionSettingsRow(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"ingestionSettings"> | null> {
  return await ctx.db
    .query("ingestionSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * Create a workspace's ingestion settings, closed except for its owner.
 *
 * **The default is the owner's own account email and nothing else.** Widening
 * is always a separate, deliberate act by the owner, and it is audited.
 *
 * Why not open by default: the capture address is semi-public (it is shown in
 * the console and derivable from a public slug), and mail that reaches it
 * becomes a note that the owner's AI clients later read as trusted context. An
 * open inbox is therefore a content-injection channel with a persistence
 * guarantee, not just a spam nuisance. Why the account email specifically: it
 * is the one address we already know the person controls — they authenticated
 * with it — so seeding it makes forwarding-to-yourself work on day one without
 * admitting a single stranger.
 *
 * The seeded value is a snapshot. If the user later changes the email on their
 * account, this entry does not follow: an account-email change must not
 * silently repoint who may write into a context. The console can surface the
 * mismatch; this must not paper over it.
 *
 * Called from `createWorkspace`, inside its transaction, so a workspace never
 * exists without a policy. If the account has no usable email — which should
 * not happen under email OTP — the row is still written, with an empty list.
 * That accepts nothing, which is the right answer to "we do not know who you
 * are".
 */
export async function seedIngestionSettings(
  ctx: MutationCtx,
  options: {
    workspaceId: Id<"workspaces">;
    ownerUserId: Id<"users">;
    now: number;
  },
): Promise<Id<"ingestionSettings">> {
  const owner = await ctx.db.get(options.ownerUserId);
  const seeded = normalizeSenderEntry(owner?.email);

  return await ctx.db.insert("ingestionSettings", {
    workspaceId: options.workspaceId,
    targetFolder: DEFAULT_TARGET_FOLDER,
    allowedSenders: seeded === null ? [] : [seeded],
    allowedDomains: [],
    allowAnySender: false,
    updatedBy: options.ownerUserId,
    createdAt: options.now,
    updatedAt: options.now,
  });
}
