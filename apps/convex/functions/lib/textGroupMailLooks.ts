/**
 * A group chat watches the mail shared with it, on its own (decided by the
 * owner, 2026-10-27: "it should just work, and know when an email needs to go
 * to the group vs me personally"; `docs/decisions/texting-assistant/chat-mail.md`).
 *
 * Sharing a mailbox is the whole setup. New mail in it, as Gmail tells us,
 * makes the chat's look due a minute later, never sooner than five minutes
 * after its last: the chat's own check-in, as a person's own check-in looks at
 * their mail. One look per chat however many mailboxes it shares, kept on the
 * earliest share there, and run as that share's person tagging Tex in the
 * chat, so it is the ordinary chat turn with every check it has (who is in
 * the chat now, the workspace it is bound to, the shares still live). The
 * turn posts what the chat needs and stays quiet otherwise; mail that needs
 * only the mailbox's person is left to their own check-ins, which are told
 * which of their mail a chat watches (`claimPersonMailRead`).
 *
 * The cron hands these out beside routines (`routines/runs.ts`): a look is a
 * chat routine's run with no note behind it.
 */

import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { accountTimeZone, routineRecipients } from "./routines/access";
import { ROUTINE_LEASE_MS, effectiveTimeZone } from "./routines/model";
import { routineChat } from "./routines/chats";
import { liveMailShares } from "./textGroupMail";

/** How long after a notification the look starts, so the mail that came with it has landed. */
export const LOOK_DELAY_MS = 60_000;
/** The least time between two looks. */
export const LOOK_GAP_MS = 5 * 60_000;
/** The path a look is handed out under: no note, the texting Worker asks the mail question (`groupRoutines.ts`). */
export const CHAT_MAIL_LOOK_PATH = "(shared mail)";
const LOOKS_CLIENT_ID = "context_texts_group";

export type ClaimedLook = {
  runId: string;
  path: string;
  timeZone: string;
  send: "text";
  phones: string[];
  chat: string;
  since: number;
};

/** The share a chat's look is kept on: its earliest. */
async function lookerOf(ctx: QueryCtx, groupKey: string): Promise<Doc<"chatMailShares"> | null> {
  const shares = await ctx.db
    .query("chatMailShares")
    .withIndex("by_group", (q) => q.eq("groupKey", groupKey))
    .take(40);
  return shares.reduce<Doc<"chatMailShares"> | null>((first, share) => (first === null || share.createdAt < first.createdAt ? share : first), null);
}

/** New mail reached `address` of `userId`: each chat it is shared with looks soon. */
export async function wakeChatMailLooks(ctx: MutationCtx, userId: Doc<"users">["_id"], address: string, now: number): Promise<number> {
  const shares = (await ctx.db.query("chatMailShares").withIndex("by_user", (q) => q.eq("userId", userId)).take(50)).filter(
    (share) => share.address === address,
  );
  let woken = 0;
  for (const groupKey of new Set(shares.map((share) => share.groupKey))) {
    const looker = await lookerOf(ctx, groupKey);
    if (looker === null) continue;
    const due = Math.max(now + LOOK_DELAY_MS, (looker.lastLookAt ?? 0) + LOOK_GAP_MS);
    if (looker.nextLookAt !== undefined && looker.nextLookAt <= due) continue;
    await ctx.db.patch(looker._id, { nextLookAt: due });
    woken += 1;
  }
  return woken;
}

/**
 * Hand out up to `runIds.length` due looks. A look whose chat can no longer
 * hear one (unbound, muted, a guest chat, nothing shared live, its person
 * without a phone) is dropped, not retried: the next new mail asks again.
 */
export async function claimChatMailLooks(ctx: MutationCtx, runIds: string[], now: number): Promise<ClaimedLook[]> {
  if (runIds.length === 0) return [];
  const due = await ctx.db
    .query("chatMailShares")
    .withIndex("by_nextLookAt", (q) => q.gte("nextLookAt", 0).lte("nextLookAt", now))
    .take(runIds.length * 3);
  const looks: ClaimedLook[] = [];
  for (const share of due) {
    if (looks.length >= runIds.length) break;
    if (share.lookClaimedAt !== undefined && share.lookClaimedAt + ROUTINE_LEASE_MS > now) continue;
    const chat = await routineChat(ctx, share.workspaceId, share.groupKey.slice(0, 16));
    const live = chat === null ? [] : await liveMailShares(ctx, chat);
    const phones = await routineRecipients(ctx, { workspaceId: share.workspaceId, writerUserId: share.userId, send: "text" });
    if (chat === null || chat.groupKey !== share.groupKey || live.length === 0 || phones.length === 0) {
      await ctx.db.patch(share._id, { nextLookAt: undefined });
      continue;
    }
    const runId = runIds[looks.length]!;
    const since = share.lastLookAt ?? share.createdAt;
    await ctx.db.patch(share._id, { nextLookAt: undefined, lastLookAt: now, lookRunId: runId, lookClaimedAt: now });
    await recordAudit(ctx, {
      workspaceId: share.workspaceId,
      actorUserId: share.userId,
      actorClientId: LOOKS_CLIENT_ID,
      action: "mail.chat_look",
      details: {},
    });
    looks.push({
      runId,
      path: CHAT_MAIL_LOOK_PATH,
      timeZone: effectiveTimeZone(undefined, await accountTimeZone(ctx, share.userId)),
      send: "text",
      phones,
      chat: share.groupKey,
      since,
    });
  }
  return looks;
}

/** A look's outcome came back: its lease ends. False when no look has this id. */
export async function finishChatMailLook(ctx: MutationCtx, runId: string): Promise<boolean> {
  const share = await ctx.db
    .query("chatMailShares")
    .withIndex("by_look_run", (q) => q.eq("lookRunId", runId))
    .unique();
  if (share === null) return false;
  await ctx.db.patch(share._id, { lookRunId: undefined, lookClaimedAt: undefined });
  return true;
}
