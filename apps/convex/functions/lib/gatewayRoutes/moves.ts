/**
 * `POST /gateway/moves/start`: an AI client's folder move, queued the way the
 * console queues one (phase 4 of `docs/decisions/app-and-console/convex-tree.md`),
 * so `move_folder` is one step however big the folder is.
 *
 * The two proofs every gateway route spends: the gateway secret (checked by
 * `gatewayRoute`) and the person's own access token, resolved here. The
 * workspace is one the grant reaches, never one the gateway names alone, and
 * the clearance is decided here the way the gateway decides it
 * (`visibilityTierForGrant`): `private` only for an owner whose grant asked for
 * private notes. Writing at all needs `owner` or `editor` and the grant's
 * `context:write`.
 *
 * Always 200. `{ move: null }` for every way of saying "not yours", one answer
 * for each. `{ move: { queued: false } }` sends the gateway the old way;
 * `{ move: { queued: false, error, message } }` is a refusal to show the
 * agent; `{ move: { queued: true, count } }` is done.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const SCOPE_WRITE = "context:write";
const SCOPE_PRIVATE = "context:private";

export async function gatewayMoveStartHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const from = stringField(body, "from");
  const to = stringField(body, "to");
  if (accessToken === null || expected === null || from === null || to === null) return json({ move: null });

  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null) return json({ move: null });
  const entry = session.workspaces.find((workspace) => workspace.workspaceId === expected);
  if (entry === undefined) return json({ move: null });
  const scopes = new Set(session.scopes);
  if ((entry.role !== "owner" && entry.role !== "editor") || !scopes.has(SCOPE_WRITE)) return json({ move: null });

  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: entry.workspaceId as Id<"workspaces">,
    scope: entry.role === "owner" && scopes.has(SCOPE_PRIVATE) ? "private" : "team",
    grantedNames: entry.grantedNames ?? [],
    operation: { kind: "nodesMoveStart", from, to },
  });
  if (result.kind !== "moveQueued") return json({ move: { queued: false } });
  const { kind: _kind, ...move } = result;
  return json({ move });
}
