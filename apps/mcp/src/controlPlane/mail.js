/**
 * Note mail mailboxes (`docs/decisions/note-mail.md`): join, look up, mark
 * read, and list the mailboxes a Tex background job joined on a note. The
 * access token is the proof, as for the session; nothing about the mail's
 * text crosses.
 */

export function createMailMethods({ post }) {
  return {
    /**
     * `{ mailbox }` or `{ error: "name_taken" | "refused" }`. `jobId` is sent only when it is a string: the Tex
     * background job whose turn is joining, so the gateway can deliver mail to that job at once.
     */
    async joinMailbox(accessToken, workspaceId, path, name, jobId) {
      return await post("/gateway/mail/join", {
        accessToken,
        workspaceId,
        path,
        name,
        ...(typeof jobId === "string" ? { jobId } : {}),
      });
    },

    /** The mailbox this token's grant joined, or null. */
    async getMailbox(accessToken, mailboxId) {
      const answer = await post("/gateway/mail/get", { accessToken, mailboxId });
      return answer?.mailbox ?? null;
    },

    async markMailRead(accessToken, mailboxId, readThrough) {
      return await post("/gateway/mail/read", { accessToken, mailboxId, readThrough });
    },

    /** `[{ mailboxId, name, jobId }]` on this note that a live grant joined from a Tex job; `[]` otherwise. */
    async jobMailboxes(accessToken, workspaceId, path) {
      const answer = await post("/gateway/mail/jobs", { accessToken, workspaceId, path });
      return answer?.mailboxes ?? [];
    },
  };
}
