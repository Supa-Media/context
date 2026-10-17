/**
 * Email a person's AI sends as them (`tools/email.js`): the control plane
 * checks the limits, picks the sender (one of the token's person's own Gmail
 * connections that granted sending) and sends it.
 * `check` asks only whether it would go, and sends nothing.
 *
 * Answers `{ ok: true, from }` or `{ ok: false, refused }`; the email's words
 * cross once, to be sent, and are kept by neither side.
 */

const REFUSALS = new Set(["invalid", "not_allowed", "no_sender", "hourly_limit", "daily_limit", "recipient_limit", "not_configured", "unavailable"]);

export function createEmailMethods({ post }) {
  return {
    async sendPersonEmail(accessToken, expectedWorkspaceId, email, { check = false } = {}) {
      const answer = await post("/gateway/email/send", { accessToken, expectedWorkspaceId, email, check });
      if (answer?.ok === true && typeof answer.from === "string") return { ok: true, from: answer.from };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
  };
}
