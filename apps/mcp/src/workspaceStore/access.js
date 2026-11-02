/**
 * Who may reach what, held in the objects: the shared contract (decided by the owner, 2026-11-01;
 * `docs/decisions/identity-and-access/access-in-objects.md`). Every thread that moves access out of the control plane
 * codes against this file: the row shapes, the call names, the token format and the order of writes that touch two
 * objects. Pure: no stubs, no storage. The person object's side is built on it, and so are the workspace object's
 * members and invites.
 *
 * Two kinds of object hold access, both `WorkspaceStore` (`workspaceStore/api.js`), both placed in eastern North America:
 *
 * - **The person object** is the person's personal workspace's own object, `workspace:<personalWorkspaceId>`. It keeps
 *   `reach` (every workspace and group chat the person is in, with their role and groups there), `sharedToMe` (every
 *   note or folder another workspace shared with them by name) and `connections` (their AI clients' grants, by token
 *   hash). It is the authority for connections, and holds a copy of reach and sharedToMe.
 * - **The workspace object**, `workspace:<workspaceId>`, keeps `members` and `invites`. It is the authority for
 *   membership: once a workspace's access lives in its object, it checks the caller's membership itself on every read,
 *   so a stale copy of reach in a person object can never let anyone in.
 *
 * Every row carries its writer's clock (`at`); a write older than the row held is ignored, and a removal leaves a
 * tombstone at its clock, the same rule as tree rows (`workspaceStore/rows.js`).
 */

/**
 * Where a person's or a workspace's access is read from, as the control plane's switch record names it: `convex` until
 * the copy, `dual` while the object holds a copy that is checked but answers nothing, `object` after the switch.
 */
export const ACCESS_HOMES = Object.freeze({ CONVEX: "convex", DUAL: "dual", OBJECT: "object" });
export const isAccessHome = (value) => Object.values(ACCESS_HOMES).includes(value);

/** A membership's role. Write access is never implied by read. */
export const ROLES = Object.freeze(["owner", "editor", "member"]);
/** A share's or a group chat's role: view or edit. */
export const SHARE_ROLES = Object.freeze(["view", "edit"]);
/** A connection's state. A revoked one never resolves again; it is kept so a reused refresh token can be named. */
export const CONNECTION_STATES = Object.freeze(["active", "revoked"]);

/**
 * The calls, by name. Person calls go to the person object, `ws.*` to a workspace object. Each takes JSON and names
 * the object it is meant for (`personalWorkspaceId` or `workspaceId`); the object pins the first it sees and refuses
 * any other, as `ws.*` already does.
 */
export const ACCESS_OPS = Object.freeze({
  // Person object.
  /** `{tokenHash}` → `{session}`: the control plane's `/gateway/session` payload, or `null`. One answer for every miss. */
  SESSION: "person.session",
  /** `{tokenHash, at}`: when a connection was last used. Never awaited by a request. */
  TOUCH: "person.connections.touch",
  /** `{rows: ReachRow[]}` / `{workspaceIds?, chatIds?, at}` / `{}` → `{rows}`. */
  REACH_PUT: "person.reach.put",
  REACH_REMOVE: "person.reach.remove",
  REACH_LIST: "person.reach.list",
  /** `{rows: SharedRow[]}` / `{keys: [{fromWorkspaceId, target}], at}` / `{}` → `{rows}`. */
  SHARED_PUT: "person.shared.put",
  SHARED_REMOVE: "person.shared.remove",
  SHARED_LIST: "person.shared.list",
  /** `{rows: ConnectionRow[]}`; `{grantId, at}`; `{}` → `{rows}` without hashes. */
  CONNECTIONS_PUT: "person.connections.put",
  CONNECTIONS_REVOKE: "person.connections.revoke",
  CONNECTIONS_LIST: "person.connections.list",
  /**
   * `{refreshHash, clientId, next: {tokenHash, refreshHash, expiresAt, scopes?}, at}` → `{connection}` or `{connection: null}`; a spent refresh
   * hash revokes the grant. Only for the client that holds it, only once the person is switched, and only while the workspace the connection
   * was made at is still in reach (the control plane's rule: nobody refreshes their way back in).
   */
  CONNECTIONS_ROTATE: "person.connections.rotate",
  /** `{tokenHash, clientId, at}` → `{revoked, grantId}`: RFC 7009, by either of a connection's token hashes, only for the client that holds it. */
  CONNECTIONS_REVOKE_TOKEN: "person.connections.unplug",
  /** `{userId, personalWorkspaceId}`: which person this object belongs to, set once. `{}` → `{userId, home}`. */
  PERSON_PIN: "person.pin",
  PERSON_STATE: "person.state",
  /** `{home}`: where this person's access is read from (`ACCESS_HOMES`). */
  PERSON_HOME: "person.home",
  // Workspace object.
  /** `{rows: MemberRow[]}` / `{userIds, at}` / `{}` → `{rows}`; `{userId}` → `{member}` or `{member: null}`. */
  MEMBERS_PUT: "ws.members.put",
  MEMBERS_REMOVE: "ws.members.remove",
  MEMBERS_LIST: "ws.members.list",
  MEMBER_GET: "ws.members.get",
  /** `{rows: InviteRow[]}` / `{ids, at}` / `{}` → `{rows}`. */
  INVITES_PUT: "ws.invites.put",
  INVITES_REMOVE: "ws.invites.remove",
  INVITES_LIST: "ws.invites.list",
  /** `{home}`: where this workspace's members are read from (`ACCESS_HOMES`). */
  ACCESS_HOME: "ws.access.home",
  // Copy and check (every table): a whole copy in pages, a page of rows, and a digest to compare against the control plane.
  /** `{epoch, rows, last, mode: "replace" | "merge"}` → `{staged, swapped}`: `replace` swaps on the last page, `merge` upserts. */
  REACH_SNAPSHOT: "person.reach.snapshot",
  SHARED_SNAPSHOT: "person.shared.snapshot",
  CONNECTIONS_SNAPSHOT: "person.connections.snapshot",
  MEMBERS_SNAPSHOT: "ws.members.snapshot",
  INVITES_SNAPSHOT: "ws.invites.snapshot",
  /** `{}` → `{count, sha}` (`accessDigest`), over live rows only. */
  REACH_DIGEST: "person.reach.digest",
  SHARED_DIGEST: "person.shared.digest",
  CONNECTIONS_DIGEST: "person.connections.digest",
  MEMBERS_DIGEST: "ws.members.digest",
  INVITES_DIGEST: "ws.invites.digest",
});

/**
 * The gateway's client for these calls (built beside `workspaceClient` in `workspaceStore/api.js`):
 *
 * - `workspaceClient(env, personalWorkspaceId).access.{reach, sharedToMe, connections}`, each with `put(rows)`,
 *   `remove(keys, at)`, `list({after, limit})`, `snapshot({epoch, rows, last, mode})`, `digest()`; plus
 *   `access.connections.revoke(grantId, at)` and `.rotate({refreshHash, next, at})`, `access.session(tokenHash)`,
 *   `access.pin(userId)` and `access.setHome(home)`. `state()` carries `access: {home, person}`.
 * - `workspaceClient(env, workspaceId).members` and `.invites` the same five calls, `members.get(userId)`, and
 *   `members.setHome(home)`.
 *
 * The person object's tables are `reach`, `shared` (`sharedToMe`) and `connections` (`ROW_KEYS`).
 *
 * Every `*.list` takes `{after, limit}` (`after` a row key from the last page, `limit` at most `MAX_LIST`) and answers
 * `{rows, next}`, `next` null on the last page. Every `*.put` and `*.snapshot` page carries at most `MAX_ROWS_PER_CALL`.
 */
export const MAX_LIST = 1000;
export const MAX_ROWS_PER_CALL = 2000;

/** A row's key in its table: what `list` pages by, `digest` sorts by, and a removal names. */
export const ROW_KEYS = Object.freeze({
  reach: (row) => (row.chatId !== undefined ? `chat:${row.chatId}` : `workspace:${row.workspaceId}`),
  shared: (row) => sharedKey(row),
  sharedToMe: (row) => sharedKey(row),
  connections: (row) => row.grantId,
  members: (row) => row.userId,
  invites: (row) => row.id,
});

/** JSON with every object's keys sorted, so two sides that hold the same rows write the same bytes. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A table's digest: `{count, sha}`, `sha` the sha256 (lowercase hex) of the canonical JSON of its live rows sorted by
 * key, each row as its `check*Row` returns it without `at` and `lastUsedAt` (when, not what), and `scopes` and `groups`
 * sorted. Both sides compute it with this function, so the parity check compares like with like.
 */
export async function accessDigest(table, rows) {
  const keyOf = ROW_KEYS[table];
  if (keyOf === undefined) throw new TypeError("not an access table");
  const sorted = [...rows]
    .map(({ at, lastUsedAt, ...row }) => ({
      ...row,
      ...(Array.isArray(row.scopes) ? { scopes: [...row.scopes].sort() } : {}),
      ...(Array.isArray(row.groups) ? { groups: [...row.groups].sort() } : {}),
    })).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const bytes = new TextEncoder().encode(canonicalJson(sorted));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { count: sorted.length, sha: [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

/* ---------------------------------- tokens ---------------------------------- */

/**
 * A token minted once a person's access lives in their object names that object: `cat1.<personalWorkspaceId>.<secret>`
 * (access) or `crt1.<personalWorkspaceId>.<secret>` (refresh), the secret 32 random bytes, base64url. The gateway goes
 * straight to the named object with the token's sha256 and nothing else.
 *
 * The id is a locator, never proof. The object answers only for a hash it holds, and the hash covers the whole token,
 * id included, so changing the id sends the hash to an object that does not hold it, and changing the secret changes
 * the hash: both get the same refusal as a token that never existed. No signature is needed because nothing is
 * believed that the object did not store.
 *
 * Tokens minted before (`cat_…`, `crt_…`) are `legacy`. A legacy access token resolves through the control plane until
 * it expires (one hour for a client's; a Tex turn's mint moves to the new format before its person is switched). A
 * legacy refresh token is found through `token:<sha256>` (`tokenIndexName`), a small object that names its person
 * object, written when the connection is copied across.
 */
export const TOKEN_PREFIXES = Object.freeze({ access: "cat1", refresh: "crt1" });
const LEGACY_PREFIXES = Object.freeze({ access: "cat_", refresh: "crt_" });
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_TOKEN = /^(cat1|crt1)\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;
/** A token hash as every table here keys it: sha256, lowercase hex. */
export const TOKEN_HASH = /^[0-9a-f]{64}$/;

/** A new token for `personalWorkspaceId`. `secret` is 43 base64url characters (32 random bytes). */
export function objectToken(kind, personalWorkspaceId, secret) {
  const prefix = TOKEN_PREFIXES[kind];
  if (prefix === undefined) throw new TypeError("a token is an access or a refresh token");
  if (typeof personalWorkspaceId !== "string" || !ID.test(personalWorkspaceId)) throw new TypeError("a token names one person object");
  if (typeof secret !== "string" || !SECRET.test(secret)) throw new TypeError("a token's secret is 32 random bytes");
  return `${prefix}.${personalWorkspaceId}.${secret}`;
}

/**
 * What a presented token says about where to look: `{format: "object", kind, personalWorkspaceId}`,
 * `{format: "legacy", kind}`, or `null` for anything else. Only shape; whether it is live is the object's answer.
 */
export function parseToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 4096) return null;
  const match = OBJECT_TOKEN.exec(token);
  if (match !== null) return { format: "object", kind: match[1] === TOKEN_PREFIXES.access ? "access" : "refresh", personalWorkspaceId: match[2] };
  if (token.startsWith(LEGACY_PREFIXES.access)) return { format: "legacy", kind: "access" };
  if (token.startsWith(LEGACY_PREFIXES.refresh)) return { format: "legacy", kind: "refresh" };
  return null;
}

/** The index object for a legacy refresh token: `token:<sha256>`, holding `{personalWorkspaceId}` and nothing else. */
export function tokenIndexName(tokenHash) {
  if (typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) throw new TypeError("an index is named by a token's sha256");
  return `token:${tokenHash}`;
}

/* ----------------------------------- rows ----------------------------------- */

/** Thrown for an access row an object will not keep. Answered as `422 refused`, like a tree row. */
export class AccessRowRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessRowRefused";
  }
}

const text = (value, max = 256) => typeof value === "string" && value !== "" && value.length <= max && !value.includes("\0");
const id = (value) => typeof value === "string" && ID.test(value);
const clock = (value) => Number.isFinite(value) && value >= 0;
const names = (value) => Array.isArray(value) && value.length <= 100 && value.every((name) => text(name, 128));
const refuse = (message) => {
  throw new AccessRowRefused(message);
};

/**
 * One workspace the person is in: `{workspaceId, slug, kind, role, groups[], pinned?, at}`. `groups` are the names of
 * the groups the person is in there, without `@`, as the workspace object's members row holds them; the person's own
 * handle is added when a session is built (it is the slug of their personal workspace's row).
 * `pinned` marks the workspace every account reaches (`@context-lc`); its `groups` are the pin reader's names.
 */
export function checkReachRow(row) {
  if (!row || typeof row !== "object") refuse("not a reach row");
  if (!id(row.workspaceId)) refuse("a reach row names its workspace");
  if (!text(row.slug, 64)) refuse("a reach row carries the workspace's handle");
  if (row.kind !== "personal" && row.kind !== "shared") refuse("a workspace is personal or shared");
  if (!ROLES.includes(row.role)) refuse("not a role");
  if (!names(row.groups ?? [])) refuse("not a list of names");
  if (row.pinned !== undefined && typeof row.pinned !== "boolean") refuse("pinned is true or false");
  if (!clock(row.at)) refuse("a row needs its writer's clock");
  return { workspaceId: row.workspaceId, slug: row.slug.toLowerCase(), kind: row.kind, role: row.role, groups: [...(row.groups ?? [])], pinned: row.pinned === true, at: row.at };
}

/** One group chat the person is in: `{chatId, role, at}`, `chatId` the chat's key (sha256 hex, as Tex's objects name it). */
export function checkChatReachRow(row) {
  if (!row || typeof row !== "object") refuse("not a chat row");
  if (typeof row.chatId !== "string" || !TOKEN_HASH.test(row.chatId)) refuse("a chat row names its chat's key");
  if (!SHARE_ROLES.includes(row.role)) refuse("not a chat role");
  if (!clock(row.at)) refuse("a row needs its writer's clock");
  return { chatId: row.chatId, role: row.role, at: row.at };
}

/**
 * One note or folder shared with the person by name from another workspace: `{fromWorkspaceId, noteId | folder, role,
 * at}`. Exactly one of `noteId` (a note's id) or `folder` (a folder row's id). A locator, not a permission: the
 * workspace object still judges every read through its own share rows.
 */
export function checkSharedRow(row) {
  if (!row || typeof row !== "object") refuse("not a shared row");
  if (!id(row.fromWorkspaceId)) refuse("a shared row names the workspace it is from");
  const hasNote = row.noteId !== undefined && row.noteId !== null;
  const hasFolder = row.folder !== undefined && row.folder !== null;
  if (hasNote === hasFolder) refuse("a shared row is one note or one folder");
  if (hasNote && !text(row.noteId, 64)) refuse("not a note id");
  if (hasFolder && !text(row.folder, 128)) refuse("not a folder id");
  if (!SHARE_ROLES.includes(row.role)) refuse("not a share role");
  if (!clock(row.at)) refuse("a row needs its writer's clock");
  return { fromWorkspaceId: row.fromWorkspaceId, ...(hasNote ? { noteId: row.noteId } : { folder: row.folder }), role: row.role, at: row.at };
}

/** A shared row's key: the workspace it is from and the one thing it names. */
export const sharedKey = (row) => `${row.fromWorkspaceId}:${row.noteId !== undefined ? `note:${row.noteId}` : `folder:${row.folder}`}`;

/**
 * One AI client's grant: `{grantId, clientId, clientName, workspaceId, scopes[], tokenHash, refreshHash,
 * previousRefreshHash?, expiresAt, status, lastUsedAt, createdAt?, machine?, at}`. `tokenHash` is null for a grant with no access token yet
 * (it resolves nothing until a refresh); `expiresAt` is 0 when none was recorded. `previousRefreshHash` is the refresh token the last
 * rotation spent: presented again, it revokes the grant. Texting clients (`context_texts`, `context_texts_group`) are
 * never held here; their checks stay with the control plane. `workspaceId` is the workspace the person connected it at, the session's default. Hashes
 * only, never a token. `clientName` is display text the client asserted and decides nothing. `createdAt` (when the
 * grant was made) and `machine` (the Context desktop app on the person's computer, as the control plane's
 * `isDesktopShellClient` decided when it copied the row) are display only, for the app's connected-apps screens, and
 * null when not known; neither decides what the grant may do.
 */
export function checkConnectionRow(row) {
  if (!row || typeof row !== "object") refuse("not a connection");
  if (!id(row.grantId)) refuse("a connection names its grant");
  if (!text(row.clientId, 256)) refuse("a connection names its client");
  if (row.clientName !== undefined && row.clientName !== null && !text(row.clientName, 256)) refuse("not a client name");
  if (!id(row.workspaceId)) refuse("a connection names the workspace it was made at");
  if (!Array.isArray(row.scopes) || row.scopes.length === 0 || !row.scopes.every((scope) => text(scope, 64))) refuse("a connection carries its scopes");
  if (row.tokenHash !== null && (typeof row.tokenHash !== "string" || !TOKEN_HASH.test(row.tokenHash))) refuse("a connection keys on its token's sha256, or null before its first refresh");
  if (typeof row.refreshHash !== "string" || !TOKEN_HASH.test(row.refreshHash)) refuse("a connection carries its refresh token's sha256");
  if (!clock(row.expiresAt)) refuse("a connection's token expires");
  if (!CONNECTION_STATES.includes(row.status)) refuse("not a connection state");
  if (row.lastUsedAt !== undefined && row.lastUsedAt !== null && !clock(row.lastUsedAt)) refuse("not a time");
  if (row.previousRefreshHash !== undefined && row.previousRefreshHash !== null && !(typeof row.previousRefreshHash === "string" && TOKEN_HASH.test(row.previousRefreshHash))) refuse("not a refresh token's sha256");
  if (row.createdAt !== undefined && row.createdAt !== null && !clock(row.createdAt)) refuse("not a time");
  if (row.machine !== undefined && row.machine !== null && typeof row.machine !== "boolean") refuse("machine is true or false");
  if (!clock(row.at)) refuse("a row needs its writer's clock");
  return {
    grantId: row.grantId,
    clientId: row.clientId,
    clientName: row.clientName ?? null,
    workspaceId: row.workspaceId,
    scopes: [...row.scopes],
    tokenHash: row.tokenHash,
    refreshHash: row.refreshHash,
    expiresAt: row.expiresAt,
    status: row.status,
    lastUsedAt: row.lastUsedAt ?? null,
    previousRefreshHash: row.previousRefreshHash ?? null,
    createdAt: row.createdAt ?? null,
    machine: row.machine ?? null,
    at: row.at,
  };
}

/** One member of a workspace: `{userId, personalWorkspaceId, role, groups[], at}`. */
export function checkMemberRow(row) {
  if (!row || typeof row !== "object") refuse("not a member");
  if (!id(row.userId)) refuse("a member names their account");
  if (!id(row.personalWorkspaceId)) refuse("a member names their person object");
  if (!ROLES.includes(row.role)) refuse("not a role");
  if (!names(row.groups ?? [])) refuse("not a list of names");
  if (!clock(row.at)) refuse("a row needs its writer's clock");
  return { userId: row.userId, personalWorkspaceId: row.personalWorkspaceId, role: row.role, groups: [...(row.groups ?? [])], at: row.at };
}

/**
 * One invitation not yet taken up: `{id, email | phone | name, role, invitedBy, expiresAt, tokenHash?, at}`. Exactly
 * one of email, phone or name (a handle, without `@`). The role is `editor` or `member`: an invite never hands over a
 * workspace. `tokenHash` is the sha256 of the invite link's token, so accepting finds the invite with no plaintext kept.
 */
export function checkInviteRow(row) {
  if (!row || typeof row !== "object") refuse("not an invite");
  if (!id(row.id)) refuse("an invite has its id");
  const given = ["email", "phone", "name"].filter((field) => row[field] !== undefined && row[field] !== null);
  if (given.length !== 1) refuse("an invite is to one email, one phone or one handle");
  const [kind] = given;
  if (kind === "email" && !(text(row.email, 320) && row.email.includes("@"))) refuse("not an email");
  if (kind === "phone" && !(typeof row.phone === "string" && /^\+[1-9][0-9]{6,14}$/.test(row.phone))) refuse("not a phone number");
  if (kind === "name" && !(typeof row.name === "string" && /^[a-z0-9][a-z0-9-]{1,64}$/.test(row.name))) refuse("not a handle");
  if (row.role !== "editor" && row.role !== "member") refuse("an invite is to edit or to view, never to own");
  if (!id(row.invitedBy)) refuse("an invite names who sent it");
  if (!clock(row.expiresAt)) refuse("an invite expires");
  if (row.tokenHash !== undefined && row.tokenHash !== null && !(typeof row.tokenHash === "string" && TOKEN_HASH.test(row.tokenHash))) refuse("not an invite token's sha256");
  if (!clock(row.at)) refuse("a row needs its writer's clock");
  const invitee = kind === "email" ? { email: row.email.toLowerCase() } : kind === "phone" ? { phone: row.phone } : { name: row.name };
  return { id: row.id, ...invitee, role: row.role, invitedBy: row.invitedBy, expiresAt: row.expiresAt, tokenHash: row.tokenHash ?? null, at: row.at };
}

/* --------------------------- writes across objects --------------------------- */

/**
 * A change that touches two objects: the authority's write first, then the copy, and done only when both landed.
 *
 * - Membership (invite accepted, member removed, role or groups changed): the workspace object is the authority
 *   (`ws.members.*`), the member's person object holds the copy (`person.reach.*`).
 * - A connection (made, refreshed, revoked): the person object is the authority and nothing else holds it.
 * - A share by name: the workspace object's share row is the authority, the person's `sharedToMe` the copy.
 *
 * The authority is written first because it is what reads check: a removed member is refused by the workspace object
 * on their next request even while the copy is still on its way. The copy is retried, and the call fails (never
 * reports done) while it has not landed, so the caller tries again. Both writes carry the same `at`, so a retry, or a
 * late copy, never rolls a newer change back.
 *
 * `authority` and `copy` are functions of no arguments that write and throw on failure. `tries` bounds the copy's.
 */
export async function writeBoth({ authority, copy, tries = 3 }) {
  if (typeof authority !== "function" || typeof copy !== "function") throw new TypeError("a write across objects has an authority and a copy");
  const first = await authority();
  let last = null;
  for (let attempt = 0; attempt < Math.max(1, tries); attempt += 1) {
    try {
      const second = await copy();
      return { authority: first, copy: second };
    } catch (error) {
      last = error;
    }
  }
  throw new AccessCopyBehind(last);
}

/** The authority's write landed and the copy did not: the change is not done, and is retried whole. */
export class AccessCopyBehind extends Error {
  constructor(cause) {
    super("the copy of an access change did not land");
    this.name = "AccessCopyBehind";
    this.cause = cause;
  }
}
