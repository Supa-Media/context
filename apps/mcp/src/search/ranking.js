/**
 * THE KNOBS SEARCH RANKS BY (Dev2, 2026-11-21: "we should probably have like a place in lab to edit like our search
 * config"). Each was a constant in the file that used it; each is now a setting of a step in search's own config
 * (`config/searchConfig.json`), which the live gateway reads and a Lab draft can change:
 *
 *   rrfK          the reciprocal-rank constant: a hit at rank r adds 1 / (rrfK + r + 1). The usual 60.
 *   loosePenalty  places a loose (any-word) word hit is counted lower across workspaces (10).
 *   titleWeight   the bonus for each share of the query's terms a hit's title or file name holds (1/305).
 *   phraseBonus   the bonus when the whole query is a phrase in the hit (1/122).
 *   boostFactor   the multiplier a workspace a caller names with `boost` gets (1.2).
 *   meaningFloor  the closeness a note found only by meaning needs once the words found a note with every word (0.5).
 *   looseReads    notes found only by meaning one search may add when no note held every word (6).
 *   hits          most hits a search across every workspace shows (12).
 *   logPrior      what an archived note or a log scores, as a share of a live note with the same evidence (0.5).
 *
 * In one workspace, "Merge words and meaning" (`merge`), "Lower logs and archive" (`prior`) and "Add meaning-only
 * notes" (`snippets`) rank by their own settings; "Rank across workspaces" (`fuse`) ranks every workspace's hits
 * together by its own.
 */
import searchConfig from "./config/searchConfig.cjs";

const { SEARCH_SETTINGS_BOUNDS, settingProblem, settingsOf } = searchConfig;

/** The ranking knobs' names: every search setting but the three person-facing ones (`settings.js`). */
export const RANKING_KNOBS = Object.freeze(Object.keys(SEARCH_SETTINGS_BOUNDS).filter((name) => !["minScore", "extraNotes", "snippetChars"].includes(name)));

const knobsOf = (settings) => Object.freeze(Object.fromEntries(RANKING_KNOBS.filter((name) => name in settings).map((name) => [name, settings[name]])));

/**
 * One workspace's merge, as main's config sets it (the steps "Merge words and meaning" `merge`, "Lower logs and
 * archive" `prior` and "Add meaning-only notes" `snippets`): what every caller not on the search graph ranks by.
 */
export const IN_WORKSPACE_STEPS = Object.freeze(["merge", "prior", "snippets"]);
export const DEFAULT_RANKING = knobsOf(Object.assign({}, ...IN_WORKSPACE_STEPS.map((id) => settingsOf(id))));

/** The ranking across workspaces, as main's config sets it (`fuse`). */
export const FUSE_RANKING = knobsOf(settingsOf("fuse"));

/**
 * A ranking: `base` with `over`'s knobs laid on it, each checked. A knob that is unknown or out of bounds is left
 * as `base` has it rather than used, so a search always runs.
 */
export function rankingOf(over = null, base = DEFAULT_RANKING) {
  if (!over || typeof over !== "object") return base;
  const out = { ...base };
  for (const [name, value] of Object.entries(over)) if (RANKING_KNOBS.includes(name) && settingProblem(name, value) === null) out[name] = value;
  return Object.freeze(out);
}
