/**
 * The owner's list on one row, named by the people and groups they choose (`nodesAccess.setGrantees`).
 *
 * Each entry names exactly one of: a handle (`@name`, a group of this workspace or one of its members), a
 * group's id, an email (anyone, inside the workspace or not, with an account or not), or `members` (every real
 * member of this workspace, never a pin reader: the dialog's Members position).
 * The list replaces the row's list (`setAccessRow`); the row's base is kept as it is.
 *
 * ## One refusal for every way a grantee can fail to resolve
 *
 * A handle that names nobody, a handle or id of a group of another workspace, a malformed email, a deleted
 * account: all answer `GRANTEE_NOT_FOUND`, with nothing else in the answer, and nothing is written. Otherwise the
 * answer is an oracle for whether a name exists anywhere on the platform. The row itself is checked first, and
 * a path with no row is `NOT_FOUND` whatever the list says.
 *
 * ## Who may ask
 *
 * Only the workspace's owner. A non-member gets `NOT_FOUND`, the same answer as a path that does not exist, so a
 * stranger cannot learn that a workspace or a path is there. A member who is not an owner gets `FORBIDDEN`.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { parseInvitee } from "../invitees";
import type { Visibility } from "../privacy";
import { accessSourceOf, resolveHandle, type Grant } from "./accessBackfill";
import { setAccessRow, MAX_GRANTEES, type GranteeInput, type Role } from "./setAccess";
import { getMembership, requireWorkspaceRole } from "../workspaceAuth";

/** One entry the owner names. Exactly one of `handle`, `userId`, `groupId`, `email` or `members`. */
export interface GranteeRequest {
  handle?: string;
  /** Every real member of this workspace (`rowAccess.ts`): the share dialog's Members position, with base `private`. */
  members?: true;
  /** A person by id: a member of this workspace, or someone a list here already names (`userHeldHere`). */
  userId?: string;
  groupId?: string;
  email?: string;
  role: Role;
}

export type SetGranteesAnswer =
  | { ok: true; version: number }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "NOT_ROWS_MODE" | "GRANTEE_NOT_FOUND" | "INVALID" | "CONFLICT" };

export const setGranteesAnswerValidator = v.union(
  v.object({ ok: v.literal(true), version: v.number() }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("NOT_FOUND"),
      v.literal("FORBIDDEN"),
      v.literal("NOT_ROWS_MODE"),
      v.literal("GRANTEE_NOT_FOUND"),
      v.literal("INVALID"),
      v.literal("CONFLICT"),
    ),
  }),
);

export const granteeRequestValidator = v.object({
  handle: v.optional(v.string()),
  userId: v.optional(v.string()),
  groupId: v.optional(v.string()),
  email: v.optional(v.string()),
  members: v.optional(v.literal(true)),
  role: v.union(v.literal("view"), v.literal("edit")),
});

/** Refused: the one answer every unresolvable grantee gets. */
const UNRESOLVED: SetGranteesAnswer = { ok: false, code: "GRANTEE_NOT_FOUND" };

/** One entry as a grantee the rules take, or `null` for one that resolves to nobody (`UNRESOLVED`). */
export async function resolveEntry(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  entry: GranteeRequest,
  cache: Map<string, Grant | null>,
): Promise<GranteeInput | null> {
  const { role } = entry;
  // Nobody to resolve: the grant names this workspace's own membership, whoever is in it when a note is read.
  if (entry.members === true) return { kind: "members", role };
  if (entry.handle !== undefined) {
    // A handle is a name, never an address: `parseInvitee` decides which, and an address is not a handle.
    const parsed = parseInvitee(entry.handle);
    if (!parsed.ok || parsed.invitee.kind !== "name") return null;
    const grant = await resolveHandle(ctx, workspaceId, `@${parsed.invitee.value}` as Visibility, cache);
    if (grant === null) return null;
    if (grant.kind === "group") return { kind: "group", groupId: grant.groupId, role };
    // A name can outlive its account: a deleted person is nobody, the same as a name nobody holds.
    if ((await ctx.db.get(grant.userId)) === null) return null;
    // By handle, only a member of this workspace: the owner already sees who those are, so the answer
    // reveals nothing new. Someone outside is named by email, which is stored whether or not an account
    // holds it, so no answer here says whether a handle exists anywhere else on the platform.
    if ((await getMembership(ctx, workspaceId, grant.userId)) === null) return null;
    return { kind: "user", userId: grant.userId, role };
  }
  if (entry.userId !== undefined) {
    const userId = ctx.db.normalizeId("users", entry.userId);
    if (userId === null || (await ctx.db.get(userId)) === null) return null;
    // By id, only someone the owner already sees: a member, or a person some list in this workspace already
    // names (the share dialog sends the lists it shows back by id). Anyone else is named by email.
    if ((await getMembership(ctx, workspaceId, userId)) === null && !(await userHeldHere(ctx, workspaceId, userId))) {
      return null;
    }
    return { kind: "user", userId, role };
  }
  if (entry.groupId !== undefined) {
    const groupId = ctx.db.normalizeId("workspaceGroups", entry.groupId);
    if (groupId === null) return null;
    const group = await ctx.db.get(groupId);
    if (group === null || group.workspaceId !== workspaceId) return null;
    return { kind: "group", groupId, role };
  }
  const parsed = parseInvitee(entry.email ?? "");
  if (!parsed.ok || parsed.invitee.kind !== "email") return null;
  return { kind: "email", email: parsed.invitee.value, role };
}

/** Whether some row of this workspace already lists this person by id (an owner's grant, not a share's). */
async function userHeldHere(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">): Promise<boolean> {
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("granteeUserId", userId))
    .take(5);
  return grants.some((grant) => grant.source !== "share");
}

export async function setGranteesHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    grantees: GranteeRequest[];
    /** The row's base, set in the same write. Omitted keeps it; `inherit` takes the folder's and needs an empty list. */
    base?: "private" | "team" | "inherit";
    /** The access version the caller read (`shareList`); another is `CONFLICT`, and nothing is written. */
    expectedVersion?: number;
  },
): Promise<SetGranteesAnswer> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  try {
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
  } catch (error) {
    // The helper's two refusals: a member without the role is FORBIDDEN; anything else (no membership, or no
    // workspace) is the answer a path that does not exist gets, so a stranger learns nothing about the workspace.
    const code = error instanceof ConvexError ? (error.data as { code?: string } | null)?.code : undefined;
    if (code === "INSUFFICIENT_ROLE") return { ok: false, code: "FORBIDDEN" };
    return { ok: false, code: "NOT_FOUND" };
  }
  if ((await accessSourceOf(ctx.db)) !== "rows") return { ok: false, code: "NOT_ROWS_MODE" };

  const row = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
    .unique();
  if (row === null) return { ok: false, code: "NOT_FOUND" };

  if (args.grantees.length > MAX_GRANTEES) return { ok: false, code: "INVALID" };
  // Taking the folder's setting takes its list too: a list left on an inheriting row would be a hidden grant.
  if (args.base === "inherit" && args.grantees.length > 0) return { ok: false, code: "INVALID" };
  for (const entry of args.grantees) {
    // Exactly one way of naming a grantee. A shape error is a request error, and says nothing about who exists.
    const named = [entry.handle, entry.userId, entry.groupId, entry.email, entry.members].filter((field) => field !== undefined).length;
    if (named !== 1) return { ok: false, code: "INVALID" };
  }

  // Every entry resolves before anything is written: one that does not resolve refuses the whole list.
  const cache = new Map<string, Grant | null>();
  const grantees: GranteeInput[] = [];
  for (const entry of args.grantees) {
    const resolved = await resolveEntry(ctx, args.workspaceId, entry, cache);
    if (resolved === null) return UNRESOLVED;
    grantees.push(resolved);
  }

  // The row's base is kept unless one is given: a list and its base change together, in one write.
  const answer = await setAccessRow(ctx, {
    workspaceId: args.workspaceId,
    path: args.path,
    base: args.base ?? row.access?.base ?? "inherit",
    expectedVersion: args.expectedVersion,
    grantees,
    actor: { userId, role: "owner" },
  });
  if (answer.ok) return answer;
  if (answer.code === "INVALID") return { ok: false, code: "INVALID" };
  if (answer.code === "CONFLICT") return { ok: false, code: "CONFLICT" };
  // The row is there, so a NOT_FOUND from the rules is a grantee they do not accept.
  if (answer.code === "NOT_FOUND") return UNRESOLVED;
  throw new Error(`setAccessRow answered ${answer.code} for an owner on an existing row`);
}
