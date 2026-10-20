/**
 * A person's mailboxes over HTTP (`docs/decisions/communications/mail-health.md`).
 * Registered in `http.ts`, behind the gateway's secret, with the person's own
 * access token:
 *
 *  - `POST /gateway/mail-health`: each mailbox's address, state and last
 *    successful sync, for the owner of a personal workspace and nobody else.
 *  - `POST /gateway/mail-health/raised`: Tex's check-in is about to text these
 *    states; counted as told once its text reached them.
 *
 * Neither carries mail.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

/** More than anyone connects. */
const MAX_RAISED = 50;

/**
 * `POST /gateway/mail-health` — `{ accessToken, expectedWorkspaceId }` →
 * `{ mailboxes: [{ address, state, lastSyncedAt, tell }] | null }`. Always
 * 200; `null` is every caller who may not read them, one answer for every reason.
 */
export async function gatewayMailHealthHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ mailboxes: null });
  const mailboxes = await ctx.runQuery(internal.functions.mailHealth.mailHealth, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  return json({ mailboxes });
}

/**
 * `POST /gateway/mail-health/raised` — `{ accessToken, expectedWorkspaceId,
 * mailboxes: [{ address, state }] }` → `{ raised: n }`. Always 200: a caller
 * who may not raise raises nothing.
 */
export async function gatewayMailHealthRaisedHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null || !Array.isArray(body.mailboxes)) return json({ raised: 0 });
  const mailboxes = (body.mailboxes as unknown[])
    .slice(0, MAX_RAISED)
    .map((given) => (given !== null && typeof given === "object" ? (given as Record<string, unknown>) : {}))
    .filter((given) => typeof given.address === "string" && given.address.length <= 320 && typeof given.state === "string" && given.state.length <= 32)
    .map((given) => ({ address: given.address as string, state: given.state as string }));
  const raised = await ctx.runMutation(internal.functions.mailHealth.raiseMailNotices, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    mailboxes,
  });
  return json({ raised });
}
