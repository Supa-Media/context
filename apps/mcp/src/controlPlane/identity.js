/**
 * Who is texting Tex (`apps/convex/functions/lib/texIdentity/identity.ts`), and a text's session told behind.
 */

export function createIdentityMethods({ post }) {
  return {
    /**
     * The grant's own person, for a turn Tex answers for one person:
     * `{ name, handle, phones, emails, google }`, or `null` for every caller
     * who may not know (any other client, a shared workspace, a dead token).
     */
    async texterIdentity(accessToken, workspaceId) {
      const parsed = await post("/gateway/agent/identity", { accessToken, expectedWorkspaceId: workspaceId });
      const identity = parsed?.identity;
      return identity !== null && typeof identity === "object" && !Array.isArray(identity) ? identity : null;
    },

    /**
     * The person's own name on their account, from their own chat with Tex (`gatewayRoutes/accountName.ts`): with
     * `name`, set it. `{ status, name }`, or null when nothing answered; a group chat's token is always refused.
     */
    async accountName(accessToken, name) {
      const parsed = await post("/gateway/account/name", { accessToken, ...(name === undefined ? {} : { name }) });
      return parsed && typeof parsed === "object" && typeof parsed.status === "string" ? parsed : null;
    },

    /**
     * Who tagged Tex in a group chat, for their own ask of their personal Tex (`agent/askPersonalTex.js`): the same
     * facts, only on the token minted for that person's own tag, else `null`.
     */
    async askerIdentity(accessToken) {
      const parsed = await post("/gateway/agent/identity", { accessToken, asker: true });
      const identity = parsed?.identity;
      return identity !== null && typeof identity === "object" && !Array.isArray(identity) ? identity : null;
    },

    /**
     * Whose member card a group chat's turn may read (`agent/memberCards.js`; `lib/texIdentity/cards.ts`): the people
     * the tag's grant was minted for, `[{ handle, workspaceId }]`, on an account holder's own tag only, else `null`.
     */
    async memberCardHomes(accessToken) {
      const parsed = await post("/gateway/agent/identity", { accessToken, cards: true });
      return Array.isArray(parsed?.cards) ? parsed.cards : null;
    },

    /**
     * Who in a group chat is a member of the shared workspace it named (`agent/groupHolders.js`;
     * `lib/texIdentity/holders.ts`): `{ slug, holders }`, `slug` null when nobody here is in one by that name, or
     * `null` for every caller who may not ask (any client but a group chat's grant, a job's token, a dead token).
     */
    async workspaceHolders(accessToken, workspace) {
      const parsed = await post("/gateway/agent/identity", { accessToken, holders: String(workspace).slice(0, 80) });
      const answer = parsed?.holders;
      return answer !== null && typeof answer === "object" && Array.isArray(answer.holders) ? answer : null;
    },

    /**
     * The group chats the person texting their own Tex is in, for their 1:1 turn's `group_chats` tool
     * (`agent/groupChats.js`; `lib/texIdentity/groups.ts`): `[{ key, name, people, lastSeenAt }]`, or `null` for
     * every caller who may not know (any client but the 1:1 texting grant, another person's workspace, a dead token).
     */
    async texterGroups(accessToken, workspaceId) {
      const parsed = await post("/gateway/agent/identity", { accessToken, expectedWorkspaceId: workspaceId, groups: true });
      return Array.isArray(parsed?.groups) ? parsed.groups : null;
    },

    /**
     * A text's session the person object opened (`agent/textsSession.js`): Convex checks the phone is still linked,
     * keeps its copy of the grant, writes the audit row and re-arms the dream, check-in and housekeeping.
     * `{status: "linked" | "unlinked"}`. The token's hash, never the token.
     */
    async textsOpened({ personalWorkspaceId, phone, hashedAccessToken, expiresAt }) {
      return await post("/gateway/texts/opened", { personalWorkspaceId, phone, hashedAccessToken, expiresAt });
    },
  };
}
