/**
 * Email a person's AI sends as them (`tools/email.js`): the control plane
 * checks the limits, picks the sender (one of the token's person's own Gmail
 * connections that granted sending) and sends it.
 * `check` asks only whether it would go, and sends nothing.
 *
 * Answers `{ ok: true, from }` or `{ ok: false, refused }`; the email's words
 * cross once, to be sent, and are kept by neither side.
 */

/**
 * Longer than the control plane's own Gmail calls (a token refresh, a reply's
 * headers, the send, each bounded there), so the gateway never gives up on a
 * send that then goes out, and an AI told "not sent" never sends it twice. A
 * search or read has one short retry there and fails over to the notes here.
 */
const SEND_TIMEOUT_MS = 45_000;
const READ_TIMEOUT_MS = 25_000;

/**
 * An attachment read carries the file as base64: up to the control plane's
 * 10 MiB file limit, about 14 MB once encoded, plus the email. Held to the
 * 256 KB every other answer is, any PDF over about 190 KB came back "Gmail did
 * not answer" (a venue's agreement, 2026-10-20).
 */
export const ATTACHMENT_RESPONSE_BYTE_CAP = 15_000_000;

const REFUSALS = new Set(["invalid", "not_allowed", "no_sender", "hourly_limit", "daily_limit", "recipient_limit", "not_configured", "unavailable", "reply_not_found", "reconnect_required"]);

export function createEmailMethods({ post }) {
  return {
    async sendPersonEmail(accessToken, expectedWorkspaceId, email, { check = false } = {}) {
      const answer = await post("/gateway/email/send", { accessToken, expectedWorkspaceId, email, check }, { timeoutMs: SEND_TIMEOUT_MS });
      if (answer?.ok === true && typeof answer.from === "string") return { ok: true, from: answer.from };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
    /** The same email saved as a draft in their Gmail, sent to nobody (`tools/email.js`). */
    async savePersonEmailDraft(accessToken, expectedWorkspaceId, email) {
      const answer = await post("/gateway/email/draft", { accessToken, expectedWorkspaceId, email }, { timeoutMs: SEND_TIMEOUT_MS });
      if (answer?.ok === true && typeof answer.from === "string") return { ok: true, from: answer.from };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
    /** The person's own mail, read live for what their notes do not hold (`tools/emailRead.js`). */
    async personMailSearch(accessToken, expectedWorkspaceId, search) {
      const answer = await post("/gateway/email/search", { accessToken, expectedWorkspaceId, ...search }, { timeoutMs: READ_TIMEOUT_MS });
      // Which mailboxes Gmail did not search, and why, so their synced notes can answer instead.
      const named = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry?.address === "string" && typeof entry?.folder === "string") : []);
      const reconnect = named(answer?.reconnect);
      if (answer?.ok === true && Array.isArray(answer.results) && Array.isArray(answer.mailboxes)) {
        const unanswered = Array.isArray(answer.unanswered) ? answer.unanswered.filter((address) => typeof address === "string") : [];
        return { ok: true, results: answer.results, mailboxes: named(answer.mailboxes), incomplete: answer.incomplete === true, unanswered, reconnect };
      }
      return {
        ok: false,
        refused: READ_REFUSALS.has(answer?.refused) ? answer.refused : "unavailable",
        mailboxes: named(answer?.mailboxes),
        reconnect,
      };
    },
    /** With `attachment` (1 for the first), that attachment's bytes come back too, as base64. */
    async personMailRead(accessToken, expectedWorkspaceId, address, id, { attachment } = {}) {
      const answer = await post("/gateway/email/read", {
        accessToken,
        expectedWorkspaceId,
        address,
        id,
        ...(attachment === undefined ? {} : { attachment }),
      }, { timeoutMs: READ_TIMEOUT_MS, ...(attachment === undefined ? {} : { maxBytes: ATTACHMENT_RESPONSE_BYTE_CAP }) });
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

const READ_REFUSALS = new Set(["invalid", "not_allowed", "no_mailbox", "rate_limited", "reconnect_required", "not_found", "too_large", "unavailable"]);
