/**
 * The control plane's `/gateway/email/send`, for the stub. The real route
 * (`apps/convex/functions/lib/gatewayRoutes/personEmail.ts`) holds the limits
 * and sends through the person's Gmail; this records what arrived and answers
 * as the stub's flags say: `emailSender` is the address that may send (null
 * for none, which is every real connection until Google adds `gmail.send`),
 * and `emailRefusal` answers every send and check with that word instead.
 * `/gateway/email/draft` answers the same way off `emailDrafter`, the address
 * whose Gmail may keep drafts, and its calls carry `draft: true`.
 */

export function createEmailRoute(clearedEditor, flags) {
  /** Every call: the email, whether it was a check, and what was answered. */
  const calls = [];

  async function send(body, draft = false) {
    const cleared = await clearedEditor(body);
    const sender = draft ? flags.emailDrafter : flags.emailSender;
    let answer;
    if (!cleared) answer = { ok: false, refused: "not_allowed" };
    else if (flags.emailRefusal) answer = { ok: false, refused: flags.emailRefusal };
    else if (!sender) answer = { ok: false, refused: "no_sender" };
    // Only a mailbox the person connected sends, as the real route checks.
    else if (body.email?.from && body.email.from !== sender) answer = { ok: false, refused: "no_sender" };
    else answer = { ok: true, from: sender };
    calls.push({ accessToken: body.accessToken, email: body.email, check: body.check === true, ...(draft ? { draft } : {}), answer });
    return answer;
  }

  /**
   * `/gateway/email/search` and `/gateway/email/read` (`gatewayRoutes/personMail.ts`):
   * `mailboxes` and `mailResults` (a list, or a function of the query) answer a search, `mailMessage` a read,
   * `mailAttachment` a read naming an attachment, and `mailRefusal` refuses
   * them all. The real clearance is proved in Convex.
   */
  const mailCalls = [];
  async function mail(path, body) {
    const cleared = await clearedEditor(body);
    let answer;
    if (!cleared) answer = { ok: false, refused: "not_allowed" };
    else if (flags.mailRefusal) answer = { ok: false, refused: flags.mailRefusal, ...(flags.mailExtra ?? {}) };
    else if (path === "/gateway/email/search") {
      const results = typeof flags.mailResults === "function" ? flags.mailResults(body.query) : (flags.mailResults ?? []);
      answer = { ok: true, results, mailboxes: flags.mailboxes ?? [], ...(flags.mailExtra ?? {}) };
    } else if (body.attachment !== undefined) {
      answer = flags.mailMessage && flags.mailAttachment
        ? { ok: true, message: flags.mailMessage, attachment: flags.mailAttachment }
        : { ok: false, refused: "not_found" };
    } else answer = flags.mailMessage ? { ok: true, message: flags.mailMessage } : { ok: false, refused: "not_found" };
    const { accessToken: _token, ...rest } = body;
    mailCalls.push({ path, body: rest, answer });
    return answer;
  }

  /** The route's answer, or undefined for a path that is not this one. */
  async function handle(path, body) {
    if (path === "/gateway/email/send") return await send(body);
    if (path === "/gateway/email/draft") return await send(body, true);
    if (path === "/gateway/email/search" || path === "/gateway/email/read") return await mail(path, body);
    return undefined;
  }

  return { calls, mailCalls, handle };
}
