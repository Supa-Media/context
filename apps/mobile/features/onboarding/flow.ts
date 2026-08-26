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

/**
 * What happened on the storage step. Three outcomes, not two.
 *
 * `unverified` is the one that is easy to leave out and wrong to leave out.
 * It is what "Carry on anyway" produces: the probe failed or never came back,
 * so we have a binding row and **no idea what is inside the bucket**. Folding
 * it into `connected` — which is what this used to do — hands somebody the
 * layout step, whose opening line is "Your bucket is empty, so here is a
 * starting shape", about a bucket nobody has ever looked into. It might be
 * their live Obsidian vault. Folding it into `skipped` would be a different
 * lie: they did give us a bucket, and the console will keep checking it.
 */
export type StorageOutcome = "connected" | "skipped" | "unverified";

export interface FlowShape {
  /** What the storage step ended in. Drives both the rail and the last screen. */
  storage: StorageOutcome;
}

/**
 * Which steps this run has.
 *
 * Only a **verified** bucket gets the layout step. Skipping leaves nowhere to
 * write; carrying on past a failed probe leaves us unable to say whether it is
 * safe to write, and `applyStructure` refuses a binding that is not `connected`
 * anyway (`STORAGE_NOT_VERIFIED`), so offering the step would be offering a
 * button that cannot work. Neither is a degraded flow — a context whose binding
 * is unverified is a state the schema supports, and the console says so with a
 * way back.
 */
export function stepsFor(shape: FlowShape): StepKey[] {
  if (shape.storage === "connected") return ["name", "storage", "structure", "done"];
  return ["name", "storage", "done"];
}

/** Where the storage step hands off to. */
export function afterStorage(outcome: StorageOutcome): StepKey {
  return outcome === "connected" ? "structure" : "done";
}

/**
 * What the last screen has to say about the bucket, if anything.
 *
 * A run that ends without a working bucket must say so on the way out — this
 * is the one screen the person definitely reads, and "there is nowhere to keep
 * notes" is not something to leave them to discover. The two failure sentences
 * are deliberately different, because the next move is different: one person
 * has to go and connect something, the other has to find out why their
 * provider said no.
 *
 * Kept here rather than inline in `DoneStep` so that "carrying on past a probe
 * that failed does not get the all-clear" is a test rather than a paragraph
 * somebody has to notice in a diff.
 */
export function storageWarning(shape: FlowShape): string | null {
  switch (shape.storage) {
    case "connected":
      return null;
    case "skipped":
      return "No bucket is connected yet, so there is nowhere to keep notes. The console shows this at the top of your context, with the connect form behind it.";
    case "unverified":
      return "We could not confirm your bucket, so we never looked inside it and nothing has been written to it. Until that check passes there is nowhere to keep notes. The console shows what your provider said, with a way to retry or replace the credential.";
  }
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
