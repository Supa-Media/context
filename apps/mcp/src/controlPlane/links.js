/**
 * Share links: mint, list and revoke — the single exception to `team never
 * means public` (non-negotiable #5).
 */
import { ControlPlaneError } from "./client.js";

export function createLinkMethods({ post, required }) {
  return {
    /**
     * Mint a link and get back its URL.
     *
     * **The URL rather than the token**, which is the whole point of the
     * route: an agent that assembled an address would be guessing at `/s/`
     * versus `/share/`, at whether the readable slug is there, and at the
     * origin of a self-hosted deployment. The control plane builds it from the
     * same function the console's Copy link uses.
     *
     * `null` for a caller the control plane did not clear as the owner — one
     * answer, so nothing here reconstructs a reason it deliberately did not
     * give. `{ refused }` for a cleared owner whose mint was refused (a note
     * the team cannot read, an encrypted note, the share cap): the owner is
     * owed the reason, and it used to arrive as a 500.
     */
    async createLink(accessToken, expectedWorkspaceId, request) {
      const parsed = await post("/gateway/links/create", {
        accessToken,
        expectedWorkspaceId,
        ...request,
      });
      const link = required(parsed, "link");
      if (link === null) {
        // Present only when the caller was cleared as the owner and the mint
        // itself refused — the console's sentence for the same refusal.
        return typeof parsed.refused === "string" && parsed.refused !== ""
          ? { refused: parsed.refused }
          : null;
      }
      if (!link || typeof link !== "object") throw new ControlPlaneError("malformed link");
      const shortRefused = parsed.shortRefused ?? null;
      return { link, shortRefused: typeof shortRefused === "string" ? shortRefused : null };
    },

    /** Every live link in this context, or `null` for a caller who may not ask. */
    async listLinks(accessToken, expectedWorkspaceId) {
      const parsed = await post("/gateway/links/list", {
        accessToken,
        expectedWorkspaceId,
      });
      const links = required(parsed, "links");
      if (links === null) return null;
      if (!Array.isArray(links)) throw new ControlPlaneError("malformed links");
      return links;
    },

    /**
     * Take one back. `false` covers "not yours", "already revoked" and "no
     * such id" — the same three the console's own revoke refuses as one.
     */
    async revokeLink(accessToken, expectedWorkspaceId, shareId) {
      const parsed = await post("/gateway/links/revoke", {
        accessToken,
        expectedWorkspaceId,
        shareId,
      });
      return required(parsed, "revoked") === true;
    },
  };
}
