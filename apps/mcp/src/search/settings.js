/**
 * THE SEARCH SETTINGS A DEPLOYMENT OR A SETUP CHOOSES.
 *
 * Asked for by the owner (2026-10-10): "a setup defined just for search", so
 * the search the assistant and every AI client get can be tuned and measured
 * the way the assistant's prompt is, rather than by editing constants. Four
 * knobs, each with the constant it used to be as its default:
 *
 *   everywhere     `search_notes` with no `context` searches every workspace
 *                  the person can reach and fuses one list (`tools/search.js`).
 *                  Default on (decided by the owner 2026-10-10, after the
 *                  search benchmark found 100% that way against 59% one
 *                  workspace at a time, with no held-back note leaking): a
 *                  person's answer lives wherever it lives, and a call that
 *                  wants one workspace names it with `context:` or narrows
 *                  with `prefix`. `false` restricts a deployment or a setup
 *                  to the workspace each call addresses.
 *   min_score      the closeness under which a meaning match is noise
 *                  (`MEANING_MIN_SCORE`, 0.40).
 *   extra_notes    how many notes found only by meaning one search may add
 *                  among the word hits (`MEANING_SNIPPET_READS`, 3).
 *   snippet_chars  how much of the matching passage a meaning-only hit shows
 *                  (200). An assistant that reads 600 can often answer without
 *                  opening the note.
 *
 * Two places set them, and the narrower wins: the Worker's `SEARCH_SETTINGS`
 * var (JSON, the deployment's choice, read once per request onto the store),
 * and a texting setup's `search:` section (`agent/production.js`), which lays
 * its keys over the deployment's for that turn. Every value is bounded here,
 * so a typo in a var or a note cannot ask for ten thousand reads.
 */

import searchConfig from "./config/searchConfig.cjs";

const { settingsOf } = searchConfig;
// The three numbers' defaults are settings of search's steps in its config (`config/searchConfig.json`; Dev2,
// 2026-11-21), which a Lab draft can change: "Meaning" (`meaning`), "Meaning-only budget" (`budget`) and "Read
// snippets" (`snippets`).
const MEANING = settingsOf("meaning");
const BUDGET = settingsOf("budget");
const SNIPPETS = settingsOf("snippets");

export const DEFAULT_SEARCH_SETTINGS = Object.freeze({
  everywhere: true,
  minScore: MEANING.minScore,
  extraNotes: BUDGET.extraNotes,
  snippetChars: SNIPPETS.snippetChars,
});

// Reading a setup's `search:` section is a pure contract Tex reads too (`packages/shared/src/texContract/searchSettings.cjs`).
import { SEARCH_SETTING_KEYS, readSearchSettings } from "../../../../packages/shared/src/texContract/searchSettings.cjs";
export { SEARCH_SETTING_KEYS, readSearchSettings } from "../../../../packages/shared/src/texContract/searchSettings.cjs";

/**
 * The deployment's settings from the Worker's vars, over the defaults. A var
 * that does not parse, or asks for a value out of bounds, is the defaults:
 * search keeps working, and the operator reads one log line.
 */
export function searchSettingsFor(env) {
  const raw = env?.SEARCH_SETTINGS;
  if (typeof raw !== "string" || !raw.trim()) return { ...DEFAULT_SEARCH_SETTINGS };
  let parsed = null;
  try {
    parsed = readSearchSettings(JSON.parse(raw));
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    try {
      console.error(JSON.stringify({ event: "search-settings-invalid", source: "env" }));
    } catch {
      // A log line cannot fail a request.
    }
    return { ...DEFAULT_SEARCH_SETTINGS };
  }
  return { ...DEFAULT_SEARCH_SETTINGS, ...parsed };
}

/** Settings back in the file's and the var's names (`min_score`, …), for a harness that writes the var. */
export function wireSearchSettings(settings) {
  const names = Object.fromEntries(Object.entries(SEARCH_SETTING_KEYS).map(([wire, name]) => [name, wire]));
  const out = {};
  for (const [name, value] of Object.entries(settings ?? {})) if (names[name]) out[names[name]] = value;
  return out;
}

/** The store's settings with a setup's laid over them; the defaults when a store has none. */
export function searchSettingsOf(store, over = null) {
  const base = store?.searchSettings && typeof store.searchSettings === "object" ? store.searchSettings : DEFAULT_SEARCH_SETTINGS;
  return over ? { ...DEFAULT_SEARCH_SETTINGS, ...base, ...over } : { ...DEFAULT_SEARCH_SETTINGS, ...base };
}
