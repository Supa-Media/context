import { ControlPlaneError, isLoopbackHost, sha256Hex } from "../controlPlane.js";
import { SUPPORTED_SCOPES } from "../session.js";
import { MAX_CLIENT_NAME_LENGTH, MAX_REDIRECT_URIS, REGISTRATION_BYTE_CAP } from "./policy.js";
import { jsonResponse, oauthError, randomToken } from "./responses.js";
import { registrantKey } from "./registrant.js";

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
 * What a client may call itself, given that a person reads it.
 *
 * `client_name` is client-asserted — registration is unauthenticated by
 * construction — and unlike `software_id`, which nothing renders, this string
 * is the subject of the sentence on the consent screen, the label in the
 * connections list, and the name in the audit trail. It arrives from a stranger
 * and is displayed to somebody making a security decision, so it is bounded
 * here for the same reason `software_id` is: this is where the bytes land.
 *
 * **One line, and nothing that reorders or hides.** Each of these becomes a
 * space, runs of whitespace then collapse, and what is left is trimmed:
 *
 * - `\p{Cc}` — the C0 and C1 controls, which is where `\n`, `\r`, `\t` and
 *   `\0` live. A newline is the one that matters most: the consent screen puts
 *   this string in a sentence, and a name that is mostly line breaks is a name
 *   that pushes the rest of that sentence away from the reader.
 * - The **bidi controls** (`U+061C`, `U+200E`, `U+200F`, `U+202A`–`U+202E`,
 *   `U+2066`–`U+2069`). These reorder the characters around them, so a name can
 *   be made to render as something other than what is stored and compared.
 * - The **invisible spacers** `U+200B`, `U+2060` and `U+FEFF`, which occupy a
 *   name without showing anything.
 *
 * **`U+200C` and `U+200D` are deliberately kept.** The zero-width non-joiner
 * and joiner are `Cf` like the rest, and stripping the whole category was the
 * first version of this function — but they are orthography, not decoration:
 * Persian and several Indic scripts need them between letters, and an emoji
 * sequence is held together by `U+200D`, so removing them silently rewrites
 * names that are simply not in English. Neither reorders text and neither is
 * invisible padding in the sense above; they are a narrower risk than the
 * damage removing them does.
 *
 * Normalised rather than refused — a stray newline in an otherwise fine name is
 * not a reason to fail a registration — and the result is echoed in the
 * response, so a client can see what was kept.
 *
 * The cap is applied **after** the collapse, so leading padding cannot eat the
 * name, and a trailing lone surrogate is dropped: cutting mid-pair is a defect
 * this function would have introduced itself.
 */
const NAME_HOSTILE = /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;

function normalizeClientName(value) {
  if (typeof value !== "string") return "Unnamed MCP client";
  let name = value
    .replace(NAME_HOSTILE, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_CLIENT_NAME_LENGTH);
  // A high surrogate with nothing after it is half a character; `slice` is what
  // would have made it.
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  name = name.trim();
  return name || "Unnamed MCP client";
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

  const clientName = normalizeClientName(body.client_name);

  /*
    RFC 7591's `software_id`: what the software *is*, across every installation
    of it, as opposed to `client_name`, which is what this one installation
    calls itself.

    It is stored because the control plane has one reader — the desktop shell's
    machine grant is minted without an approve screen, and only for a client
    that declared itself the shell. It is **client-asserted**, registration is
    unauthenticated by construction, and neither this file nor the control
    plane treats it as authentication: it narrows which clients a convenience
    applies to, and the conditions that actually bound that convenience are the
    loopback redirect and the exact default scope.

    Bounded here rather than downstream, because this is where a stranger's
    bytes arrive: a short, boring alphabet, so nothing that lands in the
    control plane can carry markup, whitespace tricks, or a paragraph. Anything
    outside it is dropped rather than refused — an unknown `software_id` is not
    a reason to fail a registration that is otherwise fine.
  */
  const softwareId =
    typeof body.software_id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(body.software_id)
      ? body.software_id
      : undefined;

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
    softwareId,
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
  // Echoed only when it survived the check above, so a client can tell that
  // what it declared was kept rather than quietly dropped (RFC 7591 §3.2.1
  // asks the response to carry the registered metadata).
  if (softwareId !== undefined) registered.software_id = softwareId;
  if (clientSecret) {
    registered.client_secret = clientSecret;
    // 0 means "does not expire" (RFC 7591 §3.2.1).
    registered.client_secret_expires_at = 0;
  }
  return jsonResponse(registered, 201);
}
