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
    createdAt: v.number(),
  })
    .index("by_mailboxId", ["mailboxId"])
    .index("by_workspace_path_name", ["workspaceId", "path", "name"]),
};
