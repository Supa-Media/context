/**
 * Offering to set a context up, after the flow that would have done it.
 *
 * ## Why this is in the console at all
 *
 * A layout is chosen in one of the two setup flows — `/welcome` for a personal
 * context, `/workspace/new` for a shared one — and `applyStructure` was
 * reachable from nowhere else. That held for exactly as long as those flows ran
 * to the end, and they do not: pressing the managed-storage card leaves the
 * page for Stripe, and Stripe returns to the workspace's Premium settings
 * because the flow is component state with no URL to come back to. Whoever did
 * that arrives in the console owning a verified, empty bucket with no folders,
 * no `privacy.md`, and nothing on screen offering either — the state in issue
 * #647, and the reason the first thing that context says to its owner is that
 * `privacy.md` could not be read.
 *
 * So the prompt belongs where they actually land. It is not a second setup
 * flow: it is the same two answers those flows offer for an empty bucket —
 * **a starting layout**, or **the vault you already have** — drawn where the
 * person is rather than behind a URL they abandoned.
 *
 * ## The listing decides; the binding only ever narrows
 *
 * **`scaffoldReason` is a memory, not a fact.** It is written by exactly one
 * thing — `verifyStorageBinding` — and it records what the verifier saw *when
 * it last looked*. Nothing that writes notes updates it: not the gateway, not
 * `write_note`, not email ingestion, not this console's own editor. So a
 * context created empty, verified, and then filled by a connected AI client
 * carries `empty` on its binding for ever, and the first version of this card
 * believed it: it drew "This context is empty" over a workspace with folders
 * and notes in it, and offered to scaffold one.
 *
 * So the live root listing decides. If it has anything in it, there is nothing
 * to offer, whatever the binding remembers; and until it has been *read*, there
 * is nothing to say either — `undefined` is "not loaded", and a card that
 * flashes up in that gap is the same wrong claim, briefly.
 *
 * The binding is still read, and only ever to say *no*: it is what keeps the
 * card away from a bucket the verifier found a context in, or has already
 * scaffolded, or has never looked inside.
 *
 * ## Reading the binding, not guessing at it
 *
 * `scaffoldReason` is the verifier's own word for what it found
 * (`functions/provisioning.ts`), and only three of its values mean anything
 * here:
 *
 *   `empty`        the bucket answered and holds nothing. Offer.
 *   `partial`      we started writing a layout and did not finish. Offer to
 *   `failed`       finish it — `applyStructure` resumes rather than refusing,
 *                  which is issue #22's fix and the one case a retry is right.
 *
 * Everything else is silence, and deliberately so:
 *
 *   `existing-context`  their vault was here first. The most valuable thing
 *                       this product does for it is nothing.
 *   `created`           already laid out. `applyStructure` would refuse.
 *   `undefined`         we have not looked, or a deployment older than the
 *                       field. **Not** an empty bucket, and offering to write
 *                       folders into a context whose contents we have never
 *                       seen is how a prompt becomes noise on somebody's live
 *                       workspace.
 *
 * Onboarding's `structureStepFor` reads the same field and treats `undefined`
 * as "ask", which is right *there* and wrong here: that screen is standing in
 * front of a bucket it has just watched being connected, and this one is
 * standing in a console that may be showing anything.
 */

/** What, if anything, the console should offer about an unfinished context. */
export type ContextSetup =
  /** Nothing to say. */
  | { kind: "none" }
  /** A verified bucket with nothing in it. */
  | { kind: "empty" }
  /** A layout we began writing and did not finish. */
  | { kind: "unfinished" };

/** The slice of the binding this reads. */
export interface SetupStorage {
  /** `unverified` | `connected` | `error`, straight from the row. */
  status: string;
  /** The verifier's word for what it found in the bucket. */
  scaffoldReason?: string;
}

export function contextSetupFor(options: {
  /** The viewer's role in this context, or `undefined` while it loads. */
  role: string | undefined;
  /** The binding: `undefined` while it loads, `null` when there is none. */
  storage: SetupStorage | null | undefined;
  /**
   * The context's **root listing**, as the file browser has it — the live
   * answer to "is there anything in this bucket".
   *
   * `undefined` means it has not been read yet, which is not emptiness. See
   * the header: this is the field that decides, and the binding below can only
   * narrow what it says.
   */
  root: { entries: readonly unknown[] } | undefined;
  /**
   * The layout a flow last recorded for this context, when one did.
   *
   * Read for exactly one decision — whether a *half-written* layout is this
   * card's to finish — and `"custom"` is the answer that says no. See the
   * `unfinished` branch below.
   */
  structureTemplate?: string;
}): ContextSetup {
  /*
    Owner-only, and this is not merely a UI nicety: `applyStructure` requires
    `owner` and refuses anybody else, so the card would be a button that
    throws. An editor who can write notes still cannot decide the shape of
    somebody else's context.
  */
  if (options.role !== "owner") return { kind: "none" };

  /*
    No binding, or one that has not answered, is somebody else's notice. The
    "connect a bucket" warning already owns the first case, and offering to lay
    out folders in a bucket we cannot reach is an offer that cannot be kept —
    `applyStructure` refuses anything but `connected`.
  */
  const storage = options.storage;
  if (storage === null || storage === undefined) return { kind: "none" };
  if (storage.status !== "connected") return { kind: "none" };

  /*
    The live fact, and the one that outranks everything below.

    Not read yet is not empty, and anything at all at the root means this
    context is somebody's working workspace — which is the whole of what went
    wrong the first time this shipped. An owner sees every entry (no privacy
    rule hides a folder from them), so an empty listing here is emptiness
    rather than a filtered view of it.
  */
  const root = options.root;
  if (root === undefined) return { kind: "none" };
  if (root.entries.length > 0) return { kind: "none" };

  if (storage.scaffoldReason === "empty") return { kind: "empty" };
  if (storage.scaffoldReason === "partial" || storage.scaffoldReason === "failed") {
    /*
      Only a layout this card can actually finish.

      The card offers the standard layout and nothing else, so resuming a
      half-written *custom* one would hand `applyStructure` `para` and finish a
      shape that is neither: the named folders that landed, plus five PARA
      folders nobody asked for. Nothing overwritten, nothing lost, and nobody
      able to tell what happened — which is the worst kind of wrong write. The
      folders somebody typed live in the flow that took them, and that is where
      finishing them belongs.

      An *empty* bucket is unaffected: there is no half-finished shape to
      respect, and `applyStructure` overwrites this column with what it applies.
    */
    return options.structureTemplate === "custom" ? { kind: "none" } : { kind: "unfinished" };
  }
  return { kind: "none" };
}

/** Whether the prompt is drawn at all. */
export function setupPromptVisible(setup: ContextSetup): boolean {
  return setup.kind !== "none";
}

/**
 * What the card says, which is different for the two cases.
 *
 * An empty bucket is a beginning and reads as one. A half-written layout is a
 * thing that went wrong, and saying so plainly — including that finishing it
 * cannot duplicate what is already there — is what stops somebody deleting
 * objects by hand the way issue #22 describes.
 */
export function setupCopy(setup: ContextSetup): { title: string; body: string } | null {
  if (setup.kind === "empty") {
    return {
      title: "This context is empty",
      body:
        "Nothing has been written to your storage yet. Start from the standard layout, " +
        "or bring a vault you already have — Context reads what is there rather than " +
        "imposing a shape on it.",
    };
  }
  if (setup.kind === "unfinished") {
    return {
      title: "Your layout was not finished",
      body:
        "Some of the starting folders were written and some were not. Finishing it only " +
        "writes what is missing — nothing already in your storage is touched, renamed, " +
        "or duplicated.",
    };
  }
  return null;
}
