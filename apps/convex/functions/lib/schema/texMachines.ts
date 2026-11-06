import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A person's own computer, paired so Tex can run jobs on it (`docs/decisions/texting-assistant/machines.md`).
 *
 * One slice of the control-plane schema, spread into `defineSchema` by `apps/convex/schema.ts`. Metadata only:
 * the runner's private key never leaves the machine, and the machine grant arrives here already as a hash. The
 * name `texMachine` is deliberate: `machine` already names the desktop shell's OAuth grant (`lib/machineGrant.ts`).
 */
export const texMachineTables = {
  /**
   * A pairing in progress: a runner asked to be paired and showed a code, and a signed-in person may approve it.
   *
   * Only the code's hash is kept, so a dump of this table names no code that could still be typed. Rows are swept
   * an hour after they expire (`purgeExpiredTexMachinePairings`); a claimed row stays until then, as the record of
   * which machine it became.
   */
  texMachinePairings: defineTable({
    /** The machine's Ed25519 public key, raw 32 bytes, base64url without padding. */
    publicKey: v.string(),
    name: v.string(),
    os: v.string(),
    /** SHA-256 hex of `tex-machine-pair:<normalized code>`. */
    hashedCode: v.string(),
    status: v.union(
      v.literal("waiting"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("claimed"),
    ),
    /** Set on approve: the workspace the machine will belong to. */
    workspaceId: v.optional(v.id("workspaces")),
    /** Set on approve: the person who approved it, re-checked at claim. */
    approvedBy: v.optional(v.id("users")),
    /** Set on claim. */
    machineId: v.optional(v.id("texMachines")),
    /**
     * What the runner says about itself (its specs, its version), shown on both screens to compare. JSON text, at
     * most 8000 characters, parsed only when read back. Never a credential.
     */
    facts: v.optional(v.string()),
    /**
     * Set when a session approved its own computer's code with its Context connection (`pair_device`,
     * `functions/texMachineDevices.ts`): the machine it becomes takes mail and never jobs, and ends with that grant.
     */
    mailOnly: v.optional(v.literal(true)),
    pairedByGrantId: v.optional(v.id("oauthGrants")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_code", ["hashedCode"])
    .index("by_expires", ["expiresAt"]),

  /**
   * A paired machine. Lives beside its workspace's rows: its owner is a member of that workspace, and only the
   * owner (or an owner of the workspace) may revoke it.
   */
  texMachines: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    name: v.string(),
    os: v.string(),
    publicKey: v.string(),
    /** SHA-256 hex of the machine grant. The plain grant is returned once, to the runner, and never stored. */
    hashedGrant: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),
    /**
     * A mail-only device: a session's own computer (a cloud VM's Claude Code), paired by that session's Context
     * connection (`pairedByGrantId`). It takes note mail and never jobs, stops resolving the moment that grant is
     * revoked or `expiresAt` passes, and is deleted by the purge an hour later (`functions/texMachineDevices.ts`).
     */
    mailOnly: v.optional(v.literal(true)),
    pairedByGrantId: v.optional(v.id("oauthGrants")),
    expiresAt: v.optional(v.number()),
  })
    .index("by_grant", ["hashedGrant"])
    .index("by_workspace", ["workspaceId"])
    .index("by_owner", ["ownerId"])
    .index("by_expires", ["expiresAt"]),

  /**
   * A run grant: the short-lived token a Tex background job's part presents on a paired machine. It acts exactly as
   * the job's own texting grant (`parentGrantId`), under its own client id, and lives only as long as the part does.
   * It is a pointer to the parent, not a grant of its own, so every live check on the parent applies on every request
   * (`lib/controlPlane/liveGrants.ts` `resolveRunGrant`).
   *
   * Swept with the pairings: an expired row is deleted by the hourly purge, and a machine's rows go with the machine.
   */
  texMachineRunGrants: defineTable({
    /** sha256 hex of the plain run token; the plain token is returned once, to the gateway, and never stored. */
    hashedAccessToken: v.string(),
    /** The job's own texting grant (`context_texts` or `context_texts_group`) this one acts as. */
    parentGrantId: v.id("oauthGrants"),
    machineId: v.id("texMachines"),
    /** The workspace object's run id (`run_` + 24 hex), for revoking at the part's end. */
    runId: v.string(),
    /** The job whose part this is: its note's mail reaches only that job's own mailbox (`noteMail.ts` `mailGrant`). */
    jobId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_access_token", ["hashedAccessToken"])
    .index("by_expires", ["expiresAt"])
    .index("by_machine", ["machineId"])
    .index("by_run", ["runId"]),

  /**
   * A paired machine lent to a Tex group chat: the chat's people may run its jobs there (`docs/decisions/texting-assistant/machines.md`).
   *
   * Only the machine's owner attaches or detaches it, and only from inside the chat. A row does not end when its owner
   * leaves the chat: `texMachinesForChat` filters on the chat's people at read time, so a person who left lends nothing.
   * Rows go with their machine (revoke, and the account and workspace cascades).
   */
  texMachineChats: defineTable({
    /** `textGroups.groupKey` of the chat the machine is lent to. */
    groupKey: v.string(),
    machineId: v.id("texMachines"),
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_group", ["groupKey"])
    .index("by_machine", ["machineId"]),
};
