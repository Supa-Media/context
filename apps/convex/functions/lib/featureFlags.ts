/**
 * Feature flags as the control plane reads them: whether one person has a flag, everyone a flag is on for, and a
 * person's whole set. The ids and their expiry dates are `packages/shared/src/flags.cjs`; staff set each flag's mode
 * and list in the console (`functions/featureFlags.ts`).
 *
 * In `people` mode a flag is on for the people listed by name and for everyone in a tester group on its list
 * (`testerGroups`).
 *
 * Off is the answer for anything unsure: an id not on the list (a typo, or a flag already launched or removed), a flag
 * with no row, a flag in `people` mode the person is not on.
 */

import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { FLAGS, isFlagId, type FlagMode } from "@context/shared/src/flags.cjs";

type Db = Pick<QueryCtx, "db">;

/** The ids on the list, read through here so a test can stand in its own (`vi.mock` of `flags.cjs`). */
export function flagIds(): string[] {
  return Object.keys(FLAGS);
}

/** A flag's mode; `off` for a missing row or an id not on the list. */
export async function flagMode(ctx: Db, flagId: string): Promise<FlagMode> {
  if (!isFlagId(flagId)) return "off";
  const row = await ctx.db
    .query("featureFlags")
    .withIndex("by_flag", (q) => q.eq("flagId", flagId))
    .first();
  return row?.mode ?? "off";
}

/** Whether `userId` has `flagId` on. */
export async function flagOnFor(ctx: Db, userId: Id<"users">, flagId: string): Promise<boolean> {
  const mode = await flagMode(ctx, flagId);
  if (mode === "everyone") return true;
  if (mode !== "people") return false;
  const named = await ctx.db
    .query("featureFlagPeople")
    .withIndex("by_flag_user", (q) => q.eq("flagId", flagId).eq("userId", userId))
    .first();
  if (named !== null) return true;
  for (const membership of await groupsOf(ctx, userId)) {
    const listed = await ctx.db
      .query("featureFlagGroups")
      .withIndex("by_flag_group", (q) => q.eq("flagId", flagId).eq("groupId", membership))
      .first();
    if (listed !== null) return true;
  }
  return false;
}

/** The tester groups `userId` is in. */
async function groupsOf(ctx: Db, userId: Id<"users">): Promise<Id<"testerGroups">[]> {
  const rows = await ctx.db
    .query("testerGroupPeople")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.map((row) => row.groupId);
}

/**
 * Everyone `flagId` is on for: `{everyone: true}` when it is open to all (walk your own table then), the listed people
 * in `people` mode, and nobody otherwise.
 */
export async function peopleWithFlag(
  ctx: Db,
  flagId: string,
): Promise<{ everyone: true } | { everyone: false; userIds: Id<"users">[] }> {
  const mode = await flagMode(ctx, flagId);
  if (mode === "everyone") return { everyone: true };
  if (mode !== "people") return { everyone: false, userIds: [] };
  const userIds = new Set<Id<"users">>();
  for (const row of await ctx.db
    .query("featureFlagPeople")
    .withIndex("by_flag", (q) => q.eq("flagId", flagId))
    .collect()) userIds.add(row.userId);
  for (const listed of await ctx.db
    .query("featureFlagGroups")
    .withIndex("by_flag", (q) => q.eq("flagId", flagId))
    .collect()) {
    for (const row of await ctx.db
      .query("testerGroupPeople")
      .withIndex("by_group", (q) => q.eq("groupId", listed.groupId))
      .collect()) userIds.add(row.userId);
  }
  return { everyone: false, userIds: [...userIds] };
}

/** Every flag `userId` has on, sorted. */
export async function flagsFor(ctx: Db, userId: Id<"users">): Promise<string[]> {
  const ids = new Set(flagIds());
  const modes = new Map<string, FlagMode>();
  for (const row of await ctx.db.query("featureFlags").collect()) {
    if (ids.has(row.flagId)) modes.set(row.flagId, row.mode);
  }
  const on = new Set<string>();
  for (const [flagId, mode] of modes) if (mode === "everyone") on.add(flagId);
  const listed: Doc<"featureFlagPeople">[] = await ctx.db
    .query("featureFlagPeople")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of listed) if (modes.get(row.flagId) === "people") on.add(row.flagId);
  for (const groupId of await groupsOf(ctx, userId)) {
    for (const row of await ctx.db
      .query("featureFlagGroups")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect()) if (modes.get(row.flagId) === "people") on.add(row.flagId);
  }
  return [...on].sort();
}
