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
     * A text's session the person object opened (`agent/textsSession.js`): Convex checks the phone is still linked,
     * keeps its copy of the grant, writes the audit row and re-arms the dream, check-in and housekeeping.
     * `{status: "linked" | "unlinked"}`. The token's hash, never the token.
     */
    async textsOpened({ personalWorkspaceId, phone, hashedAccessToken, expiresAt }) {
      return await post("/gateway/texts/opened", { personalWorkspaceId, phone, hashedAccessToken, expiresAt });
    },
  };
}
