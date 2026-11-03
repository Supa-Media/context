/**
 * A person's Tex moved into their workspace's object (decided by the owner,
 * 2026-11-02: "@seyi is my personal workspace, the tex has a folder in there,
 * and this all lives in 1 durable object"; then "lets do one object then
 * please"). A group chat keeps its own Tex store; only `person:<workspaceId>`
 * moves, to `workspace:<workspaceId>`.
 *
 * Copy, check, switch, retire, as the move to placed stores (`move.js`) does:
 *
 * 1. The first Tex call to the workspace object, before it answers anything,
 *    asks the person's placed Tex store (`enam:person:<workspaceId>`) to merge
 *    out (`merge_out`). From that moment the store keeps no write (its guard)
 *    and passes every ordinary call on to the workspace object, so a gateway
 *    still running the old code during a deploy loses nothing. It answers the
 *    list of what it holds: every note and record (key, etag, size), every
 *    routine alarm, and every ledger's manifest and digest.
 * 2. The workspace object copies the notes in pages (`merge_page`, each body
 *    checked against its etag), the ledgers in pages of rows (`merge_ledger`,
 *    each row as it was kept: chat, seq, id, time, kind, entry), and the
 *    alarms.
 * 3. Parity: it lists what it now holds and compares key by key, alarm by
 *    alarm, and each ledger's manifest and digest of every row in order (so a
 *    one-to-one chat's first entry, `backfilledv1`, is still first). Any
 *    difference and the copy is thrown away and the call fails; the next call
 *    starts again. Only a clean copy is marked arrived, and only then does the
 *    workspace object answer, and tell the old store (`merge_done`).
 * 4. The old copy is kept for three days after `merge_done`, then cleared by
 *    its own alarm; never before the copy was confirmed. Wiping the person's
 *    Tex (the account ending) clears it at once (`merge_purge`).
 *
 * The workspace object keeps the notes in its own tables (`tex_objects`,
 * `tex_chunks`), apart from the workspace's notes, and the ledger, alarms and
 * page state in the tables a Tex store keeps them in.
 */

import { objectByName, objectIdOf } from "../objectPlace.js";
import { clearAlarms, everyAlarm, schedule } from "./alarms.js";
import { OWNER_HEADER, placedName, purgeOld } from "./move.js";

/** How long the old copy is kept after the copy is confirmed. */
export const KEEP_MERGED_MS = 3 * 24 * 60 * 60 * 1000;
/** The calls only a workspace object makes to its person's Tex store, during a merge. */
export const MERGE_OPS = new Set(["merge_out", "merge_page", "merge_ledger", "merge_done", "merge_purge"]);

const CALL = "x-tex-call";
const ORIGIN = "https://tex-store.internal";
const PERSON = /^person:([A-Za-z0-9_-]{1,64})$/;
const PAGE_KEYS = 200;
const PAGE_BYTES = 8 * 1024 * 1024;
const LEDGER_ROWS = 500;
const LEDGER_BYTES = 8 * 1024 * 1024;

const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The workspace a person owner names (`person:<workspaceId>`), or null. */
export function personWorkspaceOf(owner) {
  const match = typeof owner === "string" ? PERSON.exec(owner) : null;
  return match ? match[1] : null;
}

/** The workspace object's name for a person's Tex: their personal workspace's own object. */
export function mergedName(owner) {
  const workspaceId = personWorkspaceOf(owner);
  if (workspaceId === null) throw new TypeError("only a person's Tex merges into a workspace object");
  return `workspace:${workspaceId}`;
}

function fieldsOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null")) ?? {};
  } catch {
    return {};
  }
}

/** Every note and record, as a merge compares them. */
function objectList(objects) {
  const listed = [];
  let cursor;
  for (;;) {
    const page = objects.list({ cursor });
    for (const meta of page.objects) listed.push({ key: meta.key, etag: meta.etag, size: meta.size });
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return listed;
}

/** Each ledger's manifest row and a digest of its rows in order: what a copy must match exactly. */
async function ledgerList(sql) {
  // Both tables are made by `texLedger` before any host calls here.
  const chats = rows(sql.exec("SELECT chat, version, created, updated, count, bytes FROM ledger_chats ORDER BY chat")).map((row) => ({
    chat: String(row.chat),
    version: Number(row.version),
    created: Number(row.created),
    updated: Number(row.updated),
    count: Number(row.count),
    bytes: Number(row.bytes),
  }));
  const out = [];
  for (const chat of chats) {
    const kept = rows(sql.exec("SELECT seq, id, at, kind, entry FROM ledger WHERE chat = ? ORDER BY seq", chat.chat));
    const text = kept.map((row) => JSON.stringify([Number(row.seq), String(row.id), Number(row.at), String(row.kind), String(row.entry)])).join("\n");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    out.push({ ...chat, rows: kept.length, first: kept.length > 0 ? String(kept[0].id) : null, digest: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") });
  }
  // A row whose chat has no manifest is still the chat's: counted, so a copy that drops it does not match.
  const orphans = Number(rows(sql.exec("SELECT COUNT(*) AS n FROM ledger WHERE chat NOT IN (SELECT chat FROM ledger_chats)"))[0]?.n ?? 0);
  return { chats: out, orphans };
}

/** Everything a person's Tex holds, as a merge compares it. */
export async function mergeManifest(sql, objects) {
  return { objects: objectList(objects), alarms: everyAlarm(sql), ledger: await ledgerList(sql) };
}

/** One page of notes and records, whole: a 4-byte length, the metadata as JSON, then each body in order. */
function notesAfter(objects, after) {
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

function readNotesPage(buffer) {
  const view = new Uint8Array(buffer);
  const length = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(view.subarray(4, 4 + length)));
  let at = 4 + length;
  const objects = head.objects.map((meta) => {
    const body = view.subarray(at, at + meta.size);
    at += meta.size;
    return { meta, body };
  });
  if (at !== view.byteLength) throw new Error("a merge page that does not add up");
  return { objects, more: head.more === true, last: head.last };
}

/** One page of ledger rows after `[chat, seq]`, in (chat, seq) order, as they were kept. */
function ledgerAfter(sql, after) {
  const [chat, seq] = Array.isArray(after) && typeof after[0] === "string" && Number.isSafeInteger(after[1]) ? after : ["", -Number.MAX_SAFE_INTEGER];
  const found = rows(sql.exec("SELECT chat, seq, id, at, kind, entry FROM ledger WHERE chat > ? OR (chat = ? AND seq > ?) ORDER BY chat, seq LIMIT ?", chat, chat, seq, LEDGER_ROWS + 1));
  const out = [];
  let bytes = 0;
  for (const row of found.slice(0, LEDGER_ROWS)) {
    const size = String(row.entry).length;
    if (out.length > 0 && bytes + size > LEDGER_BYTES) break;
    out.push({ chat: String(row.chat), seq: Number(row.seq), id: String(row.id), at: Number(row.at), kind: String(row.kind), entry: String(row.entry) });
    bytes += size;
  }
  const last = out.at(-1);
  return { rows: out, more: found.length > out.length, last: last ? [last.chat, last.seq] : after ?? null };
}

/** The person's old store's copy removed, past its write guard: the tables a Tex store keeps (`objects.js` `DEFAULT_TABLES`). */
function clearOldTex(sql) {
  sql.exec("DELETE FROM chunks");
  sql.exec("DELETE FROM objects");
  sql.exec("DELETE FROM ledger");
  sql.exec("DELETE FROM ledger_chats");
  clearAlarms(sql);
}

/** Every Tex note, record, ledger and alarm the workspace object keeps for its person, removed. */
function clearTex(sql, objects) {
  objects.wipe();
  sql.exec("DELETE FROM ledger");
  sql.exec("DELETE FROM ledger_chats");
  clearAlarms(sql);
}

/**
 * The person's Tex store's side of a merge: its answer to the merge calls.
 * `place`/`setPlace` are the store's own record of where it stands (`move.js`);
 * `setAlarm` is the runtime's, for clearing the old copy later.
 */
export async function serveMergeOut(request, { sql, objects, place, setPlace, setAlarm, env, now = Date.now }) {
  const fields = fieldsOf(request);
  const op = fields.op;
  if (op === "merge_out") {
    if (personWorkspaceOf(fields.owner) === null || fields.to !== mergedName(fields.owner) || (place.from !== undefined && place.from !== fields.owner)) {
      return Response.json({ error: "bad_merge" }, { status: 400 });
    }
    if (place.mergedTo === undefined) {
      // One synchronous step: from here every write is refused (the guard) and every call passed on.
      setPlace({ mergedTo: fields.to, mergeOwner: fields.owner, mergedAt: now() });
    }
    return Response.json(await mergeManifest(sql, objects));
  }
  if (place.mergedTo === undefined) return Response.json({ error: "not_merging" }, { status: 409 });
  if (op === "merge_page") return new Response(notesAfter(objects, fields.after));
  if (op === "merge_ledger") return Response.json(ledgerAfter(sql, fields.after));
  if (op === "merge_done") {
    if (place.mergeDoneAt === undefined) {
      const at = now();
      setPlace({ mergeDoneAt: at, purgeAt: at + KEEP_MERGED_MS });
      setAlarm(at + KEEP_MERGED_MS);
    }
    return Response.json({ ok: true });
  }
  if (op === "merge_purge") {
    clearOldTex(sql);
    setPlace({ purgedAt: now() });
    // The store under the bare name it was copied from, if any, goes too: nothing of the person's Tex is kept there.
    if (place.from !== undefined) {
      try {
        await purgeOld(env, place.from);
      } catch {
        // Cleared by its own alarm.
      }
    }
    return Response.json({ ok: true });
  }
  return Response.json({ error: "unknown_op" }, { status: 400 });
}

/** The old copy cleared once its alarm comes, after the copy was confirmed; the record of where it went stays. */
export function clearMerged(sql, setPlace, now = Date.now) {
  clearOldTex(sql);
  setPlace({ purgedAt: now() });
}

/** An ordinary call to a store that has merged, passed on to the workspace object, with the bytes already read. */
export async function forwardMerged(env, place, request, body) {
  const namespace = env?.WORKSPACE_STORE;
  if (!namespace) return Response.json({ error: "tex_store_moving" }, { status: 503 });
  const headers = new Headers(request.headers);
  headers.set(OWNER_HEADER, place.mergeOwner);
  return await objectByName(namespace, place.mergedTo).fetch(new Request(request.url, { method: request.method, headers, body }));
}

/** The person's placed Tex store, each call naming its owner, so one that never copied its own old store in does that first. */
function personStore(env, owner) {
  const stub = objectByName(env.TEX_STORE, placedName(owner));
  return {
    async call(op, fields = {}) {
      const response = await stub.fetch(
        new Request(`${ORIGIN}/${op}`, { method: "POST", headers: { [CALL]: encodeURIComponent(JSON.stringify({ op, ...fields })), [OWNER_HEADER]: owner } }),
      );
      if (!response.ok) throw new Error(`Tex merge ${op} failed (${response.status})`);
      return response;
    },
  };
}

/**
 * The workspace object's side: copy everything from the person's Tex store,
 * check it, and answer. Throws, with nothing kept, when any check fails. Run
 * inside `blockConcurrencyWhile`, so nothing else is answered meanwhile. With
 * no Tex stores bound (a deployment that never had them) there is nothing to
 * copy.
 *
 * @returns {Promise<{keys: number, bytes: number, alarms: number, entries: number, ms: number, oldId: string|null}>}
 */
export async function mergeIn({ sql, objects, env, owner, now = Date.now }) {
  const started = now();
  if (!env?.TEX_STORE || typeof env.TEX_STORE.idFromName !== "function") return { keys: 0, bytes: 0, alarms: 0, entries: 0, ms: 0, oldId: null };
  const old = personStore(env, owner);
  const oldId = objectIdOf(env.TEX_STORE, placedName(owner));
  try {
    const manifest = await (await old.call("merge_out", { to: mergedName(owner), owner })).json();
    // A copy cut short earlier is never answered from: start clean.
    clearTex(sql, objects);
    let after = "";
    let bytes = 0;
    for (;;) {
      const page = readNotesPage(await (await old.call("merge_page", { after })).arrayBuffer());
      for (const { meta, body } of page.objects) {
        await objects.restore(meta, body);
        bytes += body.byteLength;
      }
      if (!page.more) break;
      if (page.last === after) throw new Error("a merge page that did not advance");
      after = page.last;
    }
    let entries = 0;
    let at = null;
    for (;;) {
      const page = await (await old.call("merge_ledger", { after: at })).json();
      for (const row of page.rows) {
        sql.exec("INSERT INTO ledger (chat, seq, id, at, kind, entry) VALUES (?, ?, ?, ?, ?, ?)", row.chat, row.seq, row.id, row.at, row.kind, row.entry);
        entries += 1;
      }
      if (!page.more) break;
      if (same(page.last, at)) throw new Error("a ledger page that did not advance");
      at = page.last;
    }
    for (const chat of manifest.ledger.chats) {
      sql.exec("INSERT INTO ledger_chats (chat, version, created, updated, count, bytes) VALUES (?, ?, ?, ?, ?, ?)", chat.chat, chat.version, chat.created, chat.updated, chat.count, chat.bytes);
    }
    for (const alarm of manifest.alarms) schedule(sql, alarm);
    const held = await mergeManifest(sql, objects);
    if (!same(held.objects, manifest.objects) || !same(held.alarms, manifest.alarms) || !same(held.ledger, manifest.ledger)) throw new Error("the copy does not match the person's Tex store");
    await old.call("merge_done");
    return { keys: held.objects.length, bytes, alarms: held.alarms.length, entries, ms: now() - started, oldId };
  } catch (error) {
    clearTex(sql, objects);
    throw Object.assign(error, { oldId });
  }
}

/** Clears the person's old Tex store now: their Tex was wiped, so nothing of it is kept anywhere. */
export async function purgeMerged(env, owner) {
  if (!env?.TEX_STORE) return;
  await personStore(env, owner).call("merge_purge");
}

/** One line and one `tex_entry` point per merge: names, counts and times, never a key. */
export function logMerge(env, outcome, facts) {
  const line = { event: "tex_store_merge", outcome, old_object: facts.oldId ?? null, keys: facts.keys ?? 0, bytes: facts.bytes ?? 0, alarms: facts.alarms ?? 0, entries: facts.entries ?? 0, ms: facts.ms ?? 0 };
  console.log(JSON.stringify(line));
  try {
    env?.TEX_ENTRY?.writeDataPoint?.({
      blobs: ["gateway", "merge", "tex_store_merge", outcome, String(facts.oldId ?? "")],
      doubles: [line.ms, line.keys, line.bytes, line.alarms, line.entries],
    });
  } catch {
    // Diagnostics never fail a call.
  }
}
