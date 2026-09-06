/**
 * OAuth 2.1 for MCP — the discovery and authorization surface that makes
 * "paste this URL into ChatGPT" work.
 *
 * Verified against the MCP authorization specification (revision `2026-07-28`;
 * the `draft` text is byte-identical apart from version links), RFC 9728, RFC
 * 8414, RFC 7591, RFC 8707, RFC 8252 and RFC 7009, plus Anthropic's published
 * connector-authentication requirements. Where the spec and a real client
 * disagree, the comment says so.
 *
 * ## Why this exists at all
 *
 * The catch-all used to answer `/.well-known/oauth-protected-resource` with
 * `200 "context"`. A modern MCP client asks that URL first, gets a body that is
 * not metadata, and concludes there is no authorization server — so it never
 * starts a flow, and the only way in was a token pasted into a URL. Discovery
 * is not a nicety here; it is the difference between a connectable server and
 * an unconnectable one.
 *
 * ## The shape of the flow
 *
 * The gateway is the authorization server *and* the resource server, but it is
 * deliberately not the identity provider. `/oauth/authorize` validates the
 * request and then hands the browser to the control plane's own app, which is
 * where the person signs in and picks a workspace. This worker never sees a
 * password, never sees a user session cookie, and never decides who anyone is.
 * It sees an authorization code afterwards and nothing before.
 *
 * ## What is deliberately not here
 *
 *  - **No token introspection endpoint.** Nothing external needs it.
 *  - **No client_credentials.** Every connection is somebody's consent; a
 *    machine grant with no human behind it has no workspace to resolve to.
 *    (Claude does not support it either.)
 *  - **No `plain` PKCE.** See `verifyPkce`.
 */

import { ControlPlaneError, isLoopbackHost, sha256Hex } from "./controlPlane.js";
import { SUPPORTED_SCOPES } from "./session.js";

/** Access tokens are short-lived; the refresh token is the durable half. */
const ACCESS_TOKEN_TTL_SECONDS = 3600;

/**
 * What a client gets when it sends no `scope` at all.
 *
 * Deliberately not `SUPPORTED_SCOPES`. A client that names nothing is asking
 * for the ordinary thing, and `context:private` is never the ordinary thing —
 * it is the one scope a person is asked about separately, and defaulting it on
 * would hand every silent client the whole context including notes its owner
 * marked private. The consent screen still shows the tier as an explicit
 * choice; this only decides what the *request* said.
 */
const DEFAULT_REQUESTED_SCOPE = "context:read context:write";

/** RFC 7591 caps nothing; this worker does. A registration is a few hundred bytes. */
const REGISTRATION_BYTE_CAP = 32_000;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 120;

/* ------------------------------ small helpers ----------------------------- */

function randomToken(bytes = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

/**
 * Discovery documents are public, identical for every caller, and change only
 * on deploy — the one thing here worth letting a client cache.
 */
function metadataResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error body. Always 400 unless stated. */
/**
 * The network a registration came from, as the limiter should count it.
 *
 * **A key a stranger can rotate is a write amplification on a table nothing
 * sweeps**, which this repository has already argued once, at the ingestion
 * limiter: *"anyone able to send mail can mint an unbounded number of rows by
 * addressing a million invented names"*. An IPv6 host is routinely given a
 * whole `/64` — standard on a cheap VPS and on residential broadband — so
 * keying on the address would hand one customer 2^64 free buckets, and each
 * distinct bucket is its own permanent `rateLimits` row. Measured before this
 * function existed: 100 registrations from a rotating address produced 100
 * client rows **and** 100 limiter rows, where an unlimited endpoint produced
 * 100. The limit made the growth worse.
 *
 * So an IPv6 address counts as its /64 and an IPv4 address counts as itself.
 * That collapses the cheap keyspace to one bucket per network. It does not
 * make the keyspace *bounded* — somebody holding many networks still holds
 * many buckets — which is why the sweep in `crons.ts` is the other half of
 * this and not an optimisation.
 *
 * Normalising also fixes three ways of writing one host that were three
 * buckets: `2001:db8::1`, its expanded form, and its upper-case form; and
 * `::ffff:203.0.113.7` against `203.0.113.7`.
 *
 * Returns `null` for anything it cannot parse, which the caller treats exactly
 * as a missing header — shared, never unlimited.
 */
export function registrantNetwork(rawAddress) {
  const address = String(rawAddress ?? "").trim().toLowerCase();
  if (address === "") return null;

  // `[2001:db8::1]:443` and `203.0.113.7:443`. A header should not carry a
  // port, and one that does must not be a second bucket for the same host.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  const bare = bracketed ? bracketed[1] : address.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");

  if (!bare.includes(":")) return /^\d+\.\d+\.\d+\.\d+$/.test(bare) ? bare : null;

  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const [head, tail] = halves;
  const left = head === "" ? [] : head.split(":");
  const right = halves.length === 2 ? (tail === "" ? [] : tail.split(":")) : [];
  const parts = halves.length === 2 ? [...left, ...right] : left;

  // An IPv4-mapped address ends in dotted-quad form. Its /64 is meaningless —
  // it names one IPv4 host — so it counts as that host, which is also what
  // makes `::ffff:203.0.113.7` and `203.0.113.7` one bucket rather than two.
  const last = parts[parts.length - 1];
  if (last !== undefined && last.includes(".")) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(last) ? last : null;
  }

  const filled =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (filled.length !== 8 || filled.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  return `${filled.slice(0, 4).map((part) => parseInt(part, 16).toString(16)).join(":")}::/64`;
}

/**
 * A stable, non-identifying bucket name for whoever is registering.
 *
 * `undefined` when Cloudflare did not set a header this can read, which the
 * control plane treats as "share the unattributed bucket" rather than as "no
 * limit" — see the comment at the call site for why that direction is the only
 * safe one.
 */
async function registrantKey(request) {
  const network = registrantNetwork(request.headers.get("CF-Connecting-IP"));
  if (network === null) return undefined;
  return (await sha256Hex(network)).slice(0, 32);
}

function oauthError(error, description, status = 400, extraHeaders = {}) {
  return jsonResponse({ error, error_description: description }, status, extraHeaders);
}

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
export function authorizationServerMetadata(origin) {
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
  });
}

/* --------------------------- client registration -------------------------- */

/**
 * Redirect URI validation — exact string match, with one narrow exception.
 *
 * Exact means exact. Not `startsWith`, not "same origin", not "the registered
 * one is a prefix of the presented one". Every one of those is an open redirect
 * that hands an authorization code to whoever controls the rest of the URL, and
 * a prefix check in particular is defeated by `https://evil.test/cb.attacker`
 * against a registered `https://evil.test/cb`.
 *
 * The exception is RFC 8252 §7.3 loopback redirects. A native client binds an
 * ephemeral port it cannot know at registration time, so `http://127.0.0.1/cb`
 * registered must match `http://127.0.0.1:51763/cb` presented — **the port and
 * only the port is ignored, and only for `127.0.0.1`, `[::1]`, and
 * `localhost`.** Everything else about the URL, including the path, still has
 * to be identical. Claude Code depends on this; without it, CLI clients cannot
 * connect at all.
 */
export function redirectUriMatches(registered, presented) {
  if (typeof registered !== "string" || typeof presented !== "string") return false;
  if (registered === presented) return true;
  let a;
  let b;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
  if (!loopbackHosts.has(a.hostname) || a.hostname !== b.hostname) return false;
  if (a.protocol !== b.protocol) return false;
  // Everything except the port must still match exactly.
  return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
}

/** A redirect URI we are willing to store at all. */
function redirectUriIsAcceptable(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false; // a fragment cannot survive a redirect meaningfully
  if (url.protocol === "https:") return true;
  // MCP: redirect URIs MUST be https or loopback. `http://localhost` is the
  // native-client case; plain http anywhere else would put an authorization
  // code on the wire in cleartext.
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  // A custom scheme (`myapp://callback`) is legal for native clients under RFC
  // 8252 but is not something this deployment has a client for, and accepting
  // arbitrary schemes widens the redirect surface for no current benefit.
  return false;
}

/**
 * RFC 7591 dynamic client registration.
 *
 * The current MCP spec marks DCR as MAY and deprecated in favour of client ID
 * metadata documents, but every shipping client still falls back to it when the
 * authorization server does not advertise CIMD — and this one does not — so it
 * is the path that actually gets used.
 */
export async function handleRegister(request, env, controlPlane) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return oauthError("invalid_client_metadata", "Registration must be JSON.");
  }
  const raw = await request.text();
  if (raw.length > REGISTRATION_BYTE_CAP) {
    return oauthError("invalid_client_metadata", "Registration payload is too large.");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return oauthError("invalid_client_metadata", "Registration must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return oauthError("invalid_client_metadata", "Registration must be a JSON object.");
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return oauthError("invalid_redirect_uri", "At least one redirect_uri is required.");
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return oauthError("invalid_redirect_uri", "Too many redirect URIs.");
  }
  if (!redirectUris.every(redirectUriIsAcceptable)) {
    return oauthError(
      "invalid_redirect_uri",
      "Redirect URIs must be https, or http on a loopback address, with no fragment."
    );
  }

  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
  const unsupported = grantTypes.filter(
    (type) => type !== "authorization_code" && type !== "refresh_token"
  );
  if (unsupported.length) {
    return oauthError(
      "invalid_client_metadata",
      "Only authorization_code and refresh_token are supported."
    );
  }
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : ["code"];
  if (responseTypes.some((type) => type !== "code")) {
    return oauthError("invalid_client_metadata", "Only the code response type is supported.");
  }

  const authMethod = body.token_endpoint_auth_method || "client_secret_basic";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
    return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  }
  // `client_secret_basic` is RFC 7591's default when the field is omitted, and
  // it is normalised to `client_secret_post` rather than supported separately:
  // one credential-presentation path is one path to get wrong.
  const normalizedAuthMethod = authMethod === "none" ? "none" : "client_secret_post";

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, MAX_CLIENT_NAME_LENGTH)
      : "Unnamed MCP client";

  const clientId = `mcp_${randomToken(18)}`;
  const clientSecret = normalizedAuthMethod === "none" ? null : `mcs_${randomToken(32)}`;

  try {
    await controlPlane.registerClient({
    clientId,
    clientName,
    redirectUris,
    // The secret is hashed before it leaves this process, exactly like an
    // access token. The plaintext exists in this response and in the client,
    // and nowhere else — we structurally cannot re-send it later.
    hashedClientSecret: clientSecret ? await sha256Hex(clientSecret) : null,
    tokenEndpointAuthMethod: normalizedAuthMethod,
    grantTypes: grantTypes.includes("refresh_token")
      ? grantTypes
      : [...grantTypes, "refresh_token"],
    responseTypes,
    scope: typeof body.scope === "string" ? body.scope : SUPPORTED_SCOPES.join(" "),
    applicationType: body.application_type === "native" ? "native" : "web",
    /*
      WHAT THE REGISTRATION RATE LIMIT IS KEYED ON.

      Registration is the only unauthenticated write in the control plane —
      RFC 7591 requires that — and every call mints a permanent row that
      nothing sweeps. A limit keyed on nothing would be one bucket for the
      whole internet, so a flood would switch registration off for everybody
      rather than cost its own source; a limit keyed on this costs the source.

      `CF-Connecting-IP` is set by Cloudflare on the way in and overwrites
      anything the client sent, so it is not forgeable here — unlike
      `X-Forwarded-For`, which is why that one is not read.

      **Hashed, so the control plane never stores an address.** The limiter
      only needs a stable bucket name, and an IP in a table is personal data
      this product has no reason to hold. Truncated because a bucket does not
      need 256 bits and a shorter key is a smaller row.

      Absent — a self-hosted gateway behind something that does not set it —
      sends nothing, and the control plane shares one bucket among those. That
      fails toward "throttled together" rather than "unlimited", which is the
      direction an optional field has to fail in.
    */
    registrantKey: await registrantKey(request),
    });
  } catch (error) {
    /*
      A refusal because they went too fast is not this server being broken.
      The `/oauth/` catch upstairs answers every control-plane failure with
      503 `server_error`, which is right for a bucket that is down and wrong
      for a limit: a client cannot tell "retry in an hour" from "retry now",
      and 503 invites the second. Answered here, before that catch sees it.
    */
    if (error instanceof ControlPlaneError && error.status === 429) {
      return oauthError(
        "temporarily_unavailable",
        "too many client registrations from here; retry later",
        429,
        { "Retry-After": "3600" }
      );
    }
    throw error;
  }

  const registered = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: normalizedAuthMethod,
    scope: SUPPORTED_SCOPES.join(" "),
  };
  if (clientSecret) {
    registered.client_secret = clientSecret;
    // 0 means "does not expire" (RFC 7591 §3.2.1).
    registered.client_secret_expires_at = 0;
  }
  return jsonResponse(registered, 201);
}

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

/* --------------------------------- token ---------------------------------- */

/**
 * Verify a PKCE code verifier against the stored S256 challenge.
 *
 * Constant-time comparison of the two base64url digests. The comparison is on
 * hashes of equal length, so the early length exit leaks nothing.
 */
async function verifyPkce(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== "string") return false;
  // RFC 7636 §4.1 — 43 to 128 characters from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const computed = base64Url(new Uint8Array(digest));
  if (computed.length !== codeChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) {
    diff |= computed.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Read a token-endpoint request body.
 *
 * `application/x-www-form-urlencoded` is mandatory per RFC 6749 §4.1.3, and
 * Anthropic calls out that a JSON-only token endpoint returns 415 and breaks
 * the flow outright. Note the asymmetry with `/oauth/register`, which is JSON:
 * two endpoints, two parsers, on purpose.
 */
async function readForm(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return null;
  const raw = await request.text();
  if (raw.length > REGISTRATION_BYTE_CAP) return null;
  return new URLSearchParams(raw);
}

/**
 * Authenticate the client presenting a token request.
 *
 * Public clients (`token_endpoint_auth_method: "none"`) present only their
 * `client_id`; PKCE, not a secret, is what binds the exchange to them.
 * Confidential clients must present the secret they were issued, compared as a
 * hash so the stored value is never a working credential.
 */
async function authenticateClient(client, params, request) {
  if (client.tokenEndpointAuthMethod === "none" || client.hashedClientSecret === null) {
    return true;
  }
  let presented = params.get("client_secret");
  if (!presented) {
    // RFC 6749 §2.3.1 also allows HTTP Basic. Accepted because some clients
    // send it despite registering `client_secret_post`.
    const header = request.headers.get("Authorization") || "";
    if (/^Basic /i.test(header)) {
      try {
        const decoded = atob(header.slice(6).trim());
        presented = decoded.slice(decoded.indexOf(":") + 1);
      } catch {
        presented = null;
      }
    }
  }
  if (!presented) return false;
  const hashed = await sha256Hex(presented);
  if (hashed.length !== client.hashedClientSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < hashed.length; i += 1) {
    diff |= hashed.charCodeAt(i) ^ client.hashedClientSecret.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleToken(request, env, controlPlane, { origin, slug }) {
  const params = await readForm(request);
  if (!params) {
    return oauthError(
      "invalid_request",
      "The token endpoint requires application/x-www-form-urlencoded."
    );
  }

  const clientId = params.get("client_id");
  if (!clientId) return oauthError("invalid_client", "client_id is required.", 401);
  const client = await controlPlane.getClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);
  if (!(await authenticateClient(client, params, request))) {
    return oauthError("invalid_client", "Client authentication failed.", 401);
  }

  const resource = params.get("resource");
  if (resource && !resourceMatches(resource, origin, slug)) {
    return oauthError("invalid_target", "resource does not identify this MCP server.");
  }

  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") {
    return exchangeCode(params, client, controlPlane);
  }
  if (grantType === "refresh_token") {
    return refresh(params, client, controlPlane);
  }
  return oauthError("unsupported_grant_type", "Unsupported grant_type.");
}

async function exchangeCode(params, client, controlPlane) {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");
  if (!code) return oauthError("invalid_request", "code is required.");
  if (!redirectUri) return oauthError("invalid_request", "redirect_uri is required.");
  if (!codeVerifier) return oauthError("invalid_request", "code_verifier is required.");

  // Spent first, checked second. A code that fails any check below is already
  // dead, which is what RFC 6749 §4.1.2 asks for: a code presented wrongly is a
  // code that may have leaked, and a retryable one is a code an attacker gets
  // to keep guessing against. `consumeAuthorizationCode` is atomic, so a replay
  // — even a concurrent one — gets `null` here and cannot be distinguished from
  // a code that never existed.
  const authorization = await controlPlane.consumeAuthorizationCode(code, client.clientId);
  if (!authorization) return oauthError("invalid_grant", "The authorization code is invalid.");

  if (authorization.clientId !== client.clientId) {
    return oauthError("invalid_grant", "The authorization code is invalid.");
  }
  // Exact match against the value stored at authorization time, not against the
  // client's registered list: RFC 6749 §4.1.3 binds the code to the specific
  // URI the flow started with, so a client with two registered URIs cannot
  // complete a flow started at one by presenting the other.
  if (authorization.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (authorization.codeChallengeMethod !== "S256") {
    return oauthError("invalid_grant", "The authorization code is invalid.");
  }
  if (!(await verifyPkce(codeVerifier, authorization.codeChallenge))) {
    return oauthError("invalid_grant", "The code_verifier does not match the code_challenge.");
  }

  // `authorization.scope` is what the *person approved*, not what the client
  // asked for — the control plane narrowed it at consent time and clamped it to
  // what the approver's role could hand over. Filtering against
  // `SUPPORTED_SCOPES` here drops anything this gateway would not honour
  // anyway; it is a sanity pass, not the narrowing.
  const scopes = (authorization.scope || DEFAULT_REQUESTED_SCOPE)
    .split(/\s+/)
    .filter((entry) => SUPPORTED_SCOPES.includes(entry));
  if (!scopes.length) return oauthError("invalid_scope", "No usable scope was granted.");

  const accessToken = `cat_${randomToken(32)}`;
  const refreshToken = `crt_${randomToken(32)}`;
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;

  await controlPlane.createGrant({
    workspaceId: authorization.workspaceId,
    userId: authorization.userId,
    clientId: client.clientId,
    scopes,
    hashedRefreshToken: await sha256Hex(refreshToken),
    hashedAccessToken: await sha256Hex(accessToken),
    accessTokenExpiresAt: expiresAt,
  });

  return tokenResponse(accessToken, refreshToken, scopes);
}

async function refresh(params, client, controlPlane) {
  const presented = params.get("refresh_token");
  if (!presented) return oauthError("invalid_request", "refresh_token is required.");

  const accessToken = `cat_${randomToken(32)}`;
  const refreshToken = `crt_${randomToken(32)}`;
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;

  const requestedScope = params.get("scope");
  const narrowed = requestedScope
    ? requestedScope.split(/\s+/).filter((entry) => SUPPORTED_SCOPES.includes(entry))
    : null;

  // Rotation is mandatory for public clients under OAuth 2.1 §4.3.1, so the old
  // refresh token dies in the same transaction that mints the new one. The
  // control plane detects reuse of an already-rotated token and revokes the
  // whole grant — a replayed refresh token means it leaked, and leaving the
  // grant alive leaves the thief alive with it.
  const grant = await controlPlane.rotateGrant({
    // Verbatim, so the stored hash is not itself a working credential; the
    // *new* pair goes over as hashes, because only the client needs the
    // plaintext. See the rule in controlPlane.js.
    refreshToken: presented,
    clientId: client.clientId,
    newHashedRefreshToken: await sha256Hex(refreshToken),
    newHashedAccessToken: await sha256Hex(accessToken),
    accessTokenExpiresAt: expiresAt,
    scopes: narrowed && narrowed.length ? narrowed : null,
  });

  // `invalid_grant` specifically. Anthropic's client treats anything else —
  // `invalid_request`, a custom code — as a hard failure rather than a signal
  // to re-authorize, and the connection silently stops refreshing.
  if (!grant) return oauthError("invalid_grant", "The refresh token is invalid or revoked.");

  return tokenResponse(accessToken, refreshToken, grant.scopes || []);
}

function tokenResponse(accessToken, refreshToken, scopes) {
  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
}

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
    const tokenType = hint === "access_token" ? "access" : "refresh";
    try {
      await controlPlane.revokeGrant(token, tokenType, client.clientId);
    } catch {
      // Swallowed deliberately: a failure here must not tell the caller whether
      // the token existed. The control plane logs it.
    }
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
