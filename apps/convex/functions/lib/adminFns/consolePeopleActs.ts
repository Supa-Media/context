/**
 * The People page's acts: tell a let-in phone row it is in, put a removed
 * row back on the list, and see and close the personal mail inboxes that
 * take mail from anyone.
 *
 * Handlers only. `functions/consolePeople.ts` authorizes with `requireAdmin`
 * before calling each one.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { getIngestionSettingsRow, resolvePersonalContextForIngestion } from "../ingestionStore";
import type { AdminActor } from "../admin";
import { recordAdminAudit } from "./audit";
import { checkBatch } from "./waitlist";
import { textRowsHandler, untoldRows } from "./waitlistUntold";

/** Ingestion settings rows read to find the open inboxes. There is no index on `allowAnySender`. */
export const INBOX_SCAN = 10_000;
/** Workspace memberships read for one account. */
const MEMBERSHIP_SCAN = 200;

/** Text the untold phone rows among `ids`, at most `WAITLIST_BATCH` a press. Ids that are not untold are ignored. */
export async function tellLetInHandler(
  ctx: MutationCtx,
  ids: Id<"waitlist">[],
): Promise<{ texted: number; left: number }> {
  checkBatch(ids.length);
  const wanted = new Set<string>(ids.map(String));
  const rows = (await untoldRows(ctx)).filter((row) => wanted.has(String(row._id)));
  return await textRowsHandler(ctx, rows);
}

/** Put removed rows back to waiting. Nothing else changes, and nobody is told. */
export async function restoreWaitlistHandler(
  ctx: MutationCtx,
  ids: Id<"waitlist">[],
): Promise<{ changed: number }> {
  checkBatch(ids.length);
  let changed = 0;
  for (const id of ids) {
    const row = await ctx.db.get(id);
    if (row === null || row.status !== "removed") continue;
    await ctx.db.patch(id, { status: "waiting" });
    changed += 1;
  }
  return { changed };
}

/** The ingestion rows that accept mail from anyone. */
async function openSettingsRows(ctx: QueryCtx): Promise<Doc<"ingestionSettings">[]> {
  const rows = await ctx.db.query("ingestionSettings").take(INBOX_SCAN);
  return rows.filter((row) => row.allowAnySender);
}

/**
 * The personal workspace whose capture address this settings row governs, and
 * the one owner who holds it. Null for anything else: a shared workspace has no
 * inbox, and a personal one without exactly one owner has no accountable person.
 */
async function personalInboxOf(
  ctx: QueryCtx,
  settings: Doc<"ingestionSettings">,
): Promise<{ workspace: Doc<"workspaces">; ownerUserId: Id<"users"> } | null> {
  const workspace = await ctx.db.get(settings.workspaceId);
  if (workspace === null) return null;
  const resolved = await resolvePersonalContextForIngestion(ctx, workspace.slug);
  if (resolved === null || resolved.workspace._id !== workspace._id) return null;
  return resolved;
}

/**
 * The accounts whose personal inbox takes mail from anyone.
 *
 * Bounded by `INBOX_SCAN`: a deployment with more settings rows than that would
 * under-list here, which is the price of having no index on the flag. Today the
 * table holds one row per personal workspace.
 */
export async function openInboxesHandler(
  ctx: QueryCtx,
): Promise<Array<{ userId: Id<"users">; workspaceSlug: string }>> {
  const out: Array<{ userId: Id<"users">; workspaceSlug: string }> = [];
  for (const settings of await openSettingsRows(ctx)) {
    const inbox = await personalInboxOf(ctx, settings);
    if (inbox === null) continue;
    out.push({ userId: inbox.ownerUserId, workspaceSlug: inbox.workspace.slug });
  }
  return out;
}

/**
 * Switch one account's personal inbox to known senders only. The allowlist and
 * domains are kept as they are; only the open flag goes. `changed` is false
 * when the account has no open inbox, so a second press is a no-op.
 */
export async function closeInboxHandler(
  ctx: MutationCtx,
  userId: Id<"users">,
  actor: AdminActor,
): Promise<{ changed: boolean }> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MEMBERSHIP_SCAN);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null) continue;
    const settings = await getIngestionSettingsRow(ctx, workspace._id);
    if (settings === null || !settings.allowAnySender) continue;
    const inbox = await personalInboxOf(ctx, settings);
    if (inbox === null || inbox.ownerUserId !== userId) continue;

    await ctx.db.patch(settings._id, { allowAnySender: false, updatedBy: actor.userId, updatedAt: Date.now() });
    await recordAdminAudit(ctx, actor, "mail.inbox_closed", String(userId));
    return { changed: true };
  }
  return { changed: false };
}
