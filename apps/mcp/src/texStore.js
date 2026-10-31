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
import { texObjects } from "./texStore/objects.js";
import { serveTexStore } from "./texStore/wire.js";

/** How long a routine that did not run waits before it is tried again. */
export const RETRY_MS = 60 * 1000;

/**
 * The default dispatch: nothing is wired, so no routine runs and every due one
 * waits for `RETRY_MS`. The place that runs routines is injected by whoever
 * builds the object, since `env` cannot carry a function; wiring it is the open
 * step in `docs/decisions/texting-assistant/tex-durable-objects.md`.
 */
const unwired = async () => false;

export class TexStore {
  /**
   * @param {object} state the Durable Object's state (`storage.sql`, `setAlarm`, `deleteAlarm`)
   * @param {object} env the Worker's bindings
   * @param {{dispatch?: (routine: {id: string, at: number, payload: unknown}) => Promise<boolean>, now?: () => number}} [options]
   */
  constructor(state, env, { dispatch = unwired, now = Date.now } = {}) {
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
   * The runtime alarm fired: hand each due routine on, one after another. A
   * routine that ran is removed; one that did not waits `RETRY_MS`, so the
   * alarm is never armed at a time that is already past and nothing is lost.
   */
  async alarm() {
    this.ready();
    const sql = this.state.storage.sql;
    const started = this.now();
    for (const routine of due(sql, started)) {
      let ran = false;
      try {
        ran = (await this.dispatch(routine)) === true;
      } catch {
        ran = false;
      }
      if (ran) settle(sql, routine.id, routine.at);
      else retry(sql, routine, started + RETRY_MS);
    }
    this.arm();
  }
}
