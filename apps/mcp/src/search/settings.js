/**
 * THE SEARCH SETTINGS A DEPLOYMENT OR A SETUP CHOOSES.
 *
 * Asked for by the owner (2026-10-10): "a setup defined just for search", so
 * the search the assistant and every AI client get can be tuned and measured
 * the way the assistant's prompt is, rather than by editing constants. Four
 * knobs, each with the constant it used to be as its default:
 *
 *   everywhere     `search_notes` with no `context` searches every workspace
 *                  the person can reach and fuses one list (`tools/search.js`),
 *                  instead of the one the connection is on. Default off.
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

export const DEFAULT_SEARCH_SETTINGS = Object.freeze({
  everywhere: false,
  minScore: 0.4,
  extraNotes: 3,
  snippetChars: 200,
});

const BOUNDS = {
  minScore: { min: 0, max: 1, integer: false },
  extraNotes: { min: 0, max: 10, integer: true },
  snippetChars: { min: 50, max: 2000, integer: true },
};

/** The front-matter and JSON key for each setting. */
export const SEARCH_SETTING_KEYS = Object.freeze({
  everywhere: "everywhere",
  min_score: "minScore",
  extra_notes: "extraNotes",
  snippet_chars: "snippetChars",
});

/**
 * Settings from a plain object of wire keys (`min_score`, …), each checked, or
 * `null` when a value is outside what it may be. Missing keys stay missing,
 * so a partial section lays over another without blanking it.
 *
 * @param {unknown} raw e.g. `{ everywhere: "true", min_score: "0.35" }`
 * @returns {Partial<typeof DEFAULT_SEARCH_SETTINGS> | null}
 */
export function readSearchSettings(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = SEARCH_SETTING_KEYS[key];
    if (!name) return null;
    if (name === "everywhere") {
      if (value === true || value === "true") out.everywhere = true;
      else if (value === false || value === "false") out.everywhere = false;
      else return null;
      continue;
    }
    const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    const bound = BOUNDS[name];
    if (!Number.isFinite(number) || number < bound.min || number > bound.max) return null;
    if (bound.integer && !Number.isInteger(number)) return null;
    out[name] = number;
  }
  return out;
}

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
