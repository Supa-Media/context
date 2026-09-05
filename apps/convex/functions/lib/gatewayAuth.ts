/**
 * The gateway's door: authenticating the MCP gateway, and the small pile of
 * request/response plumbing every one of its routes shares.
 *
 * `apps/mcp/src/controlPlane.js` is the normative contract for what goes over
 * this wire. Everything here exists to make one side of it hard to get wrong.
 *
 * ## The gateway secret proves one thing, and only one thing
 *
 * `Authorization: Bearer ${GATEWAY_SECRET}` proves *this caller is the
 * gateway*. It proves nothing about which person is asking, which workspace
 * they may reach, or whether their grant is still live — and it must never
 * become sufficient for any of those. A leaked gateway secret on its own has
 * to yield nothing: no credential, no enumeration, no customer list. That
 * property is enforced route by route in `http.ts`; this file only supplies
 * the first proof.
 *
 * ## The secret never leaves this module
 *
 * It is read from the environment, compared, and dropped. It is never logged,
 * never echoed into a response body, never written into an audit row, and
 * never placed in an error. An error string is the easiest place in a system
 * for a secret to escape, so the comparison here returns a boolean and the
 * caller has nothing to say about *why* it failed.
 *
 * ## Comparison is constant-time, and length-blind
 *
 * Both sides are hashed first and the fixed-width digests are compared with a
 * branch-free XOR accumulation. Hashing is not for storage — the secret is a
 * shared value both parties hold in the clear — it is what removes the length
 * side channel: comparing the raw strings would let a caller learn the
 * secret's length from a timing difference before it learned anything else.
 */

import { hashToken, TOKEN_HASH_PATTERN } from "./crypto";

/** The shared secret the gateway presents. Held by exactly two parties. */
export const GATEWAY_SECRET_ENV_VAR = "GATEWAY_SECRET";

/**
 * The shared secret the **email worker** presents. A different secret, held by
 * a different pair of parties.
 *
 * Not `GATEWAY_SECRET`, deliberately, and this is the whole reason there are two
 * of these constants. The two callers have different powers: the gateway's
 * secret opens nothing without an end user's access token, while the email
 * worker's — for the reasons `infra/email-worker/src/controlPlane.ts` sets out
 * at length — can reach one person's storage credential with no human in the
 * loop. Sharing one secret would mean a compromised email worker is a
 * compromised MCP gateway and vice versa; keeping them separate makes each
 * blast radius nameable.
 *
 * A deployment that sets only one of them serves only that caller. Neither
 * falls back to the other, and an unset secret authenticates nobody.
 */
export const EMAIL_WORKER_SECRET_ENV_VAR = "EMAIL_WORKER_SECRET";

/**
 * Origin of the app that hosts the consent screen — where a *human* signs in
 * and approves an authorization request.
 *
 * The gateway never sees that session, never sees a password, and never
 * decides who someone is. It only follows the `consentUrl` we build from this,
 * and it re-checks that the URL is https and on an origin we own before
 * redirecting a browser to it.
 */
export const APP_ORIGIN_ENV_VAR = "APP_ORIGIN";

/**
 * The most JSON a gateway request may carry.
 *
 * Every documented payload is a few hundred bytes. Small on purpose, and for
 * the same reason the gateway caps *our* responses: a trusted peer having a
 * bad day is still a way to exhaust the runtime.
 */
const MAX_REQUEST_BYTES = 64_000;

/**
 * How long a parked authorization request, and then the code it becomes,
 * stays alive.
 *
 * RFC 6749 §4.1.2 asks for a code that expires "shortly after" issuance and
 * recommends a maximum of ten minutes. The parked request gets the same
 * window: a consent screen nobody answered within ten minutes is a request the
 * person walked away from, and it should not be answerable an hour later from
 * a browser tab someone else opened.
 */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/**
 * An opaque, high-entropy identifier.
 *
 * Used for request ids and authorization codes — values whose only defence is
 * that they cannot be guessed, because possession of one is the whole
 * capability. `crypto.getRandomValues` rather than `Math.random`: the latter is
 * seeded per transaction and is not a CSPRNG.
 */
export function randomOpaqueToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * Length is compared first only because the inputs are always digests of the
 * same width; a mismatch here means a caller passed something that is not a
 * digest, which is a programming error rather than an oracle.
 */
function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Is this request carrying the secret named by `envVarName`?
 *
 * Returns a boolean and nothing else. No reason, no partial credit, no
 * distinction between "no header", "wrong scheme", and "wrong secret" — the
 * caller could not act on the difference and an attacker could.
 *
 * A deployment with that variable unset authenticates nobody. It does not fall
 * back to "allow", it does not fall back to the *other* secret, and it does not
 * treat an empty presented secret as matching an empty configured one.
 *
 * The env-var name is a parameter so that two callers with different powers can
 * share one comparison rather than growing a second, subtly different one. It is
 * private on purpose: the exported wrappers below are the only two doors, and a
 * route cannot invent a third by passing a string.
 */
async function requestCarriesSecret(
  request: Request,
  envVarName: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const configured = env[envVarName];
  if (typeof configured !== "string" || configured.length === 0) return false;

  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  if (presented.length === 0) return false;

  const [presentedDigest, configuredDigest] = await Promise.all([
    hashToken(presented),
    hashToken(configured),
  ]);
  return constantTimeEqualsHex(presentedDigest, configuredDigest);
}

/** Is this request carrying the MCP gateway's secret? */
export async function requestIsFromGateway(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return await requestCarriesSecret(request, GATEWAY_SECRET_ENV_VAR, env);
}

/**
 * Is this request carrying the email worker's secret?
 *
 * The gateway's secret does **not** satisfy this, and this one does not satisfy
 * the gateway's. Two doors, two keys — see `EMAIL_WORKER_SECRET_ENV_VAR`.
 */
export async function requestIsFromEmailWorker(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return await requestCarriesSecret(request, EMAIL_WORKER_SECRET_ENV_VAR, env);
}

/**
 * Where the browser goes to have a human approve an authorization request.
 *
 * Throws rather than guessing at a default. A guessed consent origin is a
 * confused deputy with our name on it: the gateway 302s a real person's
 * browser there carrying a real authorization request.
 */
export function consentUrlFor(
  requestId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const origin = env[APP_ORIGIN_ENV_VAR];
  if (typeof origin !== "string" || origin.length === 0) {
    throw new Error(`${APP_ORIGIN_ENV_VAR} is not set`);
  }
  const url = new URL(origin);
  if (url.protocol !== "https:") {
    throw new Error(`${APP_ORIGIN_ENV_VAR} must be https`);
  }
  url.pathname = "/authorize";
  url.search = "";
  url.hash = "";
  url.searchParams.set("request_id", requestId);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Request and response plumbing                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every answer is a 200 with a JSON object, or a refusal. There are no partial
 * successes, no 3xx, and no HTML.
 *
 * Built in one place so that two "nothing matched" answers from two different
 * code paths are byte-identical: same status, same headers, same bytes. The
 * whole point of `{ "binding": null }` covering six different failures is that
 * a caller cannot tell which one it hit, and that property dies the moment one
 * path sets a different header.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // A control-plane answer carries a decrypted credential on one route and
      // a live session on another. Nothing in between may keep a copy.
      "Cache-Control": "no-store",
    },
  });
}

/** The gateway secret was absent or wrong. Carries no detail whatsoever. */
export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

/** The body was not the documented shape. Names no field and quotes nothing. */
export function badRequest(): Response {
  return json({ error: "invalid_request" }, 400);
}

/** Read a JSON object body, or `null` for anything that is not one. */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;

  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_REQUEST_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Field readers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A non-empty string field, or `null`.
 *
 * Deliberately not coercing. Coercion is where cross-tenant bugs live: an
 * `undefined` that becomes `"undefined"` and matches some other row, a number
 * that becomes an id-shaped string.
 */
export function stringField(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A field that is legitimately either a string or `null`.
 *
 * `undefined` (the key absent) reads as `null`, matching the contract's
 * "optional; null means not supplied". `sentinel` distinguishes a genuine
 * `null` from a wrong type — a caller that sends `{ state: 42 }` gets a
 * refusal rather than having it silently become `null`.
 */
export function nullableStringField(
  body: Record<string, unknown>,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string" && value.length > 0) {
    return { ok: true, value };
  }
  return { ok: false };
}

/** An array of non-empty strings, or `null`. */
export function stringArrayField(
  body: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = body[key];
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return null;
  }
  return value as string[];
}

/** A finite epoch-ms timestamp, or `null`. */
export function timestampField(
  body: Record<string, unknown>,
  key: string,
): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * A non-negative integer count, or `null` for anything else.
 *
 * Strict on purpose. A count arrives from the gateway and is written straight
 * onto a row an owner reads as progress, so `-1`, `1.5`, `NaN`, `Infinity` and
 * `"12"` are all refusals rather than things to coerce — a coerced count is a
 * progress bar that runs backwards, and `Infinity` stored is a row that can
 * never be rendered again.
 */
export function countField(
  body: Record<string, unknown>,
  key: string,
): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** A 64-character lowercase-hex token hash, or `null`. */
export function tokenHashField(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = stringField(body, key);
  return value !== null && TOKEN_HASH_PATTERN.test(value) ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Redirect URIs                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Exact match, with one narrow exception.
 *
 * Not `startsWith`, not `includes`, not "same origin". A prefix comparison
 * accepts `https://client.test/callback.evil`; an origin comparison accepts
 * any path on a host the client registered. Both hand an authorization code to
 * somewhere the client never nominated.
 *
 * The exception is RFC 8252 §7.3: a native client's loopback redirect gets an
 * ephemeral port the OS picks at run time, which cannot be known at
 * registration. So for a loopback host — and only for a loopback host — the
 * port is ignored. Scheme, host, path, query, and fragment must still match
 * exactly, which is what keeps `http://127.0.0.1:51763/other` a refusal.
 *
 * This mirrors `redirectUriMatches` in `apps/mcp/src/oauth.js`. The gateway
 * checks it before parking a request and we check it again here, because the
 * gateway is the party this check is meant to constrain.
 */
/**
 * A redirect URI we are willing to store at all.
 *
 * MCP requires https or loopback. `http://localhost/…` is the native-client
 * case; plain http anywhere else would put an authorization code on the wire
 * in cleartext. A custom scheme (`myapp://callback`) is legal for native
 * clients under RFC 8252 but is not something this deployment has a client
 * for, and accepting arbitrary schemes widens the redirect surface for no
 * current benefit.
 *
 * A fragment is refused because it cannot survive a redirect meaningfully.
 *
 * The gateway applies the same rule at registration. We apply it again because
 * the gateway is the party this rule constrains.
 */
export function redirectUriIsAcceptable(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost"
    );
  }
  return false;
}

export function redirectUriMatches(registered: string, presented: string): boolean {
  if (typeof registered !== "string" || typeof presented !== "string") return false;
  if (registered === presented) return true;

  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }

  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
  if (!loopbackHosts.has(a.hostname) || a.hostname !== b.hostname) return false;
  if (a.protocol !== b.protocol) return false;
  return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
}
