/**
 * Pins, "You open most" and Recent follow a move for everyone who can see
 * where it went (phase 4 B2 of `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Until now only the mover's places followed a move, made in the app. Every
 * other member's pin, and every move an agent, the organizer or a sync tool
 * made, was left naming the old path, and simply stopped showing. That rule
 * existed because a Convex function could not ask `privacy.md` who may see the
 * new path, and rewriting a pin for somebody who may not would hand them the
 * name of a folder held back from them. The tree now keeps the rules, so the
 * question can be asked where the rows are.
 *
 * So each person's places under the old name move to the new one only if that
 * person may see the new one (`canSee`, at their own role and named groups,
 * over the rules after the move). Anybody else's stay where they were and stop
 * showing, as before; a move undone brings them back. Rules that are missing
 * or do not parse retarget nobody: never a guess about who may see a path.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { clearanceOf } from "./clearance";
import { scopeForRole } from "./filesFns/access";
import { grantedNamesFor } from "./grantedNames";
import { retargetPlaces } from "./places";
import { type PrivacyRule, type Visibility, canSee } from "./privacy";

/** The rules after the move, as the tree's mirror keeps them. */
export interface FollowRules {
  invalid: boolean;
  folders: readonly { prefix: string; visibility: string }[];
  notes: readonly { path: string; visibility: string }[];
}

/** One move, old name to new. */
export interface PlaceMove {
  from: string;
  to: string;
}

const PLACE_TABLES = ["placePins", "placeOpens", "placeRecents"] as const;

/** Places rows one move reads, per table: far past any real Home, a bound on a loop. */
const ROWS_PER_MOVE = 2_000;

/** The people with a place at `from` or under it. */
async function peopleWithPlacesAt(ctx: MutationCtx, workspaceId: Id<"workspaces">, from: string): Promise<Set<Id<"users">>> {
  const people = new Set<Id<"users">>();
  for (const table of PLACE_TABLES) {
    const exact = await ctx.db
      .query(table)
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", from))
      .take(ROWS_PER_MOVE);
    // `/` sorts just before `0`, so this range is exactly the keys inside `from/`.
    const inside = await ctx.db
      .query(table)
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gte("path", `${from}/`).lt("path", `${from}0`))
      .take(ROWS_PER_MOVE);
    for (const row of [...exact, ...inside]) people.add(row.userId);
  }
  return people;
}

/** What `userId` may see under `rules`, or `null` for anyone no longer a member. */
async function sightOf(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  rules: { rules: PrivacyRule[]; overrides: Map<string, Visibility> },
): Promise<((path: string) => boolean) | null> {
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .unique();
  if (membership === null) return null;
  const clearance = clearanceOf(scopeForRole(membership.role), await grantedNamesFor(ctx, workspaceId, userId));
  return (path) => canSee(path, clearance.scope, rules.rules, rules.overrides, clearance.names);
}

/**
 * Carry every member's places from each move's old name to its new one, for
 * the members who may see the new one. Moves apply in order, so a chain lands
 * at its end.
 */
export async function followMovesForMembers(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  moves: readonly PlaceMove[],
  rules: FollowRules | null,
): Promise<void> {
  if (rules === null || rules.invalid) return;
  const parsed = {
    rules: rules.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility as Visibility })),
    overrides: new Map(rules.notes.map((note) => [note.path, note.visibility as Visibility])),
  };
  for (const move of moves) {
    if (move.from === move.to || move.from === "" || move.to === "") continue;
    for (const userId of await peopleWithPlacesAt(ctx, workspaceId, move.from)) {
      const sees = await sightOf(ctx, workspaceId, userId, parsed);
      if (sees === null) continue;
      // Each place by its own new name: a note held back inside a folder that moved stays put.
      await retargetPlaces(ctx, userId, workspaceId, move.from, move.to, sees);
    }
  }
}
