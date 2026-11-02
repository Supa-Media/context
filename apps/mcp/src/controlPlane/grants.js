/**
 * OAuth client registration and grant lifecycle: register, authorize,
 * consume a code, create/rotate/revoke a grant.
 */
import { ControlPlaneError } from "./client.js";

export function createGrantMethods({ post, required }) {
  /**
   * `{revoked, held}`: `held` is `{grantId, personalWorkspaceId}` when the grant is a switched person's, which the
   * control plane leaves to their object (`oauth/objectGrants.js` revokes it there, then writes the copy behind).
   */
  async function revokeGrantAnswer(token, tokenType, clientId) {
    const parsed = await post("/gateway/grants/revoke", { token, tokenType, clientId });
    const revoked = required(parsed, "revoked");
    const held = parsed.held;
    if (held !== undefined && held !== null) {
      if (typeof held.grantId !== "string" || typeof held.personalWorkspaceId !== "string") throw new ControlPlaneError("malformed held grant");
      return { revoked: false, held: { grantId: held.grantId, personalWorkspaceId: held.personalWorkspaceId } };
    }
    return { revoked: revoked === true, held: null };
  }

  return {
    async registerClient(registration) {
      const parsed = await post("/gateway/clients/register", registration);
      if (required(parsed, "ok") !== true) throw new ControlPlaneError("registration refused");
      return true;
    },

    async getClient(clientId) {
      return required(await post("/gateway/clients/get", { clientId }), "client");
    },

    async startAuthorization(request) {
      const parsed = await post("/gateway/authorize/start", request);
      const requestId = required(parsed, "requestId");
      const consentUrl = required(parsed, "consentUrl");
      if (typeof requestId !== "string" || typeof consentUrl !== "string") {
        throw new ControlPlaneError("malformed authorization start");
      }
      return { requestId, consentUrl };
    },

    async consumeAuthorizationCode(code, clientId) {
      return required(await post("/gateway/codes/consume", { code, clientId }), "authorization");
    },

    async createGrant(grant) {
      const grantId = required(await post("/gateway/grants/create", grant), "grantId");
      if (typeof grantId !== "string" || !grantId) {
        throw new ControlPlaneError("malformed grant id");
      }
      return grantId;
    },

    /**
     * A grant for a switched person, written behind their object (`oauth/objectGrants.js`): the control plane makes the
     * row, as `createGrant` does, and answers the connection row the object is to keep.
     */
    async createHeldGrant(grant) {
      const parsed = await post("/gateway/grants/create", { ...grant, heldBy: "object" });
      const grantId = required(parsed, "grantId");
      const connection = required(parsed, "connection");
      if (typeof grantId !== "string" || !grantId || connection === null || typeof connection !== "object" || connection.grantId !== grantId) {
        throw new ControlPlaneError("malformed held grant");
      }
      return { grantId, connection };
    },

    async rotateGrant(rotation) {
      return required(await post("/gateway/grants/rotate", rotation), "grant");
    },

    /**
     * Say that the client holding this token just fetched `tools/list`, so a
     * later `orient` names only what changed after it. Bookkeeping: the
     * caller defers it and swallows its failure.
     */
    async reportToolsListed(accessToken) {
      return await post("/gateway/grants/tools-listed", { accessToken });
    },

    async revokeGrant(token, tokenType, clientId) {
      return (await revokeGrantAnswer(token, tokenType, clientId)).revoked;
    },

    revokeGrantAnswer,
  };
}
