import type { CastStep } from "@context/shared";
import { createSharedDoc, seedSharedDoc } from "../../console/presence/sharedDoc";
import { createCastClock, type Wall } from "./castClock";
import { CAST_MOMENTS, LIVELY, playCast, type CastMoment, type CastPace } from "./castRun";

/** When each step of a show starts, and when the show is over, in ms. */
export interface CastTimeline {
  /** `starts[i]` is when step `i` begins; a step that never starts is `null`. */
  starts: (number | null)[];
  /** When the last person has left. */
  total: number;
  /**
   * How often each moment happens, for the studio's sound list. Typing counts
   * once per line typed rather than per key.
   */
  moments: Record<CastMoment, number>;
}

export function noMoments(): Record<CastMoment, number> {
  return Object.fromEntries(CAST_MOMENTS.map((moment) => [moment, 0])) as Record<CastMoment, number>;
}

const landed = (path: string) => path;

/** A wall that never moves: the clock only advances by rushing. */
const STILL: Wall = { now: () => 0, setTimeout: () => null, clearTimeout: () => {} };

/**
 * The show's timings, without waiting for them: the same `playCast` the
 * homepage runs, into a document nobody sees, on a clock rushed to the end.
 * The typing is the real typing (`instant` is false), so a line's length is
 * the time it takes, and the studio's times match what plays.
 */
export function castTimeline(
  markdown: string,
  steps: readonly CastStep[],
  /** The pages its `opens:` steps name, by the name written, so steps there are timed against them. */
  pages: Readonly<Record<string, string>> = {},
  pace: CastPace = LIVELY,
  /** The scene's terminals, whose Context work shows in them as the homepage plays it. */
  terminals?: readonly string[],
): CastTimeline {
  const shared = createSharedDoc({});
  seedSharedDoc(shared, markdown);
  const clock = createCastClock(STILL);
  const starts: (number | null)[] = steps.map(() => null);
  let total: number | null = null;
  const moments = noMoments();
  let current = -1;
  let typed = -1;
  const opened: ReturnType<typeof createSharedDoc>[] = [];
  const run = playCast(steps, shared, {
    schedule: (ms, fn) => clock.schedule(ms, fn),
    instant: () => false,
    pageNamed: () => null,
    addNote: (name) => `${name}.md`,
    // Every workspace step is timed as if it lands, so its sound is counted.
    workspace: { addFolder: landed, move: landed, rename: landed, setStatus: landed, addTask: landed },
    // Chats drawn nowhere, so their beats are timed as the homepage plays them.
    chat: () => {},
    // A page it was not given is timed as an empty one.
    open: (name) => {
      const page = createSharedDoc({});
      seedSharedDoc(page, pages[name] ?? pages[name.toLowerCase()] ?? "");
      opened.push(page);
      return { path: name, shared: page };
    },
    agentDid: () => {},
    room: () => {},
    step: (index) => {
      current = index;
      starts[index] = clock.now();
    },
    ended: () => {
      total = clock.now();
    },
    cue: (moment) => {
      if (moment === "typing") {
        if (typed === current) return;
        typed = current;
      }
      moments[moment] += 1;
    },
  }, { pace, terminals });
  clock.rush(() => total !== null);
  run.stop();
  clock.stop();
  shared.doc.destroy();
  for (const page of opened) page.doc.destroy();
  return { starts, total: total ?? clock.now(), moments };
}

/** `0:07`, `1:12`: a time on the studio's script and scrubber. */
export function castTimeLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The step playing at `ms`: the last one that has started. `-1` before the first. */
export function stepAt(timeline: Pick<CastTimeline, "starts">, ms: number): number {
  let at = -1;
  timeline.starts.forEach((start, index) => {
    if (start !== null && start <= ms) at = index;
  });
  return at;
}
