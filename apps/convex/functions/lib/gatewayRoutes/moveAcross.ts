/**
 * `POST /gateway/moves/across`: an AI client's note move into another
 * workspace, made by the same engine the console's Move uses
 * (`functions/contextMoves.ts`), so a keyed workspace at either end works the
 * way it does there (`docs/decisions/storage-and-credentials/notes-by-id.md`,
 * "A move into another workspace, when either end is keyed"). The gateway's
 * own path-based move cannot read a keyed note's bytes or retire it.
 *
 * The two proofs every gateway route spends: the gateway secret (checked by
 * `gatewayRoute`) and the person's own access token, resolved here. Both
 * workspaces must be ones the grant reaches, and the rule is the console's:
 * `owner` of the source with private clearance (the grant's `context:private`),
 * `editor` or `owner` of the destination, and `context:write` throughout.
 * `openMove` checks the roles again in its own transaction.
 *
 * Always 200. `{ move: null }` for every way of saying "not yours", one answer
 * for each, so a stranger's workspace and one that does not exist read alike.
 * Otherwise `{ move: { status, movedObjects, skipped, error? } }` once the
 * engine has run: a note is one batch, so the answer is final for a note.
 */

import { objectSettled } from "../../workspaceObjectPush";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { messageOf } from "../contextMoveAuthorize";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const SCOPE_WRITE = "context:write";
const SCOPE_PRIVATE = "context:private";
/** As many passes as the console's move gets: a folder may need several. */
const PASSES = 2_000;

export async function gatewayMoveAcrossHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const sourceId = stringField(body, "sourceWorkspaceId");
  const destinationId = stringField(body, "destinationWorkspaceId");
  const from = stringField(body, "from");
  const to = stringField(body, "to");
  if (accessToken === null || sourceId === null || destinationId === null || from === null || to === null) {
    return json({ move: null });
  }

  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null) return json({ move: null });
  const scopes = new Set(session.scopes);
  if (!scopes.has(SCOPE_WRITE) || !scopes.has(SCOPE_PRIVATE)) return json({ move: null });
  const source = session.workspaces.find((workspace) => workspace.workspaceId === sourceId);
  const destination = session.workspaces.find((workspace) => workspace.workspaceId === destinationId);
  if (source === undefined || destination === undefined || source.workspaceId === destination.workspaceId) {
    return json({ move: null });
  }
  if (source.role !== "owner" || (destination.role !== "owner" && destination.role !== "editor")) {
    return json({ move: null });
  }

  let moveId: Id<"contextMoves">;
  try {
    moveId = await ctx.runMutation(internal.functions.contextMoves.openMove, {
      sourceWorkspaceId: source.workspaceId as Id<"workspaces">,
      destinationWorkspaceId: destination.workspaceId as Id<"workspaces">,
      actorUserId: session.actorUserId,
      from,
      to,
    });
  } catch (error) {
    return json({ move: { status: "failed", movedObjects: 0, skipped: [], error: messageOf(error) } });
  }
  await ctx.runAction(internal.functions.contextMoves.advanceContextMove, { moveId, passesLeft: PASSES });
  await objectSettled(ctx, source.workspaceId as Id<"workspaces">);
  const row = await ctx.runQuery(internal.functions.contextMoves.readMove, { moveId });
  if (row === null) return json({ move: null });
  return json({
    move: {
      status: row.status,
      movedObjects: row.movedObjects,
      skipped: row.skipped,
      ...(row.error === undefined ? {} : { error: row.error }),
    },
  });
}
