import { SUPPORTED_SCOPES } from "../session.js";
import { jsonResponse, metadataResponse } from "./responses.js";

/* ------------------------------- identity -------------------------------- */

/**
 * The gateway's own public origin.
 *
 * Taken from `env.PUBLIC_ORIGIN` when set, because a Worker behind a custom
 * domain sees whatever `Host` the request carried, and every URL in a discovery
 * document is security-relevant: a client that is handed an attacker-controlled
 * `authorization_endpoint` will happily send an authorization request there.
 * `Host`-derived is the fallback for local development only.
 */
export function publicOrigin(request, env) {
  const configured = typeof env?.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN.trim() : "";
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/**
 * The canonical resource identifier a token is audience-bound to.
 *
 * MCP requires clients to send RFC 8707 `resource` on both the authorization
 * and the token request, and requires the resource server to reject a token
 * that was not issued for it. The canonical URI for this deployment is the MCP
 * endpoint the client was given — which, with the per-workspace path form, has
 * more than one legitimate spelling for the same server.
 */
export function canonicalResources(origin, slug) {
  const forms = [`${origin}/mcp`, origin];
  if (slug) forms.unshift(`${origin}/@${slug}/mcp`, `${origin}/${slug}/mcp`);
  return forms;
}

/**
 * Does a client-supplied `resource` identify *this* MCP server?
 *
 * The audience question is "is this me", and the answer is the **origin**. Which
 * workspace the URL names is not an audience question — a token's workspace
 * comes from the grant, never from a string the client typed — so any
 * well-formed per-workspace spelling of this server's endpoint is accepted.
 *
 * That generosity is load-bearing rather than lazy. A client handed
 * `https://host/@alpha/mcp` discovers its token endpoint from the authorization
 * server metadata, which is `https://host/oauth/token` with no slug in it. It
 * then sends `resource=https://host/@alpha/mcp` to a request the gateway is
 * serving at a path with no workspace on it. Comparing against only the forms
 * for the *current path's* slug would reject every real client with
 * `invalid_target`, and the flow would fail at the last step with an error that
 * points nowhere.
 *
 * What is still refused is a resource on a different host — a token minted for
 * somebody else's MCP server, which is the confused-deputy attack RFC 8707
 * exists to prevent.
 */
export function resourceMatches(resource, origin, slug) {
  if (!resource) return true; // absence is handled by the caller, not here
  let normalized;
  try {
    const url = new URL(resource);
    url.hash = "";
    normalized = url.toString().replace(/\/+$/, "");
  } catch {
    return false;
  }
  if (canonicalResources(origin, slug).some((form) => form.replace(/\/+$/, "") === normalized)) {
    return true;
  }
  if (!normalized.startsWith(`${origin}/`)) return false;
  return /^\/@?[a-z0-9-]{2,32}\/mcp$/.test(normalized.slice(origin.length));
}

/** The workspace a client's `resource` names, if it names one. */
export function slugFromResource(resource, origin) {
  if (typeof resource !== "string" || !resource.startsWith(`${origin}/`)) return null;
  const match = resource.slice(origin.length).match(/^\/@?([a-z0-9-]{2,32})\/mcp\/?$/);
  return match ? match[1] : null;
}

/**
 * The `WWW-Authenticate` challenge that triggers discovery.
 *
 * This exact header is what makes a modern client go and look for the resource
 * metadata rather than give up. Anthropic is explicit that the `401` status is
 * required — a `WWW-Authenticate` on a `200` is ignored — so every unauthorized
 * response in this worker carries both.
 *
 * The parameter is `resource_metadata`, not `resource_metadata_uri`.
 */
export function challengeHeader(origin, slug, { error, description, scope } = {}) {
  const metadataUrl = protectedResourceMetadataUrl(origin, slug);
  const parts = [];
  if (error) parts.push(`error="${error}"`);
  if (description) {
    // A quote would terminate the parameter early and a CR/LF would split the
    // header outright. Both are neutralised rather than escaped: every
    // description here is written by us, so anything exotic is a bug, not a
    // message worth preserving.
    parts.push(`error_description="${description.replace(/["\r\n]/g, "'")}"`);
  }
  // Incremental scope consent: when the refusal is about a *specific* missing
  // scope, name that scope rather than the whole menu. A client that is told
  // `scope="context:write"` can re-authorize for exactly the increment it
  // needs; one told the full list either asks for everything or gives up. The
  // default stays the full list, because a 401 is "you have no grant at all"
  // and there is no increment to ask for.
  parts.push(`scope="${(scope?.length ? scope : SUPPORTED_SCOPES).join(" ")}"`);
  parts.push(`resource_metadata="${metadataUrl}"`);
  return `Bearer ${parts.join(", ")}`;
}

function protectedResourceMetadataUrl(origin, slug) {
  // RFC 9728 §3: the well-known segment is inserted between host and path, so a
  // resource at `/@seyi/mcp` publishes metadata at
  // `/.well-known/oauth-protected-resource/@seyi/mcp`. Clients probe that form
  // first and the root form second; this worker serves both.
  return slug
    ? `${origin}/.well-known/oauth-protected-resource/@${slug}/mcp`
    : `${origin}/.well-known/oauth-protected-resource/mcp`;
}

/** Build the 401 that starts a discovery flow. */
export function unauthorizedResponse(origin, slug, refusal) {
  return jsonResponse(
    { error: "invalid_token", error_description: refusal?.description || "Unauthorized." },
    401,
    { "WWW-Authenticate": challengeHeader(origin, slug, { error: "invalid_token" }) }
  );
}

/**
 * Build the 403 for a caller who is authenticated but out of scope.
 *
 * `refusal.scope`, when present, names the scopes this particular refusal
 * wanted, so the challenge can drive incremental consent. It must only be set
 * where the refusal genuinely is about scopes: the 403 for workspace selection
 * deliberately says nothing about *which* workspace, and a scope list that
 * varied with the target would start leaking the same fact through a different
 * header.
 */
export function forbiddenResponse(origin, slug, refusal) {
  return jsonResponse(
    {
      error: "insufficient_scope",
      error_description: refusal?.description || "This connection is not permitted to do that.",
    },
    403,
    {
      "WWW-Authenticate": challengeHeader(origin, slug, {
        error: "insufficient_scope",
        description: refusal?.description,
        scope: refusal?.scope,
      }),
    }
  );
}

/* ------------------------------- discovery -------------------------------- */

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(origin, slug) {
  const [resource] = canonicalResources(origin, slug);
  return metadataResponse({
    resource,
    // MCP upgrades this from RFC 9728's OPTIONAL to a MUST, and real clients
    // use only the first entry with no fallback, so there is exactly one.
    authorization_servers: [origin],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Context",
    resource_documentation: "https://github.com/Supa-Media/context",
  });
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(origin, appOrigin) {
  // The app's address, so a CLI that finished signing in on its loopback page
  // can hand the browser to the app's own "connected" screen. An https origin
  // only; anything else is left out rather than sent to a browser.
  let app = null;
  try {
    const url = new URL(appOrigin);
    if (url.protocol === "https:") app = url.origin;
  } catch {
    app = null;
  }
  return metadataResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Public clients (`none`) are the normal case — a desktop AI client cannot
    // keep a secret. `client_secret_post` exists for hosted clients that can.
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // MCP: a client MUST refuse to proceed if this is absent, because its
    // absence means the server does not support PKCE. `plain` is not listed
    // and not accepted.
    code_challenge_methods_supported: ["S256"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: SUPPORTED_SCOPES,
    service_documentation: "https://github.com/Supa-Media/context",
    ...(app ? { context_app_origin: app } : {}),
  });
}
