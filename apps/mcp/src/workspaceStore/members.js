/**
 * Who belongs to a workspace, kept in its own object: the workspace side of the access contract
 * (`workspaceStore/access.js`; decided by the owner, 2026-11-01, `docs/decisions/identity-and-access/access-in-objects.md`).
 * Pure over a Durable Object `sql`, like `rows.js`, so the Node tests run it on `node:sqlite`.
 *
 * - **Members**: `checkMemberRow` rows, `{userId, personalWorkspaceId, role, groups, at}`, keyed by `userId`. `groups`
 *   are the workspace's group names the person is in, without `@`, as the control plane's `workspaceGroups.name`.
 * - **Invites**: `checkInviteRow` rows, keyed by `id`, to one email, phone or handle, with an optional `tokenHash` (the
 *   invitation token's sha256) so accepting can find one here; a token itself is never kept. Never `owner`.
 * - **Group names**: every group name a member row has ever carried, never forgotten, so a grant still carrying one
 *   is recognised as this workspace's group and judged by the member's groups now (`judgedReader`).
 * - **Home**: where this workspace's members are read from (`ACCESS_HOMES`): `convex` (the control plane decides;
 *   nothing here is used) or `object` (this object decides, on every read).
 * - **Reach outbox**: the person-object writes a member change still owes (`serveMembers.js`).
 *
 * Every write carries the writer's clock (`at`): an older write than the one held is ignored, and a removal leaves a
 * tombstone so a late upsert cannot bring a member back.
 */

import { ACCESS_HOMES, AccessRowRefused, accessDigest, checkInviteRow, checkMemberRow, isAccessHome, MAX_LIST, MAX_ROWS_PER_CALL, TOKEN_HASH } from "./access.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_members (user_id TEXT PRIMARY KEY, row TEXT, at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ws_invites (id TEXT PRIMARY KEY, row TEXT, token_hash TEXT, at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ws_invites_token ON ws_invites (token_hash)`,
  `CREATE TABLE IF NOT EXISTS ws_group_names (name TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS ws_member_stage (epoch TEXT NOT NULL, table_name TEXT NOT NULL, entry_key TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (epoch, table_name, entry_key))`,
  `CREATE TABLE IF NOT EXISTS ws_reach_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, workspace TEXT NOT NULL, op TEXT NOT NULL, body TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ws_member_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** A group name as rows and grants spell it: lowercase, without `@`. */
const groupName = (name) => name.trim().replace(/^@/, "").toLowerCase();

function memberRow(row) {
  const checked = checkMemberRow(row);
  return { ...checked, groups: [...new Set(checked.groups.map(groupName))].sort() };
}

function inviteRow(row) {
  // `checkInviteRow` refuses `owner`: an invitation never hands a workspace over.
  const checked = checkInviteRow(row);
  return { checked, tokenHash: checked.tokenHash };
}

const checkRow = (name, row) => (name === "members" ? { checked: memberRow(row), tokenHash: null } : inviteRow(row));

export function workspaceMembers(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const meta = (name) => all(sql.exec("SELECT value FROM ws_member_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_member_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);

  const TABLES = {
    members: { table: "ws_members", key: "user_id", keyOf: (row) => row.userId },
    invites: { table: "ws_invites", key: "id", keyOf: (row) => row.id },
  };
  const tableOf = (name) => {
    if (!Object.hasOwn(TABLES, name)) throw new AccessRowRefused("not a membership table");
    return TABLES[name];
  };
  const heldAt = (name, key) => {
    const { table, key: column } = tableOf(name);
    const held = all(sql.exec(`SELECT at FROM ${table} WHERE ${column} = ?`, key))[0];
    return held ? Number(held.at) : null;
  };
  const live = (name) => {
    const { table, key } = tableOf(name);
    return all(sql.exec(`SELECT row FROM ${table} WHERE gone = 0 ORDER BY ${key}`)).map((entry) => JSON.parse(entry.row));
  };

  /** Keep one checked row unless the one held is newer. */
  const write = (name, checked, tokenHash = null) => {
    const key = tableOf(name).keyOf(checked);
    const held = heldAt(name, key);
    if (held !== null && held > checked.at) return false;
    if (name === "members") {
      sql.exec(
        "INSERT INTO ws_members (user_id, row, at, gone) VALUES (?, ?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET row = excluded.row, at = excluded.at, gone = 0",
        key, JSON.stringify(checked), checked.at,
      );
      for (const group of checked.groups) sql.exec("INSERT INTO ws_group_names (name) VALUES (?) ON CONFLICT(name) DO NOTHING", group);
    } else {
      sql.exec(
        "INSERT INTO ws_invites (id, row, token_hash, at, gone) VALUES (?, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET row = excluded.row, token_hash = excluded.token_hash, at = excluded.at, gone = 0",
        key, JSON.stringify(checked), tokenHash, checked.at,
      );
    }
    return true;
  };

  /** A tombstone at `at` unless the row held is newer. */
  const tombstone = (name, key, at) => {
    if (typeof key !== "string" || !KEY.test(key)) return false;
    const { table, key: column } = tableOf(name);
    const held = heldAt(name, key);
    if (held !== null && held > at) return false;
    if (held !== null) sql.exec(`UPDATE ${table} SET gone = 1, at = ?${name === "invites" ? ", token_hash = NULL" : ""} WHERE ${column} = ?`, at, key);
    else sql.exec(`INSERT INTO ${table} (${column}, row, at, gone) VALUES (?, NULL, ?, 1)`, key, at);
    return true;
  };

  const api = {
    /** Upsert rows of one table (`members` | `invites`); returns the checked rows kept (older ones are skipped). */
    put(name, rows) {
      tableOf(name);
      if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_CALL) throw new AccessRowRefused(`rows come as a list of at most ${MAX_ROWS_PER_CALL}`);
      const checked = rows.map((row) => checkRow(name, row));
      return checked.filter(({ checked: row, tokenHash }) => write(name, row, tokenHash)).map(({ checked: row }) => row);
    },
    /** Remove by key (`userId` | invite `id`) at the writer's clock, leaving tombstones; returns the keys removed. */
    remove(name, keys, at) {
      tableOf(name);
      if (!Array.isArray(keys) || keys.length > MAX_ROWS_PER_CALL || !Number.isFinite(at) || at < 0) throw new AccessRowRefused("removals come as keys and a clock");
      return keys.filter((key) => tombstone(name, key, at));
    },
    /** A page of live rows in key order: `{rows, next}`, `next` null on the last page. */
    list(name, { after = null, limit = MAX_LIST } = {}) {
      const { table, key, keyOf } = tableOf(name);
      const size = Math.max(1, Math.min(MAX_LIST, Number(limit) || MAX_LIST));
      const page = all(
        typeof after === "string"
          ? sql.exec(`SELECT row FROM ${table} WHERE gone = 0 AND ${key} > ? ORDER BY ${key} LIMIT ?`, after, size + 1)
          : sql.exec(`SELECT row FROM ${table} WHERE gone = 0 ORDER BY ${key} LIMIT ?`, size + 1),
      ).map((entry) => JSON.parse(entry.row));
      const more = page.length > size;
      const rows = more ? page.slice(0, size) : page;
      return { rows, next: more ? keyOf(rows[rows.length - 1]) : null };
    },
    /** `{count, sha}` over the live rows (`accessDigest`), the same function the control plane's copy is digested by. */
    async digest(name) {
      return await accessDigest(name, live(name));
    },
    /**
     * One page of a whole copy. `replace`: pages are staged under `epoch` and the last swaps them in, leaving a
     * tombstone for every row the copy does not name. `merge`: each page is an ordinary `put`.
     */
    snapshot(name, { epoch, rows, last = false, mode = "replace" } = {}) {
      const { table, key, keyOf } = tableOf(name);
      if (mode === "merge") return { staged: api.put(name, rows).length, swapped: false };
      if (mode !== "replace" || typeof epoch !== "string" || !KEY.test(epoch)) throw new AccessRowRefused("a snapshot needs its epoch and a mode");
      if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_CALL) throw new AccessRowRefused(`rows come as a list of at most ${MAX_ROWS_PER_CALL}`);
      for (const row of rows) {
        checkRow(name, row);
        sql.exec(
          "INSERT INTO ws_member_stage (epoch, table_name, entry_key, row) VALUES (?, ?, ?, ?) ON CONFLICT(epoch, table_name, entry_key) DO UPDATE SET row = excluded.row",
          epoch, name, keyOf(row), JSON.stringify(row),
        );
      }
      if (last !== true) return { staged: rows.length, swapped: false };
      const staged = all(sql.exec("SELECT row FROM ws_member_stage WHERE epoch = ? AND table_name = ?", epoch, name)).map((entry) => JSON.parse(entry.row));
      const named = new Set(staged.map(keyOf));
      const clock = Math.max(0, ...staged.map((row) => row.at));
      // The copy is the authority's whole answer: what it does not name is gone, and what it names lands, whatever
      // the clocks held here say (a held clock is kept when newer, so a later write is still judged against it).
      const dropped = all(sql.exec(`SELECT ${key} AS k, at FROM ${table} WHERE gone = 0`)).filter((entry) => !named.has(entry.k));
      for (const entry of dropped) sql.exec(`UPDATE ${table} SET gone = 1, at = ? WHERE ${key} = ?`, Math.max(clock, Number(entry.at)), entry.k);
      for (const row of staged) {
        const { checked, tokenHash } = checkRow(name, row);
        const held = heldAt(name, keyOf(checked));
        write(name, held !== null && held > checked.at ? { ...checked, at: held } : checked, tokenHash);
      }
      sql.exec("DELETE FROM ws_member_stage WHERE table_name = ?", name);
      return { staged: rows.length, swapped: true, rows: staged.length, dropped: dropped.length };
    },
    /** The live member row, or null. */
    member(userId) {
      if (typeof userId !== "string" || !KEY.test(userId)) return null;
      const row = all(sql.exec("SELECT row FROM ws_members WHERE user_id = ? AND gone = 0", userId))[0];
      return row ? JSON.parse(row.row) : null;
    },
    /** Every group name a member row here has carried, as `@name`. */
    groupTokens() {
      return new Set(all(sql.exec("SELECT name FROM ws_group_names")).map((row) => `@${row.name}`));
    },
    inviteByToken(tokenHash) {
      if (typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) return null;
      const row = all(sql.exec("SELECT row FROM ws_invites WHERE token_hash = ? AND gone = 0", tokenHash))[0];
      return row ? JSON.parse(row.row) : null;
    },
    home() {
      const value = meta("home");
      return isAccessHome(value) ? value : ACCESS_HOMES.CONVEX;
    },
    setHome(home) {
      if (!isAccessHome(home)) throw new AccessRowRefused("a workspace's members are read from convex or object");
      setMeta("home", home);
      return home;
    },
    /** A JSON value kept beside the members (the workspace's handle and kind), or null. */
    getMeta(name) {
      const value = meta(`json:${name}`);
      return value === null ? null : JSON.parse(value);
    },
    setMeta(name, value) {
      setMeta(`json:${name}`, JSON.stringify(value));
    },
    state() {
      const count = (table) => Number(all(sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE gone = 0`))[0]?.n ?? 0);
      return { home: api.home(), members: count("ws_members"), invites: count("ws_invites"), reachPending: api.pending().length };
    },
    /** Queue a person-object write owed by a member change; a newer one for the same person supersedes it. */
    owe(person, workspace, op, body) {
      sql.exec("DELETE FROM ws_reach_outbox WHERE person = ? AND workspace = ?", person, workspace);
      sql.exec("INSERT INTO ws_reach_outbox (person, workspace, op, body) VALUES (?, ?, ?, ?)", person, workspace, op, JSON.stringify(body));
    },
    pending() {
      return all(sql.exec("SELECT * FROM ws_reach_outbox ORDER BY seq")).map((row) => ({
        seq: Number(row.seq),
        person: row.person,
        op: row.op,
        body: JSON.parse(row.body),
        tries: Number(row.tries),
      }));
    },
    settled(seq) {
      sql.exec("DELETE FROM ws_reach_outbox WHERE seq = ?", seq);
    },
    failed(seq) {
      sql.exec("UPDATE ws_reach_outbox SET tries = tries + 1 WHERE seq = ?", seq);
    },
  };
  return api;
}

/**
 * The reader a note check judges, where this object decides access (home `object`).
 *
 * The gateway passes the grant's `scope` and its row tokens (`@name` each); the object adds who the person is here.
 * Not a live member: nobody (`null`), whatever the grant says, so a removed person is refused on their next request
 * even while their own object still lists this workspace. A member: `private` only for an owner whose grant asked for
 * it, else `team`; the tokens are the grant's minus every group name this workspace's members have carried, plus the
 * groups the member is in now, so a grant or a person's copy from before a removal from a group cannot carry it.
 *
 * @returns {{scope: "private"|"team", tokens: Set<string>}|null}
 */
export function judgedReader(members, { userId, scope, groups }) {
  const member = members.member(userId);
  if (member === null) return null;
  const own = members.groupTokens();
  const tokens = new Set((Array.isArray(groups) ? groups : []).filter((token) => typeof token === "string" && !own.has(token)));
  for (const group of member.groups) tokens.add(`@${group}`);
  return { scope: member.role === "owner" && scope === "private" ? "private" : "team", tokens };
}
