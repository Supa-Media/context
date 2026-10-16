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
 * Whether a check still stands for the rows as they are now.
 *
 * Never once the rules have changed since it began.
 * A check that ran against the derivation version held now, begun after the
 * last finished derivation, stands. So does one whose rules are still the
 * rules held now, when the rows had already been derived from them as it
 * began: a derivation from unchanged rules writes the same access again, and a
 * busy workspace derives on every move (`refreshAccess`), so without this a
 * check could never finish before the next move made it stale. A check stored
 * before it recorded its rules has only the first test. A workspace never
 * derived is at version 0, which a check started before any derivation also
 * reads.
 */
export function checkStatus(
  check: Pick<Doc<"privacyRowChecks">, "status" | "version" | "startedAt" | "differences" | "rulesEtag" | "derivedEtag"> | null,
  state: Pick<Doc<"nodeAccessState">, "version" | "migratedAt" | "migratedFromEtag"> | null,
  rulesEtag: string | null,
): CheckStatus {
  if (check === null) return "unchecked";
  if (check.status === "running") return "running";
  // Rules written since the check began are stale at once: a large tree's walk bumps the version only when it ends.
  if (check.rulesEtag !== undefined && check.rulesEtag !== rulesEtag) return "stale";
  const sameDerivation = check.version === (state?.version ?? 0) && check.startedAt >= (state?.migratedAt ?? 0);
  const sameRules =
    check.rulesEtag !== undefined && check.rulesEtag === check.derivedEtag && (state?.migratedFromEtag ?? null) === rulesEtag;
  if (!sameDerivation && !sameRules) return "stale";
  return check.differences > 0 ? "differs" : "clean";
}

/** The rules' version a workspace holds now, or null when it has none. */
export async function rulesEtagOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<string | null> {
  const row = await db
    .query("nodePrivacy")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return row?.etag ?? null;
}
