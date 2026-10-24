/**
 * `POST /gateway/tex-review`: Tex's review of a finished conversation
 * (`functions/texReviews.ts`, `apps/mcp/src/agent/selfReview.js`).
 *
 * The two proofs every gateway route spends: the gateway secret (checked by
 * `gatewayRoute`) and the texting grant's own access token, forwarded
 * verbatim and resolved here, so a review is only ever about the conversation
 * that token belongs to.
 *
 * `mode: "tier"` asks what a review may carry before the model is asked for
 * any words: `{ tier: "full" | "scores" }`. Otherwise it files one: the
 * scores always (an anonymous row and the day's scores note), and the words
 * only on the `full` tier, decided again here; words sent for anybody else are
 * dropped unread. Always 200: `{ review: null }` for a token that resolves to
 * nothing or a grant that is not Tex's, `{ review: null, refused }` with a word
 * (`invalid`, `rate_limited`, `unavailable`), else `{ review: { filed } }`.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { fileTeamNote } from "../../bugNotes";
import { hashToken } from "../crypto";
import { parseReason, parseScores, parseWords, renderReviewNote, renderScoresNote, reviewNotePath, scoresNotePath } from "../feedback/texReviewNote";
import { json, stringField } from "../gatewayAuth";

function randomId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gatewayTexReviewHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  if (accessToken === null) return json({ review: null });
  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null) return json({ review: null });
  const setup = await ctx.runQuery(internal.functions.texReviews.reviewSetup, { grantId: session.grantId });
  if (setup === null) return json({ review: null });
  if (body.mode === "tier") return json({ tier: setup.tier });

  const scores = parseScores(body.scores);
  const reason = parseReason(body.reason);
  if (scores === null || reason === null) return json({ review: null, refused: "invalid" });

  const now = Date.now();
  let rows;
  try {
    rows = await ctx.runMutation(internal.functions.texReviews.recordScores, { userId: setup.userId, kind: setup.kind, reason, now, ...scores });
  } catch (error) {
    const code = error instanceof ConvexError ? (error.data as { code?: string })?.code : undefined;
    return json({ review: null, refused: code === "RATE_LIMITED" ? "rate_limited" : "unavailable" });
  }
  // A self-hosted deployment has no pinned context: the row is all there is.
  if (setup.destination === null) return json({ review: { filed: "scores" } });

  const day = new Date(now).toISOString().slice(0, 10);
  await fileTeamNote(ctx, setup.destination, scoresNotePath(setup.destination.folder, day), renderScoresNote(day, rows), "tex_scores_note");
  // Decided here again, never by what the gateway sent.
  const words = setup.tier === "full" ? parseWords(body.words) : null;
  if (words === null) return json({ review: { filed: "scores" } });
  const id = randomId();
  const path = reviewNotePath(setup.destination.folder, { now, scores, id });
  const filed = await fileTeamNote(
    ctx,
    setup.destination,
    path,
    renderReviewNote({ id, now, kind: setup.kind, reason, people: setup.people, scores, words }),
    "tex_review_note",
  );
  return json({ review: { filed: filed ? "full" : "scores" } });
}
