import { describeStorageFailure, describeThrownStorageError, type StorageFailure } from "./errors";

/**
 * Re-verify: ask the control plane to check the bucket again, and say what came
 * back.
 *
 * This matters more than a refresh button usually would. One transient network
 * blip during a probe sets a binding to `error`, and until something re-runs
 * the probe it stays there — the gateway only accepts `connected`, so the
 * customer's whole context is down until they re-paste credentials they never
 * needed to change. Re-verify is the escape hatch, and a button that "renders
 * but does nothing" is the bug, not a missing nicety.
 *
 * ## Why this is a state machine and not an await
 *
 * `reverifyStorage` is a **mutation**, and it does not perform the probe. It
 * rate-limits, schedules `verifyStorageBinding`, and returns
 * `{ queued: true, status }` — where `status` is the status *before* the check,
 * because the check has not run yet. It cannot return the outcome: the whole
 * reason it is a mutation is that a public function which could see a probe's
 * return value would have a decrypted credential in scope.
 *
 * So the outcome arrives the only way it can — on the row, through the reactive
 * `getStorageBinding` subscription. This controller queues the probe, remembers
 * what the row looked like at that moment, and settles when the row moves. That
 * is what `observe` is for.
 *
 * Deliberately free of React so every branch — including the one where the row
 * never moves — is a test rather than a thing you find out about in production.
 */

/** The slice of the binding this needs to tell "before" from "after". */
export interface ObservedBinding {
  status: string;
  updatedAt: number;
  lastVerifiedAt?: number;
  lastError?: string;
  errorCode?: string;
}

export type ReverifyState =
  | { kind: "idle" }
  /** Queued, waiting for the row to move. */
  | { kind: "running" }
  | { kind: "ok"; message: string }
  | { kind: "failed"; failure: StorageFailure }
  /** Queued, but nothing came back inside the window. */
  | { kind: "timeout"; message: string };

/**
 * How long to wait for the row to move before saying so.
 *
 * The probe is a scheduled function doing real network I/O against a bucket
 * that may be slow or unreachable; 30s is generous for the happy path and short
 * enough that a person is not left watching a spinner forever. Timing out is
 * not a failure — the probe is still queued and the pane's own status pill will
 * update whenever it lands, which is what the message says.
 */
export const REVERIFY_TIMEOUT_MS = 30_000;

/** How long a settled outcome stays on screen before the panel goes quiet. */
export const REVERIFY_OK_RESET_MS = 8_000;

export interface ReverifyController {
  /** Queue a probe. A second call while one is running is ignored. */
  start(binding: ObservedBinding): void;
  /** Feed in each new value of the binding. Settles a running check. */
  observe(binding: ObservedBinding): void;
  /** Drop the current outcome without starting anything. */
  dismiss(): void;
  dispose(): void;
}

export interface ReverifyOptions<Handle> {
  /** Calls `reverifyStorage`. Resolves when the probe is queued. */
  queue: () => Promise<{ queued: boolean; status: string }>;
  schedule: (fn: () => void, ms: number) => Handle;
  cancel: (handle: Handle) => void;
  onChange: (state: ReverifyState) => void;
}

export function createReverifyController<Handle>(
  options: ReverifyOptions<Handle>,
): ReverifyController {
  let state: ReverifyState = { kind: "idle" };
  let timer: Handle | null = null;
  /** The row as it looked when the probe was queued. */
  let baseline: ObservedBinding | null = null;
  let disposed = false;
  /**
   * Increments on every start and on dispose, so a probe queued, abandoned, and
   * queued again cannot have its first response settle the second run.
   */
  let generation = 0;

  function clearTimer() {
    if (timer !== null) {
      options.cancel(timer);
      timer = null;
    }
  }

  function set(next: ReverifyState) {
    state = next;
    options.onChange(next);
  }

  /**
   * Has the row moved since the probe was queued?
   *
   * `updatedAt` is the primary signal because `recordVerification` patches it
   * on every outcome, success or failure. `lastVerifiedAt` is checked too, for
   * the case where a probe finishes inside the same millisecond it was queued —
   * possible against a fast local backend, and it would otherwise hang.
   *
   * Note what is *not* used: the status. A re-verify of a `connected` binding
   * that stays `connected` is the most common outcome there is, and waiting for
   * the status to change would hang on exactly that case.
   */
  function moved(binding: ObservedBinding): boolean {
    if (baseline === null) return false;
    if (binding.updatedAt > baseline.updatedAt) return true;
    return (
      binding.lastVerifiedAt !== undefined &&
      binding.lastVerifiedAt !== baseline.lastVerifiedAt
    );
  }

  function settle(binding: ObservedBinding) {
    clearTimer();
    baseline = null;

    if (binding.status === "connected") {
      set({ kind: "ok", message: "Checked just now — your bucket is reachable and writable." });
      const mine = generation;
      timer = options.schedule(() => {
        timer = null;
        // Only clear our own success. A failure that arrived since stays put.
        if (!disposed && mine === generation && state.kind === "ok") set({ kind: "idle" });
      }, REVERIFY_OK_RESET_MS);
      return;
    }

    set({
      kind: "failed",
      failure: describeStorageFailure(binding.errorCode, binding.lastError),
    });
  }

  return {
    start(binding) {
      if (disposed || state.kind === "running") return;
      generation += 1;
      const mine = generation;
      clearTimer();
      baseline = binding;
      set({ kind: "running" });

      timer = options.schedule(() => {
        timer = null;
        if (disposed || mine !== generation || state.kind !== "running") return;
        baseline = null;
        set({
          kind: "timeout",
          message:
            "Still waiting on your provider. The check is queued and this pane updates on its own when it lands.",
        });
      }, REVERIFY_TIMEOUT_MS);

      void options.queue().then(
        (result) => {
          if (disposed || mine !== generation || state.kind !== "running") return;
          // A backend that declined to queue without throwing. Nothing is
          // coming, so do not leave a spinner promising otherwise.
          if (!result.queued) {
            clearTimer();
            baseline = null;
            set({
              kind: "failed",
              failure: {
                headline: "The check wasn't queued",
                next: "Nothing about your binding changed. Try again in a moment.",
              },
            });
          }
        },
        (error: unknown) => {
          if (disposed || mine !== generation || state.kind !== "running") return;
          clearTimer();
          baseline = null;
          set({ kind: "failed", failure: describeThrownStorageError(error) });
        },
      );
    },

    observe(binding) {
      if (disposed || state.kind !== "running") return;
      if (!moved(binding)) return;
      settle(binding);
    },

    dismiss() {
      if (disposed) return;
      generation += 1;
      clearTimer();
      baseline = null;
      set({ kind: "idle" });
    },

    dispose() {
      disposed = true;
      generation += 1;
      clearTimer();
      baseline = null;
    },
  };
}
