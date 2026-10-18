/**
 * Tex's check-in over HTTP (`docs/decisions/texting-assistant/heartbeat.md`).
 * Registered in `http.ts`, behind the texting Worker's secret:
 *
 *  - `POST /agent-texts/heartbeats/due`: the check-ins due now, each with a
 *    short-lived grant on the person's personal workspace and their own phones.
 *  - `POST /agent-texts/heartbeats/result`: how one went, as a code.
 *
 * And behind the gateway's secret, with the person's own access token:
 *
 *  - `POST /gateway/attention/ask`: one of their agents asks for their
 *    attention (`lib/attention/ask.ts`). It carries how urgent, never the
 *    words: those wait in `tex/attention/` in their bucket.
 *
 * None carries note text in either direction.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { MAX_DUE_HEARTBEATS, isHeartbeatOutcome } from "../heartbeats/model";
import { isAttentionUrgency } from "../attention/model";

/**
 * `POST /agent-texts/heartbeats/due` — `{}` → `{ heartbeats: [{ runId, accessToken, timeZone, since, phones }] }`.
 * The plaintext tokens are made here and returned once; only their hashes reach the database.
 */
export async function agentHeartbeatsDueHandler(ctx: ActionCtx, _body: Record<string, unknown>): Promise<Response> {
  const plaintext: string[] = [];
  const tokens: Array<{ hashedAccessToken: string; hashedRefreshToken: string }> = [];
  const runIds: string[] = [];
  for (let i = 0; i < MAX_DUE_HEARTBEATS; i += 1) {
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    plaintext.push(accessToken);
    tokens.push({
      hashedAccessToken: await hashToken(accessToken),
      hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
    });
    runIds.push(`beat_${randomOpaqueToken(16)}`);
  }
  const claimed = await ctx.runMutation(internal.functions.heartbeats.claimDueHeartbeats, { runIds, tokens });
  return json({ heartbeats: claimed.map(({ token, ...beat }) => ({ ...beat, accessToken: plaintext[token]! })) });
}

/** `POST /agent-texts/heartbeats/result` — `{ runId, outcome }` → `{ status: "recorded" | "unknown" }`. */
export async function agentHeartbeatsResultHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const runId = stringField(body, "runId");
  const outcome = body.outcome;
  if (runId === null || runId.length > 128 || !isHeartbeatOutcome(outcome)) return badRequest();
  const status = await ctx.runMutation(internal.functions.heartbeats.recordHeartbeatResult, { runId, outcome });
  return json({ status });
}

/**
 * `POST /gateway/attention/ask` — `{ accessToken, expectedWorkspaceId, urgency, deliver }` →
 * `{ attention: { status, dueAt?, timeZone? } | null }`. Always 200 for a
 * well-formed ask; `null` is every caller who may not ask, one answer for
 * every reason. The person and the workspace come off the token's live grant.
 */
export async function gatewayAttentionAskHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const urgency = body.urgency;
  if (!isAttentionUrgency(urgency) || typeof body.deliver !== "boolean") return badRequest();
  if (accessToken === null || expected === null) return json({ attention: null });
  const attention = await ctx.runMutation(internal.functions.heartbeats.requestAttention, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    urgency,
    deliver: body.deliver,
  });
  return json({ attention });
}
