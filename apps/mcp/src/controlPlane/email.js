/**
 * Email a person's AI sends as them (`tools/email.js`): the control plane
 * checks the limits, picks the sender (one of the token's person's own Gmail
 * connections that granted sending) and sends it.
 * `check` asks only whether it would go, and sends nothing.
 *
 * Answers `{ ok: true, from }` or `{ ok: false, refused }` (with `senders` when it
 * is `choose_sender`: several Gmails can send and the email named none); the email's words
 * cross once, to be sent, and are kept by neither side.
 */

/**
 * Longer than the control plane's own Gmail calls (a token refresh, a reply's
 * headers, the send, each bounded there), so the gateway never gives up on a
 * send that then goes out, and an AI told "not sent" never sends it twice. A
 * search or read has one short retry there and fails over to the notes here.
 */
const SEND_TIMEOUT_MS = 110_000;
const READ_TIMEOUT_MS = 25_000;

/**
 * An attachment read carries the file as base64: up to the control plane's
 * 10 MiB file limit, about 14 MB once encoded, plus the email. Held to the
 * 256 KB every other answer is, any PDF over about 190 KB came back "Gmail did
 * not answer" (a venue's agreement, 2026-10-20).
 */
export const ATTACHMENT_RESPONSE_BYTE_CAP = 15_000_000;

/** `{ senders }` on a `choose_sender` refusal: the person's Gmails that can send, one of which the email must name. */
function sendersOf(answer) {
  if (answer?.refused !== "choose_sender" || !Array.isArray(answer.senders)) return {};
  return { senders: answer.senders.filter((address) => typeof address === "string" && address.length <= 320).slice(0, 20) };
}

/** `{ attached }`: the files Gmail says it holds (`personEmailCheck.ts`), each `{ filename, size }`; nothing when it was not read back. */
function attachedOf(answer) {
  if (!Array.isArray(answer?.attached)) return {};
  const attached = answer.attached
    .filter((file) => typeof file?.filename === "string" && Number.isFinite(file?.size))
    .slice(0, 50)
    .map((file) => ({ filename: file.filename.slice(0, 200), size: Math.max(0, Math.floor(file.size)) }));
  return { attached };
}

const REFUSALS = new Set(["invalid", "not_allowed", "no_sender", "hourly_limit", "daily_limit", "recipient_limit", "not_configured", "unavailable", "reply_not_found", "forward_not_found", "too_large", "reconnect_required", "ai_access_needed", "choose_sender"]);

export function createEmailMethods({ post }) {
  return {
    async sendPersonEmail(accessToken, expectedWorkspaceId, email, { check = false } = {}) {
      const answer = await post("/gateway/email/send", { accessToken, expectedWorkspaceId, email, check }, { timeoutMs: SEND_TIMEOUT_MS });
      if (answer?.ok === true && typeof answer.from === "string") return { ok: true, from: answer.from, ...attachedOf(answer) };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable", ...sendersOf(answer) };
    },
    /** The same email saved as a draft in their Gmail, sent to nobody (`tools/email.js`). */
    async savePersonEmailDraft(accessToken, expectedWorkspaceId, email) {
      const answer = await post("/gateway/email/draft", { accessToken, expectedWorkspaceId, email }, { timeoutMs: SEND_TIMEOUT_MS });
      if (answer?.ok === true && typeof answer.from === "string") return { ok: true, from: answer.from, ...attachedOf(answer) };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable", ...sendersOf(answer) };
    },
    /** The person's own mail, read live for what their notes do not hold (`tools/emailRead.js`). */
    async personMailSearch(accessToken, expectedWorkspaceId, search) {
      const answer = await post("/gateway/email/search", { accessToken, expectedWorkspaceId, ...search }, { timeoutMs: READ_TIMEOUT_MS });
      // Which mailboxes Gmail did not search, and why, so their synced notes can answer instead.
      const named = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry?.address === "string" && typeof entry?.folder === "string") : []);
      const reconnect = named(answer?.reconnect);
      const aiAccess = Array.isArray(answer?.aiAccess) ? answer.aiAccess.filter((address) => typeof address === "string") : [];
      if (answer?.ok === true && Array.isArray(answer.results) && Array.isArray(answer.mailboxes)) {
        const unanswered = Array.isArray(answer.unanswered) ? answer.unanswered.filter((address) => typeof address === "string") : [];
        // Why each gave nothing, as the control plane's fixed codes (`gmailFailureCode` in `personMail.ts`); anything else is dropped.
        const why = Array.isArray(answer.unansweredWhy)
          ? answer.unansweredWhy.filter((entry) => typeof entry?.address === "string" && typeof entry?.why === "string" && /^[A-Za-z0-9_]{1,80}$/.test(entry.why)).map(({ address, why: code }) => ({ address, why: code }))
          : [];
        return { ok: true, results: answer.results, mailboxes: named(answer.mailboxes), incomplete: answer.incomplete === true, unanswered, unansweredWhy: why, reconnect, aiAccess };
      }
      return {
        ok: false,
        refused: READ_REFUSALS.has(answer?.refused) ? answer.refused : "unavailable",
        mailboxes: named(answer?.mailboxes),
        reconnect,
        aiAccess,
      };
    },
    /** With `attachment` (1 for the first), that attachment's bytes come back too, as base64; `labChat` as in `labChatMail`. */
    async personMailRead(accessToken, expectedWorkspaceId, address, id, { attachment, labChat } = {}) {
      const answer = await post("/gateway/email/read", {
        accessToken,
        expectedWorkspaceId,
        address,
        id,
        ...(attachment === undefined ? {} : { attachment }),
        // A Lab test chat of a group chat reads the mail shared there (`labSandbox/chatRun.js` `labChatMail`).
        ...(typeof labChat === "string" ? { labChat } : {}),
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

const READ_REFUSALS = new Set(["invalid", "not_allowed", "no_mailbox", "rate_limited", "reconnect_required", "ai_access_needed", "not_found", "too_large", "unavailable"]);
