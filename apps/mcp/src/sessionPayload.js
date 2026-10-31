/**
 * The control plane's answer about a token, read into the session the gateway serves a request with (`session.js`).
 *
 * `normalizeSession` is the whole of it: a payload that is not the documented shape is refused, never coerced, and
 * the group chat's own fields (its pin, its home, its key) are honoured for the group client alone. Moved out of
 * `session.js`, which was at its line limit (`docs/decisions/repository-and-review.md`).
 */

import { ROW_NAME_PATTERN } from "./privacy/rowAccess.js";

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

/** The group chat's client (`agent/groupTurn.js`); the one a setup-only pin is honoured for. */
const TEXTS_GROUP_CLIENT = "context_texts_group";
/** A group chat's home: `tex/groups/<words>` (`apps/convex/functions/lib/textGroupHome.ts`). */
const CHAT_HOME_PATTERN = /^tex\/groups\/[a-z]+(?:-[a-z]+){1,4}$/;
/** A group chat's key (`textGroups.groupKey`): the sha256, in hex, that names the chat's Tex object (`store/texRouting.js`). */
const CHAT_KEY_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Reject a session payload that is not the documented shape.
 *
 * A malformed payload is treated as an auth failure rather than coerced. The
 * coercion path is where cross-tenant bugs live: an `undefined` workspaceId
 * that becomes `"undefined"` and matches some other row, a `scopes` that is a
 * string and whose `.includes("context:write")` is accidentally true.
 */
export function normalizeSession(raw) {
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
      if (!/^[a-z0-9][a-z0-9-]{1,64}$/.test(normalizedName) && !ROW_NAME_PATTERN.test(normalizedName)) throw fail();
      return normalizedName;
    });
    // A chat's home in the pin (`liveGrants.ts`): only on the setup row, and only a folder beneath the homes.
    const chatHome = entry.setupOnly === true && typeof entry.chatHome === "string" && CHAT_HOME_PATTERN.test(entry.chatHome) ? entry.chatHome : null;
    return { workspaceId: entry.workspaceId, slug, role: entry.role, kind, grantedNames, setupOnly: entry.setupOnly === true, ...(chatHome ? { chatHome } : {}) };
  });
  if (typeof defaultWorkspaceId !== "string" || !defaultWorkspaceId) throw fail();
  // A group chat's grant carries the pin marked setup-only (`liveGrants.ts`):
  // kept apart from the set a tool or a URL may address, and honoured for no
  // other client. Only `sessionForSetup` opens it.
  const reach = normalized.filter((entry) => !entry.setupOnly).map(({ setupOnly, ...entry }) => entry);
  const setup = clientId === TEXTS_GROUP_CLIENT ? normalized.find((entry) => entry.setupOnly) : undefined;
  if (reach.length === 0) throw fail();
  // The chat whose Tex notes this turn may reach: from the grant alone (`liveGrants.ts` `texChatIdOf`), and only under the
  // group client. Anything else, or a malformed key, is no chat at all, so the turn reaches no chat's object.
  const texChatId = clientId === TEXTS_GROUP_CLIENT && typeof raw.texChatId === "string" && CHAT_KEY_PATTERN.test(raw.texChatId) ? raw.texChatId : null;
  return {
    grantId,
    clientId,
    actorUserId,
    scopes,
    workspaces: reach,
    setupReach: setup === undefined ? null : (({ setupOnly, ...entry }) => entry)(setup),
    defaultWorkspaceId,
    ...(texChatId === null ? {} : { texChatId }),
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
    // Optional for the reason `clientName` is: it decides nothing, it only
    // chooses which tool news `orient` shows. A control plane older than the
    // field omits it, and the news is then left out rather than guessed.
    toolsListedAt: Number.isFinite(raw.toolsListedAt) ? raw.toolsListedAt : null,
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
