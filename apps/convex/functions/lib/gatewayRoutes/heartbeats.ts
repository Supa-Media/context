/**
 * Tex's check-in over HTTP (`docs/decisions/texting-assistant/heartbeat.md`).
 * Registered in `http.ts`, behind the texting Worker's secret:
 *
 *  - `POST /agent-texts/heartbeats/due`: the check-ins due now, each with a
 *    short-lived grant on the person's personal workspace and their own phones.
 *  - `POST /agent-texts/heartbeats/result`: how one went, as a code.
 *
 * Neither carries note text in either direction.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { MAX_DUE_HEARTBEATS, isHeartbeatOutcome } from "../heartbeats/model";

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
