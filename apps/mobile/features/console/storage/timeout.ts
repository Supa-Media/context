/**
 * Wait for something, but not forever.
 *
 * ## Why this exists
 *
 * `bindStorage` is a Convex **action** doing real network I/O against the
 * customer's own bucket — encrypt the credential, list, write a probe object,
 * delete it — and `ConvexReactClient.action()` has **no client-side timeout**.
 * If that hangs, the promise stays pending for the life of the page.
 *
 * `ConnectForm` awaits it with `submitting` true, and `submitting` is what
 * makes every field `editable={false}` and what disables both Connect *and*
 * Cancel. So a hung bind leaves a form nobody can type in, submit, or leave:
 * the same dead end the note editor had, in the one place somebody is holding
 * a freshly-pasted secret.
 *
 * ## Shape
 *
 * The same pattern as `createReverifyController` in `./reverify.ts` — timers
 * injected rather than reached for, a generation the late arrival cannot
 * settle — reduced to the one thing this needs. Deliberately free of React, so
 * every branch (including "it answered one tick after we gave up") is a test
 * rather than something discovered in production.
 *
 * It resolves rather than rejects, and it separates "it threw" from "it never
 * answered", because those are different sentences to a person: one is a
 * failure the provider reported, the other is an unknown we stopped waiting on.
 */

export type Settled<T> =
  | { kind: "value"; value: T }
  | { kind: "failed"; error: unknown }
  /** Nothing came back inside the window. The work may still be running. */
  | { kind: "timeout" };

/**
 * How long to wait for a bucket to be bound and probed.
 *
 * Longer than `REVERIFY_TIMEOUT_MS`: re-verify waits on a probe that has
 * already been queued, while this is one round trip that encrypts, binds, and
 * runs the whole capability probe inline against an endpoint we have never
 * spoken to before. Generous for a slow provider, short enough that nobody
 * sits in front of a locked form wondering.
 */
export const CONNECT_TIMEOUT_MS = 45_000;

export function raceTimeout<T, Handle>(
  work: Promise<T>,
  options: {
    ms: number;
    schedule: (fn: () => void, ms: number) => Handle;
    cancel: (handle: Handle) => void;
  },
): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false;

    const timer = options.schedule(() => {
      if (done) return;
      done = true;
      resolve({ kind: "timeout" });
    }, options.ms);

    const finish = (settled: Settled<T>) => {
      // A late answer is dropped, not reported. Telling somebody "connected"
      // under a panel that already said we had stopped waiting is worse than
      // saying nothing — and the storage pane learns the real outcome from its
      // own subscription either way.
      if (done) return;
      done = true;
      options.cancel(timer);
      resolve(settled);
    };

    work.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ kind: "failed", error }),
    );
  });
}
