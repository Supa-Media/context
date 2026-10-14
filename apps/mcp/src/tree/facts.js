/**
 * The Convex tree's facts, for the gateway: a move's link candidates, the
 * chaos score's extras and notes' props, from `/gateway/tree/facts`
 * (`apps/convex/functions/lib/nodes/gatewayFacts.ts`), in place of the search
 * database's `tree_links` and `tree_props` (decided by the owner,
 * 2026-10-13), which were retired in phase 7 (`retired.js`). Each answers
 * `null` wherever the tree does not serve this call, its facts are not whole,
 * or the request fails; the caller then says what it could not do (links left
 * to forwarding, no chaos line, a listing without front matter), and never
 * reads the bucket in their place.
 *
 * The exception is a store with no control plane at all (the single-tenant
 * token deployment, a self-hosted gateway): there is no tree to ask, so
 * `factProps` parses the notes themselves, as the tree's own fill would.
 */

import { bareNameOf } from "./links.js";
import { propsOf } from "./props.js";
import { getWithLegacyFallback } from "../storageLayout.js";

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

/** Notes one props request names: the control plane's `PROPS_REQUEST_PATHS`. */
export const PROPS_REQUEST_PATHS = 100;
/** Props requests in flight at once for one tool call. */
const PROPS_CONCURRENCY = 4;

/**
 * Each note's props as the Convex tree keeps them (`propsOf`,
 * `tree/props.js`): its front matter, inline tags, first heading, first
 * paragraph and length, read in place of the note's body. A note whose text
 * the facts have not read yet is absent from the answer; a sealed note maps
 * to `{ sealed: true, props: null }`. `null` where the facts cannot answer
 * this call, and the caller shows what the listing alone says.
 *
 * The control plane answers only for notes this grant may see; the caller
 * names only notes it already filtered with `canSee`.
 *
 * @param {object} store
 * @param {string[]} paths
 * @returns {Promise<Map<string, { sealed: boolean, props: { properties: Record<string, unknown>, inlineTags: string[], heading: string | null, lede: string | null, lines?: number } | null }> | null>}
 */
export async function factProps(store, paths) {
  if (typeof store?.treeManifest !== "function" && typeof store?.treeFacts !== "function") {
    return await bucketProps(store, paths);
  }
  if (typeof store?.treeFacts !== "function") return null;
  const unique = [...new Set(paths)];
  const batches = [];
  for (let at = 0; at < unique.length; at += PROPS_REQUEST_PATHS) batches.push(unique.slice(at, at + PROPS_REQUEST_PATHS));
  const found = new Map();
  try {
    for (let at = 0; at < batches.length; at += PROPS_CONCURRENCY) {
      const answers = await Promise.all(
        batches.slice(at, at + PROPS_CONCURRENCY).map((batch) => store.treeFacts({ ask: "props", paths: batch })),
      );
      for (const answer of answers) {
        if (answer?.served !== true || !Array.isArray(answer.props)) return null;
        for (const row of answer.props) {
          if (!row || typeof row.path !== "string") continue;
          if (row.sealed === true) {
            found.set(row.path, { sealed: true, props: null });
            continue;
          }
          const props = parsedProps(row.props);
          if (props !== null) found.set(row.path, { sealed: false, props });
        }
      }
    }
  } catch {
    return null;
  }
  return found;
}

function parsedProps(text) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    // Null-prototype, as `noteProperties` makes it, so a property a List
    // names (`constructor`, say) is never read off Object.prototype.
    const properties = Object.assign(
      Object.create(null),
      value.properties && typeof value.properties === "object" && !Array.isArray(value.properties) ? value.properties : {},
    );
    return {
      properties,
      inlineTags: Array.isArray(value.inlineTags) ? value.inlineTags.filter((tag) => typeof tag === "string") : [],
      heading: typeof value.heading === "string" ? value.heading : null,
      lede: typeof value.lede === "string" ? value.lede : null,
      ...(Number.isFinite(value.lines) ? { lines: value.lines } : {}),
    };
  } catch {
    return null;
  }
}

/** `factProps` for a store with no control plane: each note parsed where it lies. */
async function bucketProps(store, paths) {
  const found = new Map();
  for (const path of new Set(paths)) {
    const object = await getWithLegacyFallback(store, path).catch(() => null);
    if (!object) continue;
    const parsed = propsOf(await object.text());
    found.set(path, parsed === null ? { sealed: true, props: null } : { sealed: false, props: parsedProps(JSON.stringify(parsed)) });
  }
  return found;
}
