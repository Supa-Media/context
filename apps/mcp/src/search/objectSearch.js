/**
 * A search answered by the workspace's object (`workspaceStore/searchIndex.js`): one call to the object that holds
 * the notes, instead of a round trip to the per-context search database over Cloudflare's HTTP API (decided
 * 2026-11-03, Dev's "every read and write under 0.1 s"; `docs/decisions/search/object-word-index.md`).
 *
 * The same answer as the search database's (`answerFromProjection`, `d1/serve.js`): the same queries and ranking,
 * the same live `canSee` over every row before it leaves, the same count taken after that filter. Only where the
 * queries run differs.
 *
 * `null` is "not answered here" and the caller asks the search database exactly as before: the object's notes are not
 * caught up yet (a catch-up pass is then sent behind the response), the object is not where the notes live, the
 * switch is off (`SEARCH_FROM_OBJECT=off`), or the object failed.
 */

import { canSee } from "../privacy/engine.js";
import { folderPrefix } from "./indexable.js";
import { answerFromProjection } from "./d1/serve.js";

/** Catch-up calls one search sends behind its response: a bounded slice each (`BUILD_ROWS`, `BUILD_BYTES`), one after another. */
export const BUILD_CALLS = 40;

/** Catch the object's index up behind a response, a call at a time, until nothing is waiting. Never throws. */
async function buildBehind(object) {
  for (let call = 0; call < BUILD_CALLS; call += 1) {
    let answer;
    try {
      answer = await object.searchBuild();
    } catch {
      return;
    }
    if (answer?.served !== true || !(answer.waiting > 0)) return;
  }
}

class NotServed extends Error {
  constructor(waiting) {
    super("not served");
    this.waiting = waiting;
  }
}

/**
 * @param {object} store the request's store; `store.objectSearch` is the object's client where it may answer
 * @param {{set: (key: string, value: unknown) => void}} trace
 * @returns {Promise<{hits: object[], matchCount: number, matchCountIsFloor: boolean}|null>}
 */
export async function objectSearchAnswer(store, scope, rules, overrides, query, prefix, trace) {
  const object = store?.objectSearch ?? null;
  if (object === null || typeof object.search !== "function") return null;
  const client = {
    search: async (asks) => {
      const answer = await object.search(asks);
      if (answer?.served !== true || !Array.isArray(answer.answers)) throw new NotServed(answer?.waiting ?? null);
      return answer.answers;
    },
  };
  try {
    const answer = await answerFromProjection(client, {
      query,
      prefix: folderPrefix(prefix),
      tier: scope,
      isVisible: (path) => canSee(path, scope, rules, overrides),
      onCounts: (candidates, visible) => {
        trace.set("fastCandidates", candidates);
        trace.set("fastVisible", visible);
      },
      // A current index's miss is the answer, as a ready search database's is.
      missIsAnswer: true,
    });
    trace.set("objectSearch", answer === null ? "unanswered" : "served");
    return answer;
  } catch (error) {
    if (error instanceof NotServed) {
      trace.set("objectSearch", "catching_up");
      // More notes to index than one search may spend: a pass behind the response, so a later search is served here.
      if (typeof store.defer === "function" && typeof object.searchBuild === "function") store.defer(buildBehind(object));
      return null;
    }
    trace.set("objectSearch", "failed");
    return null;
  }
}
