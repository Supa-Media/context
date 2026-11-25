/**
 * A bot that holds an area, told that mail arrived for it, or that one of its area's routines is due
 * (`POST /gateway/bots/mail`). The workspace object that
 * saved the note sends this (`workspaceStore/botMail.js`); the control plane calls the bot's webhook if one is
 * saved, sealed there. Names and paths only: never the message, never an address or a key.
 */

const BOT_MAIL_TIMEOUT_MS = 30_000;

export function createBotMailMethods({ post }) {
  return {
    /**
     * Resolves `{ok, status}`; throws when the control plane is unreachable. `type` is `"routine"` for an area's
     * routine that came due (`workspaceStore/areaRoutines.js`), whose `note` is the routine note; mail otherwise.
     */
    async botMail(workspaceId, { bot, area, note, from, type }) {
      return await post("/gateway/bots/mail", { workspaceId, bot, area, note, from, ...(type === "routine" ? { type } : {}) }, { timeoutMs: BOT_MAIL_TIMEOUT_MS });
    },

    /** An agent's `manage area` webhook step, cleared with the person's own token: list, set or test. Never a secret back. */
    async botHook(accessToken, expectedWorkspaceId, request) {
      const parsed = await post("/gateway/bots/hook", { accessToken, expectedWorkspaceId, ...request }, { timeoutMs: BOT_MAIL_TIMEOUT_MS });
      return parsed && typeof parsed === "object" ? parsed : { error: "the control plane gave no answer" };
    },

    /** A bot spending its one-time webhook command (`http/botHookUpload.js`): the ticket and the header's value, no person's token. */
    async botHookTicket(ticket, value) {
      const parsed = await post("/gateway/bots/hook-ticket", { ticket, value }, { timeoutMs: BOT_MAIL_TIMEOUT_MS });
      return parsed && typeof parsed === "object" ? parsed : { error: "the control plane gave no answer" };
    },
  };
}
