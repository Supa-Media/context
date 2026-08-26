import { useEffect, useRef, useState } from "react";
import {
  createReverifyController,
  type ObservedBinding,
  type ReverifyState,
} from "./reverify";

type Controller = ReturnType<typeof createReverifyController<ReturnType<typeof setTimeout>>>;

/**
 * React binding for `createReverifyController` — the state machine holds the
 * logic, this holds the timer handles, the subscription, and the re-render.
 *
 * The `observe` effect is the interesting half. `reverifyStorage` queues a
 * probe and returns immediately, so there is nothing to await: the outcome
 * arrives when Convex pushes a new `getStorageBinding` down the same reactive
 * subscription the pane is already reading. This feeds every new value of that
 * row into the controller, which decides whether it is the answer it was
 * waiting for.
 *
 * The effect depends on the row's *fields*, not on the object, because the
 * binding is rebuilt on every render of `useLiveConsoleData` and an identity
 * dependency would re-run on every keystroke elsewhere in the console.
 *
 * ## One probe belongs to one context
 *
 * `subject` is the workspace being verified, and it is not decoration. The
 * controller settles by watching `updatedAt` move past a baseline it captured
 * when the probe started — and two workspaces have completely unrelated
 * `updatedAt` values. A controller that outlives a context switch will happily
 * read the *next* context's row as the answer to the *previous* context's
 * probe and report "your bucket is reachable and writable" about a bucket
 * nothing ever checked. On a product whose entire promise is that the customer
 * owns the storage, a fabricated green is the worst thing this pane could say.
 *
 * So the controller is rebuilt, and the outcome cleared, whenever the subject
 * changes. Neither is keyed on `run`, which the caller rebuilds as a fresh
 * closure every render (`storageActions` is an object literal in
 * `useLiveConsoleData`) — that is what caused the render loop this file was
 * rewritten to fix. See `../querySpec.ts` for the general rule.
 */
export function useReverify(
  binding: ObservedBinding | null,
  /** `null` when the viewer is not an owner, or in the demo console. */
  run: (() => Promise<{ queued: boolean; status: string }>) | null,
  /**
   * The workspace this pane is verifying — `null` when there is none. A probe
   * is about one context, and its result must never be shown for another.
   */
  subject: string | null,
): {
  state: ReverifyState;
  /** `null` when there is nothing to run — render no button rather than a dead one. */
  start: (() => void) | null;
  dismiss: () => void;
} {
  const [state, setState] = useState<ReverifyState>({ kind: "idle" });

  /** Read through a ref so a per-render closure never becomes a dependency. */
  const runRef = useRef(run);
  runRef.current = run;

  /**
   * The controller, rebuilt when the subject changes and **fetched through this
   * function everywhere** — never captured in a variable at render time.
   *
   * `dispose()` is a one-way latch: a disposed controller silently queues
   * nothing. Cleanup-then-setup happens on a living tree — `<StrictMode>` in
   * development, Fast Refresh, React 19's `<Activity>` prerendering — and it
   * runs the unmount cleanup without producing another render. A controller
   * held in a `useMemo`, or read into a `const` and closed over by `start`,
   * would therefore be dead with nothing to notice: the Re-verify button
   * renders and does nothing, which is the exact failure `reverify.ts` exists
   * to prevent. Resolving it at call time is what makes the rebuild reachable.
   */
  const held = useRef<{ subject: string | null; controller: Controller } | null>(null);

  const controllerFor = (which: string | null): Controller => {
    if (held.current === null || held.current.subject !== which) {
      // Abandoning a controller mid-probe: cancel its timers so a late callback
      // cannot report on a context the user has already left.
      held.current?.controller.dispose();
      held.current = {
        subject: which,
        controller: createReverifyController<ReturnType<typeof setTimeout>>({
          queue: async () => {
            const current = runRef.current;
            if (current === null) return { queued: false, status: "unknown" };
            return await current();
          },
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (handle) => clearTimeout(handle),
          onChange: setState,
        }),
      };
    }
    return held.current.controller;
  };

  useEffect(
    () => () => {
      held.current?.controller.dispose();
      held.current = null;
    },
    [],
  );

  /**
   * Clear a stale outcome when the subject changes, or when the controls appear
   * or disappear — a different context, or owner access gained or lost.
   *
   * Written as a render-phase reset rather than an effect on purpose: an effect
   * would paint the previous context's "your bucket is reachable and writable"
   * for one frame before clearing it. Guarded by a value that actually changed,
   * so it converges immediately instead of looping, and it costs nothing on
   * mount because the key starts out already seen.
   */
  const resetKey = `${subject ?? ""} ${run !== null}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setState({ kind: "idle" });
  }

  const status = binding?.status;
  const updatedAt = binding?.updatedAt;
  const lastVerifiedAt = binding?.lastVerifiedAt;
  const lastError = binding?.lastError;
  const errorCode = binding?.errorCode;

  useEffect(() => {
    if (updatedAt === undefined || status === undefined) return;
    controllerFor(subject).observe({ status, updatedAt, lastVerifiedAt, lastError, errorCode });
    // `controllerFor` is deliberately absent: it is redefined every render and
    // listing it would re-run this on every render — the defect this whole file
    // was rewritten to remove. `subject` is what actually selects a controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, status, updatedAt, lastVerifiedAt, lastError, errorCode]);

  return {
    state,
    start: run === null || binding === null ? null : () => controllerFor(subject).start(binding),
    dismiss: () => controllerFor(subject).dismiss(),
  };
}
