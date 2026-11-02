/**
 * Every write to who may reach what, noticed where it happens (decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Members, invites, groups, AI client connections and shares by name move into the objects one workspace at a time
 * (`workspaceObjectHomes.access`: `convex` | `dual` | `object`, `functions/accessObjects.ts`). While a workspace is on
 * `dual`, Convex still decides and every change must reach its object; once it is on `object`, the object decides and
 * Convex may only be written behind it. No writer is trusted to remember either: the same wrapped database that tells
 * a workspace object about tree rows (`../rowWatch/watch.ts`) records each write to an access table here, and when the
 * mutation's handler returns, `./flush.ts` turns them into outbox entries (or refuses the mutation) in the same
 * transaction.
 *
 * Which object a write lands in: a membership, an invitation or a group is its workspace's; a connection is its
 * person's, in their personal workspace's object; a membership or a group row also changes its person's `reach`, and a
 * share by name (a `noteShares` row, a `nodeAccess` row naming one account) its person's `sharedToMe`.
 */

import type { Id } from "../../../_generated/dataModel";

/** The tables whose writes change what an object holds about access. */
export const ACCESS_TABLES = [
  "oauthGrants",
  "workspaceMembers",
  "workspaceInvitations",
  "workspaceGroups",
  "workspaceGroupMembers",
  "noteShares",
  "nodeAccess",
] as const;
export type AccessSource = (typeof ACCESS_TABLES)[number];

/** The object tables, as `lib/accessObjects/expected.ts` names them. */
export type ObjectTable = "members" | "invites" | "reach" | "connections" | "sharedToMe";
/** The tables an object is the authority for. The rest are copies another object's authority keeps current. */
export const AUTHORITY_TABLES: ReadonlySet<ObjectTable> = new Set<ObjectTable>(["members", "invites", "connections"]);

/**
 * Texting grants stay decided by Convex for now (thread B, 2026-11-01): their checks (a paused phone, a group chat's
 * co-viewers) live there. So do the grants Tex's own scheduled turns run under (a routine, the daytime check-in, the
 * nightly dream, housekeeping): Convex mints each one for a single run and asks the same questions first (a linked,
 * unpaused phone; `lib/texJobs.ts`), and their tokens are answered by Convex. Their writes never reach a person
 * object, and never trip the switch. The gateway's `CONTROL_PLANE_CLIENTS` (`apps/mcp/src/workspaceStore/personRows.js`)
 * is the same set; a test holds them equal.
 */
export const CONVEX_ONLY_CLIENTS: ReadonlySet<string> = new Set([
  "context_texts",
  "context_texts_group",
  "context_routines",
  "context_heartbeat",
  "context_dreams",
  "context_housekeeping",
]);

/**
 * Fields whose change alone moves nothing an object holds (`expected.ts` leaves them out of every row): a grant
 * touched on use, a membership's last visit. A patch naming only these is not recorded, so a `touchGrant` every five
 * minutes costs no push and is never refused.
 */
const VOLATILE: Partial<Record<AccessSource, ReadonlySet<string>>> = {
  oauthGrants: new Set(["lastUsedAt", "consoleInstanceId"]),
  workspaceMembers: new Set(["activitySeenAt", "setupRetiredAt"]),
  workspaceInvitations: new Set(["emailSentAt"]),
};

/** One recorded write: the row as it stood when it mattered (after an insert or patch, before a delete). */
export type AccessWrite = { table: AccessSource; doc: Record<string, unknown> };

/** Whether a write to `table` naming `fields` (`null`: insert, replace or delete) could change an object. */
export function mayMatter(table: AccessSource, fields: string[] | null): boolean {
  if (fields === null) return true;
  const volatile = VOLATILE[table];
  if (volatile === undefined) return true;
  return fields.some((field) => !volatile.has(field));
}

/** A target the flush resolves: an object's own workspace, or a person whose personal workspace it is. */
export type Target =
  | { kind: "workspace"; workspaceId: Id<"workspaces">; table: ObjectTable }
  | { kind: "person"; userId: Id<"users">; table: ObjectTable }
  /** A `noteShares` recipient by handle or email: resolved to an account, if any, at flush. */
  | { kind: "recipient"; recipientKind: string; recipient: string; table: ObjectTable };

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The objects one write changes, and which of their tables. Pure. */
export function targetsOf(write: AccessWrite): Target[] {
  const { table, doc } = write;
  const workspaceId = str(doc.workspaceId) as Id<"workspaces"> | null;
  const userId = str(doc.userId) as Id<"users"> | null;
  switch (table) {
    case "oauthGrants": {
      // A group chat's grant is the chat's, never a person's connection (`expected.ts` `connectionsOf`).
      if (doc.texGroup !== undefined || CONVEX_ONLY_CLIENTS.has(String(doc.clientId))) return [];
      return userId === null ? [] : [{ kind: "person", userId, table: "connections" }];
    }
    case "workspaceMembers":
    case "workspaceGroupMembers": {
      const targets: Target[] = [];
      if (workspaceId !== null) targets.push({ kind: "workspace", workspaceId, table: "members" });
      if (userId !== null) targets.push({ kind: "person", userId, table: "reach" });
      return targets;
    }
    case "workspaceGroups":
      // A renamed or deleted group changes every member row naming it; the members table is sent whole anyway.
      return workspaceId === null ? [] : [{ kind: "workspace", workspaceId, table: "members" }];
    case "workspaceInvitations":
      return workspaceId === null ? [] : [{ kind: "workspace", workspaceId, table: "invites" }];
    case "noteShares": {
      const recipientKind = str(doc.recipientKind);
      const recipient = str(doc.recipient);
      if (recipientKind === null || recipient === null) return [];
      return [{ kind: "recipient", recipientKind, recipient, table: "sharedToMe" }];
    }
    case "nodeAccess": {
      const grantee = str(doc.granteeUserId) as Id<"users"> | null;
      return doc.granteeKind === "user" && grantee !== null ? [{ kind: "person", userId: grantee, table: "sharedToMe" }] : [];
    }
  }
}
