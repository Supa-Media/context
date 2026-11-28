/**
 * Note mail mailboxes (`docs/decisions/note-mail.md`): join, look up, mark
 * read, and list the mailboxes a Tex background job joined on a note. The
 * access token is the proof, as for the session; nothing about the mail's
 * text crosses.
 */

export function createMailMethods({ post }) {
  return {
    /**
     * `{ mailbox }`, `{ error: "name_taken" | "refused" }` or `{ error: "own_name", name }` (a job part's own name). `jobId` is sent only when it is a string: the Tex
     * background job whose turn is joining, so the gateway can deliver mail to that job at once.
     */
    async joinMailbox(accessToken, workspaceId, path, name, jobId, machineId) {
      return await post("/gateway/mail/join", {
        accessToken,
        workspaceId,
        path,
        name,
        ...(typeof jobId === "string" ? { jobId } : {}),
        // A session on one of the person's machines joining as that machine (`device`), so mail reaches it at once.
        ...(typeof machineId === "string" ? { machineId } : {}),
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

    /**
     * `[{ mailboxId, name, jobId | machineId, own }]` on this note that a live grant joined from a Tex job or as one of
     * the person's machines; `[]` otherwise.
     */
    async jobMailboxes(accessToken, workspaceId, path) {
      const answer = await post("/gateway/mail/jobs", { accessToken, workspaceId, path });
      return answer?.mailboxes ?? [];
    },

    /**
     * Wake a person's own Tex for a line sent to its mailbox on this note (`functions/noteMail.ts` `askTexMail`): their
     * personal workspace's id, whose Tex store the gateway wakes, or null for every refusal.
     */
    async askTexMail(accessToken, workspaceId, path, mailboxId, forHandle) {
      const answer = await post("/gateway/mail/tex", { accessToken, workspaceId, path, mailboxId, ...(typeof forHandle === "string" ? { forHandle } : {}) });
      return typeof answer?.owner === "string" ? answer.owner : null;
    },

    /**
     * An agent of this token's person that holds no seat sent mail on this note: their own Tex gets a mailbox there, so
     * a reply to the agent wakes it (`functions/noteMail.ts` `texSeatMailbox`). The mailbox id, or null.
     */
    async texSeatMailbox(accessToken, workspaceId, path) {
      const answer = await post("/gateway/mail/tex-seat", { accessToken, workspaceId, path });
      return typeof answer?.mailboxId === "string" ? answer.mailboxId : null;
    },
  };
}
