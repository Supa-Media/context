import { merge3, type Merge3Result } from "./merge";

/**
 * What a person is offered when two edits meet, and what they are told.
 *
 * Pure, and separate from the component that draws it, for the reason
 * `copy.ts` and `files/status.ts` both give: the rules here are about *what is
 * offered and what is claimed*, not about how it is painted, and the console's
 * Jest suite runs in plain node with no renderer.
 *
 * ## Three choices, and none of them writes anything on its own
 *
 * A conflict is not an error. The bucket is open in Obsidian and written by
 * connected AI clients, so "somebody else saved while you were typing" is the
 * ordinary case. What it needs is a decision, and there are exactly three
 * honest ones: take theirs, take mine, or take a merge of the two — reviewed
 * first, because the person is approving *text*, not a strategy.
 *
 * **Nothing reaches the customer's bucket until one of them is chosen.** No
 * conflict copy written beside the note, no speculative write, no automatic
 * retry — an automatic retry of a conflict is last-write-wins on a timer. This
 * is the rule the rest of the module exists to keep.
 *
 * ## Why the third choice is sometimes absent
 *
 * A three-way merge needs a common ancestor. This feature has one — the read
 * cache holds the note's body at the etag the draft was typed against — but not
 * always: the cache is bounded, and a draft can outlive its own base. When the
 * ancestor is gone there is no honest merge to offer, so **the Merge button is
 * not drawn at all** and the reason is said out loud. A two-way diff presented
 * as an informed proposal would be a guess wearing a merge's clothes, which is
 * the kind of quiet dishonesty this repo's copy rules exist to forbid.
 */

/** Why no merge is on offer. Each one is said to the person, not swallowed. */
export type MergeRefusal =
  /** The note did not exist when this was typed: there is no ancestor at all. */
  | "no-ancestor"
  /** Nothing on this device holds the version this draft was typed against. */
  | "ancestor-evicted"
  /** The copy on this device has moved past the version this was typed against. */
  | "ancestor-moved"
  /** The version in the bucket has not been read yet, because there is no signal. */
  | "offline"
  /** The three versions are too far apart to align. */
  | "too-far-apart";

export interface MergeOffer {
  /** The proposal, or `null` when there is none to make. */
  merge: Merge3Result | null;
  /** Why not. `null` exactly when `merge` is present. */
  refusal: { reason: MergeRefusal; sentence: string } | null;
}

const REFUSALS: Record<MergeRefusal, string> = {
  "no-ancestor":
    "There is nothing to merge against: this note did not exist on this device when you started typing, so both versions are whole notes rather than two edits of one.",
  "ancestor-evicted":
    "Merging needs the version you started from, and this device no longer has it — the copy it kept has been cleared. You can still keep one side or the other.",
  "ancestor-moved":
    "Merging needs the version you started from, and the copy on this device has already moved past it. You can still keep one side or the other.",
  offline:
    "The version in your bucket has not been read yet, so there is nothing to merge with. Reconnect and this note will offer it.",
  "too-far-apart":
    "These two versions are too far apart to line up, so a merge would be a guess rather than a proposal. You can still keep one side or the other.",
};

/**
 * Decide whether a merge can honestly be proposed, and build it if it can.
 *
 * `cached` is the read cache's copy and the etag it holds it at; `draftBase` is
 * the etag the draft was typed against. **Both are checked, and the etag
 * comparison is the whole point of passing them separately.** A cached body at
 * some *other* etag is not an ancestor — merging against it would silently
 * three-way somebody's edit against a version they never saw, and the result
 * would look exactly as confident as a real merge.
 */
export function offerMerge(input: {
  cached: { text: string; etag: string } | null;
  draftBase: string | null;
  mine: string;
  /** The body in the bucket now, or `null` while it has not been read. */
  theirs: string | null;
}): MergeOffer {
  const refuse = (reason: MergeRefusal): MergeOffer => ({
    merge: null,
    refusal: { reason, sentence: REFUSALS[reason] },
  });

  if (input.theirs === null) return refuse("offline");
  if (input.draftBase === null) return refuse("no-ancestor");
  if (input.cached === null) return refuse("ancestor-evicted");
  if (input.cached.etag !== input.draftBase) return refuse("ancestor-moved");

  const merged = merge3(input.cached.text, input.mine, input.theirs);
  if (merged === null) return refuse("too-far-apart");
  return { merge: merged, refusal: null };
}

/**
 * The headline, and why it is not phrased as a failure.
 *
 * Nothing went wrong. Two people — or a person and an AI client — edited the
 * same note, which is what this product is for. The sentence says what
 * happened; the buttons say what each answer will do.
 */
export const CONFLICT_HEADLINE = "This note also changed in your bucket while you were editing it.";

export const CONFLICT_REASSURANCE =
  "Nothing has been written and nothing has been lost. Both versions are here — choose which one this note should be.";

/** What each button says, and the sentence under it. */
export const CHOICES = {
  theirs: {
    label: "Keep theirs",
    detail: "Load the version in your bucket. What you typed here is discarded.",
  },
  mine: {
    label: "Keep mine",
    detail:
      "Write what you typed over the version in your bucket. Unless you turned on versioning at your storage provider, the version it replaces is gone.",
  },
  merge: {
    label: "Merge them",
    detail: "Combine both, and show me the result to check before anything is saved.",
  },
} as const;

/** The review surface's own two controls. */
export const REVIEW = {
  save: { label: "Save this version" },
  back: { label: "Back to the choices" },
} as const;

/**
 * What the review surface says about the proposal in front of it.
 *
 * The count is read off the *text*, not remembered from the merge, because the
 * text is editable — the whole point of a review is that somebody resolves the
 * marked spots by hand, and a remembered count would still claim two conflicts
 * over a body they have already cleaned up.
 */
export function proposalLine(marked: number): string {
  if (marked === 0) {
    return "Both sets of edits are in here and nothing clashed. Read it over, change anything you like, then save it.";
  }
  if (marked === 1) {
    return "Both sets of edits are in here. One spot has both versions marked, because you each wrote something different there — pick what you want and delete the markers.";
  }
  return `Both sets of edits are in here. ${marked} spots have both versions marked, because you each wrote something different there — pick what you want and delete the markers.`;
}

/**
 * What a chosen save is checked against, said plainly.
 *
 * Whichever answer is chosen, the write that follows is still conditional on
 * the version the person was shown. If somebody else has moved it again in the
 * meantime it comes back as a conflict and this whole surface reappears with
 * fresh content — it is never forced through. On a bucket that cannot do
 * conditional writes that promise is weaker, and it is stated rather than
 * quietly assumed: driven by the binding's real `capabilities.conditionalWrite`
 * from the connect-time probe, not by what the provider declares.
 */
export function checkedAgainst(conditionalWrite: boolean | undefined): string {
  if (conditionalWrite === false) {
    return "Whichever you choose is written only if your bucket still holds the version above. This bucket cannot do conditional writes, so that check is a re-read just before the write — an edit that lands in that gap can still be missed.";
  }
  return "Whichever you choose is written only if your bucket still holds the version above. If it has changed again, you will be asked again rather than overwriting it.";
}

/** What "Keep mine" means when there is no connection to write it over. */
export const KEEP_MINE_OFFLINE =
  "No connection, so this goes back in the queue and is sent when you are back — still checked against the version you were shown.";
