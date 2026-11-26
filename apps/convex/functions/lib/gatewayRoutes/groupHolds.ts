/**
 * `POST /gateway/group/hold` and `POST /gateway/group/share`: an answer held from a group chat, and the asker's yes
 * that shares it (`functions/groupHolds.ts`).
 *
 * - hold: `{ accessToken, id, slugs }` from the group turn, on the tagger's own tag (who was there is the token's own): `{ status: "held" }`.
 * - share: `{ accessToken, groupKey, id? }` from the asker's own chat with Tex: `{ status: "shared", slugs }`, or
 *   `refused`, `not_found`, `expired`, `not_member`.
 *
 * No number and no word of the answer ever comes here.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const strings = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, max) : null);

export async function gatewayGroupHoldHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const id = stringField(body, "id");
  const slugs = strings(body.slugs, 10);
  if (accessToken === null || id === null || slugs === null) return json({ status: "bad_request" });
  const status = await ctx.runMutation(internal.functions.groupHolds.recordHold, { hashedAccessToken: await hashToken(accessToken), id, slugs });
  return json({ status });
}

export async function gatewayGroupShareHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const groupKey = stringField(body, "groupKey");
  const id = stringField(body, "id");
  if (accessToken === null || groupKey === null || (body.id !== undefined && id === null)) return json({ status: "bad_request" });
  const answer = await ctx.runMutation(internal.functions.groupHolds.shareHold, { hashedAccessToken: await hashToken(accessToken), groupKey, ...(id !== null ? { id } : {}) });
  // Ids only: never a slug's words beyond the answer itself, never a number.
  console.log(JSON.stringify({ event: "group.hold_share", status: answer.status }));
  return json(answer);
}
