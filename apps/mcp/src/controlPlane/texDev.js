/**
 * The MCP's `tex_dev` tool's control-plane call (the control plane's `functions/texLabDrafts.ts`, route in
 * `functions/lib/gatewayRoutes/texDev.ts`). The connection's own grant is forwarded verbatim; the control plane takes
 * the person from it and decides who may develop on Tex. Only answers with a known status pass through.
 */

const STATUSES = new Set(["ok", "refused", "not_found", "bad_request", "conflict"]);

/**
 * How big a `tex_dev` answer may be. `set_drafts` carries every Training and Dev draft whole (each up to the control
 * plane's MAX_CONVO, 200 KB), so the gateway's default 256 KB cap refused the listing once a few long conversations
 * were drafted, and every set_* read and edit failed as "could not be reached".
 */
export const TEX_DEV_RESPONSE_BYTE_CAP = 8_000_000;

export function createTexDevMethods({ post }) {
  return {
    /** One `tex_dev` action that reads or changes a Lab draft, or reads the person's Tex page; null when unreachable. */
    async texDev(accessToken, action, args = {}) {
      const parsed = await post("/gateway/tex/dev", { accessToken, action, args }, { maxBytes: TEX_DEV_RESPONSE_BYTE_CAP });
      return parsed && typeof parsed === "object" && STATUSES.has(parsed.status) ? parsed : null;
    },
  };
}
