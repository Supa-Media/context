/**
 * Where a workspace's access is read from, for any reader or writer inside a
 * query or mutation (decided by the owner, 2026-11-01, plan "Access lives in
 * the objects"). The record is `workspaceObjectHomes` (one per workspace,
 * beside the notes switch); only `functions/accessObjects.ts` `setAccess`
 * moves it, after the object took the same switch.
 *
 * - scope `workspace`: the workspace's members and invites (`access`).
 * - scope `person`: a personal workspace's person — reach, "shared with me",
 *   connections (`personAccess`). Pass the person's personal workspace.
 *
 * `convex` (no record, or no field): Convex decides, nothing is mirrored.
 * `dual`: Convex decides, and every change is mirrored into the object before
 * it reports done. `object`: the object decides; Convex is written behind.
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

export type AccessHome = "convex" | "dual" | "object";
export type AccessScope = "workspace" | "person";

/** The record's field for each scope's switch. */
export const ACCESS_FIELD = { workspace: "access", person: "personAccess" } as const;

export async function accessHomeOf(db: DatabaseReader, workspaceId: Id<"workspaces">, scope: AccessScope): Promise<AccessHome> {
  const record = await db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return (record?.[ACCESS_FIELD[scope]] ?? "convex") as AccessHome;
}
