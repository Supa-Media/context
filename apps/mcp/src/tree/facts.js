/**
 * The Convex tree's facts, for the gateway: a move's link candidates and the
 * chaos score's extras, from `/gateway/tree/facts`
 * (`apps/convex/functions/lib/nodes/gatewayFacts.ts`), in place of the search
 * database's `tree_links` and `tree_props` (decided by the owner,
 * 2026-10-13), which were retired in phase 7 (`retired.js`). Each answers
 * `null` wherever the tree does not serve this call, its facts are not whole,
 * or the request fails; the caller then walks the bucket, or says nothing of
 * the score, as before.
 */

import { bareNameOf } from "./links.js";

/**
 * The notes a rewrite for these renames must read: every note pointing at a
 * renamed path or its bare name, every note changed since its links were
 * read, and every renamed note itself (its relative links move with it). At
 * their new names. `null` when the facts cannot answer.
 *
 * @param {object} store
 * @param {Map<string, string>} renames old key → new key
 * @returns {Promise<Set<string> | null>}
 */
export async function factCandidates(store, renames) {
  if (typeof store?.treeFacts !== "function" || renames.size === 0) return null;
  const sources = [...renames.keys()];
  const names = [...new Set(sources.map(bareNameOf))];
  let answer;
  try {
    answer = await store.treeFacts({ ask: "links", sources, names });
  } catch {
    return null;
  }
  const found = answer?.served === true ? answer.candidates : null;
  if (!found || !Array.isArray(found.pointing) || !Array.isArray(found.unparsed)) return null;
  const candidates = new Set();
  for (const path of [...found.pointing, ...found.unparsed]) {
    if (typeof path === "string") candidates.add(renames.get(path) ?? path);
  }
  for (const destination of renames.values()) candidates.add(destination);
  return candidates;
}

/**
 * What the chaos score needs beyond the keys (`chaos/live.js`), and the score
 * a week ago for this grant's audience; `null` when the facts cannot answer.
 * `today` (both audiences' score now) is kept by the control plane only for
 * an owner reading privately.
 *
 * @param {object} store
 * @param {{all: number, team: number}} [today]
 * @returns {Promise<{ extras: Map<string, {lines: number | null, exempt: boolean, review: boolean}>, weekAgo: number | null } | null>}
 */
export async function factChaos(store, today) {
  if (typeof store?.treeFacts !== "function") return null;
  let answer;
  try {
    answer = await store.treeFacts({ ask: "chaos", ...(today ? { today } : {}) });
  } catch {
    return null;
  }
  const chaos = answer?.served === true ? answer.chaos : null;
  if (!chaos || !Array.isArray(chaos.extras)) return null;
  const extras = new Map();
  for (const extra of chaos.extras) {
    if (!extra || typeof extra.path !== "string") continue;
    extras.set(extra.path, {
      lines: Number.isFinite(extra.lines) ? extra.lines : null,
      exempt: extra.exempt === true,
      review: extra.review === true,
    });
  }
  return { extras, weekAgo: Number.isFinite(chaos.weekAgo) ? chaos.weekAgo : null };
}
