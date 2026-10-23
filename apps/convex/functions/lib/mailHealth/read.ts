/**
 * A person's mailboxes, as their agents are told about them
 * (`docs/decisions/communications/mail-health.md`).
 *
 * Who may read: the owner of a personal workspace, through a live grant there
 * that carries `context:private`, for that workspace only. A shared workspace
 * holds no mailbox, a member or editor is never told the owner's addresses,
 * and every refusal is the same `null`, so nothing is learned from which.
 *
 * The "already told" markers live on the person's check-in row
 * (`texHeartbeats`), never in their bucket: a check-in that raised a
 * mailbox's state marks it there (`raiseMailNoticesHandler`), and it counts as
 * told only once the check-in's text reached them
 * (`recordHeartbeatResultHandler`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { SCOPE_PRIVATE } from "../consentScopes";
import { resolveGrantByAccessTokenHandler } from "../controlPlane/session";
import { personalWorkspaceOf } from "../../textLinks";
import { HEARTBEAT_CLIENT_ID, HEARTBEAT_LEASE_MS } from "../heartbeats/model";
import { TELLABLE, mailboxState, toldRecently, type MailboxState } from "./model";
import { GMAIL_SEND_SCOPE } from "../googleOAuth";

/**
 * What an agent is told about one mailbox. `tell`: a check-in should say it
 * now. `readOnly`: connected before every connect asked to send (2026-10-23),
 * so Tex can read it and not send from it until one reconnect.
 */
export type MailboxHealth = { address: string; state: MailboxState; lastSyncedAt: number | null; tell: boolean; readOnly: boolean };

/** More than anyone connects; the read stays bounded. */
const MAX_CONNECTIONS = 50;

type Cleared = { workspaceId: Id<"workspaces">; userId: Id<"users">; clientId: string };

/** The owner of this personal workspace, off the token's live grant, or null for anyone else. */
async function clearOwner(ctx: QueryCtx, hashedAccessToken: string, expectedWorkspaceId: string): Promise<Cleared | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken });
  if (session === null) return null;
  const covered = session.workspaces.find((entry) => entry.workspaceId === expectedWorkspaceId);
  if (covered === undefined || !session.scopes.includes(SCOPE_PRIVATE)) return null;
  const userId = session.actorUserId as Id<"users">;
  // Their own personal workspace, which only its creator owns: a member's or editor's grant never matches.
  if ((await personalWorkspaceOf(ctx, userId)) !== covered.workspaceId) return null;
  return { workspaceId: covered.workspaceId, userId, clientId: session.clientId };
}

async function heartbeatRow(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"texHeartbeats"> | null> {
  return await ctx.db
    .query("texHeartbeats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/** Each live mailbox of the workspace with its state, and whether it is owed a telling. */
async function mailboxesOf(ctx: QueryCtx, cleared: Cleared, now: number) {
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.workspaceId))
    .take(MAX_CONNECTIONS);
  const notices = (await heartbeatRow(ctx, cleared.userId))?.mailNotices;
  const found: Array<MailboxHealth & { connectionId: Id<"googleConnections"> }> = [];
  for (const row of rows) {
    const health = mailboxState(row, now);
    if (health === null) continue;
    const tell = TELLABLE.has(health.state) && !toldRecently(notices, row._id, health.state, now);
    found.push({ connectionId: row._id, address: row.address, ...health, tell, readOnly: !row.scopes.includes(GMAIL_SEND_SCOPE) });
  }
  return found.sort((a, b) => a.address.localeCompare(b.address));
}

/** The person's mailboxes and their states, or null for every caller who may not read them. */
export async function mailHealthHandler(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<MailboxHealth[] | null> {
  const cleared = await clearOwner(ctx, args.hashedAccessToken, args.expectedWorkspaceId);
  if (cleared === null) return null;
  return (await mailboxesOf(ctx, cleared, Date.now())).map(({ connectionId: _id, ...mailbox }) => mailbox);
}

/**
 * A check-in is about to text these mailboxes' states: kept on its row as
 * being raised, and counted as told when its result says it texted. Only the
 * check-in's own grant, only while its run is out, and only states that are
 * owed a telling now: anything else named is ignored. Answers how many.
 */
export async function raiseMailNoticesHandler(
  ctx: MutationCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string; mailboxes: Array<{ address: string; state: string }> },
): Promise<number> {
  const cleared = await clearOwner(ctx, args.hashedAccessToken, args.expectedWorkspaceId);
  if (cleared === null || cleared.clientId !== HEARTBEAT_CLIENT_ID) return 0;
  const row = await heartbeatRow(ctx, cleared.userId);
  const now = Date.now();
  const running = row !== null && row.runKind === undefined && row.claimedAt !== undefined && row.claimedAt + HEARTBEAT_LEASE_MS > now;
  if (!running) return 0;
  const named = (mailbox: MailboxHealth) =>
    args.mailboxes.some((given) => given.address === mailbox.address && given.state === mailbox.state);
  const raising = (await mailboxesOf(ctx, cleared, now))
    .filter((mailbox) => mailbox.tell && named(mailbox))
    .map((mailbox) => ({ connectionId: mailbox.connectionId, state: mailbox.state }));
  await ctx.db.patch(row._id, { mailRaising: raising, updatedAt: now });
  return raising.length;
}
