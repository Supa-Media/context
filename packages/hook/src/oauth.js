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

/**
 * The scopes a hook asks for, and the choice between them.
 *
 * **Capture** is the default and the one to prefer: it writes to `0-inbox/` and
 * reads nothing at all — no search, no listing, no existence oracle.
 *
 * **Orienting** is opt-in, and it is a real widening rather than a setting. A
 * session-start hook can put the person's actual context in front of the model
 * before it answers anything, which is the strongest fix there is for an agent
 * that never reaches for `orient` — but reading requires read access, and this
 * credential sits unattended on a laptop. `--orient` at install time is where
 * that trade is made, out loud, by the person whose notes they are.
 *
 * `context:private` is never requested by either. A hook that could read every
 * note its owner marked private is past what any convenience is worth, and the
 * consequence is honest rather than hidden: on a mostly-private context the
 * injected orientation is thin, and it says so rather than implying the context
 * is empty.
 */
export const HOOK_SCOPE = "context:capture";
export const ORIENT_SCOPE = "context:read context:capture";

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
/**
 * A URL this hook is willing to send a credential to.
 *
 * `discover` walks strings off the wire — the resource names an authorization
 * server, that server's metadata names where the code and the token go — and
 * the credential at the end of the walk is the one that sits unattended on a
 * laptop indefinitely. Nothing else in this package checked the scheme, so a
 * gateway that answered with `http://` sent the authorization code and the
 * PKCE verifier across the network in the clear.
 *
 * Loopback is carved out rather than forgotten: RFC 8252 §7.3 permits it for
 * exactly this flow, a self-hoster's first run is `http://127.0.0.1`, and the
 * traffic never leaves the machine. The carve-out is by resolved HOST, not by
 * substring — `http://127.0.0.1.evil.example` is a routable host that merely
 * contains the digits.
 *
 * Testing `url.hostname` rather than the raw string is also what makes the
 * odd-but-legitimate spellings work: `127.1`, `0x7f.0.0.1`, `0177.0.0.1` and
 * `2130706433` all normalise to `127.0.0.1`, and `[0:0:0:0:0:0:0:1]` to
 * `[::1]`. A later "simplification" to string matching would refuse every one
 * of them.
 *
 * The Set is the two literals RFC 8252 §7.3 names, plus `localhost`. What that
 * deliberately excludes: the rest of `127.0.0.0/8`, the IPv4-mapped
 * `[::ffff:127.0.0.1]`, the trailing-dot `localhost.`, and `0.0.0.0` — which
 * is the unspecified address rather than a loopback one. Widening a security
 * carve-out to cover a spelling nobody has hit is the wrong direction.
 * `localhost` is the one entry that is a name rather than a literal, and
 * §8.3 cautions that its resolution is not guaranteed to stay on the machine.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function credentialUrlOk(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
}

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
    // Refused here rather than trusted and checked later: this value decides
    // where the browser is sent and where the token is asked for.
    if (typeof servers[0] === "string") {
      if (!credentialUrlOk(servers[0])) {
        throw new Error(
          `the resource named an authorization server this hook will not use: ${servers[0]}`
        );
      }
      issuer = servers[0];
    }
    break;
  }

  const metadataUrl = new URL("/.well-known/oauth-authorization-server", issuer).href;
  const response = await fetchImpl(metadataUrl);
  if (!response.ok) {
    throw new Error(`the server at ${issuer} published no OAuth metadata (${response.status})`);
  }
  const metadata = await response.json();
  // Presence AND type, and the type half is load-bearing for the same reason
  // as the normalisation below: the scheme loop skips a non-string, so without
  // this refusal a `token_endpoint` of `["http://evil.example/oauth/token"]`
  // reaches `fetch`, which stringifies it back into that URL and POSTs the
  // authorization code and the PKCE verifier there in the clear. This is the
  // only thing standing between that array and the credential path.
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (typeof metadata[key] !== "string") {
      throw new Error(`OAuth metadata from ${issuer} is missing ${key}`);
    }
  }
  // Every endpoint in the document, not a list of the two that felt important.
  // Checked separately from the issuer because an https authorization server
  // is free to name an http endpoint, and these are where the browser is sent
  // and where the code and verifier are POSTed.
  //
  // Enumerated from the object rather than hand-picked, because a hand-picked
  // list is a membership somebody has to remember to extend and a test has to
  // prove. `registration_endpoint` was already outside a two-key list while
  // being part of the same walk, and `revocation_endpoint` is returned by this
  // function and used by nothing — a loaded gun that would POST a live token
  // wherever the metadata said, the moment anybody wires it up.
  //
  // COLLECTED rather than merely checked, so that everything read out below is
  // a validated string by construction. Checking here and then reaching back
  // into `metadata` for the values puts the type guard in two places, which is
  // the hand-picked membership this loop exists to remove, relocated — and
  // forgetting it on a fifth endpoint reopens the bypass while this loop still
  // looks total.
  const endpoints = new Map();
  for (const [key, value] of Object.entries(metadata)) {
    // Skipped rather than refused: this walks a document we do not own, and an
    // IdP publishing `null` for a feature it does not support is an ordinary
    // shape. Hard-failing on a key the hook never reads would break a
    // self-hosted IdP to no benefit — the same trade as reading an absent
    // `origin` as uninformative rather than inventing a meaning for it.
    if (!key.endsWith("_endpoint") || typeof value !== "string") continue;
    if (!credentialUrlOk(value)) {
      throw new Error(`OAuth metadata from ${issuer} names an insecure ${key}`);
    }
    endpoints.set(key, value);
  }
  return {
    issuer,
    resource: resource || endpoint,
    authorizationEndpoint: endpoints.get("authorization_endpoint"),
    tokenEndpoint: endpoints.get("token_endpoint"),
    // Read from the map, never from `metadata`. A non-string never entered it,
    // so `|| null` cannot let an array through here the way it once did —
    // `["http://evil.example/x"]` is truthy, survives `||`, and `fetch`
    // stringifies it back into exactly that URL.
    registrationEndpoint: endpoints.get("registration_endpoint") ?? null,
    revocationEndpoint: endpoints.get("revocation_endpoint") ?? null,
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
export async function registerClient(
  discovery,
  { clientName, scope = HOOK_SCOPE, fetchImpl = fetch } = {}
) {
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
      // The scope this client is ABOUT to ask for, not the narrowest one it
      // could. `install` refuses to reuse a client registered for a different
      // scope, on the grounds that doing so "would ask for something it never
      // declared" — and the re-registration it does instead used to declare
      // `context:capture` regardless, so an `--orient` install did exactly
      // that. The default stays narrow: a caller that names nothing gets
      // capture, never the whole menu.
      scope,
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
