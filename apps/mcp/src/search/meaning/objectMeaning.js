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

/**
 * @param {object} store the request's store; `store.objectMeaning` is the object's client where it may answer
 * @param {number[]} vector the query's fingerprint
 * @param {{tiers: string[]|null}} options
 * @returns {Promise<Array<{id: string, score: number, path: string, chunk: number, tier: string|null}>|null>}
 */
export async function objectMeaningMatches(store, vector, { tiers = null } = {}) {
  const object = store?.objectMeaning ?? null;
  if (object === null || typeof object.meaningQuery !== "function") return null;
  if (typeof store.defer === "function" && typeof object.meaningBuild === "function") store.defer(buildBehind(object));
  try {
    const answer = await object.meaningQuery(vector, { tiers });
    return answer?.served === true && Array.isArray(answer.matches) ? answer.matches : null;
  } catch {
    return null;
  }
}
