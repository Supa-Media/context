/**
 * The Durable Object that keeps Tex's notes: one per person (named by their
 * personal workspace) and one per group chat (decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A note kept here still has its row in the file tree, with its id for a file
 * name, like every other note; the row is marked as living here rather than in
 * the workspace's bucket, and the gateway reads and writes its text here. The
 * object keeps only those texts, in its own SQLite (`texStore/objects.js`),
 * reached only from this gateway (`texStore/wire.js`), which has already
 * checked who is asking. Nothing here decides access.
 *
 * The object also keeps Tex's routine alarms (`texStore/alarms.js`): one
 * runtime alarm, armed at the earliest of them. When it fires, each due routine
 * is handed to `dispatch`, which resolves `true` once the routine has run; one
 * that did not is kept and tried again after `RETRY_MS`.
 *
 * Every store lives under a name placed in eastern North America, and the
 * first call to one copies in what the owner's store under the old name held
 * (`texStore/move.js`). The old one then passes every call on, and clears its
 * copy after three days. A person's store then moves once more, into their
 * workspace's object (`texStore/merge.js`), and passes every call on there;
 * only a group chat's store is still answered from here.
 */

import { routineDispatchFor } from "./texStore/dispatch.js";
import { RETRY_MS, TexEngine } from "./texStore/engine.js";
import { MOVE_OPS, TexMoved, arrive, clearOld, forward, logMove, moveGuard, opOf, ownerOf, placeOf, purgeOld, serveMoveOut, setPlace } from "./texStore/move.js";
import { MERGE_OPS, clearMerged, forwardMerged, serveMergeOut } from "./texStore/merge.js";

export { RETRY_MS };

export class TexStore {
  /**
   * @param {object} state the Durable Object's state (`storage.sql`, `setAlarm`, `deleteAlarm`)
   * @param {object} env the Worker's bindings (`TEXTING`, the texting Worker's routine entrypoint: `texStore/dispatch.js`)
   * @param {{dispatch?: (routine: {id: string, at: number, payload: unknown}) => Promise<{next: number | null}>, now?: () => number}} [options]
   *   `dispatch` hands a due routine on and answers when it next runs, or throws to have it tried again.
   */
  constructor(state, env, { dispatch = routineDispatchFor(env), now = Date.now, pageDeps = {} } = {}) {
    this.state = state;
    this.env = env;
    this.now = now;
    this.engine = new TexEngine(state, env, { dispatch, now, pageDeps, guard: () => moveGuard(state.storage.sql)() });
  }

  /** The object's notes, ledger, page and alarms, built on first use. */
  ready() {
    this.engine.ready();
    this.objects = this.engine.objects;
    this.page = this.engine.page;
    this.timers = this.engine.timers;
    this.live = this.engine.live;
  }

  /** Sets the runtime alarm at the earliest routine or open page's poll, or clears it when there is neither. */
  arm() {
    this.engine.arm();
  }

  async fetch(request) {
    this.ready();
    const sql = this.state.storage.sql;
    const op = opOf(request);
    const setAlarm = (at) => this.state.storage.setAlarm(at);
    // Only a store copying in reaches an old one with these, never a call through the gateway's stub, which always names its owner (`wire.js`).
    if (MOVE_OPS.has(op) && ownerOf(request) !== null) return Response.json({ error: "unknown_op" }, { status: 400 });
    if (MOVE_OPS.has(op)) return serveMoveOut(request, { sql, objects: this.objects, now: this.now, setAlarm });
    // Read once, so a write stopped by the move can still be passed on whole.
    const body = await request.arrayBuffer();
    const place = placeOf(sql);
    if (place.movedTo !== undefined) return await forward(this.env, place, request, body);
    if (place.arrivedAt === undefined) {
      const owner = ownerOf(request);
      // Nothing is answered from a store that has not copied its old one in, and only a call naming its owner can start that.
      if (owner === null) return Response.json({ error: "not_arrived" }, { status: 503 });
      // A throw inside `blockConcurrencyWhile` resets the object, so a failed copy is caught in here and answered as one.
      const failed = await this.state.blockConcurrencyWhile(async () => {
        if (placeOf(sql).arrivedAt !== undefined) return false;
        try {
          const moved = await arrive({ sql, objects: this.objects, env: this.env, owner, now: this.now });
          this.arm();
          logMove(this.env, owner, "ok", moved);
          return false;
        } catch (error) {
          logMove(this.env, owner, "failed", { oldId: error?.oldId, ms: 0 });
          return true;
        }
      });
      if (failed) return Response.json({ error: "tex_store_moving" }, { status: 503 });
    }
    // A person's Tex moving into their workspace object (`texStore/merge.js`): only that object asks, naming the person.
    if (MERGE_OPS.has(op)) {
      if (!String(ownerOf(request) ?? "").startsWith("person:")) return Response.json({ error: "unknown_op" }, { status: 400 });
      const answer = await serveMergeOut(new Request(request.url, { method: request.method, headers: request.headers, body }), {
        sql,
        objects: this.objects,
        place: placeOf(sql),
        setPlace: (fields) => setPlace(sql, fields),
        setAlarm,
        env: this.env,
        now: this.now,
      });
      // Pages open on this store come back through the gateway, to the workspace object.
      if (op === "merge_out" || op === "merge_purge") this.engine.wipePage();
      return answer;
    }
    if (placeOf(sql).mergedTo !== undefined) return await forwardMerged(this.env, placeOf(sql), request, body);
    try {
      const answer = await this.engine.serve(request, body);
      if (op === "wipe") this.engine.wiped();
      if (op === "wipe" && placeOf(sql).from !== undefined) await purgeOld(this.env, placeOf(sql).from);
      return answer;
    } catch (error) {
      if (error instanceof TexMoved) {
        const now = placeOf(sql);
        return now.mergedTo !== undefined ? await forwardMerged(this.env, now, request, body) : await forward(this.env, now, request, body);
      }
      throw error;
    }
  }

  /**
   * The runtime alarm fired: hand each due routine on (`texStore/engine.js`).
   * A store that has moved or merged runs no routine: its alarm is only for
   * clearing the old copy.
   */
  async alarm() {
    this.ready();
    const sql = this.state.storage.sql;
    const place = placeOf(sql);
    if (place.movedTo !== undefined) {
      if (this.now() >= place.purgeAt) {
        if (place.purgedAt === undefined) clearOld(sql);
        this.state.storage.deleteAlarm();
      } else this.state.storage.setAlarm(place.purgeAt);
      return;
    }
    if (place.mergedTo !== undefined) {
      // Kept until the workspace object confirmed its copy (`merge_done`), then three days more.
      if (place.purgeAt === undefined) this.state.storage.deleteAlarm();
      else if (this.now() >= place.purgeAt) {
        if (place.purgedAt === undefined) clearMerged(sql, (fields) => setPlace(sql, fields), this.now);
        this.state.storage.deleteAlarm();
      } else this.state.storage.setAlarm(place.purgeAt);
      return;
    }
    await this.engine.runDue();
  }

  async webSocketMessage(ws, raw) {
    this.engine.message(ws, raw);
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
