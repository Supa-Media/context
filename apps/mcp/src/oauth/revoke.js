import { oauthError } from "./responses.js";
import { authenticateClient, readForm } from "./token.js";

/* -------------------------------- revoke ---------------------------------- */

/**
 * RFC 7009 revocation — the per-client "unplug this one" lever.
 *
 * Revoking one client's grant leaves its siblings working: same person, same
 * workspace, a different AI client, untouched. That property is the reason MCP
 * access is OAuth rather than a shared token, and it is what a token in a URL
 * structurally cannot offer.
 *
 * RFC 7009 §2.2 requires 200 whether or not anything matched — an error would
 * turn this endpoint into an oracle for which tokens are live.
 */
export async function handleRevoke(request, env, controlPlane) {
  const params = await readForm(request);
  if (!params) {
    return oauthError(
      "invalid_request",
      "The revocation endpoint requires application/x-www-form-urlencoded."
    );
  }
  const clientId = params.get("client_id");
  if (!clientId) return oauthError("invalid_client", "client_id is required.", 401);
  const client = await controlPlane.getClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);
  if (!(await authenticateClient(client, params, request))) {
    return oauthError("invalid_client", "Client authentication failed.", 401);
  }

  const token = params.get("token");
  if (token) {
    const hint = params.get("token_type_hint");
    /*
      RFC 7009 §2.1: the hint is an OPTIMISATION, and if the server cannot find
      the token under the hinted type it **MUST extend its search across all of
      its supported token types**. A client is entitled to send no hint at all.

      This used to search one index and stop. Unhinted lands on `"refresh"`, so
      an access token presented without a hint was looked up among refresh
      tokens, missed, and left live — behind the 200 that §2.2 mandates, which
      is precisely the answer that cannot tell the caller their revocation did
      nothing. `CLAUDE.md` makes per-client revocability the reason MCP access
      is OAuth rather than a shared token; a revoke that silently no-ops is that
      promise failing quietly.

      The second lookup is only reached on a miss, so the ordinary hinted path
      still costs one call, and the answer is an unconditional 200 either way.
    */
    const hinted = hint === "access_token" ? "access" : "refresh";
    const other = hinted === "access" ? "refresh" : "access";
    try {
      const revoked = await controlPlane.revokeGrant(token, hinted, client.clientId);
      if (!revoked) await controlPlane.revokeGrant(token, other, client.clientId);
    } catch {
      // Swallowed deliberately: a failure here must not tell the caller whether
      // the token existed. The control plane logs it.
    }
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
