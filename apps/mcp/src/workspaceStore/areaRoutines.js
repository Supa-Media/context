/**
 * An area's routines, run by the workspace object itself, and its bot's weekly budget there
 * (`docs/decisions/app-and-console/area-routines.md`, decided by the owner, 2026-11-25: "routines should be able to be
 * defined for an area", and "if I attach a grokbot I can define how much of my weekly usage it can use").
 *
 * Before this, a job for an area's bot was a line in its mail, and it ran only if the bot set up a routine of its own
 * (Grok Bot asked for a yes before it would). Now the job is a note in the area, `<area>/routines/<how often>/<name>.md`
 * (`packages/shared/src/areaRoutines.cjs`), and this object keeps the clock:
 *
 *   - **The list.** After a note under the Areas folder changes, or the tree moves, the list is marked stale, and the
 *     next alarm rebuilds it from the rows and the notes' text here: each routine's next time, from its folder and its
 *     front matter, in the same format Tex's routines use. Its last run and outcome are kept by path.
 *   - **A run.** When one is due, the bot that holds its area (its bot owner, or a person owner's one delegate, as
 *     area mail reaches it: `botMail.js` `botOfArea`) is told through the control plane, like mail: a signed call to
 *     its webhook naming the area and the routine note, never the note's words. The bot reads it at its own
 *     clearance and answers in the area's mail. A bot that checks its mail itself finds it in `orient`.
 *   - **Who is sent work.** The bot an area names. Its card may give a cap for an area (`works_in:`); an area with no
 *     number there has no cap (the owner, 2026-11-27).
 *   - **The budget.** A bot says on each answer how much of its week the work took (`[used N%]`, `mail.cjs`); this
 *     object adds those up per bot, area and week. Once an area's share is spent, its routines and its mail pings are
 *     held until Monday: the mail still lands, nothing is lost, and the outcome says "held".
 *
 * What it keeps: paths, times, outcomes and percentages. Never a routine's words or a message.
 */

import areaRoutines from "../../../../packages/shared/src/areaRoutines.cjs";
import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import mail from "../../../../packages/shared/src/mail.cjs";
import { botOfArea, areaOfMailNote } from "./botMail.js";

const { MAX_AREA_ROUTINES, DEFAULT_ROUTINE_ZONE, areaRoutineOf, areaRoutineNext, botCapIn, botCardPaths, parseWorksIn, weekOf } = areaRoutines;
const { mailJoinName } = areaBots;
const { parseMail } = mail;

const NOTE_KEY = /^notes\/([A-Za-z0-9-]{1,128})\.md$/;
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ws_area_routines (path TEXT PRIMARY KEY, note_id TEXT, area TEXT NOT NULL, next_at INTEGER, last_at INTEGER, last_outcome TEXT, last_bot TEXT, answered_at INTEGER, problem TEXT, seen_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS ws_bot_usage (mark TEXT PRIMARY KEY, bot TEXT NOT NULL, area TEXT NOT NULL, week TEXT NOT NULL, used INTEGER NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ws_bot_usage_week ON ws_bot_usage (week, bot, area)",
  "CREATE TABLE IF NOT EXISTS ws_area_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];
/** Rebuilt at least this often even when nothing said it changed: a safety net, as the routine scan's six hours. */
const RESCAN_MS = 6 * 60 * 60 * 1000;
/** Run now sends a routine at most once a minute: a second press, or a second person, is told it just went. */
const RUN_NOW_GAP_MS = 60 * 1000;
/** Usage kept for this long: a few weeks back is all a page draws. */
const USAGE_KEPT_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * A bot is sent one routine at a time (Dev, 2026-11-27: "diagnose and debug the entire improvement loop"): a bot
 * woken for four routines at once answered one. The next waits until it answers, or this long.
 */
const ONE_AT_A_TIME_MS = 20 * 60 * 1000;
/** A routine queued behind its bot's last one is tried again this soon. */
const QUEUED_RETRY_MS = 2 * 60 * 1000;
/** A routine sent and not answered in its own place for this long is missed, never shown as waiting forever. */
export const ROUTINE_MISSED_MS = 60 * 60 * 1000;
/** Outcomes a run may record. "failed" is also a send whose webhook didn't take it: nothing woke the bot. */
export const ROUTINE_OUTCOMES = Object.freeze(["sent", "held", "no_bot", "failed"]);

/** Where a routine's answer is looked for counts lines after its send, on a routine sent (or one nothing woke for). */
const ANSWERABLE = "last_outcome IN ('sent', 'failed') AND last_at <= ? AND answered_at IS NULL";

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** The webhook's reply columns, added to a table made before them (`rows.js` `addOwnershipColumns`). */
function addDeliveryColumns(sql) {
  const have = new Set(all(sql.exec("SELECT name FROM pragma_table_info('ws_area_routines')")).map((column) => column.name));
  if (!have.has("delivered_status")) sql.exec("ALTER TABLE ws_area_routines ADD COLUMN delivered_status INTEGER");
  if (!have.has("delivered_at")) sql.exec("ALTER TABLE ws_area_routines ADD COLUMN delivered_at INTEGER");
}

function propsOf(json) {
  try {
    return JSON.parse(json ?? "null")?.properties ?? {};
  } catch {
    return {};
  }
}

/**
 * `{noted, treeChanged, wake, run, budget, recordMail, state}` over the object's SQL. `tell(message)` hands a due
 * routine to the control plane, `{type: "routine", bot, area, note, from}`; `arm()` re-arms the object's one alarm.
 *
 * @param {any} sql
 * @param {{rows: any, objects: any, facts: any, tell: (message: object) => void, findAreasRoot: () => string|null, arm?: () => void, defer?: (work: () => void) => void, now?: () => number}} deps
 */
export function areaRoutinesWatch(sql, { rows, objects, facts, tell, findAreasRoot, arm = () => {}, defer = (work) => queueMicrotask(work), now = Date.now }) {
  for (const statement of SCHEMA) sql.exec(statement);
  addDeliveryColumns(sql);
  const pending = new Set();
  let scheduled = false;

  const meta = (key) => all(sql.exec("SELECT v FROM ws_area_meta WHERE k = ?", key))[0]?.v ?? null;
  const setMeta = (key, value) => sql.exec("INSERT INTO ws_area_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, String(value));
  // The folder doing the Areas job, by its role or its name (`jobsAnswer.js`), kept until the tree changes.
  let knownRoot = undefined;
  const areasRoot = () => {
    if (knownRoot === undefined) knownRoot = findAreasRoot() ?? null;
    return knownRoot;
  };
  const textOf = (noteId) => {
    const object = noteId ? objects.get(`notes/${noteId}.md`) : null;
    return object?.body ? new TextDecoder().decode(object.body) : null;
  };
  const propsAt = (path) => facts.props({ paths: [path] }, () => true).props?.[0] ?? null;

  function markStale() {
    setMeta("stale", "1");
  }

  /** The bot's card, as its person wrote it: `{works}`, its caps (null when it lists nothing). */
  function cardOf(bot, root) {
    for (const path of botCardPaths(root, bot)) {
      const found = propsAt(path);
      if (found?.props) return { path, works: parseWorksIn(propsOf(found.props).works_in) };
    }
    return { path: null, works: null };
  }

  /** The bot an area sends work to and how much of its week it may spend there: `{bot, name, cap, used}` or null. */
  function budget(area, at = now()) {
    const about = propsAt(`${area}/about.md`);
    if (!about || about.sealed) return null;
    const bot = botOfArea(about.props);
    if (bot === null) return null;
    // A bot's own folder (`bots/<bot>/`, its card the folder's about.md) is mail to the bot, not work in an area: no
    // area's share is spent there, so it is never held.
    const said = propsOf(about.props);
    if (typeof said.owner !== "string" || said.owner.trim() === "") return null;
    const root = areasRoot();
    const cap = root === null ? null : botCapIn(cardOf(bot, root).works, area);
    const name = mailJoinName(bot);
    return { bot, name, cap, used: usedIn(name, area, weekOf(at, DEFAULT_ROUTINE_ZONE)) };
  }

  function usedIn(name, area, week) {
    return Number(all(sql.exec("SELECT COALESCE(SUM(used), 0) AS used FROM ws_bot_usage WHERE week = ? AND bot = ? AND area = ?", week, name, area))[0]?.used ?? 0);
  }

  /** Whether work for `area`'s bot goes out now: false once its share of the week is spent. */
  function spent(found) {
    return found !== null && typeof found.cap === "number" && found.used >= found.cap;
  }

  /**
   * An area's mail note was saved: count the `[used N%]` its bot said on each line, once per line, and mark the
   * routines it answered. Called from the mail watch (`botMail.js`), which has already found the note's area.
   * `routine` is set when the mail is in a routine's own note: a bot told "read the note it names" answers there
   * (Dev, 2026-11-27: "i fear that these routines may not be working"), and that answers that routine alone.
   */
  function recordMail(noteId, area, bot, routine = null) {
    const text = textOf(noteId);
    if (text === null) return;
    const name = mailJoinName(bot);
    const answerNote = routine === null && rows.byNoteId(noteId)?.path === `${area}/mail/${name}.md`;
    for (const event of parseMail(text).events) {
      if (event.kind !== "mail" || event.from.toLowerCase() !== name) continue;
      const at = Date.parse(event.at);
      if (!Number.isFinite(at)) continue;
      if (typeof event.used === "number") {
        sql.exec(
          "INSERT OR IGNORE INTO ws_bot_usage (mark, bot, area, week, used, at) VALUES (?, ?, ?, ?, ?, ?)",
          `${noteId}|${event.at}|${event.from}`,
          name,
          area,
          weekOf(at, DEFAULT_ROUTINE_ZONE),
          event.used,
          at,
        );
      }
      // Its answer to a routine sent to it before: the routine shows when it was answered. Only where the routine
      // asked for it, the bot's own mail note in the area (`answer_in`) or the routine's own note: a reply to someone
      // else's mail in the area is not the routine's answer (Capabilities' reply to Grok Bot once marked MCP's).
      if (routine !== null) sql.exec(`UPDATE ws_area_routines SET answered_at = ? WHERE path = ? AND last_bot = ? AND ${ANSWERABLE}`, at, routine, name, at);
      else if (answerNote) sql.exec(`UPDATE ws_area_routines SET answered_at = ? WHERE area = ? AND last_bot = ? AND ${ANSWERABLE}`, at, area, name, at);
    }
  }

  /** Rebuild the list from the rows and the notes' text, keeping each path's last run. */
  function scan(at) {
    const root = areasRoot();
    const kept = new Map(all(sql.exec("SELECT * FROM ws_area_routines")).map((row) => [row.path, row]));
    const seen = new Set();
    if (root !== null) {
      for (const row of rows.filesUnder(`${root}/`)) {
        if (seen.size >= MAX_AREA_ROUTINES) break;
        if (!row.path.includes("/routines/")) continue;
        const routine = areaRoutineOf(row.path, root);
        if (routine === null) continue;
        seen.add(row.path);
        // Its next time after its last run (or after it was first seen): a run that came due while nothing woke the
        // object still goes out, once, and a new routine never runs for a time before it existed.
        const before = kept.get(row.path);
        const since = before ? (before.last_at ?? before.seen_at ?? at) : at;
        const next = areaRoutineNext(routine, textOf(row.noteId), since);
        sql.exec(
          "INSERT INTO ws_area_routines (path, note_id, area, next_at, problem, seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET note_id = excluded.note_id, area = excluded.area, next_at = excluded.next_at, problem = excluded.problem",
          row.path,
          row.noteId ?? null,
          routine.area,
          next.at,
          next.problems.length > 0 ? next.problems.join(" ").slice(0, 500) : null,
          at,
        );
      }
    }
    for (const path of kept.keys()) if (!seen.has(path)) sql.exec("DELETE FROM ws_area_routines WHERE path = ?", path);
    sql.exec("DELETE FROM ws_bot_usage WHERE at < ?", at - USAGE_KEPT_MS);
    setMeta("stale", "0");
    setMeta("scanned", at);
  }

  /**
   * One routine sent to its area's bot, as the clock sends it: never past its spent share. The
   * webhook's reply is kept when it comes (`delivered`): a send nothing took is "failed", not a quiet "sent".
   */
  function send(row, at, found = budget(row.area, at)) {
    if (found === null) return { found, outcome: "no_bot" };
    if (spent(found)) return { found, outcome: "held" };
    try {
      const reply = tell({ type: "routine", bot: found.name, area: row.area, note: row.path, from: "context" });
      if (typeof reply?.then === "function") reply.then((result) => delivered(row.path, at, result)).catch(() => delivered(row.path, at, null));
      return { found, outcome: "sent" };
    } catch {
      return { found, outcome: "failed" };
    }
  }

  /** The webhook's reply to the send at `at`: its status, and "failed" when it didn't take the routine. */
  function delivered(path, at, result) {
    const status = Number.isInteger(result?.status) ? result.status : 0;
    const ok = result?.ok === true;
    sql.exec(
      "UPDATE ws_area_routines SET delivered_status = ?, delivered_at = ?, last_outcome = CASE WHEN ? THEN last_outcome ELSE 'failed' END WHERE path = ? AND last_at = ?",
      status,
      now(),
      ok ? 1 : 0,
      path,
      at,
    );
  }

  /** Whether `name` is working on a routine it was sent: sent, taken by its webhook (or not yet known), unanswered, recent. */
  function busy(name, at) {
    return all(sql.exec(`SELECT 1 AS busy FROM ws_area_routines WHERE last_bot = ? AND last_outcome = 'sent' AND answered_at IS NULL AND last_at > ? LIMIT 1`, name, at - ONE_AT_A_TIME_MS)).length > 0;
  }

  function due(at) {
    const stale = meta("stale") !== "0" || at - Number(meta("scanned") ?? 0) >= RESCAN_MS;
    if (stale) scan(at);
  }

  function drain() {
    scheduled = false;
    const ids = [...pending];
    pending.clear();
    const root = areasRoot();
    if (root === null) return;
    let changed = false;
    for (const noteId of ids) {
      const path = rows.byNoteId(noteId)?.path;
      if (typeof path === "string" && path.startsWith(`${root}/`) && !areaOfMailNote(path)) changed = true;
    }
    if (changed) {
      markStale();
      arm();
    }
  }

  return {
    noted(key, change) {
      const match = typeof key === "string" ? NOTE_KEY.exec(key) : null;
      if (match === null || change?.changed !== true) return;
      pending.add(match[1]);
      if (!scheduled) {
        scheduled = true;
        defer(() => {
          try {
            drain();
          } catch {
            // A routine's clock never fails a save; the six-hourly rebuild catches up.
          }
        });
      }
    },
    /** A move, a rename or a trash in the tree under the Areas folder (`paths: null` is anywhere): the next alarm rebuilds the list. */
    treeChanged(change) {
      knownRoot = undefined;
      const root = areasRoot();
      if (root === null) return;
      const paths = Array.isArray(change?.paths) ? change.paths : null;
      if (paths !== null && !paths.some((path) => typeof path === "string" && (path === root || path.startsWith(`${root}/`)))) return;
      markStale();
    },
    /** When the alarm should next run for these routines, or null when nothing is waiting. */
    wake() {
      if (meta("stale") === "1") return now();
      const next = all(sql.exec("SELECT MIN(next_at) AS at FROM ws_area_routines WHERE next_at IS NOT NULL"))[0]?.at;
      if (areasRoot() === null && next === null) return null;
      const rescan = Number(meta("scanned") ?? 0) + RESCAN_MS;
      return typeof next === "number" ? Math.min(next, rescan) : rescan;
    },
    /** Every routine due now, each sent once; then the next time of each. */
    run() {
      const at = now();
      due(at);
      const outcomes = [];
      for (const row of all(sql.exec("SELECT * FROM ws_area_routines WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at", at))) {
        const holder = budget(row.area, at);
        // One at a time: a bot still on its last routine gets this one once it answers, or after twenty minutes.
        if (holder !== null && !spent(holder) && busy(holder.name, at)) {
          sql.exec("UPDATE ws_area_routines SET next_at = ? WHERE path = ?", at + QUEUED_RETRY_MS, row.path);
          outcomes.push({ path: row.path, outcome: "queued" });
          continue;
        }
        const { found, outcome } = send(row, at, holder);
        // The next time strictly after now: an object asleep through several runs sends one, never a backlog.
        const next = areaRoutineNext(areaRoutineOf(row.path, areasRoot() ?? row.area), textOf(row.note_id), at);
        sql.exec(
          "UPDATE ws_area_routines SET last_at = ?, last_outcome = ?, last_bot = ?, answered_at = NULL, delivered_status = NULL, delivered_at = NULL, next_at = ? WHERE path = ?",
          at,
          outcome,
          found?.name ?? null,
          next.at,
          row.path,
        );
        outcomes.push({ path: row.path, outcome });
      }
      return outcomes;
    },
    /**
     * One routine sent now, out of turn, as the clock would send it (Dev, 2026-11-27: "add the run now button for every
     * routine"): the same bot, list and share, so Run now never sends past a cap. Its next time is left as it was.
     * `{outcome}`, or `{outcome: null}` for a path that is no routine here (paused and broken ones included: they
     * have no next time to run out of turn from), or `{outcome: "recent"}` when it was sent in the last minute: a
     * second press, or a second person, never sends the same job twice in a row.
     */
    runNow(path, at = now()) {
      due(at);
      const row = all(sql.exec("SELECT * FROM ws_area_routines WHERE path = ?", path))[0];
      if (row === undefined || row.next_at === null || row.next_at === undefined) return { outcome: null };
      if (row.last_outcome === "sent" && row.last_at != null && at - Number(row.last_at) < RUN_NOW_GAP_MS) return { outcome: "recent" };
      const { found, outcome } = send(row, at);
      sql.exec("UPDATE ws_area_routines SET last_at = ?, last_outcome = ?, last_bot = ?, answered_at = NULL, delivered_status = NULL, delivered_at = NULL WHERE path = ?", at, outcome, found?.name ?? null, row.path);
      return { outcome };
    },
    budget,
    spent,
    recordMail,
    /** The area a routine note at `path` belongs to, or null for a path that is no area's routine. */
    areaOfRoutine(path) {
      return all(sql.exec("SELECT area FROM ws_area_routines WHERE path = ?", path))[0]?.area ?? null;
    },
    /**
     * What a reader is shown: each routine and each bot's week, judged path by path with `sees`. Paths, times,
     * outcomes and percentages only.
     */
    state(sees = () => true, at = now()) {
      const week = weekOf(at, DEFAULT_ROUTINE_ZONE);
      const routines = all(sql.exec("SELECT path, area, next_at, last_at, last_outcome, last_bot, answered_at, delivered_status, problem FROM ws_area_routines ORDER BY path"))
        .filter((row) => sees(row.path))
        .map((row) => ({
          path: row.path,
          area: row.area,
          nextAt: row.next_at ?? null,
          lastAt: row.last_at ?? null,
          outcome: row.last_outcome ?? null,
          bot: row.last_bot ?? null,
          answeredAt: row.answered_at ?? null,
          // The webhook's status for the last send (0: no webhook took it), and whether its answer is overdue.
          deliveredStatus: row.delivered_status ?? null,
          answerIn: row.last_bot ? `${row.area}/mail/${row.last_bot}.md` : null,
          missed: row.last_outcome === "sent" && row.answered_at == null && row.last_at != null && at - Number(row.last_at) > ROUTINE_MISSED_MS,
          ...(row.problem ? { problem: row.problem } : {}),
        }));
      const usage = all(sql.exec("SELECT bot, area, SUM(used) AS used FROM ws_bot_usage WHERE week = ? GROUP BY bot, area ORDER BY bot, area", week))
        .filter((row) => sees(`${row.area}/about.md`))
        .map((row) => ({ bot: row.bot, area: row.area, used: Number(row.used) }));
      return { week, routines, usage };
    },
  };
}
