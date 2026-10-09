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
 * the store built for that request.
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

import { StorageUnavailable } from "./store/factory.js";
import { ControlPlaneError } from "./controlPlane.js";
import { RESERVED_FIRST_SEGMENTS, SLUG_PATTERN } from "./workspacePath.js";

/**
 * Re-exported so every caller keeps importing it from here.
 *
 * It lives in `store/factory.js` because that is where storage now decides it
 * cannot serve a request — this file only decides who is calling.
 */
export { StorageUnavailable };

/**
 * The workspace-path selector lives in `workspacePath.js`; re-exported here so
 * every caller that imports it from the session module keeps working.
 */
export { decodePathSegment, splitWorkspacePath } from "./workspacePath.js";
export { storeForOpenedBinding, storeForSession } from "./sessionStore.js";

/** Read every visible note. */
export const SCOPE_READ = "context:read";
/** Create, update, move, and archive notes. Implies capture. */
export const SCOPE_WRITE = "context:write";
/** Drop a raw capture into 0-inbox and nothing else. */
export const SCOPE_CAPTURE = "context:capture";
/**
 * Reach notes marked private.
 *
 * Not an operation — holding it lets a client *do* nothing new. It widens the
 * set of notes every other scope applies to, which is why it is the one scope
 * a person is asked about separately on the consent screen and the one a
 * client's request cannot decide.
 */
export const SCOPE_PRIVATE = "context:private";

/**
 * Everything a client may ask for, and everything both discovery documents
 * advertise.
 *
 * `oauth.js` imports this rather than keeping a second literal. It had one, and
 * two lists of the same thing is how a server ends up advertising a scope its
 * authorization endpoint then rejects — a client that follows discovery
 * faithfully is the one that breaks.
 */
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_CAPTURE, SCOPE_PRIVATE];

/**
 * The privacy tier this grant was given.
 *
 * **Read from the grant, then clamped by role — never derived from role.**
 * That inversion is the whole change. `visibilityTierForRole(role)` used to
 * live here and answered `private` for every owner, which meant an owner could
 * not connect a client at team level even if that was exactly what they wanted:
 * every note they had ever marked private went to whatever they connected. The
 * tier is now something a person decided at consent time and the grant carries,
 * so an owner who granted `team` gets `team` on every later request, forever.
 *
 * The role clamp stays, and is not redundant with the control plane's. The
 * control plane decides what may be *written* into a grant, at approval time;
 * this decides what a *live request* may do with one, now. Between those two
 * moments a membership can change — and while an owner cannot be demoted, a
 * grant is not the only thing that can go stale. Reading a value the control
 * plane vouched for and enforcing it against the role the control plane
 * reported in the same breath costs one `Set` and closes the gap.
 */
export function visibilityTierForGrant(grantScopes, role) {
  if (role !== "owner") return "team";
  return new Set(grantScopes).has(SCOPE_PRIVATE) ? "private" : "team";
}

/** Roles that may change content at all, before per-grant scopes narrow it. */
function roleCanWrite(role) {
  return role === "owner" || role === "editor";
}

/**
 * May this connection take part in a form — submit, edit its own answer, vote?
 *
 * **This is the one write a `member` can make, and it is deliberately not a
 * scope the role clamp can grant.** `effectiveScopes` drops `context:write`
 * for every role below editor, which is right for note writing and is exactly
 * what makes a view-only workspace useless for collecting a bug report. So the
 * *role* clamp is relaxed here and the *grant* is not:
 *
 *  - the grant must itself have asked for write, so a client its person
 *    deliberately connected read-only stays read-only — submitting a form
 *    changes a file in their bucket, and "read-only" has to mean that;
 *  - `context:capture` is not enough. Capture reaches `0-inbox` and nothing
 *    else, and a form response is a write to a path an editor chose.
 *
 * What the relaxation cannot do is decide *which* form: that is the block's
 * own `submit` policy, read from the note at call time, and the role is
 * compared against it there. This answers only "may this connection use the
 * form tools at all", which is why it is a boolean and not a scope.
 */
export function participatesInForms(session) {
  const granted = new Set(session?.grantScopes || session?.scopes || []);
  if (!granted.has(SCOPE_WRITE)) return false;
  return typeof session?.role === "string" && session.role !== "";
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

/* ------------------------------ token intake ------------------------------ */

export function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (!/^Bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  return token || null;
}

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
  // Clamp once, then read the tier off the clamped set. Deriving the tier from
  // the raw grant instead would give private-tier to a scope the clamp had just
  // removed — two answers to one question, which is the shape of every
  // privilege bug in this neighbourhood.
  const scopes = effectiveScopes(session.scopes, workspace.role);
  const grantedGroups = new Set(workspace.grantedNames.map((name) => `@${name}`));
  const resolvedSession = {
    grantId: session.grantId,
    workspaceId: workspace.workspaceId,
    workspaceSlug: workspace.slug,
    workspaceKind: workspace.kind,
    role: workspace.role,
    scope: visibilityTierForGrant(scopes, workspace.role),
    actorUserId: session.actorUserId,
    actorClientId: session.clientId,
    /*
      Display text, not identity. The activity file is a document a person
      opens, and "@sayo's Claude" is the sentence it has to be able to write;
      every authorization decision reads `actorClientId`, which the control
      plane issued, and never this, which the client asserted at registration.
      Absent on a connection the control plane has no client row for.
    */
    actorClientName:
      typeof session.clientName === "string" && session.clientName ? session.clientName : null,
    scopes,
    grantedGroups,
    /**
     * The grant's own scopes, before this workspace's role clamped them, and
     * the set of contexts this connection may address.
     *
     * Both are here so `sessionForContext` can answer for a *different* covered
     * context without a second round trip. `grantScopes` is deliberately not
     * `scopes`: re-clamping an already-clamped set intersects two roles, so a
     * `member` in the context they connected to would lose write in a context
     * they own — a quiet under-grant that reads as a bug in the wrong place.
     * Neither is a credential; both are ids, slugs and roles.
     */
    grantScopes: session.scopes,
    workspaces: session.workspaces,
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
 * The same connection, addressed at another context it covers.
 *
 * **This is the whole of cross-context reach, and it is one function on
 * purpose.** A grant now covers every context its person is a live member of
 * (see `resolveGrantByAccessToken`), so a client connected once can act in a
 * workspace shared with its owner — which is what was asked for. What must not
 * follow is authority travelling with it, so every clamp `resolveSession`
 * applies to the default context is applied here to the addressed one, from the
 * grant's own scopes and the *target's* role:
 *
 *  - `effectiveScopes` intersects the grant with what that role can back up, so
 *    a `member` reaches somebody's workspace read-only however wide the grant;
 *  - `visibilityTierForGrant` reads the tier off the clamped set, so anybody
 *    who is not that context's owner sees `team` and no private note.
 *
 * A name outside the covered set is refused with a 403 that says nothing —
 * the same refusal `selectWorkspace` gives the URL form, for the same reason:
 * "you cannot reach that" and "there is no such name" must be one answer, or
 * the argument becomes an existence oracle over a global namespace.
 *
 * The access token is re-attached rather than spread: it is non-enumerable on
 * the session it came from, so `{ ...session }` silently drops it and every
 * cross-context call would fail at `storeForSession` with "no proof of
 * authorization" — fail-closed, and completely.
 */
export function sessionForContext(session, name) {
  const wanted = normalizeContextName(name);
  const refuse = () =>
    new SessionRefusal(403, "insufficient_scope", "This connection has no access to that context.");
  if (wanted === null) throw refuse();

  const covered = (session?.workspaces || []).find((entry) => entry.slug === wanted);
  if (!covered) throw refuse();
  if (covered.workspaceId === session.workspaceId) return session;

  const scopes = effectiveScopes(session.grantScopes, covered.role);
  const sibling = {
    ...session,
    workspaceId: covered.workspaceId,
    workspaceSlug: covered.slug,
    workspaceKind: covered.kind,
    role: covered.role,
    scope: visibilityTierForGrant(scopes, covered.role),
    scopes,
    grantedGroups: new Set((covered.grantedNames || []).map((name) => `@${name}`)),
  };
  Object.defineProperty(sibling, "accessToken", {
    value: session.accessToken,
    enumerable: false,
    writable: false,
  });
  return sibling;
}

/**
 * `@seyi`, `seyi` and `Seyi` are one name; anything the gateway would not read
 * out of a URL is not a name at all.
 *
 * The same shape rules `splitWorkspacePath` applies, because a context is
 * addressed by one namespace whichever door it arrives through — and applying
 * them here means a hostile argument is a refusal rather than a control-plane
 * round trip.
 */
function normalizeContextName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/^@/, "").toLowerCase();
  if (!SLUG_PATTERN.test(trimmed)) return null;
  if (RESERVED_FIRST_SEGMENTS.has(trimmed)) return null;
  return trimmed;
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
    const kind = entry.kind === "shared" ? "shared" : "personal";
    const slug = typeof entry.slug === "string" ? entry.slug.toLowerCase() : null;
    const rawGrantedNames = entry.grantedNames;
    if (
      rawGrantedNames !== undefined &&
      (!Array.isArray(rawGrantedNames) || rawGrantedNames.some((name) => typeof name !== "string"))
    ) {
      throw fail();
    }
    const grantedNames = (rawGrantedNames || []).map((name) => {
      // Convex returns the stored name without `@`; accepting the decorated
      // form here keeps this boundary compatible with older gateway fixtures,
      // while the set consumed by privacy always has the exact `@name` form.
      const normalizedName = name.trim().replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,64}$/.test(normalizedName)) throw fail();
      return normalizedName;
    });
    return { workspaceId: entry.workspaceId, slug, role: entry.role, kind, grantedNames };
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
    /*
      Optional, and unvalidated beyond its type: it is the name the client
      asserted at registration, it decides nothing, and a control plane older
      than the field simply omits it. Every other field here throws on a
      surprise because every other field decides something.
    */
    clientName: typeof raw.clientName === "string" && raw.clientName ? raw.clientName : null,
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
 *
 * `SCOPE_PRIVATE` goes through the same intersection as everything else: it
 * survives only if the grant carries it *and* the caller is the owner. It is
 * kept on a capture-only grant too, where it means nothing — the tier only
 * matters to reads — because filtering it out there would be a special case
 * that has to stay in sync with which scopes read, and there is nothing to gain
 * from one.
 */
function effectiveScopes(grantScopes, role) {
  const granted = new Set(grantScopes);
  const effective = [SCOPE_READ];
  if (granted.has(SCOPE_WRITE) && roleCanWrite(role)) {
    effective.push(SCOPE_WRITE, SCOPE_CAPTURE);
  } else if (granted.has(SCOPE_CAPTURE) && roleCanWrite(role)) {
    effective.push(SCOPE_CAPTURE);
  }
  // The tier the person granted, and only for the one role that could grant it.
  // A grant that predates the tier being grantable carries no `context:private`
  // and therefore lands on `team` — a narrowing, which is always allowed, and
  // the only reading that does not leave every legacy grant at full access.
  if (granted.has(SCOPE_PRIVATE) && role === "owner") {
    effective.push(SCOPE_PRIVATE);
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

/**
 * Whether this connection can write in *any* context it reaches.
 *
 * `tools/list` is a courtesy and `callToolForSession`'s gate is the control, so
 * this may only ever be too generous — and being too *mean* is the failure that
 * actually turns up. Somebody whose client is connected to a workspace they are
 * only a `member` of would otherwise be shown no write tools at all, in a
 * session where they own another context and can write there; an agent cannot
 * ask for a tool it was never told about, so a listing filtered by the current
 * context quietly removes a capability the connection has.
 *
 * The per-call gate still decides *where*, from the addressed context's own
 * role, and says which context refused. Offer what the connection can do;
 * refuse where it cannot.
 *
 * It lives here rather than in `index.js` because it is a scope question, and
 * the clamp that answers it is this module's. A second copy of `effectiveScopes`
 * reasoning anywhere else is the drift this file exists to prevent.
 */
export function writesAnywhere(session) {
  if (hasScope(session, SCOPE_WRITE)) return true;
  const granted = session?.grantScopes || session?.scopes || [];
  return (session?.workspaces || []).some((entry) =>
    effectiveScopes(granted, entry.role).includes(SCOPE_WRITE)
  );
}

/**
 * What this connection may actually do in a context where its person holds
 * `role` — the tier it reads at there, and whether it may write.
 *
 * `writesAnywhere`'s question asked of one context instead of all of them, and
 * here for the same reason that one is: the clamp that answers it is this
 * module's, and a second copy of `effectiveScopes` reasoning is the drift this
 * file exists to prevent. `orient` describes every context a connection
 * reaches, and it described them from the *role* alone — which is neither
 * half of the answer. A read-only grant held by an `editor` was announced as
 * writable; an `owner` was described as reading private notes on a grant that
 * carries no `context:private` and reads that context at `team`.
 *
 * It answers from the grant's own scopes, never the connection's already
 * clamped set, exactly as `sessionForContext` does: re-clamping intersects two
 * roles and would describe a context somebody owns by the role they hold
 * somewhere else.
 *
 * This is a description, never a decision. The gate in `callToolForSession`
 * still decides, from the session `sessionForContext` builds — but both read
 * the same clamp, so what orientation promises and what the call does cannot
 * disagree.
 */
export function reachForRole(session, role) {
  const granted = session?.grantScopes || session?.scopes || [];
  const scopes = effectiveScopes(granted, role);
  return {
    tier: visibilityTierForGrant(scopes, role),
    canWrite: scopes.includes(SCOPE_WRITE),
    /*
      Which of the two halves said no, because the remedies differ and
      `callToolForSession` already refuses in exactly these two voices. A grant
      that was never given write is a reconnection the person can make; a role
      that cannot back one up is not, and telling them to reconnect for write
      they can never hold there sends them round a loop that cannot end.
    */
    grantWrites: new Set(granted).has(SCOPE_WRITE),
  };
}

/**
 * Normalize the deliberately small session row returned for a live socket.
 *
 * The control plane re-reads the grant and membership; this module still owns
 * the role/scope clamp. Keeping that clamp here prevents the websocket path
 * from growing a second definition of what an editor, member, or owner may do.
 * `null` is the ordinary answer for a revoked or otherwise stale grant. Any
 * malformed non-null row also fails closed rather than being coerced.
 */
export function accessForLiveGrant(raw, expectedWorkspaceId) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.grantId !== "string" || !raw.grantId) return null;
  if (typeof raw.workspaceId !== "string" || raw.workspaceId !== expectedWorkspaceId) return null;
  if (!Array.isArray(raw.scopes) || raw.scopes.some((scope) => typeof scope !== "string")) {
    return null;
  }
  if (typeof raw.role !== "string" || !raw.role) return null;
  if (raw.kind !== "personal" && raw.kind !== "shared") return null;
  if (
    raw.grantedNames !== undefined &&
    (!Array.isArray(raw.grantedNames) || raw.grantedNames.some((name) => typeof name !== "string"))
  ) {
    return null;
  }
  const grantedGroups = new Set();
  for (const name of raw.grantedNames || []) {
    const normalized = name.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,64}$/.test(normalized)) return null;
    grantedGroups.add(`@${normalized}`);
  }
  const scopes = effectiveScopes(raw.scopes, raw.role);
  return {
    grantId: raw.grantId,
    workspaceId: raw.workspaceId,
    role: raw.role,
    kind: raw.kind,
    scopes,
    scope: visibilityTierForGrant(scopes, raw.role),
    grantedGroups,
  };
}

/**
 * Whether this connection reads at the private tier in ANY context it covers.
 *
 * `writesAnywhere`'s argument, for the other tier. A tool that only an owner
 * may use is still worth advertising to somebody who owns one of the contexts
 * they reach — hiding it would take the capability away rather than refuse it
 * in the places it does not apply — and the per-call gate decides *where*, from
 * the addressed context's own scope.
 *
 * The tier is `private` for exactly one role: the owner of that context,
 * holding `context:private`. `effectiveScopes` is the clamp that says so, and
 * this reuses it rather than restating the rule.
 */
export function readsPrivateAnywhere(session) {
  if (hasScope(session, SCOPE_PRIVATE)) return true;
  const granted = session?.grantScopes || session?.scopes || [];
  return (session?.workspaces || []).some((entry) =>
    effectiveScopes(granted, entry.role).includes(SCOPE_PRIVATE)
  );
}
