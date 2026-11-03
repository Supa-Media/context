/**
 * A person's Tex, kept in their personal workspace's object (decided by the
 * owner, 2026-11-02: "@seyi is my personal workspace, the tex has a folder in
 * there, and this all lives in 1 durable object";
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * The same Tex store a group chat has (`texStore/engine.js`): notes and
 * records, the chat's ledger, the Tex page's sockets and the routine alarms,
 * over the workspace object's own SQLite. Tex's notes sit in their own tables
 * (`tex_objects`, `tex_chunks`), never among the workspace's notes, so no
 * workspace read, listing, fact or backfill sees them; they are reached only
 * through their rows' Tex keys (`store/texRouting.js`), as before.
 *
 * - **Who calls.** Only a call naming its owner (`x-tex-owner`), which only the
 *   gateway's stub sets (`texStore/wire.js` `texStoreStub`), and only the one
 *   person whose workspace this is: the first owner seen is kept, and the
 *   object's own name is checked when the runtime gives it.
 * - **First call.** Copies the person's Tex store in and checks it
 *   (`texStore/merge.js` `mergeIn`) before anything is answered. A failed copy
 *   answers 503 and keeps nothing; the next call starts it again.
 * - **The alarm.** One runtime alarm for the object: the earliest of a routine,
 *   an open page's poll, and the workspace's own retry of an owed member write.
 */

import { TexEngine } from "../texStore/engine.js";
import { TEX_TABLES } from "../texStore/objects.js";
import { routineDispatchFor } from "../texStore/dispatch.js";
import { MERGE_OPS, logMerge, mergeIn, mergedName, personWorkspaceOf, purgeMerged } from "../texStore/merge.js";
import { MOVE_OPS, OWNER_HEADER } from "../texStore/move.js";

const CALL = "x-tex-call";
const SCHEMA = "CREATE TABLE IF NOT EXISTS tex_place (k TEXT PRIMARY KEY, v TEXT NOT NULL)";
const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** Whether a call to a workspace object is for its person's Tex: it names an owner. */
export function isTexCall(request) {
  return request.headers.has(OWNER_HEADER);
}

function placeOf(sql) {
  sql.exec(SCHEMA);
  const out = {};
  for (const row of rows(sql.exec("SELECT k, v FROM tex_place"))) out[row.k] = JSON.parse(row.v);
  return out;
}

function setPlace(sql, fields) {
  sql.exec(SCHEMA);
  for (const [k, v] of Object.entries(fields)) sql.exec("INSERT INTO tex_place (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
}

function opOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null"))?.op ?? null;
  } catch {
    return null;
  }
}

/** Whether this object's person's Tex has been copied in: only then does its alarm run routines. */
export function texArrived(sql) {
  return placeOf(sql).arrivedAt !== undefined;
}

/**
 * @param {object} state the workspace object's state
 * @param {object} env the Worker's bindings
 * @param {{otherWake?: () => (number|null), dispatch?: Function, now?: () => number, pageDeps?: object}} [options]
 */
export function texHost(state, env, { otherWake = () => null, dispatch = routineDispatchFor(env), now = Date.now, pageDeps = {} } = {}) {
  const sql = state.storage.sql;
  const engine = new TexEngine(state, env, { dispatch, now, pageDeps, tables: TEX_TABLES, otherWake });
  const refuse = (error, status = 400) => Response.json({ error }, { status });

  /** The object's own workspace, when the runtime names it (`workspace:<id>`); null when it does not. */
  const ownName = () => {
    const name = state?.id?.name;
    return typeof name === "string" && name !== "" ? name : null;
  };

  return {
    engine,

    async fetch(request) {
      const owner = request.headers.get(OWNER_HEADER) ?? "";
      const op = opOf(request);
      if (personWorkspaceOf(owner) === null) return refuse("not_this_object");
      const named = ownName();
      if (named !== null && named !== mergedName(owner)) return refuse("not_this_object");
      const place = placeOf(sql);
      if (place.owner !== undefined && place.owner !== owner) return refuse("not_this_object");
      // The calls one Tex store makes to another are never answered here: this is where a person's Tex ends.
      if (MOVE_OPS.has(op) || MERGE_OPS.has(op)) return refuse("unknown_op");
      engine.ready();
      const body = await request.arrayBuffer();
      if (place.arrivedAt === undefined) {
        // A throw inside `blockConcurrencyWhile` resets the object, so a failed copy is caught in here and answered as one.
        const failed = await state.blockConcurrencyWhile(async () => {
          if (placeOf(sql).arrivedAt !== undefined) return false;
          try {
            const merged = await mergeIn({ sql, objects: engine.objects, env, owner, now });
            setPlace(sql, { owner, arrivedAt: now(), keys: merged.keys, bytes: merged.bytes, alarms: merged.alarms, entries: merged.entries });
            engine.arm();
            logMerge(env, "ok", merged);
            return false;
          } catch (error) {
            logMerge(env, "failed", { oldId: error?.oldId });
            return true;
          }
        });
        if (failed) return refuse("tex_store_moving", 503);
      }
      const answer = await engine.serve(request, body);
      if (op === "wipe" && answer.ok) {
        engine.wiped();
        // The person's old Tex store goes too, so nothing of their Tex is kept anywhere.
        await purgeMerged(env, owner);
      }
      return answer;
    },

    /** The alarm's Tex half: routines and an open page's poll, once the person's Tex is here. */
    async alarm() {
      if (!texArrived(sql)) return;
      await engine.runDue();
    },

    /** Re-arm from every wake the object has; before the Tex is here, only the host's own. */
    arm() {
      if (texArrived(sql)) return engine.arm();
      const at = otherWake();
      if (typeof at === "number") state.storage.setAlarm(at);
    },

    owns: (ws) => engine.owns(ws),
    message: (ws, raw) => engine.message(ws, raw),
  };
}
