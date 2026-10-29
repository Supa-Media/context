/**
 * `POST /agent-texts/review-sharing`: a texted yes or no to sharing finished
 * Tex conversations with the team (`functions/texReviews.ts`
 * `setTextsReviewSharing`), behind the agent Worker's secret like every
 * `/agent-texts/*` route.
 *
 * `{ phone, share?, participants? }` → `{ status: "unlinked" }`, or
 * `{ status: "ok", sharing, changed, team, chatShared? }`. `share` absent
 * only asks; `participants` (a group chat's people but Tex) asks whether the
 * whole chat now counts.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { MAX_GROUP_PARTICIPANTS } from "../../textGroups";
import { badRequest, json, stringField } from "../gatewayAuth";

export async function agentTextsReviewSharingHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const phone = stringField(body, "phone");
  const share = body.share;
  const participants = body.participants;
  if (phone === null || phone.length > 320 || (share !== undefined && typeof share !== "boolean")) return badRequest();
  if (participants !== undefined && (!Array.isArray(participants) || participants.length > MAX_GROUP_PARTICIPANTS * 2 || participants.some((entry) => typeof entry !== "string" || entry.length > 320))) {
    return badRequest();
  }
  const answer = await ctx.runMutation(internal.functions.texReviews.setTextsReviewSharing, {
    phone,
    ...(share !== undefined ? { share } : {}),
    ...(participants !== undefined ? { participants: participants as string[] } : {}),
  });
  return json(answer);
}
