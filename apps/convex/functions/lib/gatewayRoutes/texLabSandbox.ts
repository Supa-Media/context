/**
 * The Lab test chats' one control-plane route (`functions/texLabSandbox.ts`; Dev2, 2026-11-16):
 *
 *  - `POST /gateway/tex/lab-sandbox` `{ accessToken, action, args }` → the action's answer, always with a `status`
 *    (`refused` for anyone who may not use the Lab's test chats).
 *
 * Behind the gateway's secret like every gateway route, and always 200. Reads only.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const ACTIONS = new Set(["who", "session", "draft", "set", "sets", "shared", "intakeChats"]);

/** `POST /gateway/tex/lab-sandbox` `{ accessToken, action, args }`. */
export async function gatewayTexLabSandboxHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const action = stringField(body, "action");
  const args = body.args ?? {};
  if (accessToken === null || action === null || !ACTIONS.has(action) || typeof args !== "object" || args === null || Array.isArray(args)) return json({ status: "bad_request" });
  return json(await ctx.runQuery(internal.functions.texLabSandbox.forGateway, { hashedAccessToken: await hashToken(accessToken), action, args }));
}
