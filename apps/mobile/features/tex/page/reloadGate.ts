/**
 * One read of the Tex page at a time, and at most one every `gapMs`, however
 * many "read it again" frames arrive (2026-11-17). Each frame used to start a
 * whole read of its own (the first screen, the tiles, the machines), so a busy
 * turn's stream of changes became hundreds of reads a minute, enough to
 * overload the person's own workspace object and fail their sign-ins with it.
 *
 * A request while a read runs, or inside the gap after one started, is kept as
 * one read still owed, made when both have passed: nothing announced is
 * missed, and a burst of a hundred costs two reads.
 */

export const RELOAD_GAP_MS = 2_000;

export interface ReloadGate {
  /** Ask for a read: now if none ran within the gap, else once, later. */
  request(): void;
  /** Forget a read still owed (the page closed, or moved to another chat). */
  cancel(): void;
}

export function reloadGate(
  read: () => Promise<unknown>,
  {
    gapMs = RELOAD_GAP_MS,
    now = () => Date.now(),
    later = (run: () => void, ms: number) => setTimeout(run, ms),
    clear = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  }: {
    gapMs?: number;
    now?: () => number;
    later?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear?: (handle: ReturnType<typeof setTimeout>) => void;
  } = {},
): ReloadGate {
  let running = false;
  let owed = false;
  let startedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const start = () => {
    timer = null;
    if (cancelled) return;
    owed = false;
    running = true;
    startedAt = now();
    void Promise.resolve()
      .then(read)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (owed && !cancelled) request();
      });
  };

  const request = () => {
    if (cancelled) return;
    if (running) {
      owed = true;
      return;
    }
    if (timer !== null) return;
    const wait = startedAt + gapMs - now();
    if (wait <= 0) start();
    else {
      owed = true;
      timer = later(start, wait);
    }
  };

  return {
    request,
    cancel() {
      cancelled = true;
      owed = false;
      if (timer !== null) clear(timer);
      timer = null;
    },
  };
}
