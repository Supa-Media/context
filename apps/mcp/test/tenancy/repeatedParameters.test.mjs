/**
 * HTTP parameter pollution: RFC 6749 §3.1 says no request parameter may
 * appear twice. Taking the first copy would let a second one ride along to
 * whatever reads the request differently, so /oauth/authorize, /oauth/token
 * and /oauth/revoke refuse a repeat before looking anything up.
 *
 * Runs after §8 (registrationAndPkce.test.mjs), reading `clientId`,
 * `verifier`, `challengeValue` and `authorizeUrl` from the harness, and
 * before §9-12, which still need TOKEN_A live. Sabotage record: making
 * `repeatedParameter` return null fails all five checks.
 */

import { TOKEN_A, postForm, rpc, worker } from "./fixtures.mjs";

export async function runTenancyRepeatedParameterChecks(check, harness) {
  const { env, controlPlane, clientId, verifier, challengeValue, authorizeUrl } = harness;
  const send = (request) => worker.fetch(request, env, { waitUntil() {} });
  const postRaw = (path, pairs) =>
    send(
      new Request(`https://mcp.context.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(pairs).toString(),
      })
    );

  const twoRedirects = await send(
    new Request(`${authorizeUrl()}&redirect_uri=${encodeURIComponent("https://attacker.test/callback")}`)
  );
  check(
    "an authorization request with two redirect URIs is refused without redirecting",
    twoRedirects.status === 400 && twoRedirects.headers.get("Location") === null
  );
  const twoChallenges = await send(new Request(`${authorizeUrl()}&code_challenge=${"c".repeat(43)}`));
  check(
    "an authorization request with two PKCE challenges is refused",
    twoChallenges.status === 400 && (await twoChallenges.json()).error === "invalid_request"
  );

  controlPlane.issueCode("code-repeated", {
    clientId,
    redirectUri: "https://client.test/callback",
    codeChallenge: challengeValue,
    codeChallengeMethod: "S256",
    scope: "context:read context:write",
    resource: "https://mcp.context.test/mcp",
    workspaceId: "ws_a",
    userId: "user_a",
  });
  const repeatedExchange = await postRaw("/oauth/token", [
    ["grant_type", "authorization_code"],
    ["code", "code-repeated"],
    ["redirect_uri", "https://client.test/callback"],
    ["redirect_uri", "https://attacker.test/callback"],
    ["client_id", clientId],
    ["code_verifier", verifier],
  ]);
  check(
    "a token request with a repeated parameter is refused",
    repeatedExchange.status === 400 && (await repeatedExchange.json()).error === "invalid_request"
  );
  const afterRepeat = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-repeated",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check(
    "the refusal comes before the code is looked at, so the code still works once",
    afterRepeat.status === 200
  );

  const repeatedRevoke = await postRaw("/oauth/revoke", [
    ["token", "not-a-token"],
    ["token", TOKEN_A],
    ["client_id", "mcp_client_alpha"],
  ]);
  check(
    "a revocation with a repeated parameter is refused and revokes nothing",
    repeatedRevoke.status === 400 && (await rpc(env, TOKEN_A, "ping", {})).body?.result !== undefined
  );
}
