/**
 * The storage-side rules for `placePins` and `placeOpens`, shared by the
 * functions in `functions/places.ts` and by the sweeps and moves that must
 * keep them honest. The tables themselves are described in
 * `lib/schema/places.ts`.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** "You open most" looks back this many days, today included. */
export const OPENS_WINDOW_DAYS = 14;
/** Far more tiles than a Home can show, low enough that a script cannot grow a row forever. */
export const PINS_PER_WORKSPACE = 60;
/** One row per folder opened; the stalest makes room past this. */
export const OPEN_ROWS_PER_WORKSPACE = 300;

export const dayOf = (at: number) => Math.floor(at / DAY_MS);

/** The days still inside the window as of `today`, oldest first. */
export function daysInWindow(days: Doc<"placeOpens">["days"], today: number) {
  const oldest = today - (OPENS_WINDOW_DAYS - 1);
  return days.filter((entry) => entry.day >= oldest && entry.day <= today).sort((a, b) => a.day - b.day);
}

/** Sum two day lists into one, oldest first. */
function mergeDays(a: Doc<"placeOpens">["days"], b: Doc<"placeOpens">["days"]) {
  const byDay = new Map<number, number>();
  for (const entry of [...a, ...b]) byDay.set(entry.day, (byDay.get(entry.day) ?? 0) + entry.n);
  return [...byDay.entries()].sort(([x], [y]) => x - y).map(([day, n]) => ({ day, n }));
}

/** `path` itself, or anything inside it — never a sibling like `Clients-old`. */
const isAtOrUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Move the mover's own places from `from` to `to` in one workspace, after
 * they moved, renamed, archived or restored the entry through the app. A
 * place that lands on one they already have is merged into it: one pin,
 * summed opens.
 *
 * **Only the mover's, never another member's.** The mover could see both
 * ends of the move; another member may not see where it went — a note moved
 * into the owner's private folder — and rewriting their pin would hand them
 * that folder's path, which `privacy.md` keeps from them. A Convex query
 * cannot ask the bucket's `privacy.md` who may see a path, so the only safe
 * rewrite is the one whose reader already could. Other members' places stay
 * where they were: the phone intersects every place with the tree that
 * person can see, so a stale one simply stops showing, and comes back if the
 * move is undone.
 *
 * Moves made outside the app (an agent, a sync tool) do not come through
 * here, and are handled by that same intersection.
 */
export async function retargetPlaces(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  from: string,
  to: string,
): Promise<void> {
  // A folder cannot move into itself, so this is never a real move; refusing
  // it here keeps the loops below from meeting the rows they just wrote.
  if (from === to || isAtOrUnder(to, from)) return;
  const rename = (path: string) => to + path.slice(from.length);

  const pins = await ctx.db
    .query("placePins")
    .withIndex("by_user_workspace", (q) => q.eq("userId", userId).eq("workspaceId", workspaceId))
    .collect();
  const pinned = new Set(pins.map((row) => row.path));
  for (const row of pins) {
    if (!isAtOrUnder(row.path, from)) continue;
    const path = rename(row.path);
    if (pinned.has(path)) {
      await ctx.db.delete(row._id);
    } else {
      await ctx.db.patch(row._id, { path });
      pinned.add(path);
    }
    pinned.delete(row.path);
  }

  const opens = await ctx.db
    .query("placeOpens")
    .withIndex("by_user_workspace", (q) => q.eq("userId", userId).eq("workspaceId", workspaceId))
    .collect();
  const byPath = new Map(opens.map((row) => [row.path, row]));
  for (const row of opens) {
    if (!isAtOrUnder(row.path, from)) continue;
    const path = rename(row.path);
    const existing = byPath.get(path);
    byPath.delete(row.path);
    if (existing === undefined) {
      await ctx.db.patch(row._id, { path });
      byPath.set(path, { ...row, path });
      continue;
    }
    const merged = { days: mergeDays(existing.days, row.days), lastAt: Math.max(existing.lastAt, row.lastAt) };
    await ctx.db.patch(existing._id, merged);
    byPath.set(path, { ...existing, ...merged });
    await ctx.db.delete(row._id);
  }
}

/** One person's places in one workspace: when they leave it or are removed. */
export async function deleteMemberPlaces(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<void> {
  for (const table of ["placePins", "placeOpens"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user_workspace", (q) => q.eq("userId", userId).eq("workspaceId", workspaceId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

/** Every place of one person's, in every workspace: with their account. */
export async function deleteUserPlaces(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  for (const table of ["placePins", "placeOpens"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

/** Every member's places in one workspace: with the workspace. */
export async function deleteWorkspacePlaces(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  for (const table of ["placePins", "placeOpens"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}
