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
  windows(): Promise<CollectedWindows>;
  /** True when some other application holds an input device. */
  microphoneInUse(): Promise<boolean>;
  /** Events overlapping `now`, widened by the contract's lead and trail. */
  calendarEvents(now: Date): Promise<CalendarEvent[]>;
}

/**
 * What the window collector found, plus a count of what it could not fully
 * read. `tabUrlRefusals` is not a failure of this collector — the window
 * titles are still in `windows` — so it never makes `windows` join
 * `CollectedSignals.degraded`; see `platform/macos/windows.ts` for where it
 * is counted and `evidence.ts` for the sentence it earns.
 */
export interface CollectedWindows {
  windows: WindowSignal[];
  tabUrlRefusals: number;
}

/**
 * A collector throws this, rather than a bare `Error`, precisely when it can
 * tell that a *permission* was refused — as opposed to a timeout, a malformed
 * result, or the target application hanging. `attempt()` below checks its
 * identity, never its message, to choose which sentence `degradedNotice`
 * shows for a degraded calendar: a permission refusal names the setting to
 * change, and anything else says only that the read failed this time. Nothing
 * about the classification carries the message text any further than this
 * file — the reason `attempt()`'s own comment already gives.
 */
export class PermissionRefusedError extends Error {}

/**
 * Why a collector is degraded, for the one sentence that depends on knowing —
 * `degradedNotice`'s calendar case. Everything not explicitly thrown as a
 * `PermissionRefusedError` reads as `"unknown"`: a timeout and a malformed
 * result get the same honest, non-diagnosing sentence, because guessing
 * between them is not a diagnosis this app can actually make.
 */
export type DegradedReason = "permission-refused" | "unknown";

export interface CollectedSignals {
  signals: DetectionSignals;
  /**
   * Collectors that failed this poll, by name. Surfaced in the panel as "the
   * app cannot see your calendar" rather than silently reading as "you have no
   * meetings" — a permission the person never granted must not look like an
   * answer.
   */
  degraded: string[];
  /** Why each name in `degraded` failed. See `DegradedReason`. */
  degradedReasons: Record<string, DegradedReason>;
  /**
   * Browsers whose tab URL could not be read this poll, even though the
   * window collector overall succeeded — a blind spot the app can now count
   * rather than one indistinguishable from "nothing to see there".
   */
  tabUrlRefusals: number;
}

async function attempt<T>(
  name: string,
  fallback: T,
  degraded: string[],
  reasons: Record<string, DegradedReason>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // The error itself is deliberately not carried out of here: a window
    // collector's failure message can contain a window title, and a failure
    // path is exactly where nobody remembers to redact. `PermissionRefusedError`
    // carries no such text into this classification — it is checked by type,
    // never read for its message.
    degraded.push(name);
    reasons[name] = error instanceof PermissionRefusedError ? "permission-refused" : "unknown";
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
  const degradedReasons: Record<string, DegradedReason> = {};
  const emptyWindows: CollectedWindows = { windows: [], tabUrlRefusals: 0 };
  const [processes, windowsResult, microphoneInUse, calendarEvents] = await Promise.all([
    attempt("processes", [] as string[], degraded, degradedReasons, () => collectors.processes()),
    attempt("windows", emptyWindows, degraded, degradedReasons, () => collectors.windows()),
    attempt("microphone", false, degraded, degradedReasons, () => collectors.microphoneInUse()),
    attempt("calendar", [] as CalendarEvent[], degraded, degradedReasons, () => collectors.calendarEvents(now)),
  ]);

  return {
    signals: {
      now: now.toISOString(),
      processes,
      windows: windowsResult.windows,
      microphoneInUse,
      calendarEvents,
    },
    degraded: degraded.sort(),
    degradedReasons,
    tabUrlRefusals: windowsResult.tabUrlRefusals,
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

/** A fake's signals, plus the one field `DetectionSignals` itself has no room
 * for: how many browsers this poll's window read refused a tab URL. */
type FakeSignals = Partial<DetectionSignals> & { tabUrlRefusals?: number };

/** Collectors that answer the same thing forever. */
export function fixedCollectors(partial: FakeSignals = {}): SignalCollectors {
  return {
    processes: async () => partial.processes ?? [],
    windows: async () => ({ windows: partial.windows ?? [], tabUrlRefusals: partial.tabUrlRefusals ?? 0 }),
    microphoneInUse: async () => partial.microphoneInUse ?? false,
    calendarEvents: async () => partial.calendarEvents ?? [],
  };
}

/**
 * Collectors that walk a script, one entry per poll, holding on the last entry
 * once the script runs out. This is how a flicker is written down: three polls
 * of Zoom, one poll of nothing, three more of Zoom.
 */
export function scriptedCollectors(script: readonly FakeSignals[]): SignalCollectors {
  let index = 0;
  const frame = (): FakeSignals => {
    const current = script[Math.min(index, script.length - 1)] ?? {};
    index += 1;
    return current;
  };
  // One `frame()` per poll, not per question: the four collectors are called
  // together by `collectSignals`, and advancing four times a poll would make
  // every script silently four times too short.
  let pending: FakeSignals | null = null;
  let served = 0;
  const current = (): FakeSignals => {
    if (pending === null || served >= 4) {
      pending = frame();
      served = 0;
    }
    served += 1;
    return pending;
  };
  return {
    processes: async () => current().processes ?? [],
    windows: async () => {
      // One `current()` call, not two: it advances the script on every call,
      // and `windows` needing two fields out of the same frame must not cost
      // this collector two turns for the other three's one.
      const value = current();
      return { windows: value.windows ?? [], tabUrlRefusals: value.tabUrlRefusals ?? 0 };
    },
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
