/**
 * A removed member's grants, taken out where the workspace's notes live in its object (decided by the owner,
 * 2026-11-02: `docs/decisions/storage-and-credentials/object-row-writes.md`, "Access writes in the object").
 *
 * `accessMirror.apply` copies the object's member removal into Convex. Where the workspace's tree rows live in the
 * object too, the person's grants are the object's to drop (`ws.write.dropGrantee`), and the object's change comes
 * back through the access mirror (`objectAccessMirror.dropGrantee`, which runs `removeUserGrantsIn` here with the same
 * audit row). A mutation cannot call the object, so `apply` schedules `drop` at once.
 *
 * Every answer but `ok` takes the grants out in Convex instead (`fallback`): `NOT_READY` (the object does not judge
 * by its own access yet), a refusal, or an object that could not be reached. That write is watched, so the row push
 * carries the access set to the object later. A grant left behind would still reach someone the owner removed, so no
 * answer leaves the grants where they were.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { removeUserGrantsIn } from "./lib/grants/removeUserGrants";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";

export type GranteeDropper = {
  write: { dropGrantee: (body: { kind: "user"; id: string; actor: { role: "owner" | "editor" | "member"; userId: string } }) => Promise<unknown> };
};

export type DropArgs = {
  workspaceId: Id<"workspaces">;
  userId: Id<"users">;
  actorUserId: Id<"users">;
  actorRole: "owner" | "editor" | "member";
};

/** The object drops the grants; anything but its `ok` drops them in Convex. Answers where they were taken out. */
export async function dropInObject(
  ctx: Pick<ActionCtx, "runMutation">,
  args: DropArgs,
  client: GranteeDropper | null,
): Promise<"object" | "convex"> {
  // The remover, as the audit must name the acting identity. An object that refuses their role answers FORBIDDEN, and
  // the Convex fallback takes the grants out under the same name.
  const actor = { role: args.actorRole, userId: args.actorUserId };
  let answer: unknown = null;
  if (client !== null) {
    try {
      answer = await client.write.dropGrantee({ kind: "user", id: args.userId, actor: { role: actor.role, userId: actor.userId } });
    } catch (error) {
      console.warn(JSON.stringify({ event: "drop_grantee_unreached", workspaceId: args.workspaceId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  if ((answer as { ok?: unknown } | null)?.ok === true) return "object";
  await ctx.runMutation(internal.functions.accessMirrorGrants.fallback, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    actorUserId: args.actorUserId,
  });
  return "convex";
}

const dropArgs = {
  workspaceId: v.id("workspaces"),
  userId: v.id("users"),
  actorUserId: v.id("users"),
  actorRole: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
};

export const drop = internalAction({
  args: dropArgs,
  returns: v.union(v.literal("object"), v.literal("convex")),
  handler: async (ctx, args): Promise<"object" | "convex"> => await dropInObject(ctx, args, consoleWorkspaceClient(ctx, args.workspaceId, { caller: "accessMirrorGrants" })),
});

/** The grants taken out in Convex, watched, so the row push carries the access set to the object. */
export const fallback = internalMutation({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), actorUserId: v.id("users") },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => await removeUserGrantsIn(ctx, args),
});
