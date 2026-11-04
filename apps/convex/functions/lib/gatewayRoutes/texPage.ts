/**
 * The Tex page's two gateway routes (`functions/texPage.ts`, decided with the Context app's Tex page):
 *
 *  - `POST /gateway/tex/page` `{ accessToken }` → the page's data, or `{ status: "refused" }`;
 *  - `POST /gateway/tex/page/settings` `{ accessToken, chat, values }` → `{ status: "done", instructions?, engagement? }`
 *    or `refused` / `not_found` / `bad_request` / `rate_limited`.
 *
 * Behind the gateway's secret like every gateway route, and always 200. The token is hashed here and the person is
 * read from its grant in the control plane; nothing in the body names who acts.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

/** `POST /gateway/tex/page` `{ accessToken }`. */
export async function gatewayTexPageHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  if (accessToken === null) return json({ status: "bad_request" });
  const answer = await ctx.runQuery(internal.functions.texPage.pageFor, { hashedAccessToken: await hashToken(accessToken) });
  return json(answer);
}

/** `POST /gateway/tex/page/settings` `{ accessToken, chat, values }`. */
export async function gatewayTexPageSettingsHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const chat = stringField(body, "chat");
  const values = body.values;
  if (accessToken === null || chat === null || values === null || typeof values !== "object" || Array.isArray(values)) return json({ status: "bad_request" });
  const answer = await ctx.runMutation(internal.functions.texPage.applyTexPageSettings, {
    hashedAccessToken: await hashToken(accessToken),
    chat,
    values,
  });
  return json(answer);
}
