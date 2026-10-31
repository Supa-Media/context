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
 */

import { cancel, due, nextAt, retry, schedule, settle } from "./texStore/alarms.js";
import { routineDispatchFor } from "./texStore/dispatch.js";
import { texObjects } from "./texStore/objects.js";
import { serveTexStore } from "./texStore/wire.js";

/** How long a routine that could not be handed on waits before it is tried again. */
export const RETRY_MS = 60 * 1000;

export class TexStore {
  /**
   * @param {object} state the Durable Object's state (`storage.sql`, `setAlarm`, `deleteAlarm`)
   * @param {object} env the Worker's bindings (`TEXTING`, the texting Worker's routine entrypoint: `texStore/dispatch.js`)
   * @param {{dispatch?: (routine: {id: string, at: number, payload: unknown}) => Promise<{next: number | null}>, now?: () => number}} [options]
   *   `dispatch` hands a due routine on and answers when it next runs, or throws to have it tried again.
   */
  constructor(state, env, { dispatch = routineDispatchFor(env), now = Date.now } = {}) {
    this.state = state;
    this.env = env;
    this.dispatch = dispatch;
    this.now = now;
    this.objects = null;
    this.timers = null;
  }

  /** The object's notes and alarms, built on first use. */
  ready() {
    if (this.objects !== null) return;
    this.objects = texObjects(this.state.storage.sql);
    this.timers = {
      schedule: (alarm) => {
        const set = schedule(this.state.storage.sql, alarm ?? {});
        this.arm();
        return set;
      },
      cancel: (id) => {
        cancel(this.state.storage.sql, id);
        this.arm();
      },
    };
  }

  /** Sets the runtime alarm at the earliest routine, or clears it when there is none. */
  arm() {
    const at = nextAt(this.state.storage.sql);
    if (at === null) this.state.storage.deleteAlarm();
    else this.state.storage.setAlarm(at);
  }

  async fetch(request) {
    this.ready();
    return await serveTexStore(this.objects, request, this.timers);
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
    const started = this.now();
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
}
