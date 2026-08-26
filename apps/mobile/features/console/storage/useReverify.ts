import { useEffect, useMemo, useRef, useState } from "react";
import {
  createReverifyController,
  type ObservedBinding,
  type ReverifyState,
} from "./reverify";

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
 */
export function useReverify(
  binding: ObservedBinding | null,
  /** `null` when the viewer is not an owner, or in the demo console. */
  run: (() => Promise<{ queued: boolean; status: string }>) | null,
): {
  state: ReverifyState;
  /** `null` when there is nothing to run — render no button rather than a dead one. */
  start: (() => void) | null;
  dismiss: () => void;
} {
  const [state, setState] = useState<ReverifyState>({ kind: "idle" });

  /**
   * `run` is read through a ref, and the controller is built exactly once.
   *
   * The caller builds `storageActions` as a fresh object literal on every
   * render (see `useLiveConsoleData`), so `run` is a new function every time.
   * Listing it as a dependency rebuilt the controller on every render, which
   * made the effect below re-run on every render, which called `setState` with
   * a **new** `{ kind: "idle" }` object — never `Object.is`-equal to the last
   * one, so React could not bail out — which caused another render. An
   * unbreakable loop, and a blank pane.
   *
   * The lesson is the same one in `../querySpec.ts`: a value that is rebuilt
   * every render must not appear in a dependency array. A ref is how a callback
   * stays current without being a dependency.
   */
  const runRef = useRef(run);
  runRef.current = run;

  const controller = useMemo(
    () =>
      createReverifyController<ReturnType<typeof setTimeout>>({
        queue: async () => {
          const current = runRef.current;
          if (current === null) return { queued: false, status: "unknown" };
          return await current();
        },
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
        onChange: setState,
      }),
    [],
  );

  useEffect(() => () => controller.dispose(), [controller]);

  /**
   * Clear a stale outcome when the controls appear or disappear — which is what
   * changing context, or losing owner access, looks like from here. Keyed on a
   * boolean rather than on `run` itself, for the reason above.
   */
  const canRun = run !== null;
  useEffect(() => {
    setState({ kind: "idle" });
  }, [canRun]);

  const status = binding?.status;
  const updatedAt = binding?.updatedAt;
  const lastVerifiedAt = binding?.lastVerifiedAt;
  const lastError = binding?.lastError;
  const errorCode = binding?.errorCode;

  useEffect(() => {
    if (updatedAt === undefined || status === undefined) return;
    controller.observe({ status, updatedAt, lastVerifiedAt, lastError, errorCode });
  }, [controller, status, updatedAt, lastVerifiedAt, lastError, errorCode]);

  return {
    state,
    start:
      run === null || binding === null
        ? null
        : () => controller.start(binding),
    dismiss: () => controller.dismiss(),
  };
}
