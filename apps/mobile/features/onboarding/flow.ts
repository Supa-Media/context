/**
 * The shape of the first run, as the design canvas draws it.
 *
 * **Handle → Fork → the console.** Two screens after sign-in, plus one side
 * track for somebody who already has a bucket: Point at it → the report of
 * what we found → the console. That is the whole wizard.
 *
 * Everything the first run used to carry after the fork — a layout picker, a
 * vault import, pointing AI tools at the endpoint, the bootstrap prompt, a
 * "waiting for your first tool" screen and a closing summary — now lives in
 * the console, in the "Set up @you · n of 4" widget (`console/setup/`), where
 * it can be done in any order, skipped, and come back to. The canvas's
 * reasoning is the reason: a person is in their workspace the moment they have
 * a name and somewhere to keep notes, and every further screen between them and
 * it was a screen standing in the way of the product. Nine steps was the
 * complaint; four rows they can see and ignore is the answer.
 *
 * Kept as a pure module so the transitions are tests rather than something you
 * find out about by clicking.
 *
 * ## There is no way back
 *
 * Deliberately: step 1 claims a name out of a global namespace with no release
 * path (issue #10), so a Back button from the fork would offer to undo
 * something that cannot be undone. Everything after it is reversible in the
 * console.
 */

export type StepKey = "name" | "fork" | "storage" | "dryrun";

/** Where a step hands off to: another step, or out to the console. */
export type Next = StepKey | "console";

/**
 * Which way the fork went: a bucket somebody brought, or one we run.
 *
 * Only a brought bucket gets the dry-run report — it is the one that may
 * already hold something, and the report is what we found in it. A bucket we
 * made has nothing to report.
 */
export type StorageRoute = "byo" | "managed";

/**
 * What happened on the storage step.
 *
 * `unverified` is "Carry on anyway" past a probe that failed or never came
 * back: a binding row, and no idea what is inside the bucket. It is kept apart
 * from `connected` so nothing is ever written into a bucket nobody has looked
 * in — the starting layout included.
 */
export type StorageOutcome = "connected" | "skipped" | "unverified";

export interface FlowShape {
  /** Which way the fork went. See `StorageRoute`. */
  route?: StorageRoute;
}

/** A claimed name always asks where the notes live next. */
export function afterName(): Next {
  return "fork";
}

/**
 * Where the storage step hands off to.
 *
 * A bucket somebody brought is reported on before anything is written to it.
 * Every other outcome — our bucket settled, a skip, a carry-on past a failed
 * probe — goes straight to the console, whose setup widget says what is left.
 */
export function afterStorage(outcome: StorageOutcome, route?: StorageRoute): Next {
  if (outcome === "connected" && route === "byo") return "dryrun";
  return "console";
}

/** "Looks right — continue →". */
export function afterDryRun(): Next {
  return "console";
}

/**
 * The line in the top corner of each screen — the canvas's, board by board.
 *
 * Not "Step n of m" across the run: the handle is the only screen that is a
 * step in anything (A-03 says "Step 1 of 1"), and from the fork on the most
 * useful thing to say is the name that is now yours. The report says what the
 * probe left behind, which is why it does not repeat the canvas's "read-only":
 * the probe writes one temporary object and removes it (`PointAtBucket`).
 */
export function headerLabel(step: StepKey, slug: string | null): string {
  switch (step) {
    case "name":
      return "Step 1 of 1";
    case "fork":
    case "storage":
      return slug === null ? "Name claimed" : `@${slug} · claimed`;
    case "dryrun":
      return "Nothing of yours changed";
  }
}

export function stepTitle(key: StepKey, shape?: FlowShape): string {
  switch (key) {
    case "name":
      return "Pick the name your notes live under";
    case "fork":
      return "Where should we start you?";
    case "storage":
      return shape?.route === "byo" ? "Show us what's already there" : "Setting up your storage";
    case "dryrun":
      return "Here's what's in your bucket";
  }
}
