import { isLoopbackHost } from "../controlPlane.js";
import { SUPPORTED_SCOPES } from "../session.js";
import { DEFAULT_REQUESTED_SCOPE } from "./policy.js";
import { oauthError } from "./responses.js";
import { resourceMatches, slugFromResource } from "./discovery.js";
import { redirectUriMatches } from "./registration.js";

/* ------------------------------- authorize -------------------------------- */

/**
 * `GET /oauth/authorize` — validate, then hand off to the control plane's
 * consent screen.
 *
 * Error handling follows RFC 6749 §4.1.2.1, and the split matters: an error is
 * only redirected back to the client **after** the redirect URI has been proven
 * to belong to a registered client. Before that point there is nowhere safe to
 * send anything, so the error is rendered here. Redirecting an error to an
 * unvalidated `redirect_uri` is itself the open redirect.
 */
export async function handleAuthorize(request, env, controlPlane, { origin, slug }) {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");

  if (!clientId) return oauthError("invalid_request", "client_id is required.");
  if (!redirectUri) return oauthError("invalid_request", "redirect_uri is required.");

  const client = await controlPlane.getClient(clientId);
  // Unknown client and mismatched redirect are the same refusal, rendered here
  // rather than redirected: both mean we have no proven-safe destination.
  if (!client || !Array.isArray(client.redirectUris)) {
    return oauthError("invalid_client", "Unknown client.", 401);
  }
  const matched = client.redirectUris.some((registered) =>
    redirectUriMatches(registered, redirectUri)
  );
  if (!matched) {
    return oauthError("invalid_request", "redirect_uri does not match a registered value.");
  }

  // From here on the redirect URI is trusted, so errors go back to the client.
  const state = params.get("state");
  const fail = (error, description) =>
    redirectError(redirectUri, state, error, description);

  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only the code response type is supported.");
  }

  const codeChallenge = params.get("code_challenge");
  const method = params.get("code_challenge_method");
  if (!codeChallenge) {
    return fail("invalid_request", "PKCE is required: send code_challenge.");
  }
  // `plain` is rejected outright rather than accepted-and-discouraged. Under
  // `plain` the challenge *is* the verifier, so anyone who saw the
  // authorization request can complete the exchange — which is the entire
  // attack PKCE exists to stop. OAuth 2.1 removes it; this server never
  // advertised it in `code_challenge_methods_supported`, and a client sending
  // it is either ancient or probing.
  if (method !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256.");
  }
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeChallenge)) {
    return fail("invalid_request", "code_challenge is malformed.");
  }

  const resource = params.get("resource");
  if (resource && !resourceMatches(resource, origin, slug)) {
    // RFC 8707 §2: a resource the authorization server cannot issue a token for.
    return fail("invalid_target", "resource does not identify this MCP server.");
  }

  const scope = params.get("scope");
  if (scope) {
    const requested = scope.split(/\s+/).filter(Boolean);
    const unknown = requested.filter((entry) => !SUPPORTED_SCOPES.includes(entry));
    if (unknown.length) return fail("invalid_scope", "Unknown scope requested.");
  }

  let started;
  try {
    started = await controlPlane.startAuthorization({
      clientId,
      redirectUri,
      state: state || null,
      codeChallenge,
      codeChallengeMethod: "S256",
      scope: scope || DEFAULT_REQUESTED_SCOPE,
      resource: resource || null,
      // The path has no slug on it — clients build this URL from the
      // authorization server metadata, which is workspace-free — so the
      // resource indicator is where a named context survives the round trip.
      // It only preselects on the consent screen; the person still chooses.
      requestedWorkspaceSlug: slug || slugFromResource(resource, origin),
    });
  } catch {
    return fail("server_error", "The authorization request could not be started.");
  }

  // The consent screen is where a human authenticates. It must be somewhere the
  // control plane owns and must be https — this is a browser redirect carrying
  // an authorization request, and an http or attacker-supplied destination
  // would be a confused deputy with our name on it.
  let consent;
  try {
    consent = new URL(started.consentUrl);
  } catch {
    return fail("server_error", "The authorization request could not be started.");
  }
  // The https requirement is the check that stops this redirect from becoming a
  // confused deputy, so it is not softened by a hostname baked into the source.
  // It previously exempted `control-plane.test` so the suite could use a plain
  // http double, which left a permanent cleartext carve-out in a production
  // code path — one that widens the moment anything can influence the consent
  // hostname, and that no deployment can turn off. Loopback is allowed instead:
  // it is the same exception `redirectUriIsAcceptable` already makes, it cannot
  // leave the machine, and a test double just binds a port like every other
  // local server.
  if (consent.protocol !== "https:" && !isLoopbackHost(consent.hostname)) {
    return fail("server_error", "The authorization request could not be started.");
  }

  return new Response(null, {
    status: 302,
    headers: { Location: consent.toString(), "Cache-Control": "no-store" },
  });
}

function redirectError(redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}
