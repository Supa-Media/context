/**
 * The `setAccess` op of `/gateway/privacy` (rows mode, `lib/nodes/setAccess.ts`):
 * one row's base and list, from the person's grant. Parsed here and checked
 * by `nodesAccess.setAccess`, which owns the rules about who may change a list.
 */

import type { ActionCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import { json, stringField } from "../gatewayAuth";

type Role = "view" | "edit";
/**
 * Ids stay strings here: an action has no `db` to check one with. `nodesAccess.setAccess` checks each with
 * `normalizeId` and answers `INVALID` for a malformed one, rather than throwing.
 */
type Grantee =
  | { kind: "user"; userId: string; role: Role }
  | { kind: "group"; groupId: string; role: Role }
  | { kind: "email"; email: string; role: Role };

const MAX_NAME = 1_024;
const MAX_GRANTEES = 100;

function roleOf(value: unknown): Role | null {
  return value === "view" || value === "edit" ? value : null;
}

/** One grantee as the route takes it, or `null` for a shape the rules cannot take. */
function granteeOf(raw: unknown): Grantee | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const role = roleOf(entry.role);
  if (role === null) return null;
  if (entry.kind === "user" && typeof entry.userId === "string" && entry.userId.length > 0) {
    return { kind: "user", userId: entry.userId, role };
  }
  if (entry.kind === "group" && typeof entry.groupId === "string" && entry.groupId.length > 0) {
    return { kind: "group", groupId: entry.groupId, role };
  }
  if (entry.kind === "email" && typeof entry.email === "string" && entry.email.length > 0 && entry.email.length <= MAX_NAME) {
    return { kind: "email", email: entry.email, role };
  }
  return null;
}

/** The `setAccess` body, parsed: `null` for anything malformed (refused, nothing written). */
function parse(body: Record<string, unknown>):
  | {
      path: string;
      base: "private" | "team" | "inherit";
      grantees: Grantee[] | "inherit" | undefined;
      expectedVersion: number | undefined;
      kind: "file" | "folder" | undefined;
    }
  | null {
  const path = stringField(body, "path");
  const base = stringField(body, "base");
  if (path === null || path.length > MAX_NAME) return null;
  if (base !== "private" && base !== "team" && base !== "inherit") return null;
  const expected = body.expectedVersion;
  if (expected !== undefined && (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0)) return null;
  if (body.kind !== undefined && body.kind !== "file" && body.kind !== "folder") return null;
  const kind = body.kind as "file" | "folder" | undefined;
  let grantees: Grantee[] | "inherit" | undefined;
  if (body.grantees === undefined) grantees = undefined;
  else if (body.grantees === "inherit") grantees = "inherit";
  else if (Array.isArray(body.grantees) && body.grantees.length <= MAX_GRANTEES) {
    const parsed = body.grantees.map(granteeOf);
    if (parsed.some((grantee) => grantee === null)) return null;
    grantees = parsed as Grantee[];
  } else return null;
  return { path, base, grantees, expectedVersion: expected as number | undefined, kind };
}

/**
 * Answer one `setAccess` op. `actor` is the grant's person and role, already
 * checked to be an owner or an editor by the route (`writes`).
 */
export async function setAccessOp(
  ctx: ActionCtx,
  body: Record<string, unknown>,
  workspaceId: Id<"workspaces">,
  actor: { userId: Id<"users">; role: "owner" | "editor" },
): Promise<Response> {
  const args = parse(body);
  if (args === null) return json({ ok: false, code: "INVALID" });
  const answer = await ctx.runMutation(internal.functions.nodesAccess.setAccess, {
    workspaceId,
    path: args.path,
    base: args.base,
    ...(args.grantees === undefined ? {} : { grantees: args.grantees }),
    ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
    ...(args.kind === undefined ? {} : { kind: args.kind }),
    actor,
  });
  return json(answer);
}
