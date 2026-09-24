/**
 * OAuth client registration and grant lifecycle: register, authorize,
 * consume a code, create/rotate/revoke a grant.
 */
import { ControlPlaneError } from "./client.js";

export function createGrantMethods({ post, required }) {
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

    async rotateGrant(rotation) {
      return required(await post("/gateway/grants/rotate", rotation), "grant");
    },

    async revokeGrant(token, tokenType, clientId) {
      return required(
        await post("/gateway/grants/revoke", { token, tokenType, clientId }),
        "revoked"
      );
    },
  };
}
