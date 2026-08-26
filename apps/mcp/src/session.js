/**
 * Per-request tenancy: who is calling, which context they selected, and the
 * store that reaches that context's bucket and no other.
 *
 * There is exactly one way into this gateway: an OAuth access token, resolved
 * through the control plane, on every single request. No static shared secret,
 * no environment token, no fallback binding. That is not a hardening measure
 * bolted on afterwards — it is the reason this file exists, and the reason
 * `resolveScope` (three env-var tokens compared against a header) is gone.
 *
 * ## No cross-request credential cache. None.
 *
 * A Worker isolate is reused across requests, and across *tenants*. A module-
 * level `Map` of workspaceId → decrypted secret is one wrong cache key — one
 * stale entry, one id-confusion bug — away from signing tenant A's request with
 * tenant B's credential, and that failure is silent and total. So the storage
 * binding is fetched from the control plane on every request and lives only in
 * the `S3Store` built for that request.
 *
 * The price is real and is stated rather than optimised away: two sequential
 * control-plane round trips before any bucket I/O (session, then binding — the
 * second needs the workspace id from the first). Same-region Convex, that is
 * roughly 20–60ms added to every MCP call. If that ever has to come down, the
 * two operations can be collapsed into one round trip, or a cache can be added
 * whose lifetime is a single request. A cache that outlives one request is a
 * cross-tenant leak waiting for a bad day; do not add one.
 *
 * ## The credential needs the *user's* token, not just ours
 *
 * The gateway cannot fetch a storage credential by naming a workspace. It
 * forwards the caller's own access token, and the control plane derives the
 * workspace from the grant *that* token resolves to. The gateway secret proves
 * "this is the gateway"; the user's token proves "somebody authorized this
 * context and is connecting right now". Either one alone opens nothing, so a
 * compromised gateway cannot enumerate the customer base — it can only see what
 * is actively flowing through it. The full reasoning is in `controlPlane.js`;
 * it is the single most important property in this file's neighbourhood.
 */

import { R2Store } from "./store/r2.js";
import { S3Store } from "./store/s3.js";
import { ControlPlaneError } from "./controlPlane.js";

/** Read every visible note. */
export const SCOPE_READ = "context:read";
/** Create, update, move, and archive notes. Implies capture. */
export const SCOPE_WRITE = "context:write";
/** Drop a raw capture into 0-inbox and nothing else. */
export const SCOPE_CAPTURE = "context:capture";

export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_CAPTURE];

/**
 * Membership role → privacy tier.
 *
 * The privacy engine has understood two tiers since before there were
 * workspaces, and `private` means "sees everything in this context, including
 * notes marked private". Only an `owner` gets that. An `editor` can write, and
 * a `member` cannot, but neither of them is the person whose private notes
 * these are, so both resolve to `team`.
 *
 * This mapping lives here rather than in the control plane on purpose: the
 * privacy tier is a property of the *gateway's* enforcement model, and the
 * control plane should not have to be redeployed to change what `editor` can
 * see.
 */
export function visibilityTierForRole(role) {
  return role === "owner" ? "private" : "team";
}

/** Roles that may change content at all, before per-grant scopes narrow it. */
function roleCanWrite(role) {
  return role === "owner" || role === "editor";
}

/** A refusal the caller may see. Carries no tenant detail, ever. */
export class SessionRefusal extends Error {
  constructor(status, code, description) {
    super(code);
    this.name = "SessionRefusal";
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

/**
 * The gateway could not reach a usable bucket for an otherwise valid session.
 *
 * Distinct from an auth failure because it is a different fact about a
 * different subject: the *caller* is fine, the *workspace* has no working
 * storage. Telling them apart is not an oracle — a caller learns only about
 * their own grant and their own workspace, never about anyone else's.
 */
export class StorageUnavailable extends Error {
  constructor(reason) {
    super(`storage unavailable: ${reason}`);
    this.name = "StorageUnavailable";
    this.reason = reason;
  }
}

/* ------------------------------ token intake ------------------------------ */

export function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (!/^Bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Slugs come from the control plane's global name namespace: 2–32 characters of
 * lowercase `a–z`, `0–9`, and `-`. Validated here so a hostile path segment
 * becomes a refusal instead of a control-plane round trip.
 */
const SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;

/**
 * Percent-decode one path segment, or `null` if it is not decodable.
 *
 * Case is preserved: this is also how the token-in-path route decodes an
 * access token, and a token is case-sensitive. Callers that want a slug
 * lowercase the result themselves.
 *
 * Exported so every place this worker decodes a caller-supplied path segment
 * agrees that "malformed" is a routing answer, not an exception.
 */
export function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Pull an optional workspace selector off the front of a path.
 *
 * `mcp.context.lc/@seyi/mcp` and `mcp.context.lc/seyi/mcp` both select the
 * workspace `seyi`; `mcp.context.lc/mcp` selects the grant's default. The `@`
 * is cosmetic and normalised away.
 *
 * ## What the slug in the URL is, and emphatically is not
 *
 * **It is not a security boundary and provides no isolation.** Cloudflare
 * routes every path on a hostname to the same Worker, and isolates are reused
 * across paths exactly as they are across requests. Nobody reading this later
 * should conclude that putting the tenant in the URL bought them safety: the
 * OAuth grant decides what a caller may reach, and the slug only *selects*
 * among workspaces that grant already covers. A slug the grant does not cover
 * is refused, and refused identically whether or not it names a real workspace.
 *
 * What it does buy, and the actual reason it exists:
 *
 * - **Cache keys are tenant-scoped by construction.** The Cache API keys on the
 *   full URL. Any future caching of non-secret data — resolved workspace
 *   metadata, discovery documents, directory listings — cannot cross-hit
 *   between tenants by accident, because two tenants can no longer produce the
 *   same key. This is a structural property, not a rule someone has to
 *   remember. (For `/mcp` itself the HTTP-caching win is close to nil: it is
 *   POST JSON-RPC and not cacheable. The win is keying and discovery
 *   documents.)
 * - **Observability.** Logs and analytics segment per tenant without anyone
 *   parsing a token to do it.
 * - **Legibility.** People see this URL in their MCP client settings.
 *   `mcp.context.lc/@seyi/mcp` reads as theirs.
 */
export function splitWorkspacePath(pathname) {
  const match = pathname.match(/^\/@?([^/]+)(\/.*)?$/);
  if (!match) return { slug: null, path: pathname };
  // `decodeURIComponent` throws a URIError on a malformed escape ("%zz", or a
  // truncated multi-byte sequence). This runs at the very top of `fetch`,
  // before any routing or auth, so an unhandled throw here turns
  // `GET /%zz/mcp` — which anyone on the internet can send — into a Worker
  // exception instead of a 404. A path that cannot be decoded names no
  // workspace, which is exactly what "no slug" already means.
  const decoded = decodePathSegment(match[1]);
  if (decoded === null) return { slug: null, path: pathname };
  const candidate = decoded.toLowerCase();
  // A first segment that is a known top-level route is a route, not a slug.
  if (RESERVED_FIRST_SEGMENTS.has(candidate)) return { slug: null, path: pathname };
  if (!SLUG_PATTERN.test(candidate)) return { slug: null, path: pathname };
  return { slug: candidate, path: match[2] || "/" };
}

/**
 * First path segments that name a route rather than a workspace.
 *
 * These are also reserved in the control plane's name namespace, so no
 * workspace can ever be called one of them — but the gateway does not get to
 * assume the two lists stayed in sync, so it checks its own.
 */
const RESERVED_FIRST_SEGMENTS = new Set([
  "mcp",
  "inbox",
  "oauth",
  "t",
  ".well-known",
  "granola-webhook",
]);

/* --------------------------- session resolution --------------------------- */

/**
 * Resolve a bearer token and an optional slug into the session that will serve
 * this one request.
 *
 * Returns `{ workspaceId, scope, actorUserId, actorClientId, scopes, ... }`.
 * Throws `SessionRefusal` for everything else — there is no third outcome, and
 * in particular no "carry on with a default".
 */
export async function resolveSession(token, slug, controlPlane) {
  if (!token) {
    throw new SessionRefusal(401, "invalid_token", "An OAuth access token is required.");
  }
  // A token shape check before the network call: a 3-character token is not a
  // near miss, and hashing it would still cost a round trip.
  if (token.length < 20 || token.length > 4096) {
    throw new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
  }

  let resolved;
  try {
    resolved = await controlPlane.resolveSession(token);
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      // The control plane is unreachable, misconfigured, or answering something
      // this gateway does not understand. Every one of those is a refusal.
      // There is nothing to fall back *to* — and if there were, falling back
      // would mean serving one tenant's request out of another tenant's store.
      throw new SessionRefusal(401, "invalid_token", "The access token could not be verified.");
    }
    throw error;
  }

  // Byte-identical refusal for "no such token", "revoked grant", "expired
  // token", and "the user was removed from the workspace". A caller learns
  // that their token does not work and nothing else.
  if (resolved === null) {
    throw new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
  }
  const session = normalizeSession(resolved);

  if (typeof session.expiresAt === "number" && session.expiresAt <= Date.now()) {
    throw new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
  }

  const workspace = selectWorkspace(session, slug);
  const resolvedSession = {
    grantId: session.grantId,
    workspaceId: workspace.workspaceId,
    workspaceSlug: workspace.slug,
    role: workspace.role,
    scope: visibilityTierForRole(workspace.role),
    actorUserId: session.actorUserId,
    actorClientId: session.clientId,
    scopes: effectiveScopes(session.scopes, workspace.role),
    expiresAt: session.expiresAt,
  };

  /**
   * The caller's raw access token rides along, because the control plane
   * requires it as the *second* proof before it will open a storage credential:
   * the gateway secret says "this is the gateway", and this says "a real person
   * authorized this workspace and their grant is live right now". Neither alone
   * opens anything.
   *
   * Non-enumerable on purpose. `JSON.stringify(session)`, `{...session}`, and
   * `Object.entries` all skip it, so the single most likely way for a bearer
   * token to reach a log line — someone logging the session object — cannot
   * happen by accident.
   */
  Object.defineProperty(resolvedSession, "accessToken", {
    value: token,
    enumerable: false,
    writable: false,
  });
  return resolvedSession;
}

/**
 * Reject a session payload that is not the documented shape.
 *
 * A malformed payload is treated as an auth failure rather than coerced. The
 * coercion path is where cross-tenant bugs live: an `undefined` workspaceId
 * that becomes `"undefined"` and matches some other row, a `scopes` that is a
 * string and whose `.includes("context:write")` is accidentally true.
 */
function normalizeSession(raw) {
  const fail = () =>
    new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
  if (!raw || typeof raw !== "object") throw fail();
  const { grantId, clientId, actorUserId, scopes, workspaces, defaultWorkspaceId } = raw;
  if (typeof grantId !== "string" || !grantId) throw fail();
  if (typeof clientId !== "string" || !clientId) throw fail();
  if (typeof actorUserId !== "string" || !actorUserId) throw fail();
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) throw fail();
  if (!Array.isArray(workspaces) || workspaces.length === 0) throw fail();
  const normalized = workspaces.map((entry) => {
    if (!entry || typeof entry !== "object") throw fail();
    if (typeof entry.workspaceId !== "string" || !entry.workspaceId) throw fail();
    if (typeof entry.role !== "string" || !entry.role) throw fail();
    const slug = typeof entry.slug === "string" ? entry.slug.toLowerCase() : null;
    return { workspaceId: entry.workspaceId, slug, role: entry.role };
  });
  if (typeof defaultWorkspaceId !== "string" || !defaultWorkspaceId) throw fail();
  return {
    grantId,
    clientId,
    actorUserId,
    scopes,
    workspaces: normalized,
    defaultWorkspaceId,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
  };
}

/**
 * Pick the workspace this request addresses.
 *
 * With no slug, the grant's default. With a slug, the covered workspace of that
 * name — and **403 with no detail** otherwise. "You have no grant for that
 * workspace" and "no such workspace" must be the same answer, or the path
 * becomes an existence oracle for every name in a global namespace: type slugs
 * until one answers differently and you have enumerated the customer list.
 */
function selectWorkspace(session, slug) {
  if (!slug) {
    const fallback = session.workspaces.find((w) => w.workspaceId === session.defaultWorkspaceId);
    // A default that is not in the covered set is a control-plane bug. It is
    // not silently replaced with `workspaces[0]`: quietly serving *a* workspace
    // when the named one was wrong is how a tenancy bug becomes a leak.
    if (!fallback) {
      throw new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
    }
    return fallback;
  }
  const match = session.workspaces.find((w) => w.slug === slug);
  if (!match) {
    throw new SessionRefusal(
      403,
      "insufficient_scope",
      "This connection has no access to that context."
    );
  }
  return match;
}

/**
 * Grant scopes ∩ what the role permits.
 *
 * Both halves matter and neither implies the other. A read-only grant issued to
 * an owner must not write — the person deliberately connected a client that way
 * — and a full-scope grant issued to a read-only `member` must not write
 * either, because the grant cannot confer authority the membership never had.
 */
function effectiveScopes(grantScopes, role) {
  const granted = new Set(grantScopes);
  const effective = [SCOPE_READ];
  if (granted.has(SCOPE_WRITE) && roleCanWrite(role)) {
    effective.push(SCOPE_WRITE, SCOPE_CAPTURE);
  } else if (granted.has(SCOPE_CAPTURE) && roleCanWrite(role)) {
    effective.push(SCOPE_CAPTURE);
  }
  // A grant with no read scope is capture-only: it may drop things into the
  // inbox and may not look at anything.
  if (!granted.has(SCOPE_READ)) {
    return effective.filter((scope) => scope !== SCOPE_READ);
  }
  return effective;
}

export function hasScope(session, scope) {
  return Array.isArray(session?.scopes) && session.scopes.includes(scope);
}

/* -------------------------------- the store ------------------------------- */

/**
 * Build the storage adapter for one session.
 *
 * This is the only place in the worker that turns a workspace into a bucket,
 * and the only place a storage credential exists. Everything above it works
 * against the `ContextStore` interface and never learns which provider, which
 * bucket, or which prefix it is talking to.
 *
 * Keys are never namespaced. A note is at `1-projects/foo.md` in the customer's
 * own bucket, exactly as their Obsidian sync expects. `rootPrefix` is a
 * customer-chosen convenience applied inside the adapter and invisible above
 * it; it is not tenancy and is never derived from a workspace id.
 */
export async function storeForSession(session, env, controlPlane) {
  if (!session || typeof session.workspaceId !== "string" || !session.workspaceId) {
    throw new StorageUnavailable("no workspace");
  }
  if (typeof session.accessToken !== "string" || !session.accessToken) {
    // A session that lost its token cannot prove anything to the control plane,
    // and must not be able to fall back to a gateway-secret-only request.
    throw new StorageUnavailable("no proof of authorization");
  }

  let binding;
  try {
    binding = await controlPlane.getStorageBinding(session.accessToken, session.workspaceId);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw new StorageUnavailable("control plane");
    throw error;
  }

  if (binding === null) throw new StorageUnavailable("not bound");
  if (!binding || typeof binding !== "object") throw new StorageUnavailable("malformed binding");
  if (binding.status !== "active") throw new StorageUnavailable("not active");

  /**
   * The second half of the two-party check.
   *
   * The control plane resolved the user's token to a grant and derived the
   * workspace from that grant, independently of anything the gateway concluded.
   * If its answer is not the workspace this request resolved to, the two
   * resolutions disagree — and a disagreement about *which tenant this is* is
   * the one bug that must never be papered over. Refuse; do not serve whichever
   * one happens to be in hand.
   */
  if (typeof binding.workspaceId === "string" && binding.workspaceId !== session.workspaceId) {
    throw new StorageUnavailable("workspace mismatch");
  }

  if (binding.provider === "r2-binding") return nativeStore(binding, env);
  return credentialedStore(binding);
}

/**
 * A native Cloudflare R2 binding, for self-hosters.
 *
 * The product deployment does not use this: its tenants bring their own
 * buckets, reached over the S3 API with credentials the customer can revoke
 * without asking us. A self-hosted gateway serving its owner's single bucket
 * has no such credential to hand out, and binding R2 natively is both simpler
 * and safer for them.
 *
 * Two locks, because this is the one code path where a control-plane answer
 * names something inside *our* Worker rather than something inside the
 * customer's account:
 *
 * 1. The binding name must appear in `env.NATIVE_BINDINGS`, a comma-separated
 *    allowlist set by whoever deployed the Worker. A control plane that is
 *    compromised, confused, or simply pointed at the wrong row cannot name a
 *    binding the operator never listed.
 * 2. It must actually exist on `env` and look like a bucket.
 *
 * Without the allowlist, "return `{provider:'r2-binding', bindingName:'X'}`"
 * would be a way to reach any R2 bucket the Worker can see, from the control
 * plane, for any tenant.
 */
function nativeStore(binding, env) {
  const name = binding.bindingName;
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new StorageUnavailable("malformed binding");
  }
  const allowed = String(env?.NATIVE_BINDINGS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowed.includes(name)) throw new StorageUnavailable("binding not allowed");
  const bucket = env?.[name];
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") {
    throw new StorageUnavailable("binding missing");
  }
  return new R2Store(bucket, { rootPrefix: binding.rootPrefix });
}

/** Any S3-compatible endpoint, signed with the customer's own credential. */
function credentialedStore(binding) {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = binding;
  if (
    typeof endpoint !== "string" ||
    typeof bucket !== "string" ||
    typeof accessKeyId !== "string" ||
    typeof secretAccessKey !== "string" ||
    !endpoint ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new StorageUnavailable("malformed binding");
  }
  try {
    return new S3Store({
      endpoint,
      region: typeof region === "string" && region ? region : "auto",
      bucket,
      accessKeyId,
      secretAccessKey,
      rootPrefix: binding.rootPrefix,
      forcePathStyle: binding.forcePathStyle,
    });
  } catch {
    // The adapter's own validation (ambiguous addressing style, unsafe root
    // prefix, bad bucket name) failed. Its message can quote configuration, so
    // it is dropped rather than relayed.
    throw new StorageUnavailable("malformed binding");
  }
}
