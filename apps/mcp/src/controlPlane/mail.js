/**
 * Note mail mailboxes (`docs/decisions/note-mail.md`): join, look up, mark
 * read. The access token is the proof, as for the session; nothing about the
 * mail's text crosses.
 */

export function createMailMethods({ post }) {
  return {
    /** `{ mailbox }` or `{ error: "name_taken" | "refused" }`. */
    async joinMailbox(accessToken, workspaceId, path, name) {
      return await post("/gateway/mail/join", { accessToken, workspaceId, path, name });
    },

    /** The mailbox this token's grant joined, or null. */
    async getMailbox(accessToken, mailboxId) {
      const answer = await post("/gateway/mail/get", { accessToken, mailboxId });
      return answer?.mailbox ?? null;
    },

    async markMailRead(accessToken, mailboxId, readThrough) {
      return await post("/gateway/mail/read", { accessToken, mailboxId, readThrough });
    },
  };
}
