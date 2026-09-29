import type { CastStep } from "@context/shared";
import { createSharedDoc, seedSharedDoc } from "../../console/presence/sharedDoc";
import { createCastClock, type Wall } from "./castClock";
import { playCast } from "./castRun";

/** When each step of a show starts, and when the show is over, in ms. */
export interface CastTimeline {
  /** `starts[i]` is when step `i` begins; a step that never starts is `null`. */
  starts: (number | null)[];
  /** When the last person has left. */
  total: number;
}

/** A wall that never moves: the clock only advances by rushing. */
const STILL: Wall = { now: () => 0, setTimeout: () => null, clearTimeout: () => {} };

/**
 * The show's timings, without waiting for them: the same `playCast` the
 * homepage runs, into a document nobody sees, on a clock rushed to the end.
 * The typing is the real typing (`instant` is false), so a line's length is
 * the time it takes, and the studio's times match what plays.
 */
export function castTimeline(markdown: string, steps: readonly CastStep[]): CastTimeline {
  const shared = createSharedDoc({});
  seedSharedDoc(shared, markdown);
  const clock = createCastClock(STILL);
  const starts: (number | null)[] = steps.map(() => null);
  let total: number | null = null;
  const run = playCast(steps, shared, {
    schedule: (ms, fn) => clock.schedule(ms, fn),
    instant: () => false,
    pageNamed: () => null,
    addNote: (name) => `${name}.md`,
    agentDid: () => {},
    room: () => {},
    step: (index) => {
      starts[index] = clock.now();
    },
    ended: () => {
      total = clock.now();
    },
  });
  clock.rush(() => total !== null);
  run.stop();
  clock.stop();
  shared.doc.destroy();
  return { starts, total: total ?? clock.now() };
}

/** `0:07`, `1:12`: a time on the studio's script and scrubber. */
export function castTimeLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The step playing at `ms`: the last one that has started. `-1` before the first. */
export function stepAt(timeline: CastTimeline, ms: number): number {
  let at = -1;
  timeline.starts.forEach((start, index) => {
    if (start !== null && start <= ms) at = index;
  });
  return at;
}
