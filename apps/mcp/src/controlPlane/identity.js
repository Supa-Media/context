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
     * A text's session the person object opened (`agent/textsSession.js`), told behind the answer: the grant copy,
     * the audit row, and the dream, check-in and housekeeping re-armed. Ids, a clock and the token's hash, never the token.
     */
    async textsOpened({ personalWorkspaceId, grantId, workspaceId, hashedAccessToken, expiresAt, at }) {
      return await post("/gateway/texts/opened", { personalWorkspaceId, grantId, workspaceId, hashedAccessToken, expiresAt, at });
    },
  };
}
