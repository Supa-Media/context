/**
 * The MCP's `tex_dev` tool's control-plane call (the control plane's `functions/texLabDrafts.ts`, route in
 * `functions/lib/gatewayRoutes/texDev.ts`). The connection's own grant is forwarded verbatim; the control plane takes
 * the person from it and decides who may develop on Tex. Only answers with a known status pass through.
 */

const STATUSES = new Set(["ok", "refused", "not_found", "bad_request", "conflict"]);

export function createTexDevMethods({ post }) {
  return {
    /** One `tex_dev` action that reads or changes a Lab draft, or reads the person's Tex page; null when unreachable. */
    async texDev(accessToken, action, args = {}) {
      const parsed = await post("/gateway/tex/dev", { accessToken, action, args });
      return parsed && typeof parsed === "object" && STATUSES.has(parsed.status) ? parsed : null;
    },
  };
}
