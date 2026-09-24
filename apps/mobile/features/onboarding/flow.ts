/**
 * The shape of the first run.
 *
 * Six screens at most, and three of them can be one click each. Kept as a pure
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

export type StepKey =
  | "name"
  | "fork"
  | "storage"
  | "dryrun"
  | "vault"
  | "structure"
  | "agents"
  | "bootstrap"
  | "live"
  | "done";

/**
 * Which way the fork went: a bucket somebody brought, or one we run.
 *
 * Only a brought bucket gets the dry-run report — it is the one that may
 * already hold something, and the report is what we found in it. A bucket we
 * made has nothing to report. Absent is "not decided yet", and draws no
 * dry-run step, which is the shorter rail and the one that stays honest.
 */
export type StorageRoute = "byo" | "managed";

export type VaultOutcome = "pending" | "skipped" | "imported" | "existing";

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
  /** Whether an existing Obsidian vault replaced the proposed starting layout. */
  vault?: VaultOutcome;
  /** Which way the fork went. See `StorageRoute`. */
  route?: StorageRoute;
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
 *
 * **The agents step shares that condition, for a related but distinct reason.**
 * Its whole content is a prompt instructing an AI client to go and write notes.
 * Handing that to somebody whose bucket we could not reach is handing them an
 * instruction that will fail on contact, in a client rather than in our own UI
 * where we could explain it — the same dishonesty as the capture address that
 * used to be copyable before anything could receive mail. The endpoint is not
 * lost by skipping the step: it is in the console, and `DoneStep` says where.
 */
export function stepsFor(shape: FlowShape): StepKey[] {
  if (shape.storage !== "connected") return ["name", "fork", "storage", "done"];
  const layout: StepKey[] =
    shape.vault === "imported" || shape.vault === "existing" ? [] : ["structure"];
  return [
    "name",
    "fork",
    "storage",
    ...(shape.route === "byo" ? (["dryrun"] as StepKey[]) : []),
    "vault",
    ...layout,
    "agents",
    "bootstrap",
    "live",
    "done",
  ];
}

/** A claimed name always asks where the notes live next. */
export function afterName(): StepKey {
  return "fork";
}

/**
 * Where the storage step hands off to.
 *
 * A bucket somebody brought is reported on first — what we found, what it
 * supports — before anything offers to write to it. See `StorageRoute`.
 */
export function afterStorage(outcome: StorageOutcome, route?: StorageRoute): StepKey {
  if (outcome !== "connected") return "done";
  return route === "byo" ? "dryrun" : "vault";
}

/** The dry-run report hands off to the vault question, as a connected bucket always does. */
export function afterDryRun(): StepKey {
  return "vault";
}

export function afterVault(outcome: Exclude<VaultOutcome, "pending">): StepKey {
  return outcome === "skipped" ? "structure" : "agents";
}

/**
 * Where the layout step hands off to.
 *
 * Always the agents step, because the layout step only exists on a run whose
 * bucket is connected — which is exactly the condition the agents step needs.
 * Written as a function rather than a literal `setStep("agents")` at the two
 * call sites so that the pairing is stated once and asserted in `stepsFor`'s
 * tests, rather than being a coincidence that holds until somebody changes one
 * of the two branches.
 */
export function afterStructure(): StepKey {
  return "agents";
}

/**
 * Where "point your tools at it" hands off to.
 *
 * The tools step gave the client a URL to call and a prompt to write with; the
 * bootstrap step is where the person, having pasted that prompt into a client
 * that already knows them, watches it seed the empty context out of what it
 * already knew. Two steps because the two moves are different — one is
 * plumbing, the other is content — and the person who wants only the plumbing
 * has a Skip on the second, not a hidden switch on the first.
 *
 * Only runs on the branch the agents step itself runs on: a connected bucket
 * (see `stepsFor`). Written as a function rather than a literal so the pairing
 * is asserted in one place.
 */
export function afterAgents(): StepKey {
  return "bootstrap";
}

/**
 * Where the bootstrap step hands off to.
 *
 * Always the live check. Continuing is skipping; a Skip beside a Continue is
 * courtesy, not another destination.
 */
export function afterBootstrap(): StepKey {
  return "live";
}

/**
 * Where the live check hands off to.
 *
 * Always the last screen. Waiting for a client is never a gate: the person
 * may connect one tomorrow, and the console shows it when they do.
 */
export function afterLive(): StepKey {
  return "done";
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
      return "No bucket is connected yet, so there is nowhere to keep notes. The console shows this at the top of your workspace, with the connect form behind it.";
    case "unverified":
      return "We could not confirm your bucket, so we never looked inside it and nothing has been written to it. Until that check passes there is nowhere to keep notes. The console shows what your provider said, with a way to retry or replace the credential.";
  }
}

export const STEP_LABELS: Record<StepKey, string> = {
  name: "Your name",
  fork: "Where it lives",
  storage: "Your storage",
  dryrun: "What we found",
  vault: "Your vault",
  structure: "Your layout",
  agents: "Your tools",
  bootstrap: "Bootstrap",
  live: "Live",
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
    case "fork":
      return "Where should it live?";
    case "dryrun":
      return "What we found in your bucket";
    case "live":
      return "Waiting for your first tool";
    case "storage":
      /*
        Not "Connect your bucket" any more, which presumed the answer: a bucket
        is one of three, and the person this step gained a third option for
        does not have one and is not going to make one. The step asks the
        question rather than naming one of its answers.
      */
      return "Where your notes live";
    case "vault":
      return "Bring your Obsidian vault";
    case "structure":
      return "Pick a starting layout";
    case "agents":
      return "Point your AI tools at it";
    case "bootstrap":
      /*
        Not "Bootstrap your context" — the noun is inside baseball and the
        verb "bootstrap" alone leaves a first-time reader wondering *what*
        gets bootstrapped. This says it in one line: your context begins with
        the person the client already knows, not with an empty text box.
      */
      return "Let one of your AIs seed it";
    case "done":
      return "You're set";
  }
}
