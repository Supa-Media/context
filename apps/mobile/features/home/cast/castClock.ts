/**
 * A clock a cast can be paused on and skipped along.
 *
 * `playCast` takes its timers from its host, so the show has no idea whether
 * time is real. The homepage hands it `setTimeout`; the cast studio hands it
 * this, which keeps the show's own time (`now`) apart from the wall's, so the
 * studio can:
 *
 * - **pause and resume**: the show's time stops, and every timer waits by
 *   exactly as long as it was paused;
 * - **rush**: run every timer at once, in the order it was due, until the
 *   caller says stop. Jumping to a step is a fresh page rushed to that step,
 *   and the timeline beside the script is a scratch show rushed to its end;
 * - **stop**: drop everything still waiting.
 *
 * The wall is injected, so tests drive it with a fake one.
 */

export interface Wall {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CastClock {
  /** `CastHost.schedule`: run `run` after `ms` of the show's time. */
  schedule(ms: number, run: () => void): () => void;
  /** The show's time, in ms since the clock was made. */
  now(): number;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** True while `rush` is running timers: a host lands text whole instead of typing it. */
  readonly rushing: boolean;
  /** Run due timers at once, in order, until `until()` is true or nothing is waiting. */
  rush(until: () => boolean): void;
  /** Drop every waiting timer; the clock does nothing after this. */
  stop(): void;
}

/** A bound on one rush, so a script that schedules forever cannot hang a tab. */
const MAX_RUSH_TIMERS = 200_000;

interface Timer {
  due: number;
  order: number;
  run: () => void;
}

const REAL_WALL: Wall = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createCastClock(wall: Wall = REAL_WALL): CastClock {
  const timers = new Set<Timer>();
  let order = 0;
  // The show's time is `base` plus the wall time since `since`, while running.
  let base = 0;
  let since = wall.now();
  let paused = false;
  let rushing = false;
  let stopped = false;
  let armed: unknown = null;

  const now = () => (paused || rushing ? base : base + (wall.now() - since));

  const earliest = (): Timer | undefined => {
    let first: Timer | undefined;
    for (const timer of timers) {
      if (first === undefined || timer.due < first.due || (timer.due === first.due && timer.order < first.order)) {
        first = timer;
      }
    }
    return first;
  };

  const disarm = () => {
    if (armed !== null) wall.clearTimeout(armed);
    armed = null;
  };

  const arm = () => {
    disarm();
    if (paused || rushing || stopped) return;
    const next = earliest();
    if (next === undefined) return;
    armed = wall.setTimeout(fire, Math.max(0, next.due - now()));
  };

  function fire() {
    armed = null;
    // Everything due by now, in order; a timer a run adds that is also due runs too.
    for (let next = earliest(); next !== undefined && next.due <= now() && !paused && !stopped; next = earliest()) {
      timers.delete(next);
      next.run();
    }
    arm();
  }

  return {
    schedule(ms, run) {
      if (stopped) return () => {};
      const timer: Timer = { due: now() + Math.max(0, ms), order: order++, run };
      timers.add(timer);
      if (!rushing) arm();
      return () => {
        if (timers.delete(timer) && !rushing) arm();
      };
    },
    now,
    pause() {
      if (paused || stopped) return;
      base = now();
      paused = true;
      disarm();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      since = wall.now();
      arm();
    },
    get paused() {
      return paused;
    },
    get rushing() {
      return rushing;
    },
    rush(until) {
      if (stopped || rushing) return;
      base = now();
      rushing = true;
      disarm();
      try {
        for (let count = 0; count < MAX_RUSH_TIMERS && !until() && !stopped; count += 1) {
          const next = earliest();
          if (next === undefined) break;
          timers.delete(next);
          base = Math.max(base, next.due);
          next.run();
        }
      } finally {
        rushing = false;
        since = wall.now();
        arm();
      }
    },
    stop() {
      stopped = true;
      timers.clear();
      disarm();
    },
  };
}
