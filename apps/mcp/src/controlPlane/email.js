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
    /** The same email saved as a draft in their Gmail, sent to nobody (`tools/email.js`). */
    async savePersonEmailDraft(accessToken, expectedWorkspaceId, email) {
      const answer = await post("/gateway/email/draft", { accessToken, expectedWorkspaceId, email });
      if (answer?.ok === true && typeof answer.from === "string") return { ok: true, from: answer.from };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
    /** The person's own mail, read live for what their notes do not hold (`tools/emailRead.js`). */
    async personMailSearch(accessToken, expectedWorkspaceId, search) {
      const answer = await post("/gateway/email/search", { accessToken, expectedWorkspaceId, ...search });
      if (answer?.ok === true && Array.isArray(answer.results) && Array.isArray(answer.mailboxes)) {
        return { ok: true, results: answer.results, mailboxes: answer.mailboxes, incomplete: answer.incomplete === true };
      }
      return { ok: false, refused: READ_REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
    /** With `attachment` (1 for the first), that attachment's bytes come back too, as base64. */
    async personMailRead(accessToken, expectedWorkspaceId, address, id, { attachment } = {}) {
      const answer = await post("/gateway/email/read", {
        accessToken,
        expectedWorkspaceId,
        address,
        id,
        ...(attachment === undefined ? {} : { attachment }),
      });
      if (answer?.ok === true && answer.message && typeof answer.message === "object") {
        const file = answer.attachment;
        if (attachment !== undefined && (typeof file?.data !== "string" || typeof file?.filename !== "string")) {
          return { ok: false, refused: "unavailable" };
        }
        return { ok: true, message: answer.message, ...(attachment === undefined ? {} : { attachment: file }) };
      }
      return { ok: false, refused: READ_REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
  };
}

const READ_REFUSALS = new Set(["invalid", "not_allowed", "no_mailbox", "rate_limited", "not_found", "too_large", "unavailable"]);
