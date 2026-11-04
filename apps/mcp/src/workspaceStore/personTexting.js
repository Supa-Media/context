/**
 * A person's texting with Tex, kept in their person object
 * (`docs/decisions/texting-assistant/texting-in-objects.md`): which phones are linked (as keyed hashes, never the
 * number), whether texting is paused, the scopes their role allows, their zone, their Tex style and the identity block
 * Tex is told every turn. The object is the authority for the phone link: a pause or an unlink lands here first and
 * revokes every live texting token at once, so a removed phone is refused on its very next text.
 *
 * `open` is the session a text runs under: the object refuses any phone it does not hold, and otherwise keeps a
 * short-lived `context_texts` connection whose token the gateway minted, which `sessionFor` then answers like any
 * other. Pure over a `sql` with the Durable Object's shape, like `personRows.js`.
 */

import { ACCESS_HOMES, AccessRowRefused, TOKEN_HASH } from "./access.js";

/** The texting client, as the control plane names it (`TEXTS_CLIENT_ID`). */
export const TEXTS_CLIENT_ID = "context_texts";
/** A texting connection's grant id: the object's own, never a control-plane id. */
export const TEXTING_GRANT_PREFIX = "texts_";
/** How long a texting token lives, as the control plane's `TEXTS_GRANT_TTL_MS`. */
export const TEXTING_TOKEN_MS = 15 * 60 * 1000;

export const TEXTING_OPS = Object.freeze({
  /** `{record}` → `{kept, revoked}`: the whole texting record, kept unless the one held is newer. */
  PUT: "person.texting.put",
  /** `{}` → `{record}` or `{record: null}`. */
  GET: "person.texting.get",
  /** `{phoneHash, tokenHash, refreshHash, expiresAt, at}` → `{status: "linked", ...}` or `{status: "unlinked"}`. The gateway's own. */
  OPEN: "person.texting.open",
});

const SCHEMA = [`CREATE TABLE IF NOT EXISTS texting_record (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL, at INTEGER NOT NULL)`];

const MAX_PHONES = 10;
const MAX_SCOPES = 20;
const MAX_SETTINGS_BYTES = 4096;
const MAX_IDENTITY_BYTES = 8192;

const refuse = (why) => {
  throw new AccessRowRefused(why);
};
const clock = (value) => Number.isSafeInteger(value) && value >= 0;
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/** `{phoneHashes[], paused, scopes[], timeZone, settings, identity, at}`: hashes only, bounded, nothing that decides past what it says. */
export function checkTextingRecord(record) {
  if (!plainObject(record)) refuse("not a texting record");
  const { phoneHashes, paused, scopes, timeZone = null, settings = null, identity = null, at } = record;
  if (!Array.isArray(phoneHashes) || phoneHashes.length > MAX_PHONES || !phoneHashes.every((hash) => typeof hash === "string" && TOKEN_HASH.test(hash))) refuse("a texting record keys its phones by their hashes");
  if (typeof paused !== "boolean") refuse("a texting record says whether it is paused");
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES || !scopes.every((scope) => typeof scope === "string" && scope !== "" && scope.length <= 64)) refuse("a texting record carries its scopes");
  if (timeZone !== null && (typeof timeZone !== "string" || timeZone === "" || timeZone.length > 64)) refuse("not a time zone");
  if (settings !== null && (!plainObject(settings) || jsonBytes(settings) > MAX_SETTINGS_BYTES)) refuse("not a texting style");
  if (identity !== null && (!plainObject(identity) || jsonBytes(identity) > MAX_IDENTITY_BYTES)) refuse("not an identity");
  if (!clock(at)) refuse("a row needs its writer's clock");
  return { phoneHashes: [...new Set(phoneHashes)], paused, scopes: [...scopes], timeZone, settings, identity, at };
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** `person` is this object's `personRows(sql)`. */
export function personTexting(sql, person) {
  for (const statement of SCHEMA) sql.exec(statement);

  function get() {
    const held = all(sql.exec(`SELECT record FROM texting_record WHERE id = 1`))[0];
    return held === undefined ? null : JSON.parse(held.record);
  }

  /** Every live texting connection revoked, its token hash cleared: nothing resolves through it again. */
  function revokeAll(at) {
    let revoked = 0;
    for (const row of person.live("connections")) {
      if (row.clientId !== TEXTS_CLIENT_ID || row.status !== "active") continue;
      if (person.revoke(row.grantId, at).revoked) revoked += 1;
    }
    return revoked;
  }

  function put(record) {
    const checked = checkTextingRecord(record);
    const held = get();
    if (held !== null && held.at > checked.at) return { kept: false, revoked: 0 };
    sql.exec(
      `INSERT INTO texting_record (id, record, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record, at = excluded.at`,
      JSON.stringify(checked),
      checked.at,
    );
    // A phone taken away, or texting paused: every token a text opened is refused from this moment.
    const dropped = held !== null && held.phoneHashes.some((hash) => !checked.phoneHashes.includes(hash));
    const revoked = checked.paused || checked.phoneHashes.length === 0 || dropped ? revokeAll(checked.at) : 0;
    return { kept: true, revoked };
  }

  /**
   * The session for one text. Every miss is the same `{status: "unlinked"}`: no record, a phone this person never
   * linked, texting paused, a person not switched yet, or no personal workspace of their own in reach.
   */
  function open({ phoneHash, tokenHash, refreshHash, expiresAt, at } = {}, now = Date.now()) {
    const miss = { status: "unlinked" };
    if (typeof phoneHash !== "string" || !TOKEN_HASH.test(phoneHash)) return miss;
    if (typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) refuse("a session keys on its token's sha256");
    if (typeof refreshHash !== "string" || !TOKEN_HASH.test(refreshHash) || refreshHash === tokenHash) refuse("a texting session carries a refresh hash nobody holds");
    if (!clock(expiresAt) || expiresAt <= now || expiresAt > now + TEXTING_TOKEN_MS + 60_000) refuse("a texting token lives fifteen minutes");
    if (person.home() !== ACCESS_HOMES.OBJECT || person.person() === null) return miss;
    const record = get();
    if (record === null || record.paused || record.scopes.length === 0 || !record.phoneHashes.includes(phoneHash)) return miss;
    const own = person.live("reach").find((row) => row.workspaceId !== undefined && row.kind === "personal" && row.role === "owner" && !row.pinned);
    if (own === undefined) return miss;
    sweep(now);
    const grantId = `${TEXTING_GRANT_PREFIX}${tokenHash.slice(0, 32)}`;
    person.keepTexting({
      grantId,
      clientId: TEXTS_CLIENT_ID,
      clientName: "Texts",
      workspaceId: own.workspaceId,
      scopes: record.scopes,
      tokenHash,
      refreshHash,
      expiresAt,
      status: "active",
      createdAt: now,
      at: Number.isFinite(at) ? at : now,
    });
    return { status: "linked", grantId, workspaceId: own.workspaceId, scopes: record.scopes, timeZone: record.timeZone, settings: record.settings, identity: record.identity };
  }

  /** Texting connections past their expiry or revoked are dropped outright: one text makes one, so they would only pile up. */
  function sweep(now) {
    const stale = person.live("connections").filter((row) => row.clientId === TEXTS_CLIENT_ID && (row.status !== "active" || row.expiresAt <= now));
    if (stale.length > 0) person.dropTexting(stale.map((row) => row.grantId));
  }

  return { get, put, open, revokeAll };
}
