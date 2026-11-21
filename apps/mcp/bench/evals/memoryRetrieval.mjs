/**
 * LONGMEMEVAL RETRIEVAL: ARE THE ANSWER SESSIONS IN SEARCH'S TOP 5? (Dev2, 2026-11-21: set (c) of the Search suite,
 * `searchSuite.mjs`'s "longmemeval-retrieval".)
 *
 * No reader and no judge. Each past session of a question is saved as one note in Sam's empty personal workspace, the
 * way a raw saved session lands: `inbox/sessions/longmemeval/<YYYY-MM-DD>-<session id slug>.md`, dated by its front
 * matter (so `noteModifiedAt` dates it then), body the session's transcript. The question is then one `search_notes`
 * call as Sam, at the question's date, and the answer sessions' notes are the expected addresses.
 */

import { abilityOf, sessionsOf, transcriptOf, utcMs } from "./longMemEval.mjs";
import { EVAL_PERSON, EVAL_WORKSPACE, evalBench } from "./memoryRun.mjs";
import { overlay, runSearchCases, searchScores, TOP_K } from "./searchSuite.mjs";

/** The folder a saved LongMemEval session lands in, under the person's personal workspace. */
export const SESSION_FOLDER = "inbox/sessions/longmemeval";

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const pctOf = (n, of) => (of === 0 ? null : Math.round((1000 * n) / of) / 10);

/** A session id as a file name part: lower-case words joined by hyphens, never empty, never long. */
export function slugOf(id) {
  const slug = String(id ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "session";
}

/**
 * The item's past sessions as notes, and the addresses of the answer sessions' notes. Each note is front matter
 * (`title`, `date` = the session's day in UTC) and the session's transcript. Paths are unique: two sessions whose ids
 * slug alike on one day get `-2`, `-3`, ... . `missing` names an answer session the dataset gives no usable date or
 * turns for, so it has no note and cannot be found; it is reported, never silently dropped from the expectation.
 */
export function sessionNotes(item) {
  const sessions = sessionsOf(item);
  const answerIds = new Set(Array.isArray(item?.answer_session_ids) ? item.answer_session_ids.map(String) : []);
  const notes = {};
  const expect = [];
  const used = new Set();
  const held = new Set();
  for (const session of sessions) {
    const day = isoDay(session.at);
    const base = `${day}-${slugOf(session.id)}`;
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
    used.add(name);
    const path = `${SESSION_FOLDER}/${name}.md`;
    const address = `@${EVAL_WORKSPACE}/${path}`;
    notes[address] = `---\ntitle: "Chat ${day}"\ndate: ${day}\n---\n\n${transcriptOf(session)}\n`;
    if (answerIds.has(session.id)) {
      expect.push(address);
      held.add(session.id);
    }
  }
  const missing = [...answerIds].filter((id) => !held.has(id));
  return { notes, expect, missing };
}

/**
 * One question's retrieval: `sessionNotes` laid over Sam's bench, one case searched at the question's date. Returns
 * runSearchCases' record plus `recallAny5`, `recallAll5` (an answer note in the top 5, every answer note there) and
 * `ability`.
 */
export async function retrieveQuestion(item, { ai } = {}) {
  const { notes, expect, missing } = sessionNotes(item);
  const bench = overlay(evalBench(), notes);
  const askedAt = utcMs(item.question_date);
  const kind = typeof item.question_type === "string" ? item.question_type : null;
  const id = String(item.question_id);
  const [record] = await runSearchCases({
    bench,
    cases: [{ id, query: String(item.question), as: EVAL_PERSON, expect, kind }],
    ai,
    today: askedAt === null ? null : isoDay(askedAt),
  });
  const top = (record.hits ?? []).slice(0, TOP_K);
  const inTop = expect.filter((address) => top.includes(address)).length;
  return {
    ...record,
    missing,
    recallAny5: expect.length > 0 && inTop > 0,
    recallAll5: expect.length > 0 && inTop === expect.length,
    ability: abilityOf(id, kind),
  };
}

/**
 * The scores of retrieval records: `searchScores` plus `recallAny5Pct`, `recallAll5Pct` (over the questions that have
 * answer notes) and `byAbility` { ability: { n, recallAny5Pct } }.
 */
export function retrievalScores(records) {
  const scored = records.filter((r) => (r.expect ?? []).length > 0);
  const byAbility = {};
  for (const ability of [...new Set(scored.map((r) => r.ability ?? abilityOf(r.id, r.kind)))]) {
    const group = scored.filter((r) => (r.ability ?? abilityOf(r.id, r.kind)) === ability);
    byAbility[ability] = { n: group.length, recallAny5Pct: pctOf(group.filter((r) => r.recallAny5).length, group.length) };
  }
  return {
    ...searchScores(records),
    recallAny5Pct: pctOf(scored.filter((r) => r.recallAny5).length, scored.length),
    recallAll5Pct: pctOf(scored.filter((r) => r.recallAll5).length, scored.length),
    byAbility,
  };
}
