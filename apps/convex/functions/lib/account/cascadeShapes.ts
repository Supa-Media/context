import type { Id, TableNames } from "../../../_generated/dataModel";

/**
 * The minimal shape `deleteWorkspaceCascade` needs from a query over a table
 * discovered generically at runtime: filter by a field, then collect. Typed
 * loosely on purpose — Convex's real query builder is typed per concrete
 * table, which a name computed from `CONNECT_ATTEMPT_TABLES` cannot supply at
 * compile time — but every table that reaches this type has already been
 * proven, by `connectAttemptTables`, to have both a `workspaceId` field and
 * the `_id` every Convex document carries.
 */
export type GenericConnectAttemptQuery = {
  filter: (
    predicate: (q: {
      eq: (a: unknown, b: unknown) => unknown;
      field: (name: "workspaceId") => unknown;
    }) => unknown,
  ) => { collect: () => Promise<Array<{ _id: Id<TableNames> }>> };
};

/**
 * `workspaceInvitations` deliberately has no plain `by_workspace` index (the
 * schema explains why), so a full teardown walks the statuses through
 * `by_workspace_status`. Spelled out rather than derived so a new status is a
 * conscious addition here too.
 */
export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "revoked",
] as const;
