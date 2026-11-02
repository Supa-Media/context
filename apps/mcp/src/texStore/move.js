/**
 * Moving a Tex store to an object placed in eastern North America (decided by
 * the owner, 2026-11-01: "let's pin all to us east").
 *
 * A Durable Object is placed once, near whatever first asked for it, and never
 * moves. Tex's objects were first asked for without a location hint, and the
 * six busiest were placed in London and Amsterdam while the gateway runs in
 * Virginia. So every owner's store now lives under a new name, `enam:<owner>`
 * (`placedName`), made with the hint (`objectPlace.js`), and the store under
 * the old name, `<owner>`, hands over to it once:
 *
 * 1. The first call to the new object, before it answers anything, asks the
 *    old one to move out (`move_out`). From that moment the old object keeps
 *    no write: a write already under way is stopped by the objects' guard,
 *    and every ordinary call to it is passed on to the new object
 *    (`forward`), so a gateway still running the old code during a deploy
 *    loses nothing. It answers the list of what it holds.
 * 2. The new object copies every object in pages (`move_page`), each checked
 *    against its etag, and every routine alarm.
 * 3. Parity: the new object lists what it now holds and compares it, key by
 *    key, etag and size, and alarm by alarm, with the old list. Any difference
 *    and the copy is thrown away and the call fails; the next call starts the
 *    copy again. Only a clean copy is marked arrived, and only then does the
 *    new object answer.
 * 4. The old copy is kept for three days (`KEEP_OLD_MS`), then cleared by its
 *    own alarm. Wiping the new store (an account or a chat ending) clears the
 *    old copy at once (`move_purge`).
 *
 * Owners that never had an old store pay one call to an empty object, once.
 * Every move is logged and written to `tex_entry` with the old object's id, so
 * the analytics that found the six can show each one moved.
 */

import { objectByName, objectIdOf } from "../objectPlace.js";
import { clearAlarms, everyAlarm, schedule } from "./alarms.js";

/** The prefix of every placed store's name. */
export const PLACED_PREFIX = "enam:";
/** How long the old copy is kept after a move. */
export const KEEP_OLD_MS = 3 * 24 * 60 * 60 * 1000;
/** The header naming the owner (`person:<workspaceId>`, `chat:<chatId>`) on every call to a placed store. */
export const OWNER_HEADER = "x-tex-owner";
/** The calls only one store makes to another, during a move. */
export const MOVE_OPS = new Set(["move_out", "move_page", "move_purge"]);

const CALL = "x-tex-call";
const ORIGIN = "https://tex-store.internal";
const OWNER = /^(person|chat):[A-Za-z0-9_-]{1,64}$/;
const PAGE_KEYS = 200;
const PAGE_BYTES = 8 * 1024 * 1024;

/** The name the owner's store lives under. */
export function placedName(owner) {
  if (typeof owner !== "string" || !OWNER.test(owner)) throw new TypeError("not a Tex store's owner");
  return `${PLACED_PREFIX}${owner}`;
}

/** The owner a call names, or null for none or a malformed one. */
export function ownerOf(request) {
  const owner = request.headers.get(OWNER_HEADER) ?? "";
  return OWNER.test(owner) ? owner : null;
}

/** A write to a store that has moved: passed on, never kept. */
export class TexMoved extends Error {
  constructor() {
    super("this Tex store has moved");
    this.name = "TexMoved";
  }
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS place (k TEXT PRIMARY KEY, v TEXT NOT NULL)";
const ready = new WeakSet();
const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function init(sql) {
  if (ready.has(sql)) return;
  sql.exec(SCHEMA);
  ready.add(sql);
}

/** Where this store stands: `{movedTo, owner, movedAt, purgeAt}` on an old one, `{arrivedAt, ...}` on a new one; `{}` before either. */
export function placeOf(sql) {
  init(sql);
  const out = {};
  for (const row of rows(sql.exec("SELECT k, v FROM place"))) out[row.k] = JSON.parse(row.v);
  return out;
}

function setPlace(sql, fields) {
  init(sql);
  for (const [k, v] of Object.entries(fields)) sql.exec("INSERT INTO place (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
}

/** The objects' write guard for this store: throws once it has moved. */
export function moveGuard(sql) {
  return () => {
    if (placeOf(sql).movedTo !== undefined) throw new TexMoved();
  };
}

/** The op a call names, or null. */
export function opOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null"))?.op ?? null;
  } catch {
    return null;
  }
}

function fieldsOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null")) ?? {};
  } catch {
    return {};
  }
}

/** Everything a store holds, as a move compares it: `{objects: [{key, etag, size}], alarms}`. */
function manifestOf(sql, objects) {
  const listed = [];
  let cursor;
  for (;;) {
    const page = objects.list({ cursor });
    for (const meta of page.objects) listed.push({ key: meta.key, etag: meta.etag, size: meta.size });
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return { objects: listed, alarms: everyAlarm(sql) };
}

/** One page of a moving store's objects, whole: a 4-byte length, the metadata as JSON, then each body in order. */
function pageAfter(objects, after) {
  const metas = [];
  const bodies = [];
  let bytes = 0;
  let cursor = typeof after === "string" ? after : "";
  let more = false;
  outer: for (;;) {
    const page = objects.list({ startAfter: cursor, limit: PAGE_KEYS });
    for (const meta of page.objects) {
      if (metas.length >= PAGE_KEYS || (metas.length > 0 && bytes + meta.size > PAGE_BYTES)) {
        more = true;
        break outer;
      }
      const found = objects.get(meta.key);
      metas.push({ key: found.key, etag: found.etag, size: found.size, uploaded: found.uploaded, httpMetadata: found.httpMetadata, customMetadata: found.customMetadata });
      bodies.push(found.body);
      bytes += found.size;
      cursor = meta.key;
    }
    if (!page.truncated) break;
  }
  const head = new TextEncoder().encode(JSON.stringify({ objects: metas, more, last: cursor }));
  const out = new Uint8Array(4 + head.byteLength + bytes);
  new DataView(out.buffer).setUint32(0, head.byteLength);
  out.set(head, 4);
  let at = 4 + head.byteLength;
  for (const body of bodies) {
    out.set(body, at);
    at += body.byteLength;
  }
  return out;
}

function readPage(buffer) {
  const view = new Uint8Array(buffer);
  const length = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(view.subarray(4, 4 + length)));
  let at = 4 + length;
  const objects = head.objects.map((meta) => {
    const body = view.subarray(at, at + meta.size);
    at += meta.size;
    return { meta, body };
  });
  if (at !== view.byteLength) throw new Error("a move page that does not add up");
  return { objects, more: head.more === true, last: head.last };
}

/**
 * The old store's side of a move: its answer to `move_out`, `move_page` and
 * `move_purge`. `setAlarm` is the runtime's, for clearing the old copy later.
 */
export function serveMoveOut(request, { sql, objects, now, setAlarm }) {
  const op = opOf(request);
  const fields = fieldsOf(request);
  // A placed store never moves out: it is where a move ends.
  if (placeOf(sql).arrivedAt !== undefined) return Response.json({ error: "unknown_op" }, { status: 400 });
  if (op === "move_out") {
    if (typeof fields.owner !== "string" || !OWNER.test(fields.owner) || fields.to !== placedName(fields.owner)) {
      return Response.json({ error: "bad_move" }, { status: 400 });
    }
    const place = placeOf(sql);
    if (place.movedTo === undefined) {
      const at = now();
      // One synchronous step: from here every write is refused (the guard) and every call passed on.
      setPlace(sql, { movedTo: fields.to, owner: fields.owner, movedAt: at, purgeAt: at + KEEP_OLD_MS });
      setAlarm(at + KEEP_OLD_MS);
    }
    return Response.json(manifestOf(sql, objects));
  }
  if (placeOf(sql).movedTo === undefined) return Response.json({ error: "not_moving" }, { status: 409 });
  if (op === "move_page") return new Response(pageAfter(objects, fields.after));
  if (op === "move_purge") {
    clearOld(sql);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "unknown_op" }, { status: 400 });
}

/** The old copy cleared; the record of where it went stays, so a late call is still passed on. */
export function clearOld(sql) {
  sql.exec("DELETE FROM chunks");
  sql.exec("DELETE FROM objects");
  clearAlarms(sql);
  setPlace(sql, { purgedAt: Date.now() });
}

/** An ordinary call to a store that has moved, passed on to where it went, with the bytes already read. */
export async function forward(env, place, request, body) {
  const headers = new Headers(request.headers);
  headers.set(OWNER_HEADER, place.owner);
  return await objectByName(env.TEX_STORE, place.movedTo).fetch(new Request(request.url, { method: request.method, headers, body }));
}

async function callOld(old, op, fields = {}) {
  const response = await old.fetch(new Request(`${ORIGIN}/${op}`, { method: "POST", headers: { [CALL]: encodeURIComponent(JSON.stringify({ op, ...fields })) } }));
  if (!response.ok) throw new Error(`Tex store move ${op} failed (${response.status})`);
  return response;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The new store's side: copy everything from the owner's old store, check it,
 * and mark this one arrived. Throws, with nothing kept, when any check fails.
 * Run inside `blockConcurrencyWhile`, so nothing else is answered meanwhile.
 *
 * @returns {Promise<{keys: number, bytes: number, alarms: number, ms: number, oldId: string}>}
 */
export async function arrive({ sql, objects, env, owner, now = Date.now }) {
  const started = now();
  const old = objectByName(env.TEX_STORE, owner);
  const oldId = objectIdOf(env.TEX_STORE, owner);
  const manifest = await (await callOld(old, "move_out", { to: placedName(owner), owner })).json();
  try {
    // A copy cut short earlier is never answered from: start clean.
    objects.wipe();
    clearAlarms(sql);
    let after = "";
    let bytes = 0;
    for (;;) {
      const page = readPage(await (await callOld(old, "move_page", { after })).arrayBuffer());
      for (const { meta, body } of page.objects) {
        await objects.restore(meta, body);
        bytes += body.byteLength;
      }
      if (!page.more) break;
      if (page.last === after) throw new Error("a move page that did not advance");
      after = page.last;
    }
    for (const alarm of manifest.alarms) schedule(sql, alarm);
    const held = manifestOf(sql, objects);
    if (!same(held.objects, manifest.objects) || !same(held.alarms, manifest.alarms)) throw new Error("the copy does not match the old store");
    const keys = held.objects.length;
    setPlace(sql, { arrivedAt: now(), from: owner, keys, bytes, alarms: held.alarms.length });
    return { keys, bytes, alarms: held.alarms.length, ms: now() - started, oldId };
  } catch (error) {
    objects.wipe();
    clearAlarms(sql);
    throw Object.assign(error, { oldId });
  }
}

/** Clears the owner's old copy now: the new store was wiped, so nothing of it is kept anywhere. */
export async function purgeOld(env, owner) {
  await callOld(objectByName(env.TEX_STORE, owner), "move_purge");
}

/** One line and one `tex_entry` point per move: names, counts and times, never a key. */
export function logMove(env, owner, outcome, facts) {
  const line = { event: "tex_store_move", outcome, owner_kind: owner.slice(0, owner.indexOf(":")), old_object: facts.oldId ?? null, keys: facts.keys ?? 0, bytes: facts.bytes ?? 0, alarms: facts.alarms ?? 0, ms: facts.ms ?? 0 };
  console.log(JSON.stringify(line));
  try {
    env?.TEX_ENTRY?.writeDataPoint?.({
      blobs: ["gateway", "move", "tex_store_move", outcome, String(facts.oldId ?? "")],
      doubles: [line.ms, line.keys, line.bytes, line.alarms],
      indexes: [owner.slice(owner.indexOf(":") + 1).slice(0, 96)],
    });
  } catch {
    // Diagnostics never fail a call.
  }
}
