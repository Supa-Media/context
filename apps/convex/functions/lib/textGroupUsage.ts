/**
 * Who a group chat's turns are charged to, and what each person spent there (decided by the owner, 2026-10-31).
 *
 * The sponsor is the person who brought Tex into the chat: their personal workspace's plan, cap and meter pay for every
 * turn in it, whoever tagged Tex (`functions/textGroups.ts`, `mintGroupGrant`). Alongside that meter, each finished
 * turn's cost is recorded in `textGroupUsage` against the person who tagged Tex, so the chat can show each person's
 * share. Counts and cost only: never a message, and never a number the gateway was not given.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { utcDay } from "./jev/meter";

/** Who a turn is recorded against: `user:<userId>` for an account holder, or `guest` for a guest tagger. */
export type UsageWho = `user:${string}` | "guest";

/**
 * The sponsor a chat's turns are metered to: the row's `sponsorId`, else its `boundBy`, else the tagger. The last two
 * are for rows written before the sponsor existed; the first mint that finds the sponsor unset writes this value.
 */
export function sponsorOf(chat: { sponsorId?: Id<"users">; boundBy?: Id<"users"> }, tagger: Id<"users">): Id<"users"> {
  return chat.sponsorId ?? chat.boundBy ?? tagger;
}

/**
 * Who a group grant's turn is recorded against. The grant's `userId` is the tagger for an account holder. A guest
 * tagger's grant is the binder's, so the gateway cannot name the tagger's number here.
 * TODO: record guest taggers by number (`phone:<E.164>`) once the group's turn carries it to the usage path.
 */
export function usageWho(grant: { userId: Id<"users">; texGroup?: { guestTagger?: boolean } }): UsageWho {
  return grant.texGroup?.guestTagger === true ? "guest" : `user:${grant.userId}`;
}

/** Add one finished turn's cost to the chat's usage for its person, for today's UTC day. */
export async function recordGroupUsage(
  ctx: MutationCtx,
  groupId: Id<"textGroups">,
  who: UsageWho,
  costMicroUsd: number,
  now: number,
): Promise<void> {
  const day = utcDay(now);
  const row = await ctx.db
    .query("textGroupUsage")
    .withIndex("by_group_day_who", (q) => q.eq("groupId", groupId).eq("day", day).eq("who", who))
    .unique();
  if (row) {
    await ctx.db.patch(row._id, { turns: row.turns + 1, costMicroUsd: row.costMicroUsd + costMicroUsd, updatedAt: now });
    return;
  }
  await ctx.db.insert("textGroupUsage", { groupId, who, day, turns: 1, costMicroUsd, updatedAt: now });
}

export interface UsageShare {
  who: string;
  turns: number;
  /** Micro-USD, as `addUsage` prices a turn. */
  cost: number;
  /** This person's share of the chat's cost in the window, 0 to 100; all 0 when nothing was spent. */
  percent: number;
}

/** The chat's usage rows in a window (every day, or from `sinceDay` on), summed per person, biggest cost first. */
export async function sharesOf(ctx: QueryCtx, groupId: Id<"textGroups">, sinceDay?: string): Promise<UsageShare[]> {
  const rows = await ctx.db
    .query("textGroupUsage")
    .withIndex("by_group_day_who", (q) =>
      sinceDay === undefined ? q.eq("groupId", groupId) : q.eq("groupId", groupId).gte("day", sinceDay),
    )
    .collect();
  const totals = new Map<string, { turns: number; cost: number }>();
  for (const row of rows) {
    const total = totals.get(row.who) ?? { turns: 0, cost: 0 };
    totals.set(row.who, { turns: total.turns + row.turns, cost: total.cost + row.costMicroUsd });
  }
  const spent = [...totals.values()].reduce((sum, total) => sum + total.cost, 0);
  return [...totals.entries()]
    .map(([who, total]) => ({ who, turns: total.turns, cost: total.cost, percent: spent > 0 ? (total.cost / spent) * 100 : 0 }))
    .sort((a, b) => b.cost - a.cost || (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
}
