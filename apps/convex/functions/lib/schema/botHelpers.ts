import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A bot's helper: a session the bot starts for deep work (Claude Code's `claude -p`, or any agent), which reaches
 * Context as that bot's sub-agent and is shown as one ("Claude via Grok Bot"; Dev, 2026-11-27: "it doesn't register
 * directly as Claude, but it registers as Claude by way of grok"). See `docs/decisions/app-and-console/bot-helpers.md`.
 *
 * Like a Tex computer run's grant (`texMachineRunGrants`), a row is a pointer to the bot's own grant
 * (`parentGrantId`), not a grant of its own: every live check on the parent applies on every request
 * (`lib/controlPlane/helperGrants.ts` `resolveHelperGrant`), so revoking the bot's connection ends its helpers at once.
 *
 *   1. The bot's connection asks for a helper (`manage area { start_helper }`): a row with a one-time ticket, ten
 *      minutes, kept as a hash.
 *   2. The bot spends the ticket from its own shell (`POST /api/bot-helper` on the gateway), and the token is minted
 *      then, straight into the helper's config file, so it never passes through a model or a chat.
 *   3. The helper ends (`manage area { end_helper }`), or its time runs out: the row is deleted, and the token with it.
 */
export const botHelperTables = {
  botHelpers: defineTable({
    /** The helper's id (`hlp_` + 16 hex), named in its note and its end call. */
    helperId: v.string(),
    /** The bot's own grant this helper acts as. */
    parentGrantId: v.id("oauthGrants"),
    /** The workspace whose bot started it: its note and its bot live here. */
    workspaceId: v.id("workspaces"),
    /** The bot's mail name (`mailJoinName`), and its card's short name as shown ("Grok Bot"). */
    bot: v.string(),
    botName: v.string(),
    /** What the helper calls itself ("Claude"), and the mail name it signs with (`grok-bot-claude-1`). */
    name: v.string(),
    mail: v.string(),
    /** Its own note: what it was asked, its progress and its mail with the bot. */
    note: v.string(),
    /** sha256 hex of the one-time ticket; cleared once spent. */
    hashedTicket: v.optional(v.string()),
    ticketExpiresAt: v.number(),
    /** sha256 hex of the helper's token, set when the ticket is spent. The plain token is returned once. */
    hashedAccessToken: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_helper", ["helperId"])
    .index("by_ticket", ["hashedTicket"])
    .index("by_access_token", ["hashedAccessToken"])
    .index("by_parent", ["parentGrantId"])
    .index("by_expires", ["expiresAt"]),
};
