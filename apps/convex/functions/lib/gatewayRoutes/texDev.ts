/**
 * The MCP's `tex_dev` tool's one route (`functions/texLabDrafts.ts`; Dev2, 2026-11-15):
 *
 *  - `POST /gateway/tex/dev` `{ accessToken, action, args }` → the action's answer, always with a `status`
 *    (`refused` for anyone who does not develop on Tex).
 *
 * Behind the gateway's secret like every gateway route, and always 200. The token is hashed here and the person is
 * read from its grant in the control plane; nothing in the body names who acts.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const ACTIONS = new Set(["run", "runs", "run_remove", "evals", "eval_run", "eval_remove", "code", "page", "shared", "list", "create", "get", "changes", "edit", "promote", "tool_stats", "cases", "case", "rename", "delete", "run_setup", "keep_results", "revert", "versions", "before", "set_drafts", "set_edit", "set_create", "set_remove", "set_promote", "set_history", "set_back"]);

/** `POST /gateway/tex/dev` `{ accessToken, action, args }`. */
export async function gatewayTexDevHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const action = stringField(body, "action");
  const args = body.args ?? {};
  if (accessToken === null || action === null || !ACTIONS.has(action) || typeof args !== "object" || args === null || Array.isArray(args)) return json({ status: "bad_request" });
  return json(await ctx.runMutation(internal.functions.texLabDrafts.forGateway, { hashedAccessToken: await hashToken(accessToken), action, args }));
}
