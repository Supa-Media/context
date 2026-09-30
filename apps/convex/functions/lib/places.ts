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

/** `path` itself, or anything inside it — never a sibling like `Clients2`. */
const isAtOrUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Every path in one workspace at `root` or under it. The index range runs
 * from `root` to `root` followed by the character after `/`, which holds the
 * folder, its children and siblings such as `root-old`; the last are dropped.
 */
async function rowsAtOrUnder(
  ctx: MutationCtx,
  table: "placePins",
  workspaceId: Id<"workspaces">,
  root: string,
): Promise<Doc<"placePins">[]>;
async function rowsAtOrUnder(
  ctx: MutationCtx,
  table: "placeOpens",
  workspaceId: Id<"workspaces">,
  root: string,
): Promise<Doc<"placeOpens">[]>;
async function rowsAtOrUnder(
  ctx: MutationCtx,
  table: "placePins" | "placeOpens",
  workspaceId: Id<"workspaces">,
  root: string,
): Promise<(Doc<"placePins"> | Doc<"placeOpens">)[]> {
  const rows =
    table === "placePins"
      ? await ctx.db
          .query("placePins")
          .withIndex("by_workspace_path", (q) =>
            q.eq("workspaceId", workspaceId).gte("path", root).lt("path", `${root}0`),
          )
          .collect()
      : await ctx.db
          .query("placeOpens")
          .withIndex("by_workspace_path", (q) =>
            q.eq("workspaceId", workspaceId).gte("path", root).lt("path", `${root}0`),
          )
          .collect();
  return rows.filter((row) => isAtOrUnder(row.path, root));
}

/**
 * Move every member's places from `from` to `to` in one workspace, after the
 * app moved, renamed, archived or restored the entry. A place that lands on
 * one the same person already has is merged into it: one pin, summed opens.
 *
 * Moves made outside the app (an agent, a sync tool) do not come through
 * here; readers intersect places with the live tree, so those simply stop
 * showing rather than pointing somewhere wrong.
 */
export async function retargetPlaces(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  from: string,
  to: string,
): Promise<void> {
  // A folder cannot move into itself, so this is never a real move; refusing
  // it here keeps the loop below from meeting the rows it just wrote.
  if (from === to || isAtOrUnder(to, from)) return;
  const rename = (path: string) => to + path.slice(from.length);

  for (const row of await rowsAtOrUnder(ctx, "placePins", workspaceId, from)) {
    const path = rename(row.path);
    const existing = await ctx.db
      .query("placePins")
      .withIndex("by_user_workspace", (q) => q.eq("userId", row.userId).eq("workspaceId", workspaceId))
      .filter((q) => q.eq(q.field("path"), path))
      .first();
    if (existing !== null) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { path });
  }

  for (const row of await rowsAtOrUnder(ctx, "placeOpens", workspaceId, from)) {
    const path = rename(row.path);
    const existing = await ctx.db
      .query("placeOpens")
      .withIndex("by_user_workspace_path", (q) =>
        q.eq("userId", row.userId).eq("workspaceId", workspaceId).eq("path", path),
      )
      .first();
    if (existing === null) {
      await ctx.db.patch(row._id, { path });
      continue;
    }
    await ctx.db.patch(existing._id, {
      days: mergeDays(existing.days, row.days),
      lastAt: Math.max(existing.lastAt, row.lastAt),
    });
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
