/**
 * The Tex page's two control-plane calls (the control plane's `functions/texPage.ts`, routes in
 * `functions/lib/gatewayRoutes/texPage.ts`). The console's own grant is forwarded verbatim; the control plane takes
 * the person from it and decides. Only known answers pass through, and anything else is null.
 */

const PAGE_STATUSES = new Set(["ok", "refused"]);
const SETTINGS_STATUSES = new Set(["done", "refused", "not_found", "bad_request", "rate_limited"]);

function known(parsed, statuses) {
  return parsed && typeof parsed === "object" && statuses.has(parsed.status) ? parsed : null;
}

export function createTexPageMethods({ post }) {
  return {
    /**
     * What the Tex page shows the person this token belongs to: `{ status: "ok", ... }`, or `{ status: "refused" }`
     * for every reason a grant is not the console's and live. Null for anything else.
     */
    async texPage(accessToken) {
      const parsed = await post("/gateway/tex/page", { accessToken });
      return known(parsed, PAGE_STATUSES);
    },

    /**
     * One change the Tex page asks for, as the person this token belongs to. `chat` is `"me"` or a chat's key, and
     * `values` the whole text (`instructions`) or a quick pick (`pick`), plus `answers` for a chat. Answers `{ status, instructions?, engagement? }`, or null.
     */
    async texPageSettings(accessToken, chat, values) {
      const parsed = await post("/gateway/tex/page/settings", { accessToken, chat, values });
      return known(parsed, SETTINGS_STATUSES);
    },
  };
}
