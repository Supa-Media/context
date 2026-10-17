/**
 * The control plane's `/gateway/email/send`, for the stub. The real route
 * (`apps/convex/functions/lib/gatewayRoutes/personEmail.ts`) holds the limits
 * and sends through the person's Gmail; this records what arrived and answers
 * as the stub's flags say: `emailSender` is the address that may send (null
 * for none, which is every real connection until Google adds `gmail.send`),
 * and `emailRefusal` answers every send and check with that word instead.
 */

export function createEmailRoute(clearedEditor, flags) {
  /** Every call: the email, whether it was a check, and what was answered. */
  const calls = [];

  async function send(body) {
    const cleared = await clearedEditor(body);
    let answer;
    if (!cleared) answer = { ok: false, refused: "not_allowed" };
    else if (flags.emailRefusal) answer = { ok: false, refused: flags.emailRefusal };
    else if (!flags.emailSender) answer = { ok: false, refused: "no_sender" };
    else answer = { ok: true, from: flags.emailSender };
    calls.push({ accessToken: body.accessToken, email: body.email, check: body.check === true, answer });
    return answer;
  }

  return { calls, send };
}
