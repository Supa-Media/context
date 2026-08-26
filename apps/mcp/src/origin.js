/**
 * `Origin` validation for the Streamable HTTP transport.
 *
 * The MCP specification says a server **MUST** validate the `Origin` header on
 * Streamable HTTP connections. The attack it names is DNS rebinding: a page the
 * victim is already looking at re-points a hostname it controls at an MCP
 * endpoint and issues same-origin-looking requests from inside the victim's
 * browser. Here that is not a local-loopback nuisance — a session on this
 * gateway reads and writes a customer's entire context, so a successful rebind
 * is a full workspace compromise.
 *
 * `Origin` is the right control because a web page cannot forge it: the browser
 * sets it, and script has no way to override it. An attacker with a socket can
 * of course send anything, but an attacker with a socket already has no browser
 * victim to borrow credentials from, and is refused by the access token instead.
 *
 * The requirement is not new and this gateway was not merely lagging it. The
 * sentence "Servers **MUST** validate the `Origin` header on all incoming
 * connections to prevent DNS rebinding attacks" is byte-identical in every
 * revision back to `2024-11-05`, the first one. Only the `403` status was added
 * later (`2025-11-25`, and its own changelog calls that a *clarification*).
 *
 * ## Where the spec stops and local policy starts
 *
 * The MUST-403 is scoped: it fires when the header "is present and invalid".
 * The specification never says what a server should do about a request with no
 * `Origin` at all, and it never defines what makes an origin "invalid" — there
 * is no prescribed allowlist mechanism. So the allowlist below, and the
 * treatment of `null` and of an empty header, are this gateway's policy. They
 * are argued on their merits here rather than justified by a citation that does
 * not exist.
 *
 * ## The three rules that are easy to get backwards
 *
 * 1. **No `Origin` header means "not a browser", not "attack".** Claude
 *    Desktop, Codex CLI, the MCP SDKs and every other non-browser client send
 *    none at all. Rejecting absence would break every real client while
 *    stopping nothing: a browser always sends the header, so absence is exactly
 *    the case the control cannot apply to. This is the detail that turns a
 *    security fix into an outage.
 *
 * 2. **`Origin: null` is present and untrusted, never absent.** A sandboxed
 *    iframe, a `data:` document and some `file://` contexts all serialize to
 *    the opaque origin `null`. Folding it in with "no header" would hand an
 *    attacker a one-line bypass: embed the attack page in
 *    `<iframe sandbox>` and the browser strips the origin for you.
 *
 * 3. **Matching is exact — scheme, host and port.** Not `startsWith`, not
 *    `endsWith`, not "same registrable domain". `https://context.lc.evil.com`
 *    ends with nothing this file will accept, and neither does
 *    `http://context.lc` (scheme downgrade) or `https://context.lc:8443`
 *    (different port). This mirrors `redirectUriMatches` in `oauth.js`, and for
 *    the same reason: every real-world break of a check like this has been a
 *    substring comparison someone thought was equivalent.
 *
 * ## Wildcards
 *
 * There are none, deliberately. An entry like `https://*.context.lc` parses as
 * a URL and normalizes to a host literally named `*.context.lc`, which no
 * browser can ever send — so it is inert rather than dangerous, and a test
 * asserts that. If per-subdomain access is ever needed, list the subdomains.
 * A wildcard matcher is a second parser to get wrong, on the one control that
 * stands between a hostile page and a customer's notes.
 */

/**
 * The serialization of an opaque origin. `new URL("file:///x").origin` returns
 * this *string*, so it has to be refused on both sides of the comparison —
 * otherwise an operator who put `file://` in the allowlist would silently
 * authorize every sandboxed iframe on the internet.
 */
const OPAQUE_ORIGIN = "null";

/** Paths that speak the Streamable HTTP transport and therefore need the check. */
export function isTransportPath(path) {
  // `/inbox` is not MCP, but it is the other authenticated, state-changing,
  // browser-reachable endpoint on this worker. Guarding one and not the other
  // would be an accident of which spec sentence we were reading.
  return path === "/mcp" || path === "/inbox";
}

/**
 * Normalize one origin-shaped string to its canonical serialization, or `null`
 * if it is not one.
 *
 * `new URL(...).origin` does the parts of this that are genuinely
 * case-insensitive per RFC 6454 — it lowercases the scheme and the host,
 * punycodes a unicode host, and drops the default port — while leaving
 * everything that distinguishes one origin from another alone. A trailing dot
 * (`https://context.lc.`) survives, because that really is a different origin.
 */
function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let normalized;
  try {
    normalized = new URL(trimmed).origin;
  } catch {
    return null;
  }
  if (!normalized || normalized === OPAQUE_ORIGIN) return null;
  return normalized;
}

/**
 * Parse the `ALLOWED_ORIGINS` setting: origins separated by commas or
 * whitespace. Anything that is not a parseable, non-opaque origin is dropped
 * rather than throwing — a malformed entry must not take the gateway down, and
 * dropping it fails closed.
 */
export function parseAllowedOrigins(value) {
  if (typeof value !== "string") return [];
  const out = [];
  for (const part of value.split(/[\s,]+/)) {
    const normalized = normalizeOrigin(part);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Every origin a browser may reach the transport from.
 *
 * Computed per request and never cached. It is cheap, and this worker reuses
 * isolates across tenants — a cache keyed even slightly wrong is the whole
 * class of bug the rest of this codebase refuses to open.
 *
 * The gateway's own origin is included when — and only when — the deployment
 * states what that origin is. A page served by this very deployment is
 * same-origin, and refusing it would be surprising without protecting anything.
 * Everything else has to be configured. Unconfigured therefore means
 * "non-browser clients only", which is the right default for a fresh self-host:
 * it breaks nothing anybody is running and authorizes nobody.
 *
 * **The self-origin comes from `PUBLIC_ORIGIN`, never from the request.** That
 * distinction is the whole guard. `publicOrigin()` falls back to
 * `new URL(request.url).origin` — the `Host` the caller claimed — so deriving
 * the allowlist from it made the allowlist a function of attacker input in
 * exactly the case this file exists to stop: a rebinding page sends
 * `Host: attacker.example` *and* `Origin: https://attacker.example`, the
 * allowlist computes to `["https://attacker.example"]`, and the match succeeds.
 * The sentence above ("authorizes nobody") was true of the comment and false of
 * the code.
 *
 * Production sets `PUBLIC_ORIGIN`, so it was never exposed there, and
 * Cloudflare rejects an unrecognised `Host` at the edge. What it did reach was
 * every case CLAUDE.md says must keep working anyway: `wrangler dev`, a
 * self-host whose operator skipped a variable SETUP.md called optional, and any
 * zone with a wildcard worker route, where a dangling subdomain quietly became
 * an allowed origin — undoing "exact match, no wildcards" by the back door.
 */
export function allowedOrigins(env) {
  const configured = parseAllowedOrigins(env?.ALLOWED_ORIGINS);
  const self = normalizeOrigin(
    typeof env?.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN.trim() : ""
  );
  if (self && !configured.includes(self)) configured.push(self);
  return configured;
}

/**
 * Is this request's `Origin` acceptable?
 *
 * Returns `true` for an absent header (rule 1 above) and for an exact allowlist
 * match; `false` for everything else, including `null`, an empty header, an
 * unparseable one, and any origin that is merely similar to an allowed one.
 */
export function originIsAllowed(headerValue, allowed) {
  // Absent: not a browser. `Headers.get` returns null when the header is not
  // present at all, which is the only case that gets a pass.
  if (headerValue === null || headerValue === undefined) return true;

  // Present but empty, or the literal opaque origin. Both are "a browser sent
  // something that names no trustworthy origin", which is a refusal, not an
  // absence. `null` would fail `normalizeOrigin` anyway; it is named here so
  // that a future refactor of the parser cannot quietly reclassify it.
  const trimmed = String(headerValue).trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === OPAQUE_ORIGIN) return false;

  const normalized = normalizeOrigin(trimmed);
  if (!normalized) return false;
  return allowed.includes(normalized);
}

/**
 * The one response a rejected origin ever gets.
 *
 * `403 Forbidden` and the body shape are both specified, narrowly: "If the
 * `Origin` header is present and invalid, servers **MUST** respond with HTTP
 * 403 Forbidden. The HTTP response body **MAY** comprise a JSON-RPC *error
 * response* that has no `id`." So the body is a JSON-RPC error carrying
 * `id: null` — JSON-RPC's own spelling of "this response belongs to no
 * request" — rather than the OAuth-shaped `{error, error_description}` the rest
 * of this worker uses for auth refusals. The code is from `-32000..-32019`,
 * the range the specification leaves to implementations.
 *
 * Constant in every byte, and produced before the token is read, before the
 * workspace slug is resolved, and before the control plane is contacted. A
 * refusal that differed for a real workspace versus an invented one — or for a
 * live token versus a revoked one — would turn the security control into the
 * existence oracle the rest of this gateway is careful not to be.
 *
 * Deliberately carries no `Access-Control-Allow-Origin` (the browser should not
 * be able to read even this) and no `WWW-Authenticate` (this is not an
 * authentication problem, and pointing the caller at the OAuth flow would
 * invite it to retry forever).
 */
export function originRefusalResponse() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "origin not allowed" },
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}

/**
 * The guard itself: `null` when the request may proceed, a `Response` when it
 * may not. Callers must return the response untouched — adding a header derived
 * from the request would reintroduce the variance the constant body avoids.
 */
export function enforceOrigin(request, env) {
  if (originIsAllowed(request.headers.get("Origin"), allowedOrigins(env))) {
    return null;
  }
  return originRefusalResponse();
}
