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
  const expectedEtag = stringField(body, "expectedEtag");
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
    operation: { kind: "nodesMoveStart", from, to, ...(expectedEtag === null ? {} : { expectedEtag }) },
  });
  if (result.kind !== "moveQueued") return json({ move: { queued: false } });
  const { kind: _kind, ...move } = result;
  return json({ move });
}

/** Most moves one batch may ask for: the gateway's `BATCH_MOVE_CAP`. */
const BATCH_MOVES_MAX = 100;

/**
 * `POST /gateway/moves/batch`: several note moves in a keyed workspace, made
 * whole or not at all (`lib/nodes/rowMoveBatch.ts`). The same two proofs and
 * the same write rule as `/gateway/moves/start`. A bad body, or a batch the
 * caller may not make, is `{ move: null }`; a refused batch is
 * `{ move: { ok: false, error, message } }`, and a made one `{ move: { ok: true, moves } }`.
 */
export async function gatewayMoveBatchHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const raw = body.moves;
  if (accessToken === null || expected === null || !Array.isArray(raw) || raw.length === 0 || raw.length > BATCH_MOVES_MAX) {
    return json({ move: null });
  }
  const moves: { from: string; to: string; expectedEtag?: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return json({ move: null });
    const record = item as Record<string, unknown>;
    const from = stringField(record, "from");
    const to = stringField(record, "to");
    const expectedEtag = stringField(record, "expectedEtag");
    if (from === null || to === null) return json({ move: null });
    moves.push({ from, to, ...(expectedEtag === null ? {} : { expectedEtag }) });
  }

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
    operation: { kind: "nodesMoveBatch", moves },
  });
  if (result.kind !== "moveBatch") return json({ move: null });
  const { kind: _kind, ...move } = result;
  return json({ move });
}
