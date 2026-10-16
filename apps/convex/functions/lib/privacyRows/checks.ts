/**
 * The staff check of access rows against privacy rules (`privacyRows.ts`): the
 * stored result per workspace, and whether it still stands for the rows as
 * they are now. Pure over the two rows it reads, so the rule is one place.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

/** Differences kept per workspace. The count is exact; the sample is for reading by hand. */
export const SAMPLE_MAX = 20;

/**
 * unchecked: never checked. running: a check is walking the rows now.
 * stale: the rows were derived again (or the check began before the last
 * derivation), so the result says nothing about them. differs: the check
 * found a difference. clean: current, and no difference.
 */
export type CheckStatus = "unchecked" | "running" | "stale" | "differs" | "clean";

export async function checkRowOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"privacyRowChecks"> | null> {
  return await db
    .query("privacyRowChecks")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

export async function accessStateRowOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"nodeAccessState"> | null> {
  return await db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * A check is current only if it ran against the derivation version held now
 * and began after the last finished derivation. A workspace never derived is
 * at version 0, which a check started before any derivation also reads.
 */
export function checkStatus(
  check: Pick<Doc<"privacyRowChecks">, "status" | "version" | "startedAt" | "differences"> | null,
  state: Pick<Doc<"nodeAccessState">, "version" | "migratedAt"> | null,
): CheckStatus {
  if (check === null) return "unchecked";
  if (check.status === "running") return "running";
  if (check.version !== (state?.version ?? 0) || check.startedAt < (state?.migratedAt ?? 0)) return "stale";
  return check.differences > 0 ? "differs" : "clean";
}
