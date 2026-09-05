/**
 * Where `DetectionSignals` comes from, and the seam that makes it testable.
 *
 * Four questions, one small module each, because they fail independently and
 * for unrelated reasons: a process list needs no permission at all, window
 * titles need Accessibility, browser tab URLs need Automation, and the calendar
 * needs Calendars. A person can grant one and refuse another and the app has to
 * keep working with whatever it has.
 *
 * Every collector is an interface with a deterministic fake beside it. That is
 * not a testing nicety here — the real implementations shell out to macOS and
 * cannot run in CI at all, so a design where the loop can only be exercised
 * with a real meeting is a design where the loop is never exercised.
 *
 * **Collectors return facts, never judgements.** No collector decides that a
 * meeting is happening; `detect()` in `packages/meetings/src/detect.js` does
 * that, and it is the only thing that does.
 */

import type { CalendarEvent, DetectionSignals, WindowSignal } from "../contract.ts";

/**
 * One OS concern. Each may reject; `collectSignals` treats a rejection as
 * "this collector knows nothing right now", never as a negative observation.
 */
export interface SignalCollectors {
  /** Running application or bundle names. */
  processes(): Promise<string[]>;
  /** Open windows, with browser tab URLs where the browser will say. */
  windows(): Promise<WindowSignal[]>;
  /** True when some other application holds an input device. */
  microphoneInUse(): Promise<boolean>;
  /** Events overlapping `now`, widened by the contract's lead and trail. */
  calendarEvents(now: Date): Promise<CalendarEvent[]>;
}

export interface CollectedSignals {
  signals: DetectionSignals;
  /**
   * Collectors that failed this poll, by name. Surfaced in the panel as "the
   * app cannot see your calendar" rather than silently reading as "you have no
   * meetings" — a permission the person never granted must not look like an
   * answer.
   */
  degraded: string[];
}

async function attempt<T>(
  name: string,
  fallback: T,
  degraded: string[],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch {
    // The error itself is deliberately not carried out of here: a window
    // collector's failure message can contain a window title, and a failure
    // path is exactly where nobody remembers to redact.
    degraded.push(name);
    return fallback;
  }
}

/**
 * Ask all four, in parallel, and assemble the contract's shape.
 *
 * A failing collector degrades to its empty value. The empty values are all
 * "no evidence" rather than "evidence of absence", which keeps a broken
 * collector from *creating* a detection — the failure direction that matters,
 * since the other one only costs a missed meeting the person can start by hand.
 */
export async function collectSignals(
  collectors: SignalCollectors,
  now: Date,
): Promise<CollectedSignals> {
  const degraded: string[] = [];
  const [processes, windows, microphoneInUse, calendarEvents] = await Promise.all([
    attempt("processes", [] as string[], degraded, () => collectors.processes()),
    attempt("windows", [] as WindowSignal[], degraded, () => collectors.windows()),
    attempt("microphone", false, degraded, () => collectors.microphoneInUse()),
    attempt("calendar", [] as CalendarEvent[], degraded, () => collectors.calendarEvents(now)),
  ]);

  return {
    signals: { now: now.toISOString(), processes, windows, microphoneInUse, calendarEvents },
    degraded: degraded.sort(),
  };
}

/* ------------------------------------------------------------------------- *
 * Fakes.
 *
 * These are the collectors CI runs against. They are in `src/` rather than in
 * `test/` on purpose: `--dev --fake-signals` runs the real app against them,
 * which is how the panel and the tray get exercised on a machine that is not in
 * a meeting, and a fake that only the tests can reach is a fake that rots.
 * ------------------------------------------------------------------------- */

/** Collectors that answer the same thing forever. */
export function fixedCollectors(partial: Partial<DetectionSignals> = {}): SignalCollectors {
  return {
    processes: async () => partial.processes ?? [],
    windows: async () => partial.windows ?? [],
    microphoneInUse: async () => partial.microphoneInUse ?? false,
    calendarEvents: async () => partial.calendarEvents ?? [],
  };
}

/**
 * Collectors that walk a script, one entry per poll, holding on the last entry
 * once the script runs out. This is how a flicker is written down: three polls
 * of Zoom, one poll of nothing, three more of Zoom.
 */
export function scriptedCollectors(script: readonly Partial<DetectionSignals>[]): SignalCollectors {
  let index = 0;
  const frame = (): Partial<DetectionSignals> => {
    const current = script[Math.min(index, script.length - 1)] ?? {};
    index += 1;
    return current;
  };
  // One `frame()` per poll, not per question: the four collectors are called
  // together by `collectSignals`, and advancing four times a poll would make
  // every script silently four times too short.
  let pending: Partial<DetectionSignals> | null = null;
  let served = 0;
  const current = (): Partial<DetectionSignals> => {
    if (pending === null || served >= 4) {
      pending = frame();
      served = 0;
    }
    served += 1;
    return pending;
  };
  return {
    processes: async () => current().processes ?? [],
    windows: async () => current().windows ?? [],
    microphoneInUse: async () => current().microphoneInUse ?? false,
    calendarEvents: async () => current().calendarEvents ?? [],
  };
}

/** Collectors that always throw — the "no permissions granted" machine. */
export function failingCollectors(): SignalCollectors {
  const boom = async (): Promise<never> => {
    throw new Error("collector unavailable");
  };
  return {
    processes: boom,
    windows: boom,
    microphoneInUse: boom,
    calendarEvents: boom,
  };
}
