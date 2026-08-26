/**
 * The shape of the first run.
 *
 * Four screens at most, and two of them can be one click each. Kept as a pure
 * module so the awkward transitions — the one where somebody skips connecting a
 * bucket, and the one where their bucket turns out to already hold a context —
 * are tests rather than something you find out about by clicking.
 *
 * ## There is no way back
 *
 * Deliberately, and not from laziness: step 1 claims a name out of a global
 * namespace with no release path (issue #10), so a Back button from step 2
 * would offer to undo something that cannot be undone. Every later step is
 * either skippable or reversible in the console, so there is nothing behind you
 * worth returning to.
 */

export type StepKey = "name" | "storage" | "structure" | "done";

/** What happened on the storage step. Skipping is a first-class outcome. */
export type StorageOutcome = "connected" | "skipped";

export interface FlowShape {
  /** True once somebody chose "I'll do this later". */
  storageSkipped: boolean;
}

/**
 * Which steps this run has.
 *
 * Skipping storage removes the layout step, because there is no bucket to lay
 * anything down in. That is not a degraded flow — a context with no binding is
 * a state the schema supports (`status: "unverified"`), and the console says so
 * with a way back.
 */
export function stepsFor(shape: FlowShape): StepKey[] {
  if (shape.storageSkipped) return ["name", "storage", "done"];
  return ["name", "storage", "structure", "done"];
}

/** Where the storage step hands off to. */
export function afterStorage(outcome: StorageOutcome): StepKey {
  return outcome === "connected" ? "structure" : "done";
}

export const STEP_LABELS: Record<StepKey, string> = {
  name: "Your name",
  storage: "Your bucket",
  structure: "Your layout",
  done: "You're set",
};

/**
 * "Step 2 of 4", or `null` for a step this run does not contain.
 *
 * The total moves when somebody skips storage. That is honest rather than
 * sloppy: the indicator describes the run they are actually in, and a
 * "Step 3 of 4" that never reaches 4 is worse than a total that shrank.
 */
export function stepProgress(
  key: StepKey,
  shape: FlowShape,
): { index: number; total: number } | null {
  const steps = stepsFor(shape);
  const index = steps.indexOf(key);
  if (index === -1) return null;
  return { index: index + 1, total: steps.length };
}

/** The one-line title over each step. */
export function stepTitle(key: StepKey): string {
  switch (key) {
    case "name":
      return "Claim your name";
    case "storage":
      return "Connect your bucket";
    case "structure":
      return "Pick a starting layout";
    case "done":
      return "You're set";
  }
}
