/**
 * `POST /gateway/tex/chat-home` `{ accessToken, workspaceId, chat }` → `{ home: boolean }`: whether a group chat's
 * home is in the workspace this token reads (`texChatLanding.chatHomedIn`), so the gateway may open that chat's
 * Durable Object for a note whose row it reached there (`apps/mcp/src/store/texRouting.js`, `homeChat`).
 *
 * The token is read as `/gateway/note-ids/lookup` reads it: the workspace is the grant's own, never taken from the
 * body. Every refusal is `{ home: false }`, the same bytes for a chat that does not exist as for a workspace that is
 * not the caller's. Which notes under the home the reader sees is still each row's own access; this answers only
 * which object holds them.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const NO = { home: false } as const;

export async function gatewayTexChatHomeHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  const chat = stringField(body, "chat");
  if (accessToken === null || workspaceId === null || chat === null || !/^[0-9a-f]{64}$/.test(chat)) return json(NO);
  try {
    const reader = await ctx.runQuery(internal.functions.nodesGateway.readClearance, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: workspaceId,
    });
    if (reader === null) return json(NO);
    const home = await ctx.runQuery(internal.functions.texChatLanding.chatHomedIn, { workspaceId: reader.workspaceId, chat });
    return json({ home });
  } catch {
    return json(NO);
  }
}
