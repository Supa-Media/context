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
     */
    async reportProblem(accessToken, message) {
      const parsed = await post("/gateway/feedback", { accessToken, message });
      if (parsed?.report && typeof parsed.report.eventId === "string") return { eventId: parsed.report.eventId };
      if (typeof parsed?.refused === "string") return { refused: parsed.refused };
      return null;
    },
  };
}
