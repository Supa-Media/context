/**
 * The Tex page's two control-plane calls (the control plane's `functions/texPage.ts`, routes in
 * `functions/lib/gatewayRoutes/texPage.ts`). The console's own grant is forwarded verbatim; the control plane takes
 * the person from it and decides. Only known answers pass through, and anything else is null.
 */

import { ControlPlaneError } from "./client.js";

const PAGE_STATUSES = new Set(["ok", "refused"]);
const SETTINGS_STATUSES = new Set(["done", "refused", "not_found", "bad_request", "rate_limited"]);

/** A short code from a control-plane body: a word, never a token, a number, or anyone's text. */
function upstreamCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(code) || /\d{4,}/.test(code)) return null;
  if (code.includes("token") || code.includes("secret") || code.includes("bearer") || code.includes("key")) return null;
  return code;
}

function codeFrom(body) {
  if (body === null || typeof body !== "object") return null;
  return upstreamCode(body.reason) ?? upstreamCode(body.code) ?? upstreamCode(body.status) ?? upstreamCode(body.refused);
}

/** Convex always answers 200; `upstream` is that status, or the transport's, and `code` is the body's reason. */
function logUpstream(upstream, body, ms) {
  console.error(JSON.stringify({ event: "tex_page_upstream", upstream: Number.isInteger(upstream) ? upstream : null, code: codeFrom(body), ms }));
}

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
      const started = Date.now();
      try {
        const parsed = await post("/gateway/tex/page", { accessToken });
        const answer = known(parsed, PAGE_STATUSES);
        // A usable page is quiet. A refusal, or a body that is not a page, says the status and the code, never the token.
        if (!(answer?.status === "ok" && typeof answer.workspaceId === "string")) logUpstream(200, parsed, Date.now() - started);
        return answer;
      } catch (error) {
        const failure = error instanceof ControlPlaneError ? error : null;
        logUpstream(failure?.status ?? null, { reason: failure?.reason ?? "request_failed" }, Date.now() - started);
        throw error;
      }
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
