/**
 * Carries the bot logins bound on 2026-11-26 through `botLogins` into their workspaces' objects, so no bot binds
 * twice (Dev, 2026-11-26: "why would they need to rebind?"). The object keeps bindings now
 * (`apps/mcp/src/workspaceStore/mailBots.js`); the gateway asks here only when its object has none for a connection,
 * copies what it finds into the object, and never asks again for it (`apps/mcp/src/mail/boundBot.js`). Read-only:
 * nothing new is written to `botLogins`. Delete this file, and the table once emptied, after those bots have carried.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { contextsForGrant, resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { TOKEN_HASH_PATTERN } from "./lib/crypto";

/** Which bot this live token's connection was bound as in this workspace: `{ bot, name }`, or `{ bot: null }`. */
export const carriedBotFor = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(v.object({ bot: v.string(), name: v.string() }), v.object({ bot: v.null() })),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return { bot: null };
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null || live.grant.texGroup !== undefined) return { bot: null };
    // The workspace comes from what the grant reaches, compared with the expected one, never looked up by it.
    const reached = (await contextsForGrant(ctx, live)).find((entry) => entry.workspaceId === args.expectedWorkspaceId);
    if (reached === undefined) return { bot: null };
    const row = await ctx.db
      .query("botLogins")
      .withIndex("by_grant_workspace", (q) => q.eq("grantId", live.grant._id).eq("workspaceId", reached.workspaceId))
      .unique();
    return row === null ? { bot: null } : { bot: row.bot, name: row.name };
  },
});
