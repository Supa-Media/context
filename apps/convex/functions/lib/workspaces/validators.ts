/**
 * Return-value validators shared by the `workspaces.ts` Convex functions.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row.
 */

import { v } from "convex/values";

/**
 * The mark a workspace draws, as it crosses the wire.
 *
 * A union rather than two optional fields, matching the schema: a mark shows
 * one thing, and "photo set, emoji also set" would leave every drawing surface
 * to invent its own tie-break. See `@context/shared`'s `workspaceIcon` module.
 *
 * A photo arrives as its **leaf, not its bytes**. The console asks for the
 * bytes separately, once, and caches them on the leaf — which is a content
 * hash, so the cache is sound forever. Inlining a megabyte per row into a query
 * every console paint re-runs would make the context list a download.
 */
export const workspaceIconValidator = v.union(
  v.object({ kind: v.literal("photo"), leaf: v.string() }),
  v.object({ kind: v.literal("emoji"), emoji: v.string() }),
);

export const workspaceSummary = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  kind: v.string(),
  structureTemplate: v.string(),
  role: v.string(),
  /** Absent is the letter, which is what every workspace drew before this. */
  icon: v.optional(workspaceIconValidator),
  /**
   * Where meetings land in this context, when somebody has chosen.
   *
   * Absent means the default, and the *console* resolves that rather than this
   * query substituting one: `MEETINGS_FOLDER` lives in `packages/meetings`,
   * which is the gateway's own gate on the same value, and a second copy here
   * would be a second place for the default to drift.
   */
  meetingsFolder: v.optional(v.string()),
  /**
   * When this context last changed, and when this member last caught up.
   *
   * The pair, rather than a boolean, because the console decides what to draw
   * from it — a dot on this context's mark when the first is newer than the
   * second — and a server-computed `hasNew` would be a second place for that
   * rule to live. Both are absent for a context nothing has been recorded in
   * and a member who has never looked, which reads as "nothing to say" and is
   * the right answer for a context that has just been created.
   *
   * Neither is a count. A count would have to be a count of what *this* reader
   * may see, which is a per-member question over a shared row — the number
   * lives in the context itself, one press away.
   *
   * **`activityAt` is already narrowed to this reader** by the query: an owner
   * is served the context's own stamp, and everybody else the team-tier one,
   * so the dot never reports the time of a private change to somebody the file
   * itself would refuse. See `schema.ts`, `activityTeamAt`.
   */
  activityAt: v.optional(v.number()),
  activitySeenAt: v.optional(v.number()),
  joinedAt: v.number(),
  createdAt: v.number(),
  /**
   * True on the one row that is here because it is **pinned for everybody**
   * rather than because this person is a member of it — see
   * `lib/pinnedContext.ts`.
   *
   * Optional, and absent is false, so every existing consumer keeps reading
   * exactly what it read before. It is on the row rather than in a second query
   * because every consumer that needs it already has the row, and because the
   * two things that must treat it differently would otherwise have to re-derive
   * "is this the pinned one" from the slug:
   *
   *  - **The console draws it apart** — last in the rail, under a rule, marked
   *    read-only (`features/console/rail.ts`).
   *  - **Onboarding must not count it.** The `(app)` gate asks "is there
   *    anything here for you" off this same list, so without this flag a
   *    brand-new account would arrive with one reachable context, skip
   *    `/welcome`, and never claim a name. `standingFrom` filters on it.
   *
   * A real membership wins and is reported as an ordinary row: somebody who
   * owns or edits that workspace sees their real role and no flag.
   */
  pinned: v.optional(v.boolean()),
});
