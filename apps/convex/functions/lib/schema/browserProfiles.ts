import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tex's saved browser profiles at Browserbase (the owner, 2026-10-29;
 * `docs/decisions/texting-assistant/vault.md`). One row per browser owner: a
 * person's own browser (filed under their personal workspace) or a group
 * chat's (under the chat's shared workspace). The row is the only handle on
 * the profile, which holds that browser's sign-ins at the vendor, so it is
 * released, never just deleted: `releasing` rows are deleted at Browserbase
 * by `browserProfiles.releaseProfile`, and the row goes once that succeeds.
 *
 * `owner` is the gateway's HMAC tag for the browser (it names nobody). `chat`
 * is a hash of a group chat, so a chat whose people changed (a new owner tag)
 * has its old profile released. Nothing here is a credential.
 */
export const browserProfileTables = {
  browserProfiles: defineTable({
    workspaceId: v.id("workspaces"),
    owner: v.string(),
    chat: v.optional(v.string()),
    provider: v.literal("browserbase"),
    profileId: v.string(),
    status: v.union(v.literal("live"), v.literal("releasing")),
    failures: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_owner", ["owner"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_chat", ["workspaceId", "chat"]),
};
