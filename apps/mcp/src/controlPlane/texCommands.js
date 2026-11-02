/**
 * Tex's chat commands asked for by its agent as tools (`agent/commandTools.js`,
 * the control plane's `functions/texCommands.ts`).
 */

const STATUSES = new Set(["done", "refused", "not_allowed", "bad_request", "mail_refused"]);

export function createTexCommandMethods({ post }) {
  return {
    /**
     * One command as the person this token belongs to, in the chat it names.
     * The token is forwarded verbatim; the control plane takes the chat and the
     * person off its live grant and decides. Answers the control plane's
     * `{ status, ... }` with a known status, or null for anything else.
     */
    async texCommand(accessToken, command) {
      const parsed = await post("/gateway/tex/command", { accessToken, command });
      return parsed && typeof parsed === "object" && STATUSES.has(parsed.status) ? parsed : null;
    },
  };
}
