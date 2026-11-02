/**
 * A person object's access tables (`workspaceStore/access.js` has the contract): `reach`, `sharedToMe` and
 * `connections`, kept in the person's personal workspace's own object beside its notes. Pure over a `sql` with the
 * Durable Object's shape, so the Node tests run it on `node:sqlite` and the object runs it as it is.
 *
 * One generic table per kind: a row is stored as its checked JSON under its key, with its writer's clock; an older
 * write is ignored and a removal leaves a tombstone at its clock, so a late copy never brings a row back.
 */

import {
  ACCESS_HOMES,
  AccessRowRefused,
  MAX_LIST,
  MAX_ROWS_PER_CALL,
  ROW_KEYS,
  TOKEN_HASH,
  accessDigest,
  checkChatReachRow,
  checkConnectionRow,
  checkReachRow,
  checkSharedRow,
  isAccessHome,
} from "./access.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS access_rows (tbl TEXT NOT NULL, key TEXT NOT NULL, row TEXT, at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0, token_hash TEXT, refresh_hash TEXT, PRIMARY KEY (tbl, key))`,
  `CREATE INDEX IF NOT EXISTS access_rows_token ON access_rows (token_hash)`,
  `CREATE INDEX IF NOT EXISTS access_rows_refresh ON access_rows (refresh_hash)`,
  `CREATE TABLE IF NOT EXISTS access_stage (tbl TEXT NOT NULL, epoch TEXT NOT NULL, key TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (tbl, epoch, key))`,
  `CREATE TABLE IF NOT EXISTS access_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Refresh tokens already rotated away: presenting one again means it leaked, and the whole grant is revoked.
  `CREATE TABLE IF NOT EXISTS access_spent (refresh_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL)`,
];

/**
 * Clients whose sessions carry checks only the control plane runs today (a texting number's pause, a group chat's
 * members): their connections are never held here, so their tokens are always answered by the control plane.
 */
export const CONTROL_PLANE_CLIENTS = new Set(["context_texts", "context_texts_group"]);
/** The app's own client: its sessions carry the names the person answers to in every workspace. */
const CONSOLE_CLIENT_ID = "context_console";
/** The most workspaces one session carries, as the control plane's `MAX_SESSION_CONTEXTS`; the pin is added after. */
export const MAX_SESSION_CONTEXTS = 50;

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function checkReach(row) {
  return row && typeof row === "object" && row.chatId !== undefined ? checkChatReachRow(row) : checkReachRow(row);
}
function checkConnection(row) {
  const checked = checkConnectionRow(row);
  if (CONTROL_PLANE_CLIENTS.has(checked.clientId)) throw new AccessRowRefused("a texting client's connection stays with the control plane");
  return checked;
}
const CHECKS = { reach: checkReach, shared: checkSharedRow, connections: checkConnection };
export const PERSON_TABLES = Object.freeze(Object.keys(CHECKS));

export function personRows(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const meta = (name) => all(sql.exec(`SELECT value FROM access_meta WHERE name = ?`, name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec(`INSERT INTO access_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`, name, value);
  const tableOf = (tbl) => {
    if (!Object.hasOwn(CHECKS, tbl)) throw new AccessRowRefused("not a person table");
    return tbl;
  };

  /** Keep one checked row unless the one held is newer. */
  function keep(tbl, checked) {
    const key = ROW_KEYS[tbl](checked);
    const held = all(sql.exec(`SELECT at FROM access_rows WHERE tbl = ? AND key = ?`, tbl, key))[0];
    if (held !== undefined && Number(held.at) > checked.at) return false;
    const tokenHash = tbl === "connections" ? checked.tokenHash : null;
    const refreshHash = tbl === "connections" ? checked.refreshHash : null;
    sql.exec(
      `INSERT INTO access_rows (tbl, key, row, at, gone, token_hash, refresh_hash) VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(tbl, key) DO UPDATE SET row = excluded.row, at = excluded.at, gone = 0, token_hash = excluded.token_hash, refresh_hash = excluded.refresh_hash`,
      tbl, key, JSON.stringify(checked), checked.at, tokenHash, refreshHash,
    );
    return true;
  }

  function put(tbl, rows) {
    tableOf(tbl);
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_CALL) throw new AccessRowRefused(`a put carries at most ${MAX_ROWS_PER_CALL} rows`);
    const checked = rows.map((row) => CHECKS[tbl](row));
    let kept = 0;
    for (const row of checked) if (keep(tbl, row)) kept += 1;
    return { kept };
  }

  function remove(tbl, keys, at) {
    tableOf(tbl);
    if (!Array.isArray(keys) || keys.length > MAX_ROWS_PER_CALL || !keys.every((key) => typeof key === "string" && key !== "")) throw new AccessRowRefused("a removal names its rows");
    if (!Number.isFinite(at)) throw new AccessRowRefused("a removal needs its writer's clock");
    let removed = 0;
    for (const key of keys) {
      const held = all(sql.exec(`SELECT at FROM access_rows WHERE tbl = ? AND key = ?`, tbl, key))[0];
      if (held !== undefined && Number(held.at) > at) continue;
      sql.exec(
        `INSERT INTO access_rows (tbl, key, row, at, gone, token_hash, refresh_hash) VALUES (?, ?, NULL, ?, 1, NULL, NULL)
         ON CONFLICT(tbl, key) DO UPDATE SET row = NULL, at = excluded.at, gone = 1, token_hash = NULL, refresh_hash = NULL`,
        tbl, key, at,
      );
      removed += 1;
    }
    return { removed };
  }

  function live(tbl) {
    return all(sql.exec(`SELECT row FROM access_rows WHERE tbl = ? AND gone = 0 ORDER BY key`, tbl)).map((held) => JSON.parse(held.row));
  }

  function list(tbl, { after = null, limit = MAX_LIST } = {}) {
    tableOf(tbl);
    const size = Math.max(1, Math.min(MAX_LIST, Number.isFinite(limit) ? Math.floor(limit) : MAX_LIST));
    const held = all(sql.exec(`SELECT key, row FROM access_rows WHERE tbl = ? AND gone = 0 AND key > ? ORDER BY key LIMIT ?`, tbl, typeof after === "string" ? after : "", size + 1));
    const page = held.slice(0, size);
    const rows = page.map((entry) => JSON.parse(entry.row));
    return { rows: tbl === "connections" ? rows.map(withoutHashes) : rows, next: held.length > size ? page[page.length - 1].key : null };
  }

  /** A whole copy in pages: staged under `epoch`, swapped in on the last page (`replace`) or upserted (`merge`). */
  function snapshot(tbl, { epoch, rows, last = false, mode = "replace" }) {
    tableOf(tbl);
    if (typeof epoch !== "string" || epoch === "" || epoch.length > 64) throw new AccessRowRefused("a copy names its epoch");
    if (mode !== "replace" && mode !== "merge") throw new AccessRowRefused("a copy replaces or merges");
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_CALL) throw new AccessRowRefused(`a page carries at most ${MAX_ROWS_PER_CALL} rows`);
    const checked = rows.map((row) => CHECKS[tbl](row));
    sql.exec(`DELETE FROM access_stage WHERE tbl = ? AND epoch <> ?`, tbl, epoch);
    for (const row of checked) {
      sql.exec(`INSERT INTO access_stage (tbl, epoch, key, row) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, epoch, key) DO UPDATE SET row = excluded.row`, tbl, epoch, ROW_KEYS[tbl](row), JSON.stringify(row));
    }
    const staged = Number(all(sql.exec(`SELECT COUNT(*) AS n FROM access_stage WHERE tbl = ? AND epoch = ?`, tbl, epoch))[0]?.n ?? 0);
    if (!last) return { staged, swapped: false };
    const incoming = all(sql.exec(`SELECT key, row FROM access_stage WHERE tbl = ? AND epoch = ?`, tbl, epoch)).map((entry) => JSON.parse(entry.row));
    if (mode === "replace") {
      const wanted = new Set(incoming.map((row) => ROW_KEYS[tbl](row)));
      const stale = all(sql.exec(`SELECT key, at FROM access_rows WHERE tbl = ? AND gone = 0`, tbl)).filter((entry) => !wanted.has(entry.key));
      for (const entry of stale) remove(tbl, [entry.key], Math.max(Number(entry.at), Date.now()));
    }
    for (const row of incoming) keep(tbl, row);
    sql.exec(`DELETE FROM access_stage WHERE tbl = ?`, tbl);
    return { staged, swapped: true };
  }

  async function digest(tbl) {
    tableOf(tbl);
    return await accessDigest(tbl, live(tbl));
  }

  const connectionBy = (column, hash) => {
    if (typeof hash !== "string" || !TOKEN_HASH.test(hash)) return null;
    const held = all(sql.exec(`SELECT row FROM access_rows WHERE tbl = 'connections' AND gone = 0 AND ${column} = ?`, hash))[0];
    return held === undefined ? null : JSON.parse(held.row);
  };

  /** Revoke one grant: kept, marked revoked, its token hashes cleared so nothing resolves through it again. */
  function revoke(grantId, at) {
    if (typeof grantId !== "string" || grantId === "") throw new AccessRowRefused("a revocation names its grant");
    if (!Number.isFinite(at)) throw new AccessRowRefused("a revocation needs its writer's clock");
    const held = all(sql.exec(`SELECT row, at FROM access_rows WHERE tbl = 'connections' AND key = ? AND gone = 0`, grantId))[0];
    if (held === undefined) return { revoked: false };
    const row = JSON.parse(held.row);
    if (row.status === "revoked") return { revoked: true };
    const next = { ...row, status: "revoked", at: Math.max(at, Number(held.at)) };
    sql.exec(`UPDATE access_rows SET row = ?, at = ?, token_hash = NULL, refresh_hash = NULL WHERE tbl = 'connections' AND key = ?`, JSON.stringify(next), next.at, grantId);
    return { revoked: true };
  }

  /**
   * A refresh: the presented refresh hash is spent and the next pair takes over, in one call. A refresh hash already
   * spent revokes its grant (OAuth 2.1 rotation: a replayed refresh token leaked). `null` for anything that is not live.
   */
  function rotate({ refreshHash, next, at }, now = Date.now()) {
    if (typeof refreshHash !== "string" || !TOKEN_HASH.test(refreshHash)) return { connection: null };
    const spent = all(sql.exec(`SELECT grant_id FROM access_spent WHERE refresh_hash = ?`, refreshHash))[0];
    if (spent !== undefined) {
      revoke(spent.grant_id, Number.isFinite(at) ? at : now);
      return { connection: null };
    }
    const row = connectionBy("refresh_hash", refreshHash);
    if (row === null || row.status !== "active") return { connection: null };
    const scopes = Array.isArray(next?.scopes) && next.scopes.length > 0 ? next.scopes.filter((scope) => row.scopes.includes(scope)) : row.scopes;
    if (scopes.length === 0) return { connection: null };
    const rotated = checkConnection({ ...row, scopes, tokenHash: next?.tokenHash, refreshHash: next?.refreshHash, expiresAt: next?.expiresAt, at: Math.max(Number.isFinite(at) ? at : now, row.at) });
    sql.exec(`INSERT INTO access_spent (refresh_hash, grant_id) VALUES (?, ?) ON CONFLICT(refresh_hash) DO NOTHING`, refreshHash, row.grantId);
    keep("connections", rotated);
    return { connection: withoutHashes(rotated) };
  }

  return {
    put,
    remove,
    list,
    snapshot,
    digest,
    live,
    connectionByToken: (hash) => connectionBy("token_hash", hash),
    connectionByRefresh: (hash) => connectionBy("refresh_hash", hash),
    /** Which person this object belongs to: set once, refused if a different one is named after. */
    pin(userId) {
      if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new AccessRowRefused("a person object names its account");
      const held = meta("person.userId");
      if (held !== null && held !== userId) throw new AccessRowRefused("this object belongs to someone else");
      if (held === null) setMeta("person.userId", userId);
      return { userId };
    },
    rotate,
    revoke,
    person: () => meta("person.userId"),
    home: () => meta("person.home") ?? ACCESS_HOMES.CONVEX,
    setHome(home) {
      if (!isAccessHome(home)) throw new AccessRowRefused("not an access home");
      if (home === ACCESS_HOMES.OBJECT && meta("person.userId") === null) throw new AccessRowRefused("a person object is pinned before it answers");
      setMeta("person.home", home);
      return home;
    },
  };
}

/** A connection as a listing shows it: never a hash, so a list can be handed to a screen. */
export function withoutHashes({ tokenHash, refreshHash, ...row }) {
  return row;
}

/**
 * The control plane's session payload (`/gateway/session`, read by `sessionPayload.js` `normalizeSession`) for a token
 * hash, or `null`. Every miss is the same `null`: no such token, revoked, expired, a person not switched yet, or the
 * workspace the connection was made at no longer in reach (the control plane's membership rule).
 */
export function sessionFor(store, tokenHash, now = Date.now()) {
  if (store.home() !== ACCESS_HOMES.OBJECT) return null;
  const actorUserId = store.person();
  if (actorUserId === null) return null;
  const connection = store.connectionByToken(tokenHash);
  if (connection === null || connection.status !== "active" || !(connection.expiresAt > now)) return null;
  const reach = store.live("reach").filter((row) => row.workspaceId !== undefined);
  const own = reach.find((row) => row.workspaceId === connection.workspaceId && !row.pinned);
  if (own === undefined) return null;
  const withNames = connection.clientId === CONSOLE_CLIENT_ID;
  // The person's own handle is a name they answer to everywhere: their personal workspace's slug.
  const handle = reach.find((row) => row.kind === "personal" && row.role === "owner" && !row.pinned)?.slug ?? null;
  const namesOf = (row) => (row.pinned ? row.groups : withNames ? [...row.groups, ...(handle === null ? [] : [handle])] : []);
  const entry = (row) => ({
    workspaceId: row.workspaceId,
    slug: row.slug,
    role: row.role,
    kind: row.kind,
    ...(namesOf(row).length > 0 ? { grantedNames: [...new Set(namesOf(row))] } : {}),
  });
  const others = reach.filter((row) => row !== own && !row.pinned).slice(0, MAX_SESSION_CONTEXTS - 1);
  const pinned = reach.filter((row) => row.pinned && row.workspaceId !== own.workspaceId && !others.some((other) => other.workspaceId === row.workspaceId));
  return {
    grantId: connection.grantId,
    clientId: connection.clientId,
    clientName: connection.clientName,
    actorUserId,
    scopes: connection.scopes,
    workspaces: [own, ...others, ...pinned.slice(0, 1)].map(entry),
    defaultWorkspaceId: own.workspaceId,
    expiresAt: connection.expiresAt,
    toolsListedAt: null,
  };
}
