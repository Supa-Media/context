/**
 * Tex's nightly dream over HTTP (`docs/decisions/texting-assistant/dreams.md`).
 * Registered in `http.ts`, behind the texting Worker's secret:
 *
 *  - `POST /agent-texts/dreams/due`: the dreams due now, each with a
 *    short-lived grant on the person's personal workspace.
 *  - `POST /agent-texts/dreams/result`: how one went, as a code.
 *
 * And behind the gateway's secret, with the person's own access token:
 *
 *  - `POST /gateway/dreams/start`: their agent asks for a dream now
 *    (`lib/dreams/now.ts`).
 *
 * None carries note text in either direction.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { MAX_DUE_DREAMS, isDreamOutcome } from "../dreams/model";

/**
 * `POST /agent-texts/dreams/due` — `{}` → `{ dreams: [{ runId, accessToken, timeZone, since }] }`.
 * The plaintext tokens are made here and returned once; only their hashes reach the database.
 */
export async function agentDreamsDueHandler(ctx: ActionCtx, _body: Record<string, unknown>): Promise<Response> {
  const plaintext: string[] = [];
  const tokens: Array<{ hashedAccessToken: string; hashedRefreshToken: string }> = [];
  const runIds: string[] = [];
  for (let i = 0; i < MAX_DUE_DREAMS; i += 1) {
    const accessToken = `cat_${randomOpaqueToken(32)}`;
    plaintext.push(accessToken);
    tokens.push({
      hashedAccessToken: await hashToken(accessToken),
      hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
    });
    runIds.push(`dream_${randomOpaqueToken(16)}`);
  }
  const claimed = await ctx.runMutation(internal.functions.dreams.claimDueDreams, { runIds, tokens });
  return json({ dreams: claimed.map(({ token, ...dream }) => ({ ...dream, accessToken: plaintext[token]! })) });
}

/** `POST /agent-texts/dreams/result` — `{ runId, outcome }` → `{ status: "recorded" | "unknown" }`. */
export async function agentDreamsResultHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const runId = stringField(body, "runId");
  const outcome = body.outcome;
  if (runId === null || runId.length > 128 || !isDreamOutcome(outcome)) return badRequest();
  const status = await ctx.runMutation(internal.functions.dreams.recordDreamResult, { runId, outcome });
  return json({ status });
}

/**
 * `POST /gateway/dreams/start` — `{ accessToken, expectedWorkspaceId }` →
 * `{ dream: { status, retryAt? } | null }`. Always 200; `null` is every caller
 * who may not ask, one answer for every reason. The person and the workspace
 * come off the token's live grant, never from anything the gateway names.
 */
export async function gatewayDreamsStartHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ dream: null });
  const dream = await ctx.runMutation(internal.functions.dreams.requestDreamNow, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  return json({ dream });
}
