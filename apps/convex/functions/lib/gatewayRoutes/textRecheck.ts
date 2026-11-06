/**
 * The texting Worker's last look before an answer goes out, in a group or a
 * 1:1 chat (`docs/design/tex-event-log/CONTRACT.md` section 3b; 1:1 since
 * Dev2's one-door plan, 2026-11-05: both kinds of chat get the same look): Tex drafted a reply
 * to one message, its asker has said more since, and the reply has not been
 * sent. Does it still answer what they want? Asked of the decision model as
 * `textDecide` (the same feature, gate and daily calls), one typed question.
 *
 * The group review of 2026-10-30: Tex answered a debugging question with a
 * reply about saving a playbook, drafted for an earlier ask. Nothing looked
 * again between deciding once and sending.
 *
 * The draft and the transcript are never returned, stored or logged: the one
 * log line carries counts and codes.
 */

import type { ActionCtx } from "../../../_generated/server";
import { badRequest, json } from "../gatewayAuth";
import { withJev } from "../jev/client";
import { workspaceFor } from "./textDecide";

export { FITS_AT, MAX_DRAFT, readRecheckAnswers, readRecheckBody, recheckRequest } from "@context/shared/src/textDecide.cjs";
export type { RecheckBody, RecheckResult } from "@context/shared/src/textDecide.cjs";
// The question and how its answer reads are one copy, shared with the gateway (`packages/shared/src/textDecide.cjs`).
import { readRecheckAnswers, readRecheckBody, recheckRequest, type RecheckResult } from "@context/shared/src/textDecide.cjs";

export async function agentTextsRecheckHandler(ctx: ActionCtx, raw: Record<string, unknown>): Promise<Response> {
  const body = readRecheckBody(raw);
  if (body === null) return badRequest();
  const started = Date.now();
  const workspaceId = await workspaceFor(ctx, body);
  const result: RecheckResult =
    workspaceId === null
      ? { ok: false, reason: "unavailable", cause: "no_group" }
      : await withJev(ctx, { feature: "textDecide", workspaceId }, async (jev, refusal) => {
          if (!jev) return { ok: false, reason: refusal === "daily_cap" || refusal === "not_premium" ? "capped" : refusal === "unconfigured" ? "unavailable" : "off", cause: refusal ?? "refused" };
          if (jev.remaining <= 0) return { ok: false, reason: "capped", cause: "daily_cap" };
          const answers = await jev.decide(recheckRequest(body));
          return answers === null ? { ok: false, reason: "unavailable", cause: "model_failed" } : readRecheckAnswers(answers);
        });
  // Counts and codes only: never the transcript, the draft, or a number.
  console.info(
    JSON.stringify({
      event: "texts.recheck",
      candidates: body.candidates.length,
      totalMs: Date.now() - started,
      ...(result.ok ? { fits: result.fits } : { reason: result.reason, cause: result.cause }),
    }),
  );
  return json(result);
}
