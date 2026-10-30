/**
 * The control plane's `/gateway/chat/send` and `/gateway/chat/spaces`, for the
 * stub. The real routes (`apps/convex/functions/lib/gatewayRoutes/googleChat.ts`)
 * hold the limits and talk to Google Chat; this records what arrived and
 * answers as its own `flags` say: `from` is the account that may send (null
 * for none), `spaceName` is the name Chat gives any space it is asked about,
 * and `refusal` answers every call with that word instead. The real
 * clearance is proved in Convex.
 */

export function createGoogleChatRoute(clearedOwnAccount) {
  // `recent`: the messages `/gateway/chat/recent` answers (a list, or a function of the body).
  const flags = { from: null, spaceName: null, refusal: null, recent: null, unnamed: false };
  /** Every call: the message, whether it was a check, and what was answered. */
  const calls = [];

  async function send(body) {
    let answer;
    if (!(await clearedOwnAccount(body))) answer = { ok: false, refused: "not_allowed" };
    else if (flags.refusal) answer = { ok: false, refused: flags.refusal };
    else if (!flags.from) answer = { ok: false, refused: "no_chat" };
    else {
      const message = body.message ?? {};
      const place = typeof message.to === "string" ? { person: message.to } : { space: flags.spaceName ?? message.space };
      answer = { ok: true, from: flags.from, place };
      // A send answers with the ids Google gave, as the real route does; `unnamed` leaves them out.
      if (body.check !== true && !flags.unnamed) Object.assign(answer, { space: "spaces/AAA", message: `spaces/AAA/messages/m${calls.length + 1}`, started: false });
    }
    calls.push({ message: body.message, check: body.check === true, answer });
    return answer;
  }

  async function spaces(body) {
    if (!(await clearedOwnAccount(body))) return { ok: false, refused: "not_allowed" };
    if (!flags.from) return { ok: false, refused: "no_chat" };
    return { ok: true, from: flags.from, spaces: [{ name: "spaces/AAA", displayName: flags.spaceName ?? "Portal", type: "SPACE" }] };
  }

  /** The route's answer, or undefined for a path that is not this one. */
  async function handle(path, body) {
    if (path === "/gateway/chat/send") return await send(body);
    if (path === "/gateway/chat/spaces") return await spaces(body);
    if (path === "/gateway/chat/recent") {
      if (!(await clearedOwnAccount(body))) return { ok: false, refused: "not_allowed" };
      if (!flags.from) return { ok: false, refused: "no_chat" };
      return { ok: true, from: flags.from, messages: typeof flags.recent === "function" ? flags.recent(body) : (flags.recent ?? []) };
    }
    return undefined;
  }

  return { flags, calls, handle };
}
