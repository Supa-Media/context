/**
 * A group chat's own check-in (decided by the owner, 2026-10-27: "shouldnt it
 * monitor the inbox I share, and heartbeats and stuff just as dm Tex would do,
 * I dont want to have to setup anything special for the group, it should just
 * work, and know when an email needs to go to the group vs me personally";
 * `docs/decisions/texting-assistant/chat-mail.md`).
 *
 * A chat bound to a shared workspace looks on its own, as a person's own
 * check-in does (`lib/heartbeats/`): at the same daily slots in its binder's
 * time zone, and about a minute after new mail reaches a mailbox shared there,
 * never sooner than five minutes after its last look. Nothing is set up: a
 * chat is armed by its next turn, and the daily arming catches the rest.
 *
 * One look per chat, kept on its own row and run as its binder tagging Tex in
 * the chat (or, failing them, the earliest person sharing mail there), so it
 * is the ordinary chat turn with every check it has (who is in the chat now,
 * the workspace it is bound to, the shares still live). The turn posts what
 * the chat needs and stays quiet otherwise; mail that needs only the
 * mailbox's person is left to their own check-ins, which are told which of
 * their mail a chat watches (`claimPersonMailRead`).
 *
 * A chat that chose to be quiet, or where nobody has talked to Tex for
 * `DORMANT_MS` (a look's own turn does not count: `applyGroupTurn` with
 * `routine`), looks only for mail shared with it: a chat nobody reads is not
 * worth a model's look three times a day. Its next turn arms it again.
 *
 * The cron hands these out beside routines (`routines/runs.ts`): a look is a
 * chat routine's run with no note behind it.
 */

import { chatWorkspace } from "./textGroupReach";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { nextBeatAfter } from "./heartbeats/model";
import { accountTimeZone, routineRecipients } from "./routines/access";
import { ROUTINE_LEASE_MS, effectiveTimeZone } from "./routines/model";
import { routineChat } from "./routines/chats";
import { liveMailShares } from "./textGroupMail";

/** How long after a notification the look starts, so the mail that came with it has landed. */
export const LOOK_DELAY_MS = 60_000;
/** The least time between two looks brought forward by mail. */
export const LOOK_GAP_MS = 5 * 60_000;
/** A chat where nobody has talked to Tex for this long looks only for shared mail. */
export const DORMANT_MS = 14 * 24 * 60 * 60_000;
/** A first look goes back this far. */
export const FIRST_LOOK_MS = 24 * 60 * 60_000;
/** The path a look is handed out under: no note, the texting Worker asks the check-in question (`groupRoutines.ts`). */
export const CHAT_LOOK_PATH = "(check-in)";
const LOOKS_CLIENT_ID = "context_texts_group";
/** Most chats one daily arming reads. */
const ARM_BATCH = 2000;

export type ClaimedLook = {
  runId: string;
  path: string;
  timeZone: string;
  send: "text";
  phones: string[];
  chat: string;
  since: number;
};

/** Who a chat's look runs as: whoever bound it, else the earliest person sharing mail there. */
async function lookerOf(ctx: QueryCtx, group: Doc<"textGroups">): Promise<Id<"users"> | null> {
  if (group.boundBy !== undefined) return group.boundBy;
  const shares = await ctx.db
    .query("chatMailShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(40);
  const first = shares.reduce<Doc<"chatMailShares"> | null>((soonest, share) => (soonest === null || share.createdAt < soonest.createdAt ? share : soonest), null);
  return first?.userId ?? null;
}

async function zoneOf(ctx: QueryCtx, userId: Id<"users"> | null): Promise<string> {
  return effectiveTimeZone(undefined, userId === null ? null : await accountTimeZone(ctx, userId));
}

/** A chat bound to a workspace with no look coming gets its next daily one. Never moves one already due. */
export async function armChatLook(ctx: MutationCtx, group: Doc<"textGroups">, now: number): Promise<boolean> {
  if (group.nextLookAt !== undefined || group.mutedAt !== undefined || group.guestGroupId !== undefined) return false;
  // A chat with a workspace in reach (`lib/textGroupReach.ts` `chatWorkspace`): the bound one if still in reach, else the first.
  if ((await chatWorkspace(ctx, group)) === null) return false;
  const next = nextBeatAfter(await zoneOf(ctx, await lookerOf(ctx, group)), now);
  if (next === null) return false;
  await ctx.db.patch(group._id, { nextLookAt: next });
  return true;
}

/** Daily (`crons.ts`, beside the people's own): every bound chat with no look coming is armed. */
export async function armChatLooksHandler(ctx: MutationCtx, now: number): Promise<number> {
  let armed = 0;
  for (const group of await ctx.db.query("textGroups").take(ARM_BATCH)) {
    if (await armChatLook(ctx, group, now)) armed += 1;
  }
  return armed;
}

/** New mail reached `address` of `userId`: each chat it is shared with looks soon. */
export async function wakeChatMailLooks(ctx: MutationCtx, userId: Id<"users">, address: string, now: number): Promise<number> {
  const shares = (await ctx.db.query("chatMailShares").withIndex("by_user", (q) => q.eq("userId", userId)).take(50)).filter(
    (share) => share.address === address,
  );
  let woken = 0;
  for (const groupKey of new Set(shares.map((share) => share.groupKey))) {
    const group = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
      .first();
    if (group === null) continue;
    const due = Math.max(now + LOOK_DELAY_MS, (group.lastLookAt ?? 0) + LOOK_GAP_MS);
    if (group.nextLookAt !== undefined && group.nextLookAt <= due) continue;
    await ctx.db.patch(group._id, { nextLookAt: due });
    woken += 1;
  }
  return woken;
}

/**
 * Hand out up to `runIds.length` due looks. A look whose chat can no longer
 * hear one (unbound, muted, a guest chat, its looker without a phone or no
 * longer a writer there) is dropped, not retried: its next turn arms it
 * again. Handing one out sets the next daily slot at once, so a look whose
 * result never comes back is simply followed by the next.
 */
export async function claimChatLooks(ctx: MutationCtx, runIds: string[], now: number): Promise<ClaimedLook[]> {
  if (runIds.length === 0) return [];
  const due = await ctx.db
    .query("textGroups")
    .withIndex("by_nextLookAt", (q) => q.gte("nextLookAt", 0).lte("nextLookAt", now))
    .take(runIds.length * 3);
  const looks: ClaimedLook[] = [];
  for (const group of due) {
    if (looks.length >= runIds.length) break;
    if (group.lookClaimedAt !== undefined && group.lookClaimedAt + ROUTINE_LEASE_MS > now) continue;
    const workspaceId = (await chatWorkspace(ctx, group))?._id;
    const chat = workspaceId === undefined ? null : await routineChat(ctx, workspaceId, group.groupKey.slice(0, 16));
    const looker = await lookerOf(ctx, group);
    const phones = workspaceId === undefined || looker === null ? [] : await routineRecipients(ctx, { workspaceId, writerUserId: looker, send: "text" });
    const mail = chat === null ? [] : await liveMailShares(ctx, chat);
    const listening = mail.length > 0 || (group.engagement !== "quiet" && group.lastSeenAt + DORMANT_MS > now);
    if (chat === null || chat._id !== group._id || workspaceId === undefined || looker === null || phones.length === 0 || !listening) {
      await ctx.db.patch(group._id, { nextLookAt: undefined });
      continue;
    }
    const runId = runIds[looks.length]!;
    const timeZone = await zoneOf(ctx, looker);
    const since = group.lastLookAt ?? now - FIRST_LOOK_MS;
    await ctx.db.patch(group._id, { nextLookAt: nextBeatAfter(timeZone, now) ?? undefined, lastLookAt: now, lookRunId: runId, lookClaimedAt: now });
    await recordAudit(ctx, { workspaceId, actorUserId: looker, actorClientId: LOOKS_CLIENT_ID, action: "chat.look", details: {} });
    looks.push({ runId, path: CHAT_LOOK_PATH, timeZone, send: "text", phones, chat: group.groupKey, since });
  }
  return looks;
}

/** A look's outcome came back: its lease ends. False when no look has this id. */
export async function finishChatLook(ctx: MutationCtx, runId: string): Promise<boolean> {
  const group = await ctx.db
    .query("textGroups")
    .withIndex("by_look_run", (q) => q.eq("lookRunId", runId))
    .unique();
  if (group === null) return false;
  await ctx.db.patch(group._id, { lookRunId: undefined, lookClaimedAt: undefined });
  return true;
}
