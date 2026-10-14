/**
 * The Convex tree, read for the agent tools (`../tree/served.js`).
 *
 * Spends the same two proofs `/gateway/site` does: the gateway secret, and the
 * person's own access token. The control plane chooses the workspace from the
 * token's grant and the clearance from the person's role in it, so nothing
 * this gateway concludes about either can widen what comes back.
 */
import { ControlPlaneError } from "./client.js";

/** A manifest page is a few thousand names; a slow one costs the tool its answer, and it says so. */
export const TREE_MANIFEST_TIMEOUT_MS = 6_000;

/**
 * Bytes one tree answer may be. A manifest page is up to 10,000 names
 * (`GATEWAY_PAGE_ENTRIES`) and a props answer up to 100 notes' front matter;
 * the 256 KB every other control-plane answer is held to refused any
 * workspace past about three thousand notes, which then listed the bucket.
 */
export const TREE_RESPONSE_BYTE_CAP = 16_000_000;

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
        { timeoutMs: TREE_MANIFEST_TIMEOUT_MS, maxBytes: TREE_RESPONSE_BYTE_CAP }
      );
      if (!parsed || parsed.served !== true) return { served: false };
      if (!Array.isArray(parsed.entries) || !(parsed.cursor === null || typeof parsed.cursor === "string")) {
        throw new ControlPlaneError("malformed tree manifest");
      }
      return { served: true, entries: parsed.entries, cursor: parsed.cursor };
    },

    /**
     * The tree's facts for this grant (`/gateway/tree/facts`): a move's link
     * candidates (`{ ask: "links", sources, names }`) or the chaos score's
     * extras and history (`{ ask: "chaos", today? }`), or notes' props
     * (`{ ask: "props", paths }`). `{ served: false }`
     * where the tree does not serve it, and for every refusal.
     *
     * @param {string} accessToken
     * @param {string} expectedWorkspaceId
     * @param {{ask: "links", sources: string[], names: string[]} | {ask: "chaos", today?: {all: number, team: number}} | {ask: "props", paths: string[]}} request
     */
    async readTreeFacts(accessToken, expectedWorkspaceId, request) {
      const parsed = await post(
        "/gateway/tree/facts",
        {
          ask: request?.ask,
          ...(Array.isArray(request?.sources) ? { sources: request.sources } : {}),
          ...(Array.isArray(request?.names) ? { names: request.names } : {}),
          ...(Array.isArray(request?.paths) ? { paths: request.paths } : {}),
          ...(request?.today ? { today: request.today } : {}),
          // Last, so nothing in the request can stand in for the person's token.
          accessToken,
          expectedWorkspaceId,
        },
        { timeoutMs: TREE_MANIFEST_TIMEOUT_MS, maxBytes: TREE_RESPONSE_BYTE_CAP }
      );
      if (!parsed || parsed.served !== true) return { served: false };
      return parsed;
    },
  };
}
