/**
 * Indexing priorities, as a search index row records them: per priority, how
 * many notes are indexed and how many wait (decided by the owner, 2026-10-08:
 * everything but the Inbox and Archive is 1, the Inbox 2, the Archive 3; see
 * `indexingPriority` in `packages/shared/src/folderRoles.cjs`). Counts only,
 * never a path, so the admin console can show it without naming a note.
 */

import { v } from "convex/values";

export const indexingPrioritiesValidator = v.array(
  v.object({ priority: v.number(), indexed: v.number(), pending: v.number() }),
);

export type IndexingPriorities = Array<{ priority: number; indexed: number; pending: number }>;

/** Whole, non-negative counts, at most one entry per priority 1–3. */
export function cleanPriorities(priorities: IndexingPriorities): IndexingPriorities {
  const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  return priorities
    .filter((entry, index, all) =>
      [1, 2, 3].includes(entry.priority) && all.findIndex((other) => other.priority === entry.priority) === index,
    )
    .map((entry) => ({ priority: entry.priority, indexed: whole(entry.indexed), pending: whole(entry.pending) }))
    .sort((a, b) => a.priority - b.priority);
}
