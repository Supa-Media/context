/**
 * People added to one row's list by a connected AI client (`/gateway/privacy` op `addGrantees`, the `people`
 * argument of the gateway's `set_visibility`).
 *
 * The console's `setGrantees` replaces the owner's list with the one on screen. An AI client is not looking at
 * the list, so it adds: the people it names join the ones already there, a person already listed takes the role
 * the call names, and nobody already listed is removed. The row's base is kept. Entries are named exactly as the
 * owner names them (`setGrantees.ts`): a handle (a member or a group of this workspace), a group id, or an email,
 * and every one that does not resolve gets the one refusal, `GRANTEE_NOT_FOUND`, with nothing written.
 *
 * It never decides whether the call should run: the gateway's egress gate holds every call that names somebody
 * until the person says yes (`apps/mcp/src/privacy/egress.js`). This is what runs once they have.
 *
 * Owner only, as the console's list is. An editor's grant is `FORBIDDEN`.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import type { Grant } from "./accessBackfill";
import { granteeInputOf, MAX_GRANTEES, setAccessRow, type GranteeInput } from "./setAccess";
import { resolveEntry, type GranteeRequest, type SetGranteesAnswer } from "./setGrantees";

/** Who a grantee is, whatever role they hold: two entries for one person are one entry. */
function whoOf(grantee: GranteeInput): string {
  if (grantee.kind === "user") return `user:${grantee.userId}`;
  if (grantee.kind === "group") return `group:${grantee.groupId}`;
  if (grantee.kind === "members") return "members";
  if (grantee.kind === "accounts") return "accounts";
  return `email:${grantee.email.trim().toLowerCase()}`;
}

export async function addGranteesHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    entries: GranteeRequest[];
    actor: { userId: Id<"users">; role: "owner" | "editor" };
  },
): Promise<SetGranteesAnswer> {
  if (args.actor.role !== "owner") return { ok: false, code: "FORBIDDEN" };
  if (args.entries.length === 0 || args.entries.length > MAX_GRANTEES) return { ok: false, code: "INVALID" };
  for (const entry of args.entries) {
    const named = [entry.handle, entry.groupId, entry.email].filter((field) => field !== undefined).length;
    if (named !== 1) return { ok: false, code: "INVALID" };
  }

  const row = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
    .unique();
  if (row === null || row.goneAt !== undefined) return { ok: false, code: "NOT_FOUND" };

  const cache = new Map<string, Grant | null>();
  const added: GranteeInput[] = [];
  for (const entry of args.entries) {
    const resolved = await resolveEntry(ctx, args.workspaceId, entry, cache);
    if (resolved === null) return { ok: false, code: "GRANTEE_NOT_FOUND" };
    added.push(resolved);
  }

  // The list as it stands (a share is not part of it), with each named person at the role this call gives.
  const merged = new Map<string, GranteeInput>();
  const held = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  for (const grant of held) {
    if (grant.source === "share") continue;
    const kept = granteeInputOf(grant);
    if (kept !== null) merged.set(whoOf(kept), kept);
  }
  for (const grantee of added) merged.set(whoOf(grantee), grantee);
  if (merged.size > MAX_GRANTEES) return { ok: false, code: "INVALID" };

  const answer = await setAccessRow(ctx, {
    workspaceId: args.workspaceId,
    path: args.path,
    base: row.access?.base ?? "inherit",
    grantees: [...merged.values()],
    actor: { userId: args.actor.userId, role: "owner" },
  });
  if (answer.ok) return answer;
  if (answer.code === "INVALID") return { ok: false, code: "INVALID" };
  if (answer.code === "NOT_FOUND") return { ok: false, code: "GRANTEE_NOT_FOUND" };
  if (answer.code === "FORBIDDEN") return { ok: false, code: "FORBIDDEN" };
  return { ok: false, code: "NOT_FOUND" };
}
