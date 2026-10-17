/**
 * Tex's housekeeping over HTTP (`docs/decisions/texting-assistant/housekeeping.md`).
 * Registered in `http.ts`, behind the texting Worker's secret:
 *
 *  - `POST /agent-texts/housekeeping/due`: the runs due now, each with a
 *    short-lived grant on the person's personal workspace.
 *  - `POST /agent-texts/housekeeping/result`: how one went, as a code.
 *
 * Neither carries note text in either direction.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { MAX_DUE_HOUSEKEEPING, isHousekeepingOutcome } from "../housekeeping/model";

/**
 * `POST /agent-texts/housekeeping/due` — `{}` → `{ runs: [{ runId, accessToken, timeZone }] }`.
 * The plaintext tokens are made here and returned once; only their hashes reach the database.
 */
export async function agentHousekeepingDueHandler(ctx: ActionCtx, _body: Record<string, unknown>): Promise<Response> {
  const plaintext: string[] = [];
  const tokens: Array<{ hashedAccessToken: string; hashedRefreshToken: string }> = [];
  const runIds: string[] = [];
  for (let i = 0; i < MAX_DUE_HOUSEKEEPING; i += 1) {
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    plaintext.push(accessToken);
    tokens.push({
      hashedAccessToken: await hashToken(accessToken),
      hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
    });
    runIds.push(`house_${randomOpaqueToken(16)}`);
  }
  const claimed = await ctx.runMutation(internal.functions.housekeeping.claimDueHousekeeping, { runIds, tokens });
  return json({ runs: claimed.map(({ token, ...run }) => ({ ...run, accessToken: plaintext[token]! })) });
}

/** `POST /agent-texts/housekeeping/result` — `{ runId, outcome }` → `{ status: "recorded" | "unknown" }`. */
export async function agentHousekeepingResultHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const runId = stringField(body, "runId");
  const outcome = body.outcome;
  if (runId === null || runId.length > 128 || !isHousekeepingOutcome(outcome)) return badRequest();
  const status = await ctx.runMutation(internal.functions.housekeeping.recordHousekeepingResult, { runId, outcome });
  return json({ status });
}
