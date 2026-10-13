/**
 * The Convex tree, read for the agent tools (`../tree/served.js`).
 *
 * Spends the same two proofs `/gateway/site` does: the gateway secret, and the
 * person's own access token. The control plane chooses the workspace from the
 * token's grant and the clearance from the person's role in it, so nothing
 * this gateway concludes about either can widen what comes back.
 */
import { ControlPlaneError } from "./client.js";

/** A manifest page is a few thousand names; a slow one costs the tool its speed, not its answer. */
export const TREE_MANIFEST_TIMEOUT_MS = 6_000;

export function createTreeMethods({ post }) {
  return {
    /**
     * One page of the keys this grant may see in the workspace, from the
     * Convex tree: `{ served: true, entries, cursor }`, or `{ served: false }`
     * where the tree does not serve it (and for every refusal), when the
     * bucket answers instead.
     *
     * @param {string} accessToken
     * @param {string} expectedWorkspaceId
     * @param {{cursor?: string, folder?: string}} page
     */
    async readTreeManifest(accessToken, expectedWorkspaceId, page = {}) {
      const parsed = await post(
        "/gateway/tree/manifest",
        {
          accessToken,
          expectedWorkspaceId,
          ...(typeof page.cursor === "string" ? { cursor: page.cursor } : {}),
          ...(typeof page.folder === "string" ? { folder: page.folder } : {}),
        },
        { timeoutMs: TREE_MANIFEST_TIMEOUT_MS }
      );
      if (!parsed || parsed.served !== true) return { served: false };
      if (!Array.isArray(parsed.entries) || !(parsed.cursor === null || typeof parsed.cursor === "string")) {
        throw new ControlPlaneError("malformed tree manifest");
      }
      return { served: true, entries: parsed.entries, cursor: parsed.cursor };
    },
  };
}
