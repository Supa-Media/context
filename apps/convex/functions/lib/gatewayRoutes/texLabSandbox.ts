/**
 * The Lab test chats' one control-plane route (`functions/texLabSandbox.ts`; Dev2, 2026-11-16):
 *
 *  - `POST /gateway/tex/lab-sandbox` `{ accessToken, action, args }` → the action's answer, always with a `status`
 *    (`refused` for anyone who may not use the Lab's test chats).
 *
 * Behind the gateway's secret like every gateway route, and always 200. Reads only, but for `previewChat`, which starts
 * the GitHub run that carries a test chat's calls to a pull request's preview.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { dispatchWorkflow } from "../../texLabRuns";

const ACTIONS = new Set(["who", "session", "draft", "set", "sets", "shared", "intakeChats", "previewChat"]);
/** The workflow that carries a test chat's calls to a pull request's preview (`packages/lab/gateway/labSandbox/preview.js`). */
export const PREVIEW_CHAT_WORKFLOW = "lab-preview-chat.yml";

/** `POST /gateway/tex/lab-sandbox` `{ accessToken, action, args }`. */
export async function gatewayTexLabSandboxHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const action = stringField(body, "action");
  const args = body.args ?? {};
  if (accessToken === null || action === null || !ACTIONS.has(action) || typeof args !== "object" || args === null || Array.isArray(args)) return json({ status: "bad_request" });
  const hashedAccessToken = await hashToken(accessToken);
  // A test chat on a pull request's preview: the one write here, starting the GitHub run that carries its calls
  // (Dev2, 2026-11-22). Only for someone who may use the Lab's test chats; the run is given only the pull request and
  // the mailbox's random id, both public, and reaches production only with GitHub's own signed token for it.
  if (action === "previewChat") {
    const a = args as Record<string, unknown>;
    if (!(await ctx.runQuery(internal.functions.texLabSandbox.mayUseTestChats, { hashedAccessToken }))) return json({ status: "refused" });
    if (!Number.isSafeInteger(a.pr) || (a.pr as number) < 1 || (a.pr as number) > 9_999_999 || typeof a.bridge !== "string" || !/^[0-9a-f]{32}$/.test(a.bridge)) return json({ status: "bad_request" });
    const out = await dispatchWorkflow(PREVIEW_CHAT_WORKFLOW, { pr: String(a.pr), bridge: a.bridge });
    return json(out.ok ? { status: "ok" } : { status: "refused", error: out.error });
  }
  return json(await ctx.runQuery(internal.functions.texLabSandbox.forGateway, { hashedAccessToken, action, args }));
}
