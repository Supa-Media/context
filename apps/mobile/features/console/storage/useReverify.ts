import { useEffect, useMemo, useState } from "react";
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

  const controller = useMemo(
    () =>
      createReverifyController<ReturnType<typeof setTimeout>>({
        queue: async () => {
          if (run === null) return { queued: false, status: "unknown" };
          return await run();
        },
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
        onChange: setState,
      }),
    [run],
  );

  useEffect(() => {
    setState({ kind: "idle" });
    return () => controller.dispose();
  }, [controller]);

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
