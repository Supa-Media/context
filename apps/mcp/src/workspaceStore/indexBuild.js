/**
 * A workspace object's two search indexes (`searchIndex.js` words, `meaningIndex.js` meaning) caught up on the
 * object's own alarm, not only behind a search (decided 2026-11-03, Dev's "every read under 0.1 s").
 *
 * Behind a search alone, an index first built in a workspace of 50,000 passages took dozens of searches to finish,
 * and every search before then asked Vectorize instead (about 350 ms). Here, once a build call or a search says
 * changes are still waiting, the object wakes `GAP_MS` later and builds again, until nothing waits. A note saved
 * while nobody searches is indexed the same way.
 *
 * Only in memory: an object that is evicted forgets that it was building, and the next search's build call, which
 * still runs behind every search, starts it again. A model that fails waits `BACKOFF_MS` before the next try, so a
 * Workers AI outage is not an alarm a second.
 */

import { HOMES } from "./api.js";

/** The wait between one alarm build and the next while changes are waiting. */
export const GAP_MS = 1_000;
/** The wait after a build that failed (the model, most likely). */
export const BACKOFF_MS = 60_000;

/**
 * @param {{rows: {home(): string}, search?: {catchUp(): number|null}, meaning?: {catchUp(): Promise<object|null>}}} store
 * @param {{now?: () => number}} [options]
 */
export function indexBuilder(store, { now = Date.now } = {}) {
  let wakeAt = null;

  const waitingOf = (answer) => {
    if (typeof answer === "number") return answer;
    if (answer && typeof answer === "object") return answer.busy === true ? 1 : Number(answer.waiting) || 0;
    return 0;
  };

  return {
    /** When the alarm should next build, or `null` with nothing waiting. */
    wake() {
      return wakeAt;
    },

    /** A build call answered (`ws.search.build`, `ws.meaning.build`): with changes still waiting, build on the alarm. */
    noted(answer) {
      if (answer?.failed === true) {
        wakeAt = now() + BACKOFF_MS;
        return;
      }
      if (waitingOf(answer) > 0 && wakeAt === null) wakeAt = now() + GAP_MS;
    },

    /** One build of each index, on the alarm. Never throws. */
    async run() {
      wakeAt = null;
      let home;
      try {
        home = store.rows.home();
      } catch {
        return;
      }
      if (home !== HOMES.OBJECT) return;
      const started = now();
      let words = 0;
      let meaning = 0;
      let failed = false;
      try {
        words = waitingOf(store.search?.catchUp());
      } catch {
        failed = true;
      }
      try {
        meaning = waitingOf(await store.meaning?.catchUp());
      } catch {
        failed = true;
      }
      const waiting = words + meaning;
      // Counts and a duration only: whether an index ever finishes is otherwise invisible in production.
      console.log(JSON.stringify({ event: "index_build", wordsWaiting: words, meaningWaiting: meaning, failed, ms: now() - started }));
      if (failed) wakeAt = now() + BACKOFF_MS;
      else if (waiting > 0) wakeAt = now() + GAP_MS;
    },
  };
}
