/**
 * `POST /gateway/site` — a website's status, or a publish, for an agent on an
 * owner's or editor's connection (`lib/websites/agentSite.ts`).
 *
 * Registered in `http.ts` by the same factory as every gateway route, so the
 * gateway secret is checked before this runs; the user's own token is then
 * spent for the clearance. Every refusal is `{ site: null }`.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

export async function gatewaySiteHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const action = stringField(body, "action");
  const draft = stringField(body, "draft");
  if (accessToken === null || expected === null || action === null) return json({ site: null });
  const site = await ctx.runAction(internal.functions.websites.gatewaySite, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    action,
    ...(draft === null ? {} : { draft }),
  });
  return json({ site });
}
