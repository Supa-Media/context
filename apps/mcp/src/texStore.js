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
 * copy after three days.
 */

import { cancel, due, nextAt, retry, schedule, settle } from "./texStore/alarms.js";
import { routineDispatchFor } from "./texStore/dispatch.js";
import { texObjects } from "./texStore/objects.js";
import { texLedger } from "./texStore/ledger.js";
import { PAGE_LIVE_PATH, pageLive } from "./texStore/pageLive.js";
import { serveTexStore } from "./texStore/wire.js";
import { MOVE_OPS, TexMoved, arrive, clearOld, forward, logMove, moveGuard, opOf, ownerOf, placeOf, purgeOld, serveMoveOut } from "./texStore/move.js";

/** How long a routine that could not be handed on waits before it is tried again. */
export const RETRY_MS = 60 * 1000;

export class TexStore {
  /**
   * @param {object} state the Durable Object's state (`storage.sql`, `setAlarm`, `deleteAlarm`)
   * @param {object} env the Worker's bindings (`TEXTING`, the texting Worker's routine entrypoint: `texStore/dispatch.js`)
   * @param {{dispatch?: (routine: {id: string, at: number, payload: unknown}) => Promise<{next: number | null}>, now?: () => number}} [options]
   *   `dispatch` hands a due routine on and answers when it next runs, or throws to have it tried again.
   */
  constructor(state, env, { dispatch = routineDispatchFor(env), now = Date.now, pageDeps = {} } = {}) {
    this.state = state;
    this.pageDeps = pageDeps;
    this.env = env;
    this.dispatch = dispatch;
    this.now = now;
    this.objects = null;
    this.timers = null;
  }

  /** The object's notes and alarms, built on first use. */
  ready() {
    if (this.objects !== null) return;
    const guard = moveGuard(this.state.storage.sql);
    this.objects = texObjects(this.state.storage.sql, { now: this.now, guard });
    // The chat's one record of everything that happened (`texStore/ledger.js`), beside the notes.
    this.objects.ledger = texLedger(this.state.storage.sql, { now: this.now, guard });
    // The chat's Tex page: the open pages' sockets (`texStore/pageLive.js`). Its records are views of the chat's one log,
    // which sets `this.objects.records` (`texStore/pageRecords.js`).
    this.page = pageLive(this.state, this.state.storage.sql, this.env, { now: this.now, waitingMail: () => this.objects.records?.waiting?.() ?? 0, ...this.pageDeps });
    this.live = { changed: (sections) => this.page.changed(sections) };
    this.timers = {
      schedule: (alarm) => {
        guard();
        const set = schedule(this.state.storage.sql, alarm ?? {});
        this.arm();
        return set;
      },
      cancel: (id) => {
        guard();
        cancel(this.state.storage.sql, id);
        this.arm();
      },
    };
  }

  /** Sets the runtime alarm at the earliest routine or open page's poll, or clears it when there is neither. */
  arm() {
    const routine = nextAt(this.state.storage.sql);
    const poll = this.page?.pollAt() ?? null;
    const at = routine === null ? poll : poll === null ? routine : Math.min(routine, poll);
    if (at === null) this.state.storage.deleteAlarm();
    else this.state.storage.setAlarm(at);
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
    // An open Tex page's socket, from the gateway, which has checked who is asking (`http/texPage/live.js`).
    if (new URL(request.url).pathname === PAGE_LIVE_PATH && (request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const answer = this.page.accept(request);
      this.arm();
      return answer;
    }
    const fresh = () => new Request(request.url, { method: request.method, headers: request.headers, body });
    try {
      const answer = await serveTexStore(this.objects, fresh(), this.timers, this.live);
      if (op === "wipe") this.page.wipe();
      if (op === "wipe" && placeOf(sql).from !== undefined) await purgeOld(this.env, placeOf(sql).from);
      return answer;
    } catch (error) {
      if (error instanceof TexMoved) return await forward(this.env, placeOf(sql), request, body);
      throw error;
    }
  }

  /**
   * The runtime alarm fired: hand each due routine on, one after another. One
   * handed on answers when it next runs, and the routine is kept for that time;
   * one that answers no next time is removed; one that could not be handed on
   * waits `RETRY_MS`. Nothing is ever armed at a time already past, so nothing
   * is lost and the alarm does not spin.
   */
  async alarm() {
    this.ready();
    const sql = this.state.storage.sql;
    // A store that has moved runs no routine: its alarm is only for clearing the old copy.
    const place = placeOf(sql);
    if (place.movedTo !== undefined) {
      if (this.now() >= place.purgeAt) {
        if (place.purgedAt === undefined) clearOld(sql);
        this.state.storage.deleteAlarm();
      } else this.state.storage.setAlarm(place.purgeAt);
      return;
    }
    const started = this.now();
    // An open page's jobs, read again when due; a failure waits for the next one and never stops a routine.
    const pollAt = this.page.pollAt();
    if (pollAt !== null && pollAt <= started) {
      try {
        await this.page.poll();
      } catch {
        // Polled again below, by `arm`.
      }
    }
    for (const routine of due(sql, started)) {
      let answer = null;
      try {
        answer = await this.dispatch(routine);
      } catch {
        answer = null;
      }
      if (answer === null) retry(sql, routine, started + RETRY_MS);
      else if (typeof answer.next === "number") retry(sql, routine, answer.next);
      else settle(sql, routine.id, routine.at);
    }
    this.arm();
  }

  async webSocketMessage(ws, raw) {
    this.ready();
    this.page.message(ws, raw);
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
