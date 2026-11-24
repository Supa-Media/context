/**
 * The control plane's `/gateway/agent/identity` with `cards: true`, for the stub: whose member card a group chat's turn
 * may read (`apps/convex/functions/lib/texIdentity/cards.ts`, where the real rules are proved). A test or the bench
 * names the people for a token (`homes.set(accessToken, [{ handle, workspaceId }])`); every other token answers null.
 * Any other identity ask is left to the rest of the stub, as before.
 */

export function createMemberCardRoutes() {
  const homes = new Map();
  return {
    homes,
    async handle(path, body) {
      if (path !== "/gateway/agent/identity" || body?.cards !== true) return undefined;
      return { cards: homes.get(body.accessToken) ?? null };
    },
  };
}
