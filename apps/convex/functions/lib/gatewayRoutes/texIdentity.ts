/**
 * `POST /gateway/agent/identity` — `{ accessToken, expectedWorkspaceId }` →
 * `{ identity: { name, handle, phones, emails, google } | null }`.
 *
 * Who is texting Tex (`lib/texIdentity/identity.ts`). Behind the gateway's
 * secret, with the person's own access token: the person comes off the
 * token's live grant, never from anything the gateway names. Always 200;
 * `null` is every caller who may not know, one answer for every reason.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

export async function gatewayAgentIdentityHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ identity: null });
  const identity = await ctx.runQuery(internal.functions.texIdentity.forGateway, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  return json({ identity });
}
