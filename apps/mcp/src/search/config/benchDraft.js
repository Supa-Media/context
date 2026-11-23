/**
 * A Lab draft's search config, in a bench environment only (`packages/lab/gateway/bench/plans.js`): a bench run asks
 * its searches on a draft by `SEARCH_CONFIG_DRAFT` (its JSON) in the bench environment, and every search in that
 * request runs on it (`tools/search.js` `findNotes`). A real deployment's environment is never a bench one
 * (`BENCH_WORLD`), so no var there can change how a person's search runs; a draft that fails the schema is ignored.
 */

import searchConfig from "./searchConfig.cjs";

const { searchConfigProblems } = searchConfig;
const parsed = new Map();

/** The draft config this bench environment searches on, or undefined (main's). */
export function benchSearchConfigFor(env) {
  if (env?.BENCH_WORLD !== true) return undefined;
  const raw = env.SEARCH_CONFIG_DRAFT;
  if (typeof raw !== "string" || raw === "") return undefined;
  if (!parsed.has(raw)) {
    if (parsed.size >= 8) parsed.clear();
    let config = null;
    try {
      config = JSON.parse(raw);
      if (searchConfigProblems(config).length > 0) config = null;
    } catch {
      config = null;
    }
    parsed.set(raw, config);
  }
  return parsed.get(raw) ?? undefined;
}
