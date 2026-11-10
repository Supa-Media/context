/**
 * What a note's date properties are filled from (`notes/dateStamp.js`, Dev2 2026-11-10;
 * `docs/decisions/app-and-console/date-properties.md`), answered by the workspace object from its own rows and facts:
 * when the note was first saved (its row's `created`), when its text last changed (`uploaded`, else the row's clock),
 * and the date format the workspace's notes already use, by name only (`linter`, `iso`, …), never a value.
 *
 * Two asks, both judged by the reader's `sees` like every facts ask (`serve.js` `answerFacts`):
 *  - `{ask: "dates", path}` → `{dates: {created, saved, style}}`. A note the reader may not see answers what a note
 *    that is not there does: no clocks, and the format alone (a new note's first save copies it too).
 *  - `{ask: "dateGaps", after?, limit?}` → `{gaps: [{path, created, saved}], next, style}`: the notes that have a date
 *    key with an empty value, in path order, for the one backfill pass (`fill_dates`). `next` is where the following
 *    page starts, null at the end.
 */

import { commonStyle, roleOfKey } from "../notes/dateProperties.js";

/** Notes one gaps page names. */
export const DATE_GAPS_PAGE = 100;
/** Notes with date values the workspace's format is read from. */
const STYLE_SAMPLE = 400;
/** Notes one `dates` ask reads again first, so the format is not read from facts long out of date. */
const STYLE_CATCH_UP = 50;
const PATH_LENGTH = 4096;
const NOT_SERVED = Object.freeze({ served: false });

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const finite = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
/** A props value Context reads as empty: `key:` alone parses as an empty list (`lists/properties.js`). */
const isEmpty = (value) => value === "" || (Array.isArray(value) && value.length === 0);

/** Each date key's value in a note's props JSON: `[{role, value}]`. */
function datesIn(json) {
  if (typeof json !== "string") return [];
  let props;
  try {
    props = JSON.parse(json);
  } catch {
    return [];
  }
  const properties = props?.properties;
  if (!properties || typeof properties !== "object") return [];
  const found = [];
  for (const [key, value] of Object.entries(properties)) {
    const role = roleOfKey(key);
    if (role !== null) found.push({ role, value });
  }
  return found;
}

/** A cheap first cut in SQL before each note's props are read: any props naming a date key's word. */
const MENTIONS = "(f.props LIKE '%created%' OR f.props LIKE '%modified%' OR f.props LIKE '%updated%')";

/**
 * @param {{sql: object, key: string, notes: Function, current: Function, catchUp: Function, parsed: Function, stale: Function, read: Function}} facts
 *   `facts.js`'s own helpers over the same object, and its SQL for a row's note key.
 */
export function dateFactAsks({ sql, key, notes, current, catchUp, parsed, stale, read }) {
  /** The workspace's date format by name, from notes the reader may see; null when none has a readable date. */
  function styleFor(sees) {
    const rows = all(
      sql.exec(
        `SELECT r.path AS path, f.props AS props FROM ws_facts f JOIN ws_rows r ON ${key} = f.key
         WHERE r.gone = 0 AND r.kind = 'file' AND ${MENTIONS} ORDER BY r.at DESC LIMIT ?`,
        STYLE_SAMPLE,
      ),
    );
    const values = [];
    for (const row of rows) {
      if (!sees(row.path)) continue;
      for (const { value } of datesIn(row.props)) if (typeof value === "string" && value !== "") values.push(value);
    }
    return commonStyle(values);
  }

  /** A live note row's clocks: `{created, saved}`. */
  function clocks(path) {
    const row = all(sql.exec("SELECT created, uploaded, at FROM ws_rows WHERE path = ? AND gone = 0 AND kind = 'file' ORDER BY id LIMIT 1", path))[0];
    if (!row) return null;
    return { created: finite(row.created), saved: finite(row.uploaded) ?? finite(row.at) };
  }

  return {
    dates({ path }, sees) {
      if (typeof path !== "string" || path === "" || path.length > PATH_LENGTH) return { served: true, dates: { created: null, saved: null, style: null } };
      catchUp(notes(), STYLE_CATCH_UP);
      const style = styleFor(sees);
      // Judged before the row is read, so a path the reader may not see answers what a missing one does.
      const own = sees(path) ? clocks(path) : null;
      return { served: true, dates: { created: own?.created ?? null, saved: own?.saved ?? null, style } };
    },

    dateGaps({ after = null, limit = DATE_GAPS_PAGE }, sees) {
      const start = typeof after === "string" && after.length <= PATH_LENGTH ? after : "";
      const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, DATE_GAPS_PAGE) : DATE_GAPS_PAGE;
      const byPath = current();
      if (byPath === null) return NOT_SERVED;
      const paths = [...byPath.keys()].filter((path) => path > start).sort();
      const gaps = [];
      let next = null;
      for (const path of paths) {
        if (gaps.length === size) {
          next = gaps.at(-1).path;
          break;
        }
        const note = byPath.get(path);
        if (stale(note)) read(note);
        if (!parsed(note) || !sees(path)) continue;
        const row = all(sql.exec("SELECT props FROM ws_facts WHERE key = ?", note.key))[0];
        if (!datesIn(row?.props).some(({ value }) => isEmpty(value))) continue;
        gaps.push({ path, ...clocks(path) });
      }
      return { served: true, gaps, next, style: styleFor(sees) };
    },
  };
}
