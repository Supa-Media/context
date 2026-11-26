import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * How Context reaches a bot that holds an area (`docs/decisions/app-and-console/area-bots.md`):
 * one webhook per bot name per workspace. The address, an optional header
 * secret and the signing key are sealed with `encryptSecret`, bound to the
 * workspace, and opened only in `functions/botHooks.ts` `callBotHook` for one
 * signed call. The bot's card in the notes never holds any of it.
 */
export const botHookTables = {
  botHooks: defineTable({
    workspaceId: v.id("workspaces"),
    /** The bot's name as mail knows it (`mailJoinName`): lowercase, at most 24 characters. */
    bot: v.string(),
    /** The address's host, shown so a person can tell which one is saved. Not a secret. */
    host: v.string(),
    encryptedUrl: v.string(),
    /** `Name: value`, sent on every call, for a bot that checks a header of its own. */
    encryptedHeader: v.optional(v.string()),
    /** The header value's last four characters, shown as "ends xxxx". */
    headerEnds: v.optional(v.string()),
    /** The key every call is signed with (HMAC-SHA256), shown to the setter once. */
    encryptedSigningKey: v.string(),
    setBy: v.id("users"),
    setAt: v.number(),
    lastCallAt: v.optional(v.number()),
    lastCallOk: v.optional(v.boolean()),
    /** The bot's HTTP status, or 0 when it could not be reached. */
    lastCallStatus: v.optional(v.number()),
  }).index("by_workspace_bot", ["workspaceId", "bot"]),
  /**
   * Whether a bot answers (`functions/botLogins.ts`): when it bound its login, Context mailed it a check, and this is
   * when that went out and when the bot's own login last answered in mail. Healthy only when an answer came after
   * the check; "not answering" once the check is older than a few minutes with none (Dev, 2026-11-26).
   */
  botHealth: defineTable({
    workspaceId: v.id("workspaces"),
    bot: v.string(),
    checkSentAt: v.number(),
    answeredAt: v.optional(v.number()),
  }).index("by_workspace_bot", ["workspaceId", "bot"]),
  /**
   * A one-time ticket a bot spends from its own shell to hand Context its
   * webhook's header (`functions/botHookTickets.ts`): minted by `manage area`
   * for one bot, address and header name, good for ten minutes, once. The
   * ticket and the token that minted it are kept only as hashes; the header's
   * value never touches this row.
   */
  botHookTickets: defineTable({
    hashedTicket: v.string(),
    hashedAccessToken: v.string(),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    bot: v.string(),
    address: v.string(),
    headerName: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_hashed_ticket", ["hashedTicket"])
    .index("by_workspace_expires", ["workspaceId", "expiresAt"]),
};
