/**
 * Problem reports an agent files with `report_problem`.
 */

export function createFeedbackMethods({ post }) {
  return {
    /**
     * File a report as the person this token belongs to.
     *
     * The token is forwarded verbatim, as every call on this client does; the
     * control plane resolves the person from it and runs the same intake as
     * the app's bug button, so this can report on nobody's behalf but the
     * grant's own. Answers `{ eventId }` when it was sent, `{ refused }` with
     * a word (`invalid`, `rate_limited`, `not_configured`, `unavailable`) for
     * a person it resolved, and `null` for a token that resolves to nothing.
     * `texts` — the person's recent texts with Tex — goes only after their
     * YES to the report (`tools/reportGate.js`).
     */
    async reportProblem(accessToken, message, texts = undefined) {
      const parsed = await post("/gateway/feedback", { accessToken, message, ...(typeof texts === "string" ? { texts } : {}) });
      if (parsed?.report && typeof parsed.report.eventId === "string") return { eventId: parsed.report.eventId };
      if (typeof parsed?.refused === "string") return { refused: parsed.refused };
      return null;
    },

    /**
     * Tex's review of a finished conversation (`agent/selfReview.js`), as the
     * texting grant this token belongs to. `{ mode: "tier" }` asks whether it
     * may carry words: `"full"` or `"scores"`, null when the control plane
     * answered anything else. Otherwise it files the scores, and the words when
     * the control plane decides again that they may go: `"full"`, `"scores"`,
     * or null when nothing was filed.
     */
    async texReviewTier(accessToken) {
      const parsed = await post("/gateway/tex-review", { accessToken, mode: "tier" });
      return parsed?.tier === "full" || parsed?.tier === "scores" ? parsed.tier : null;
    },

    async fileTexReview(accessToken, review) {
      const parsed = await post("/gateway/tex-review", { accessToken, ...review });
      const filed = parsed?.review?.filed;
      return filed === "full" || filed === "scores" ? filed : null;
    },
  };
}
