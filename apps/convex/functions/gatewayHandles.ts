/**
 * Handles as the workspace object's grantee lists take them: `@name` → `{kind: "user" | "group", id}`, for the
 * gateway's cache of names it has resolved (`apps/mcp/src/workspaceStore/handleCache.js`), behind the
 * `/gateway/privacy` op `resolveHandles`. Resolved exactly as `setGrantees.ts` `resolveEntry` resolves a handle: a
 * name, never an address; a group of this workspace, or a user who exists. Anything else is `null`.
 *
 * Read only. Whether a handle is held was never a secret (`names.checkNameAvailable` answers it to any signed-in
 * person), and a user is answered by id only, never by name or address.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { parseInvitee } from "./lib/invitees";
import { resolveHandle, type Grant } from "./lib/nodes/accessBackfill";
import type { Visibility } from "./lib/privacy";

export const MAX_HANDLES = 100;

const resolvedValidator = v.union(
  v.null(),
  v.object({ kind: v.union(v.literal("user"), v.literal("group")), id: v.string() }),
);

export const resolve = internalQuery({
  args: { workspaceId: v.id("workspaces"), handles: v.array(v.string()) },
  returns: v.array(v.object({ handle: v.string(), grantee: resolvedValidator })),
  handler: async (ctx, { workspaceId, handles }) => {
    const cache = new Map<string, Grant | null>();
    const out: Array<{ handle: string; grantee: { kind: "user" | "group"; id: string } | null }> = [];
    for (const handle of handles.slice(0, MAX_HANDLES)) {
      const parsed = parseInvitee(handle);
      if (!parsed.ok || parsed.invitee.kind !== "name") {
        out.push({ handle, grantee: null });
        continue;
      }
      const grant = await resolveHandle(ctx, workspaceId as Id<"workspaces">, `@${parsed.invitee.value}` as Visibility, cache);
      if (grant === null) out.push({ handle, grantee: null });
      else if (grant.kind === "group") out.push({ handle, grantee: { kind: "group", id: grant.groupId } });
      // A name can outlive its account: a deleted person is nobody.
      else if ((await ctx.db.get(grant.userId)) === null) out.push({ handle, grantee: null });
      else out.push({ handle, grantee: { kind: "user", id: grant.userId } });
    }
    return out;
  },
});
