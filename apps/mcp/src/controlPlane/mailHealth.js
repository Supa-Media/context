/**
 * Whether the person's own mailboxes are working
 * (`docs/decisions/communications/mail-health.md`). The token is forwarded
 * verbatim; the control plane clears the owner of their personal workspace
 * from it and answers nothing to anyone else. No mail crosses.
 */

const STATES = new Set(["ok", "needs_reconnect", "store_full", "stale", "recovering"]);

/** A read that should never hold `orient` or a check-in up for long. */
const MAIL_HEALTH_TIMEOUT_MS = 3_000;

export function createMailHealthMethods({ post }) {
  return {
    /**
     * `[{ address, state, lastSyncedAt, tell }]` for the owner of this personal
     * workspace, or null for anyone else. A mailbox in a state this gateway
     * does not know is left out.
     */
    async readMailHealth(accessToken, workspaceId) {
      const parsed = await post(
        "/gateway/mail-health",
        { accessToken, expectedWorkspaceId: workspaceId },
        { timeoutMs: MAIL_HEALTH_TIMEOUT_MS },
      );
      if (!Array.isArray(parsed?.mailboxes)) return null;
      return parsed.mailboxes
        .filter((mailbox) => typeof mailbox?.address === "string" && STATES.has(mailbox.state))
        .map((mailbox) => ({
          address: mailbox.address,
          state: mailbox.state,
          lastSyncedAt: typeof mailbox.lastSyncedAt === "number" ? mailbox.lastSyncedAt : null,
          tell: mailbox.tell === true,
        }));
    },

    /** Tex's check-in is about to text these states. Answers how many the control plane kept. */
    async raiseMailNotices(accessToken, workspaceId, mailboxes) {
      const parsed = await post("/gateway/mail-health/raised", {
        accessToken,
        expectedWorkspaceId: workspaceId,
        mailboxes: mailboxes.map(({ address, state }) => ({ address, state })),
      });
      return typeof parsed?.raised === "number" ? parsed.raised : 0;
    },
  };
}
