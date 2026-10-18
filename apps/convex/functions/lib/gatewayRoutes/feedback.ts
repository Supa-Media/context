/**
 * `POST /gateway/feedback`: a problem report an agent files through the
 * gateway's `report_problem` tool.
 *
 * The two proofs every gateway route spends: the gateway secret (checked by
 * `gatewayRoute` before this runs) and the person's own access token,
 * forwarded verbatim and resolved here. The person the report is filed as is
 * the grant's, never anything the gateway names, and the report goes through
 * the same intake as the app's bug button (`lib/feedback/deliver.ts`): the
 * same ten-a-day budget per person, the same Sentry envelope, nothing of the
 * report stored.
 *
 * One exception, by where it goes: a report from the texting grant is a bug
 * report the person filed with Tex, and it lands as a note in the pinned
 * context's `tex-bugs/` folder instead of Sentry (`bugNotes.ts`). Only on a
 * deployment that has a pinned context; a self-hosted one sends it to Sentry.
 *
 * Always 200. `{ report: { eventId } }` when it was sent. `{ report: null }`
 * for a token that resolves to nothing, one answer for every reason. And
 * `{ report: null, refused }` for a person the token did resolve to, with a
 * word the gateway turns into a sentence: `invalid`, `rate_limited`,
 * `not_configured` or `unavailable`.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { fileBugNote } from "../../bugNotes";
import { TEXTS_CLIENT_ID, parseAgentReport } from "../feedback/agentReport";
import { deliverFeedback, feedbackTarget } from "../feedback/deliver";
import { json, stringField } from "../gatewayAuth";

const REFUSALS: Record<string, string> = {
  FEEDBACK_INVALID: "invalid",
  FEEDBACK_RATE_LIMITED: "rate_limited",
  FEEDBACK_BUSY: "unavailable",
  FEEDBACK_UNAVAILABLE: "unavailable",
};

export async function gatewayFeedbackHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  if (accessToken === null) return json({ report: null });

  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null) return json({ report: null });

  const userId = session.actorUserId as Id<"users">;
  const bugNote =
    session.clientId === TEXTS_CLIENT_ID ? await ctx.runQuery(internal.functions.bugNotes.destination, { userId }) : null;
  const sentry = feedbackTarget();
  if (sentry === null && bugNote === null) return json({ report: null, refused: "not_configured" });

  try {
    const report = parseAgentReport({
      message: body.message,
      clientName: session.clientName ?? "",
      clientId: session.clientId,
      texts: body.texts,
    });
    const sent =
      bugNote !== null
        ? await deliverFeedback(ctx, {
            userId,
            report,
            send: (eventId, now) => fileBugNote(ctx, bugNote, { message: report.message, texts: report.texts, eventId, now }),
          })
        : await deliverFeedback(ctx, { sentry: sentry!, userId, report });
    return json({ report: sent });
  } catch (error) {
    const code = error instanceof ConvexError ? (error.data as { code?: string })?.code : undefined;
    // Anything unexpected is "unavailable" rather than a 500: the gateway can
    // only report a 500 as the control plane being down.
    return json({ report: null, refused: (code && REFUSALS[code]) || "unavailable" });
  }
}
