/**
 * A setup's `search:` section, read and checked: the person-facing search
 * settings (`minScore`, `extraNotes`, `snippetChars`, `everywhere`), what each
 * may be, and their front-matter keys. A pure contract the gateway
 * (`apps/mcp/src/search/settings.js` and `config/searchConfig.cjs`, which take
 * the bounds from here) and Tex (`agent/production.js`) both read. Moved verbatim.
 */
"use strict";

/** What each person-facing setting may be; `searchConfig.cjs` lists them with the ranking knobs. */
const PERSON_SEARCH_BOUNDS = Object.freeze({
  minScore: Object.freeze({ min: 0, max: 1, integer: false }),
  extraNotes: Object.freeze({ min: 0, max: 10, integer: true }),
  snippetChars: Object.freeze({ min: 50, max: 2000, integer: true }),
});

/** The front-matter and JSON key for each setting. */
const SEARCH_SETTING_KEYS = Object.freeze({
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
 */
function readSearchSettings(raw) {
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
    const bound = PERSON_SEARCH_BOUNDS[name];
    if (!Number.isFinite(number) || number < bound.min || number > bound.max) return null;
    if (bound.integer && !Number.isInteger(number)) return null;
    out[name] = number;
  }
  return out;
}

module.exports = { PERSON_SEARCH_BOUNDS, SEARCH_SETTING_KEYS, readSearchSettings };
