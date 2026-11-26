/**
 * The control plane's `/gateway/agent/identity` with `cards: true`, for the stub: whose member card a group chat's turn
 * may read (`apps/convex/functions/lib/texIdentity/cards.ts`, where the real rules are proved). A test or the bench
 * names the people for a token (`homes.set(accessToken, [{ handle, workspaceId }])`); every other token answers null.
 *
 * And with `groups: true`: the group chats the person texting their own Tex is in (`controlPlane.texterGroups`,
 * `lib/texIdentity/groups.ts`), named per 1:1 token (`groups.set(accessToken, [{ key, name, people, lastSeenAt }])`),
 * so a bench 1:1 sees its groups as production's does and its `ask_chat` can name them (`bench/crossWorld.mjs`).
 * Every other token answers null, as the real one does for any client but the 1:1 texting grant.
 *
 * Any other identity ask is left to the rest of the stub, as before.
 */

export function createMemberCardRoutes() {
  const homes = new Map();
  const groups = new Map();
  return {
    homes,
    groups,
    async handle(path, body) {
      if (path !== "/gateway/agent/identity") return undefined;
      if (body?.cards === true) return { cards: homes.get(body.accessToken) ?? null };
      if (body?.groups === true) return { groups: groups.get(body.accessToken) ?? null };
      return undefined;
    },
  };
}
