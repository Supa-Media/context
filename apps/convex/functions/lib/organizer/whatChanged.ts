/**
 * "What changed", the orchestrator's half: read each arrival with the writing
 * model and keep the change cards that survive the checks.
 *
 * Runs in the sweep between gathering and recording, holding no credential,
 * the same as `askEach` does for organizing. Every call goes through Jev smarts
 * (`withJev`, feature `whatChanged`), so it is switched, capped and metered.
 */

import type { JevSession } from "../jev/client";
import { eachLimited } from "../jev/client";
import { changeMap, changeRequest, readChanges } from "../../../../mcp/src/organizer/changes.js";
import type { ChangeWork } from "./changeOps";
import type { OrganizerSuggestion } from "./sweepOps";

/** Arrivals read at once, per sweep. */
const WRITE_CONCURRENCY = 4;

export interface ChangesRead {
  found: OrganizerSuggestion[];
  /** How far the arrivals have now been read, or null when nothing moved the mark. */
  readUpTo: number | null;
  read: number;
  answered: number;
}

export async function readWhatChanged(jev: JevSession | null, work: ChangeWork | null, now: number): Promise<ChangesRead> {
  const none = { found: [], readUpTo: null, read: 0, answered: 0 };
  if (!work || work.sources.length === 0 || !jev) return none;
  const map = changeMap({ people: work.people, projects: work.projects, statuses: work.statuses, now });
  const answered = new Array<boolean>(work.sources.length).fill(false);
  const found: OrganizerSuggestion[] = [];
  let read = 0;
  await eachLimited(work.sources, WRITE_CONCURRENCY, async ({ source, body }, at) => {
    if (jev.remaining <= 0) return;
    read += 1;
    const written = await jev.write(changeRequest(source, body, map));
    if (!written) return;
    answered[at] = true;
    found.push(...(readChanges(written.output, { source, text: body, map, now }) as OrganizerSuggestion[]));
  });
  // The mark moves past an arrival only once it and everything before it was
  // answered, so a failure or the day's cap leaves it to be read next time.
  let readUpTo: number | null = null;
  for (let at = 0; at < work.sources.length && answered[at]; at += 1) readUpTo = work.sources[at]!.source.updatedAt;
  return { found, readUpTo, read, answered: answered.filter(Boolean).length };
}
