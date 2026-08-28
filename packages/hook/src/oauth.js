/**
 * The OAuth half of the hook: a native client, a loopback redirect, and PKCE.
 *
 * ## Why the hook authenticates at all, and why not some other way
 *
 * A hook runs when a coding session ends, with no person watching, and posts
 * what it learned to a gateway that will not take an anonymous write. Four ways
 * to give it a credential were on the table:
 *
 *  1. **This one.** Run the ordinary authorization-code flow once at install
 *     time against a loopback redirect, and keep the refresh token. The hook is
 *     then an OAuth client like any other: it appears in the console beside the
 *     AI clients, it is revoked on its own, and it holds exactly the scope the
 *     person approved.
 *  2. A long-lived token minted in the dashboard and pasted into a config file.
 *     Simpler to install, and a bearer secret at rest with no flow behind it —
 *     nothing binds it to a client, so revoking it is all-or-nothing.
 *  3. Reuse the token the AI client already holds. Not viable: the hook cannot
 *     read another application's credential store, and a design that could is
 *     one worth refusing.
 *  4. Token in the URL. Already the compatibility fallback for clients that
 *     cannot set a header, already never the boundary, and there is no reason
 *     to start here.
 *
 * ## The scope is `context:capture`, and that is the point
 *
 * This credential sits in a file on somebody's laptop, unattended, forever. It
 * is therefore asked for the narrowest thing that does the job: capture-only,
 * which the gateway lets write to `0-inbox/` and lets read **nothing**. A
 * stolen hook token cannot enumerate a context, cannot read a note, and cannot
 * tell you whether a note exists. Asking for `context:write` would honour the
 * user's own save destination automatically, and it would also mean a laptop
 * with a stale credential on it is a laptop that can read every private note
 * its owner has ever written. That trade only goes one way.
 *
 * ## Everything here is Node built-ins
 *
 * Same rule as the gateway, for the same reason: this is a thing people
 * `npx`-install on their own machine, so its supply chain is its own source.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/** The one scope a hook asks for. See the header. */
export const HOOK_SCOPE = "context:capture";

/** How long a person gets to finish the browser half before we give up. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** An access token is refreshed this long before it actually expires. */
const REFRESH_SKEW_SECONDS = 60;

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * `plain` is not offered, in either direction. The gateway refuses it, and a
 * client that can fall back to it is a client whose authorization code is worth
 * stealing off the loopback interface.
 */
export function createPkce() {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Compared in constant time because it is the CSRF defence, not a nicety. */
export function stateMatches(expected, presented) {
  if (typeof expected !== "string" || typeof presented !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The authorization server's own metadata, found from the MCP endpoint.
 *
 * RFC 9728 first: the resource tells us which authorization server to trust,
 * rather than us assuming the gateway is its own. Today it is, and hardcoding
 * that would break the first self-hoster who puts a real IdP in front.
 */
export async function discover(endpoint, { fetchImpl = fetch } = {}) {
  const url = new URL(endpoint);
  const resourcePath = url.pathname.replace(/\/+$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-protected-resource${resourcePath}`, url).href,
    new URL("/.well-known/oauth-protected-resource", url).href,
  ];

  let issuer = url.origin;
  let resource = null;
  for (const candidate of candidates) {
    const response = await fetchImpl(candidate).catch(() => null);
    if (!response?.ok) continue;
    const body = await response.json().catch(() => null);
    if (!body) continue;
    resource = typeof body.resource === "string" ? body.resource : null;
    const servers = Array.isArray(body.authorization_servers) ? body.authorization_servers : [];
    if (typeof servers[0] === "string") issuer = servers[0];
    break;
  }

  const metadataUrl = new URL("/.well-known/oauth-authorization-server", issuer).href;
  const response = await fetchImpl(metadataUrl);
  if (!response.ok) {
    throw new Error(`the server at ${issuer} published no OAuth metadata (${response.status})`);
  }
  const metadata = await response.json();
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (typeof metadata[key] !== "string") {
      throw new Error(`OAuth metadata from ${issuer} is missing ${key}`);
    }
  }
  return {
    issuer,
    resource: resource || endpoint,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint || null,
    revocationEndpoint: metadata.revocation_endpoint || null,
  };
}

/**
 * Register this installation as its own OAuth client.
 *
 * Per machine, not per product: two laptops are two clients, so revoking the
 * one you lost does not sign out the one on your desk. The redirect URI is
 * registered without a port — RFC 8252 §7.3, and the gateway's
 * `redirectUriMatches` implements exactly that exception — because the port is
 * whatever the OS hands us at login time and cannot be known now.
 */
export async function registerClient(discovery, { clientName, fetchImpl = fetch } = {}) {
  if (!discovery.registrationEndpoint) {
    throw new Error(
      "this server does not support dynamic client registration, so the hook cannot register itself"
    );
  }
  const response = await fetchImpl(discovery.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [LOOPBACK_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: HOOK_SCOPE,
    }),
  });
  if (!response.ok) {
    throw new Error(`client registration was refused (${response.status})`);
  }
  const body = await response.json();
  if (typeof body.client_id !== "string" || !body.client_id) {
    throw new Error("client registration returned no client_id");
  }
  return { clientId: body.client_id, clientSecret: body.client_secret || null };
}

/** The path half of the redirect, which must match exactly. Only the port floats. */
export const LOOPBACK_PATH = "/context-hook/callback";
export const LOOPBACK_REDIRECT = `http://127.0.0.1${LOOPBACK_PATH}`;

/**
 * Listen on a loopback port for the authorization code.
 *
 * Bound to `127.0.0.1` explicitly rather than to every interface: the whole
 * security story of a loopback redirect is that nothing off this machine can
 * reach the listener, and `createServer().listen(0)` alone binds `::` and hands
 * that away. The server answers exactly one path, closes as soon as it has an
 * answer, and gives up after five minutes rather than sitting on an open port
 * for the rest of the session.
 */
export async function listenForCode({ timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  let settle;
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const timer = setTimeout(() => {
    settle.reject(new Error("timed out waiting for the browser to come back"));
    server.close();
  }, timeoutMs);
  timer.unref?.();

  server.on("request", (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== LOOPBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    // A referrer policy because this page's URL carries the authorization code,
    // and a page that later links anywhere would send it along.
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Context</title>` +
        `<body style="font:15px system-ui;padding:3rem;max-width:32rem">` +
        (error
          ? `<h1>Not connected</h1><p>The authorization was refused (${escapeHtml(error)}).</p>`
          : `<h1>Connected</h1><p>You can close this tab — the hook is set up.</p>`) +
        `</body>`
    );

    clearTimeout(timer);
    server.close();
    if (error) settle.reject(new Error(`authorization failed: ${error}`));
    else
      settle.resolve({
        code: url.searchParams.get("code") || "",
        state: url.searchParams.get("state") || "",
      });
  });

  return {
    redirectUri: `http://127.0.0.1:${port}${LOOPBACK_PATH}`,
    port,
    waitForCode: () => result,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

export function authorizeUrl(discovery, { clientId, redirectUri, challenge, state, scope }) {
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scope || HOOK_SCOPE);
  // RFC 8707: name the resource this token is for, so a token minted for one
  // gateway is not accepted by another.
  if (discovery.resource) url.searchParams.set("resource", discovery.resource);
  return url.href;
}

async function postToken(discovery, params, fetchImpl) {
  const response = await fetchImpl(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    // The server's own error text is written for a developer reading a log, and
    // this one is read by somebody in a terminal. Relay the code, not the prose.
    throw new Error(`the token request was refused (${body?.error || response.status})`);
  }
  return {
    accessToken: body.access_token,
    // Rotation is assumed, not hoped for: keep whichever refresh token came
    // back, and fall back to the one we sent only when none did.
    refreshToken: body.refresh_token || null,
    expiresAt: Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - REFRESH_SKEW_SECONDS) * 1000,
    scope: body.scope || "",
  };
}

export function exchangeCode(discovery, { clientId, code, verifier, redirectUri }, { fetchImpl = fetch } = {}) {
  return postToken(
    discovery,
    {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    },
    fetchImpl
  );
}

export function refreshTokens(discovery, { clientId, refreshToken }, { fetchImpl = fetch } = {}) {
  return postToken(
    discovery,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    },
    fetchImpl
  );
}

export { REFRESH_SKEW_SECONDS };
