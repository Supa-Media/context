/**
 * Who is texting Tex (`apps/convex/functions/lib/texIdentity/identity.ts`).
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
  };
}
