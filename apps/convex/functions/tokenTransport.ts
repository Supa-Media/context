/**
 * Who still sends their access token in a URL.
 *
 * The gateway accepts `/t/<token>/...` for clients that cannot set an
 * Authorization header, and tells `/gateway/session` when a token came that
 * way (`apps/mcp/src/http/presentedToken.js`). This stamps the grant, at most
 * hourly, with when and on which coarse route; the census counts them. Before
 * the URL form is refused anywhere, the census for that route has to read zero
 * (docs/decisions/gateway-protocol/token-transport.md).
 *
 * Nothing here names a person, a workspace or a token: the stamp lives on the
 * grant row the token already resolves to, and the census answers counts.
 */

import { v } from "convex/values";
import { CONSOLE_CLIENT_ID } from "./agentGrant";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";

/** One stamp an hour per grant: enough to count, cheap on a hot path. */
export const PATH_TOKEN_STAMP_EVERY_MS = 60 * 60 * 1000;

/** The gateway's route names (`PATH_TOKEN_ROUTES`); anything else is "other". */
const ROUTES = new Set(["mcp", "agent", "inbox", "collaboration", "presence", "agent-activity", "other"]);

export function pathTokenRouteOf(route: unknown): string {
  return typeof route === "string" && ROUTES.has(route) ? route : "other";
}

export const notePathToken = internalMutation({
  args: { grantId: v.id("oauthGrants"), route: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (grant === null || grant.status !== "active") return null;
    const now = Date.now();
    const route = pathTokenRouteOf(args.route);
    const recent = grant.pathTokenSeenAt !== undefined && now - grant.pathTokenSeenAt < PATH_TOKEN_STAMP_EVERY_MS;
    if (recent && grant.pathTokenRoute === route) return null;
    await ctx.db.patch(args.grantId, { pathTokenSeenAt: now, pathTokenRoute: route });
    return null;
  },
});

const census = v.object({
  since: v.number(),
  grants: v.number(),
  byRoute: v.record(v.string(), v.number()),
  console: v.number(),
  otherClients: v.number(),
});

/**
 * Live grants whose token came in a URL in the last `days` (default 30), by
 * route, and how many of them are the app's own console grant rather than an
 * outside client. Run from the CLI: `npx convex run tokenTransport:census`.
 * A grant counts under the last route it was seen on.
 */
export const pathTokenCensus = internalQuery({
  args: { days: v.optional(v.number()) },
  returns: census,
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(Math.floor(args.days ?? 30), 1), 365);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const seen = await ctx.db
      .query("oauthGrants")
      .withIndex("by_path_token_seen", (q) => q.gte("pathTokenSeenAt", since))
      .take(10_000);
    const byRoute: Record<string, number> = {};
    let grants = 0;
    let consoleGrants = 0;
    for (const grant of seen) {
      if (grant.status !== "active") continue;
      grants += 1;
      const route = pathTokenRouteOf(grant.pathTokenRoute);
      byRoute[route] = (byRoute[route] ?? 0) + 1;
      if (grant.clientId === CONSOLE_CLIENT_ID) consoleGrants += 1;
    }
    return { since, grants, byRoute, console: consoleGrants, otherClients: grants - consoleGrants };
  },
});
