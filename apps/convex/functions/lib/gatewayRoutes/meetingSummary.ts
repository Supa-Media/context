import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

/**
 * POST /gateway/meeting-summary — may this grant summarise a meeting now?
 *
 * Behind the gateway's own secret, with the person's access token as the second
 * proof, like `/gateway/builtin-model`. A malformed body is answered like an
 * unknown token: `{ verdict: null }`. The decision is `functions/meetingSummary.ts`.
 */
export async function gatewayMeetingSummaryHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  if (accessToken === null || !expected.ok) return json({ verdict: null });
  const verdict = await ctx.runMutation(internal.functions.meetingSummary.startMeetingSummary, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected.value,
  });
  return json({ verdict });
}

/** POST /gateway/meeting-summary/usage — token counts for a finished summary, never text. */
export async function gatewayMeetingSummaryUsageHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  const count = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : 0);
  if (accessToken === null || !expected.ok) return json({ recorded: false });
  const recorded = await ctx.runMutation(internal.functions.meetingSummary.recordMeetingSummaryUsage, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected.value,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    // Absent means Haiku; present but not a string is malformed, sent as "" so it is ignored rather than read as absent.
    model: body.model === undefined ? undefined : typeof body.model === "string" ? body.model : "",
    failed: body.failed === true,
    ms: count("ms"),
  });
  return json({ recorded });
}
