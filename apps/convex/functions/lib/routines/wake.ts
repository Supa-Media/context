/**
 * New mail wakes a chat's mail routine (decided by the owner, 2026-10-27:
 * "urgent mail posts instantly"; `docs/decisions/texting-assistant/chat-mail.md`).
 *
 * A Gmail notification for a mailbox shared with a group chat brings forward
 * that chat's routines that say `wake: new mail`: due a minute from now, and
 * never sooner than five minutes after their last run, so a burst of mail is
 * one look and not one per message. The run itself is the ordinary run, with
 * every check it already has (`runs.ts`, `chats.ts`); this only moves when.
 */

import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

/** How long after a notification the look starts, so the mail that came with it has landed. */
export const MAIL_WAKE_DELAY_MS = 60_000;
/** The least time between two looks a notification brings forward. */
export const MAIL_WAKE_GAP_MS = 5 * 60_000;
/** Most routines one workspace is read for. */
const ROUTINES_READ = 200;

export async function wakeMailRoutines(ctx: MutationCtx, row: Doc<"googleConnections">, now: number): Promise<number> {
  if (row.disconnectedAt !== undefined) return 0;
  const owner = (await ctx.db.get(row.workspaceId))?.createdBy;
  if (owner === undefined) return 0;
  const address = row.address.toLowerCase();
  const shares = (await ctx.db.query("chatMailShares").withIndex("by_user", (q) => q.eq("userId", owner)).take(50)).filter(
    (share) => share.address === address,
  );
  let woken = 0;
  for (const share of shares) {
    // A routine's `chat:` is the first 16 hex of its chat's key (`chats.ts`).
    const chat = share.groupKey.slice(0, 16);
    const routines = await ctx.db
      .query("routines")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", share.workspaceId))
      .take(ROUTINES_READ);
    for (const routine of routines) {
      if (routine.chat !== chat || routine.wake !== "mail" || routine.paused || routine.nextRunAt === null) continue;
      const due = Math.max(now + MAIL_WAKE_DELAY_MS, (routine.lastRunAt ?? 0) + MAIL_WAKE_GAP_MS);
      if (routine.nextRunAt <= due) continue;
      await ctx.db.patch(routine._id, { nextRunAt: due, updatedAt: now });
      woken += 1;
    }
  }
  return woken;
}
