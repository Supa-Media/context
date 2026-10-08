import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

/**
 * POST /gateway/builtin-model — may this turn spend the built-in model?
 *
 * Behind the gateway's own secret, with the person's access token as the second
 * proof, like `/gateway/provider`. A malformed body is answered like an unknown
 * token: `{ verdict: null }`. The decision is `functions/builtinModel.ts`.
 */
export async function gatewayBuiltinModelHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  if (accessToken === null || !expected.ok) return json({ verdict: null });
  const verdict = await ctx.runMutation(internal.functions.builtinModel.startBuiltinTurn, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected.value,
  });
  return json({ verdict });
}

/** POST /gateway/builtin-model/usage — token counts for a finished turn, never text. */
export async function gatewayBuiltinUsageHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  const count = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : 0);
  if (accessToken === null || !expected.ok) return json({ recorded: false });
  const recorded = await ctx.runMutation(internal.functions.builtinModel.recordBuiltinUsage, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected.value,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    decisionTokens: count("decisionTokens"),
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    model: typeof body.model === "string" ? body.model : undefined,
    failed: body.failed === true,
    ms: count("ms"),
  });
  return json({ recorded });
}
