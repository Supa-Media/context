/**
 * `POST /gateway/transcription/consent` — `{ accessToken, expectedWorkspaceId, kind }`
 * → `{ allowed: boolean }`.
 *
 * Asked by the gateway before it forwards any audio to the transcription
 * service: a Mac app's meeting chunk (`kind: "meeting"`) or a voice message
 * texted to Tex (`kind: "voiceMessage"`). Behind the gateway's secret, with
 * the person's own access token: the person comes off the token's live
 * grant, never from anything the gateway names. Always 200; `false` is every
 * refusal, a dead token included
 * (`docs/decisions/meetings/transcription-consent.md`).
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

export async function gatewayTranscriptionConsentHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const kind = body.kind === "voiceMessage" ? "voiceMessage" : "meeting";
  if (accessToken === null || expected === null) return json({ allowed: false });
  const allowed = await ctx.runQuery(internal.functions.transcriptionConsent.gatewayConsent, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    kind,
  });
  return json({ allowed });
}
