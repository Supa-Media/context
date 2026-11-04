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
  })
    .index("by_grant", ["hashedGrant"])
    .index("by_workspace", ["workspaceId"])
    .index("by_owner", ["ownerId"]),
};
