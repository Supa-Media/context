/**
 * What a background job's parts have already got, saved as each piece returns (Dev2's "jobs as config" plan, part B,
 * 2026-11-17).
 *
 * The incident: a timecards job's every part died in its answer checks, and the next part was told only the names of
 * the steps the last one took (`cutOff`). Ten parts each redid the same email search, sign-in, picture and email draft,
 * then the job failed with nothing. Now every tool result, every action held for the person's yes, and the last draft
 * the part wrote are saved in the job's object the moment they stream back (`PROGRESS_KEY`), so a part that dies
 * mid-way loses nothing it had, and the next part starts from them (`apps/mcp/src/agent/jobSaved.js` tells it how).
 *
 * Each part also ends with a typed cause (`PartCause`): what the next step depends on, and what `job_status` shows.
 * A cause that would happen again the same way (`DETERMINISTIC`) delivers the saved draft instead of spending parts.
 */

import type { StepHow } from "./jobs";

/** Why a part ended. `check_limit`: its answer checks sent the draft back more times than the config allows. */
export type PartCause = "done" | "waiting" | "stuck" | "check_limit" | "timeout" | "crash" | "model_down" | "steps_out" | "unfinished" | "changed" | "stopped" | "refused";
export const PART_CAUSES: ReadonlySet<string> = new Set<PartCause>(["done", "waiting", "stuck", "check_limit", "timeout", "crash", "model_down", "steps_out", "unfinished", "changed", "stopped", "refused"]);
/** One part's end, as its job keeps it. */
export type PartEnd = { part: number; cause: PartCause };
/** Causes that would end the next part the same way: running it again only burns a part (the timecards job burned ten). */
export const DETERMINISTIC: ReadonlySet<PartCause> = new Set<PartCause>(["check_limit"]);

/** One tool call that returned: its step line, what it returned, and whether it waits on the person's yes. */
export type SavedCall = { part: number; step: string; result?: string; held?: true; failed?: true; outside?: true };
/** Everything the job's parts have got so far. `draft`: the last answer a part wrote, checked or not, never sent. */
export type JobSaved = { calls: SavedCall[]; draft?: string; draftPart?: number };

/** The job's object key for the part running now, written on every return. Deleted once the pass folds it into the run. */
export const PROGRESS_KEY = "jobprogress";
export const MAX_SAVED_CALLS = 30;
export const MAX_SAVED_RESULT = 1_500;
/** All results together: a part's prompt carries them, so older ones give up their text first (held ones last). */
export const MAX_SAVED_CHARS = 16_000;
export const MAX_SAVED_DRAFT = 4_000;
export const MAX_ENDS_KEPT = 12;

/** A step line as it streamed (`clients.ts`), saved; null for one with nothing worth keeping. */
export function savedCall(part: number, text: string, how?: StepHow): SavedCall | null {
  const step = text.replace(/\s+/g, " ").trim().slice(0, 160);
  if (step === "") return null;
  const result = typeof how?.result === "string" ? how.result.trim().slice(0, MAX_SAVED_RESULT) : "";
  return { part, step, ...(result ? { result } : {}), ...(how?.held ? { held: true as const } : {}), ...(how?.failed ? { failed: true as const } : {}), ...(how?.outside ? { outside: true as const } : {}) };
}

/** Earlier parts' saves with this part's after them, kept within bounds: newest calls, held ones first to keep their text. */
export function mergeSaved(earlier: JobSaved | undefined, now: JobSaved | undefined): JobSaved | undefined {
  const calls = [...(earlier?.calls ?? []), ...(now?.calls ?? [])].slice(-MAX_SAVED_CALLS);
  let room = MAX_SAVED_CHARS;
  // Newest first, held ones before the rest, take their text while it fits; the rest keep their step line only.
  const order = calls.map((call, index) => ({ call, index })).sort((a, b) => Number(Boolean(b.call.held)) - Number(Boolean(a.call.held)) || b.index - a.index);
  const fits = new Set<number>();
  for (const { call, index } of order) {
    const size = call.result?.length ?? 0;
    if (size <= room) {
      room -= size;
      fits.add(index);
    }
  }
  const kept = calls.map((call, index) => {
    if (fits.has(index) || call.result === undefined) return call;
    const { result: _dropped, ...rest } = call;
    return rest;
  });
  const draft = now?.draft ?? earlier?.draft;
  const draftPart = now?.draft ? now.draftPart : earlier?.draftPart;
  if (kept.length === 0 && !draft) return undefined;
  return { calls: kept, ...(draft ? { draft: draft.slice(0, MAX_SAVED_DRAFT), ...(draftPart ? { draftPart } : {}) } : {}) };
}

/** A part's ends with this one added, newest kept. */
export function withEnd(ends: PartEnd[] | undefined, part: number, cause: PartCause): PartEnd[] {
  return [...(ends ?? []), { part, cause }].slice(-MAX_ENDS_KEPT);
}

/** Whether any saved call read from outside: the next part built on it is marked as the part that read it was. */
export const readOutside = (saved: JobSaved | undefined) => (saved?.calls ?? []).some((call) => call.outside === true);

/** Fingerprints of results a job's parts have read, newest kept: what the Part end node's `fresh` counts against. */
export const MAX_SEEN = 300;

/** A short fingerprint of a result's words (FNV-1a over its text with spacing and case evened out). */
export function resultPrint(result: string): string {
  let hash = 0x811c9dc5;
  for (const ch of result.replace(/\s+/g, " ").trim().toLowerCase()) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(36);
}

/**
 * What a part found that no earlier part had (2026-11-17: a coworking job re-read the same sites for six parts):
 * `fresh` counts its results, failed ones left out, whose words no earlier part read; `seen` is every fingerprint so
 * far; `stale` is how many parts in a row, this one included, found nothing new (0 once one does). A step's print is its
 * step line with its result, so a write that answers "Saved." each time still counts as new work. A part that doesn't
 * count (`counts` false: a retry, a part that broke, a job on a computer, whose steps carry no results) leaves both as
 * they were and says `counted: false`, so the Part end node is given no count and never ends it as stale.
 */
export function freshness(run: { seen?: string[]; stale?: number }, part: JobSaved | undefined, counts = true): { fresh: number; staleBefore: number; seen: string[]; stale: number; counted: boolean } {
  const staleBefore = run.stale ?? 0;
  if (!counts) return { fresh: 0, staleBefore, seen: run.seen ?? [], stale: staleBefore, counted: false };
  const seen = new Set(run.seen ?? []);
  let fresh = 0;
  for (const call of part?.calls ?? []) {
    if (call.failed || call.result === undefined) continue;
    const print = resultPrint(`${call.step}\n${call.result}`);
    if (!seen.has(print)) fresh += 1;
    seen.add(print);
  }
  return { fresh, staleBefore, seen: [...seen].slice(-MAX_SEEN), stale: fresh === 0 ? staleBefore + 1 : 0, counted: true };
}

export { carryPatch, partResume } from "./jobPartResume"; // which saved rounds a part goes on from
