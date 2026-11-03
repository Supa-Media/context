/**
 * Search by meaning answered by the workspace's object (`workspaceStore/meaningIndex.js`): the query's fingerprint
 * sent to the object that holds the notes, instead of to Vectorize over Cloudflare's HTTP API (decided 2026-11-03;
 * `docs/decisions/search/object-meaning-index.md`). The answer has the shape `client.js` `query` gives, so ranking,
 * the score floors and the live `canSee` over every match are the same.
 *
 * `null` is "not answered here", and the caller asks Vectorize exactly as before: the object is not where the notes
 * live, the switch is off (`MEANING_FROM_OBJECT=off`), its first build has not finished, or it failed. Either way a
 * build is sent behind the response, so the object catches up with what changed.
 */

/** Build calls one search sends behind its response, each at most `BUILD_PASSAGES` passages, one after another. */
export const MEANING_BUILD_CALLS = 8;

/** Catch the object's meaning index up behind a response, a call at a time, until nothing is waiting. Never throws. */
async function buildBehind(object) {
  for (let call = 0; call < MEANING_BUILD_CALLS; call += 1) {
    let answer;
    try {
      answer = await object.meaningBuild();
    } catch {
      return;
    }
    if (answer?.served !== true || answer.busy === true || !(answer.waiting > 0)) return;
  }
}

/** The request stores whose build loop is already deferred: one loop per request, however many triggers name it. */
const BUILDS_DEFERRED = new WeakSet();

/**
 * Catch the object's meaning index up behind the request's response. Called after a note is written, moved or removed
 * (`writeProjection.js`) and by a search (`objectMeaningMatches`). Nothing else starts a build: a note saved with no
 * search after it had no meaning fingerprint until a later search, and that search ranked it without meaning evidence
 * (production benchmark, 2026-11-03). One loop per request store, so a save and a search in the same request do not
 * stack two. Never throws; a no-op where the store is not object-homed or has no `defer` to run it behind the response.
 *
 * @returns {Promise<void>} the loop's promise where one was deferred, otherwise one already resolved
 */
export function meaningBuildBehind(store) {
  const object = store?.objectMeaning ?? null;
  if (object === null || typeof object.meaningBuild !== "function") return Promise.resolve();
  if (typeof store.defer !== "function" || BUILDS_DEFERRED.has(store)) return Promise.resolve();
  const loop = buildBehind(object);
  try {
    store.defer(loop);
  } catch {
    // A host that refuses waitUntil leaves the catch-up to the next trigger, and never fails the request.
    return Promise.resolve();
  }
  BUILDS_DEFERRED.add(store);
  return loop;
}

/**
 * @param {object} store the request's store; `store.objectMeaning` is the object's client where it may answer
 * @param {number[]} vector the query's fingerprint
 * @param {{tiers: string[]|null}} options
 * @returns {Promise<Array<{id: string, score: number, path: string, chunk: number, tier: string|null}>|null>}
 */
export async function objectMeaningMatches(store, vector, { tiers = null } = {}) {
  const object = store?.objectMeaning ?? null;
  if (object === null || typeof object.meaningQuery !== "function") return null;
  meaningBuildBehind(store);
  try {
    const answer = await object.meaningQuery(vector, { tiers });
    return answer?.served === true && Array.isArray(answer.matches) ? answer.matches : null;
  } catch {
    return null;
  }
}

/** Most notes one snippet call names: a search shows a handful of notes found only by meaning. */
export const SNIPPET_ASKS = 50;

/**
 * Snippets for `matches` (each `{path, chunk}`, already let through `canSee`) from the workspace's object, in one
 * call: a `Map` of path to `{title, snippets}` or `null` for a note it no longer holds; `null` where the object did
 * not answer, and the caller reads the notes itself.
 */
export async function objectMeaningSnippets(store, matches, chars) {
  const object = store?.objectMeaning ?? null;
  if (object === null || typeof object.meaningSnippets !== "function") return null;
  const asks = matches.slice(0, SNIPPET_ASKS).map((match) => ({ path: match.path, chunk: match.chunk }));
  if (asks.length === 0) return new Map();
  try {
    const answer = await object.meaningSnippets(asks, chars);
    if (answer?.served !== true || !answer.snippets || typeof answer.snippets !== "object") return null;
    return new Map(asks.map((ask) => [ask.path, answer.snippets[ask.path] ?? null]));
  } catch {
    return null;
  }
}
