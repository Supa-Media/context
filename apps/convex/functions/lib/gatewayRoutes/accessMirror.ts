/**
 * `POST /gateway/access/mirror` — `{ workspaceId, change }` → `{ applied }`, behind the gateway's secret only
 * (`gatewayRoute`). The caller is a workspace object (or a person's) that has just taken an access write; this writes
 * Convex behind it (`functions/accessMirror.ts`). A change this refuses answers 409 with its fixed code, so the
 * object's call throws and the change is not reported done; a body that is not a change answers 400.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { badRequest, json } from "../gatewayAuth";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPS = new Set(["remove_member", "set_role", "revoke_invite", "revoke_connection"]);

export async function gatewayAccessMirrorHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const workspaceId = body.workspaceId;
  const change = body.change as Record<string, unknown> | null | undefined;
  if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return badRequest();
  if (change === null || typeof change !== "object" || !OPS.has(String(change.op))) return badRequest();
  let answer: { applied: boolean; refused?: string };
  try {
    answer = await ctx.runMutation(internal.functions.accessMirror.apply, {
      workspaceId: workspaceId as Id<"workspaces">,
      change: change as never,
    });
  } catch {
    // A shape the validator refused, or an id of the wrong table: nothing was written.
    return badRequest();
  }
  return answer.refused === undefined ? json({ applied: answer.applied }) : json({ applied: false, refused: answer.refused }, 409);
}
