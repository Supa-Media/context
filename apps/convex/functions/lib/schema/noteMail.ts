import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Note mail mailboxes (`docs/decisions/note-mail.md`).
 *
 * The mail itself is in the note's own file, in the customer's bucket. This
 * row is only what lets the gateway say "2 new for you" on any call: which
 * note an agent joined, under which name, through which grant, and the time
 * of the last message it has read. A path and a short name, never mail text.
 *
 * Bound to the grant that joined: another connection presenting the same
 * mailbox id is answered as if it did not exist.
 */
export const noteMailTables = {
  noteMailboxes: defineTable({
    /** What the agent passes as `mailbox`. Not a credential: it only selects. */
    mailboxId: v.string(),
    grantId: v.id("oauthGrants"),
    workspaceId: v.id("workspaces"),
    /** The note's path when it was joined. */
    path: v.string(),
    /** The name the agent joined as, `[a-z0-9-]`, up to 24. */
    name: v.string(),
    /** The time (ISO) of the newest message this mailbox has read. */
    readThrough: v.optional(v.string()),
    /**
     * The Tex background job whose turn joined this mailbox, when it joined from one. The gateway looks mailboxes up
     * by this to deliver new mail to that job at once. An id the job presents, `[A-Za-z0-9_-]{8,64}`, never a credential.
     */
    jobId: v.optional(v.string()),
    /**
     * The person's own machine whose session joined this mailbox (a cloud VM's Claude Code, `device` on join). The
     * gateway pushes new mail down that machine's socket. Removed with the machine (`functions/texMachineDevices.ts`).
     */
    machineId: v.optional(v.id("texMachines")),
    createdAt: v.number(),
  })
    .index("by_mailboxId", ["mailboxId"])
    .index("by_workspace_path_name", ["workspaceId", "path", "name"])
    .index("by_machine", ["machineId"])
    // A job's own mailboxes, so a job part on a computer joins every note under its job's one name (`joinMailbox`).
    .index("by_job", ["jobId"]),

  /**
   * Tex in mail (`functions/noteMail.ts` `askTexMail`, `docs/decisions/note-mail.md`): a line sent to Tex on a note
   * whose mail a person's own Tex joined from their texts, waiting for that person's Tex to read it and answer. The
   * gateway asks with the sender's token; the texting Worker claims it for the owner and gets a texting session for the
   * run (`functions/texMail.ts`). Names and ids only, never a word of the mail. Kept an hour after it ran, for the cap.
   */
  texMailRuns: defineTable({
    /** The Tex mailbox the line was sent to. */
    mailboxId: v.string(),
    /** Whose Tex answers, and their personal workspace, which names their Tex store. */
    userId: v.id("users"),
    ownerWorkspaceId: v.id("workspaces"),
    /** The note the mail is on. */
    workspaceId: v.id("workspaces"),
    path: v.string(),
    status: v.union(v.literal("due"), v.literal("claimed")),
    createdAt: v.number(),
  })
    .index("by_owner_status", ["ownerWorkspaceId", "status"])
    .index("by_mailbox", ["mailboxId"])
    .index("by_user", ["userId"]),
};
