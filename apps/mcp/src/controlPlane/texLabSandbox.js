/**
 * The Lab test chats' control-plane call (`apps/convex/functions/texLabSandbox.ts`, route in
 * `functions/lib/gatewayRoutes/texLabSandbox.ts`). The caller's own grant is forwarded verbatim; the control plane
 * takes the person from it and decides who may use the Lab's test chats. Reads only. Only answers with a known status
 * pass through.
 */

const STATUSES = new Set(["ok", "refused", "not_found", "bad_request"]);

export function createLabSandboxMethods({ post }) {
  return {
    /** One read for a Lab test chat: `who`, `session { chat }`, `draft { draft }`, `set { id }`, `sets`; null when unreachable. */
    async labSandbox(accessToken, action, args = {}) {
      const parsed = await post("/gateway/tex/lab-sandbox", { accessToken, action, args });
      if (parsed && typeof parsed === "object" && parsed.status === undefined && action === "who") return { status: "ok", ...parsed };
      return parsed && typeof parsed === "object" && STATUSES.has(parsed.status) ? parsed : null;
    },
  };
}
