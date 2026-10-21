/**
 * Connectors (`apps/convex/functions/connections.ts`): a link where the person
 * connects an app themselves, and one call through a connected app. The
 * control plane clears the token, picks the connection and holds the
 * provider's token; nothing of it ever reaches this side.
 */

export function createConnectionMethods({ post }) {
  return {
    /** `{url, name}` or `{url: null, reason}`. */
    async connectRequest(accessToken, expectedWorkspaceId, provider) {
      const parsed = await post("/gateway/connect/request", { accessToken, expectedWorkspaceId, provider });
      const url = typeof parsed?.url === "string" && /^https:\/\//.test(parsed.url) ? parsed.url : null;
      return {
        url,
        name: typeof parsed?.name === "string" ? parsed.name : null,
        reason: typeof parsed?.reason === "string" ? parsed.reason : null,
      };
    },

    /** Every app this deployment connects, with the person's state in each: `[{app, name, about, via, state, account?}]`. */
    async connectApps(accessToken, expectedWorkspaceId) {
      const parsed = await post("/gateway/connect/apps", { accessToken, expectedWorkspaceId });
      return Array.isArray(parsed?.apps) ? parsed.apps.filter((entry) => entry && typeof entry.app === "string") : [];
    },

    /** The provider's answer `{ok: true, team, body}`, or `{ok: false, refused, teams?}`. */
    async connectCall(accessToken, expectedWorkspaceId, request) {
      const parsed = await post("/gateway/connect/call", { accessToken, expectedWorkspaceId, ...request });
      return parsed && typeof parsed === "object" ? parsed : { ok: false, refused: "unavailable" };
    },
  };
}
