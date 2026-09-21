import { ERRORS } from "./protocol";
import type { MeetingRecord } from "./record";

/**
 * A meeting that is not in the customer's bucket: what is true about it, and
 * what a person can do about it.
 *
 * ## Why this is a module and not two screens' worth of JSX
 *
 * `MeetingNoteScreen`'s `Landing` has known all of this since it was written —
 * that an `empty` session will never be sent however long anybody waits, that
 * a `failed` one is retried by a person pressing something, that a refusal is
 * said in words rather than as a status code. It knew it inside a `.tsx` that
 * imports `expo-router`, so the console's Meetings panel could not reach a line
 * of it. This is the trap `noteLink.ts` was carved out of and the rule
 * `route.ts` states: **a fact a caller needs about meetings lives where it can
 * be imported without the screens around it.**
 *
 * What the panel had instead was one flat sentence for every one of these
 * states — *"This meeting has not been written to your context yet"* — with no
 * reason beside it and nothing to press. A recording that ended, sat in the
 * panel, and offered its owner nothing but that sentence is what this file
 * exists to stop: two vocabularies for one state, and the worse one drawn on
 * the surface the owner asked for meetings to open in.
 *
 * ## The order of the branches is the rule, not an implementation
 *
 * **A refusal never un-says the path.** A meeting whose note reached the bucket
 * and whose *later* write was refused is saved and incomplete, not unsent —
 * that was a shipped defect, and `notePath` deciding first is the fix. So this
 * answers `null` for anything with a path, and the caller draws the note.
 *
 * **Nothing captured is not "on its way".** `empty` — and a `NOTHING_CAPTURED`
 * refusal, which is the same fact arriving by a different road — gets the
 * sentence that says so, and no Retry. "Sent as soon as your context answers"
 * about a session with no transcript and no typed notes is a promise nothing
 * can keep.
 */
export interface MeetingLanding {
  /**
   * Fine-grained on purpose. `empty` and `nothing-captured` are the same fact
   * and are drawn the same way — no Retry, no promise of sending — but they
   * arrive by different roads and only one of them has a recording worth
   * offering to start again, so a surface that wants to tell them apart can.
   * A surface that does not, and the console panel does not, reads `retry`.
   */
  kind: "empty" | "nothing-captured" | "refused" | "failed" | "pending";
  /** The one line that says what is true. Never a status code. */
  title: string;
  /** The sentence under it, or `null` when the title is the whole of it. */
  detail: string | null;
  /**
   * What pressing Retry should call, or `null` when retrying cannot help.
   *
   * A fact about the record rather than a per-screen judgement — deciding it
   * per surface is exactly how the console came to offer nothing for states the
   * note screen has always offered a Retry for.
   *
   * - `"finalize"` — `meetings.retryFinalize`, the `failed -> finalizing` the
   *   contract allows, for a finalize that did not complete.
   * - `"sync"` — `meetings.retry`, which clears `rejection` on the way through
   *   so the attempt actually reaches the gateway. This is the press that
   *   matters after somebody has fixed the cause of a refusal — reconnected the
   *   machine, answered the conflict — and before this it was reachable from
   *   one screen, under a label about re-running the enhancement.
   */
  retry: "finalize" | "sync" | null;
}

/**
 * What to tell somebody about this meeting, or `null` when its note is in the
 * bucket and there is nothing to explain.
 */
export function meetingLanding(record: MeetingRecord): MeetingLanding | null {
  const { session } = record;
  if (session.notePath !== null) return null;

  if (session.state === "empty") {
    return {
      kind: "empty",
      title: `Nothing was captured: ${session.emptyReason ?? "no transcript and no typed notes."}`,
      detail: null,
      retry: null,
    };
  }

  /*
    The backstop for a session with nothing in it that reached the sync queue
    instead of being folded to `empty` first (`markSyncFailed`, `record.ts`).
    Same fact, same drawing, same absence of a Retry — "has not left the
    device" would be true in the narrow sense that nothing was sent, and would
    read as a meeting waiting to depart.
  */
  if (record.rejection?.code === NOTHING_CAPTURED) {
    return { kind: "nothing-captured", title: record.rejection.message, detail: null, retry: null };
  }

  if (record.rejection !== undefined) {
    return {
      kind: "refused",
      title: "This meeting has not left the device",
      detail: rejectionNotice(record.rejection),
      retry: "sync",
    };
  }

  /*
    `failed` is not "not in your bucket *yet*" either, and for a sharper reason
    than `empty`: recovery's own `fail` is what puts a meeting here and
    `pendingSteps` offers a finalize only for a session in `finalizing`, so
    nothing sends this meeting again on its own. A person has to.
  */
  if (session.state === "failed") {
    return {
      kind: "failed",
      title: `Not filed: ${session.failureReason ?? "the finalize did not complete."}`,
      detail: null,
      retry: "finalize",
    };
  }

  return {
    kind: "pending",
    title: "Not in your bucket yet",
    detail: "It is kept on this device and sent as soon as your context answers.",
    retry: null,
  };
}

/**
 * The refusal code for a session with nothing in it, as `markSyncFailed` sets
 * it. A string rather than an `ERRORS` member because it is this client's own
 * verdict about a recording, not something the gateway ever sends.
 */
const NOTHING_CAPTURED = "NOTHING_CAPTURED";

/**
 * A REFUSAL, IN WORDS SOMEBODY CAN DO SOMETHING WITH.
 *
 * What the note screen showed instead was `record.rejection.message`, and for
 * the whole life of the desktop app that string was **"gateway answered 400"**
 * — `postEntry` read a `message` field this gateway does not send, so the
 * sentence explaining the refusal was parsed off the wire and dropped. A person
 * was shown a status code and no action, about their own meeting.
 *
 * The client reads `error_description` now, so the gateway's sentence does
 * arrive; this maps the codes whose recovery is a thing a *person* does, and
 * falls through to the gateway's own words for everything else. The fallback is
 * deliberately the gateway's sentence rather than a generic one: a refusal this
 * app has never seen before is exactly the one worth quoting.
 *
 * Moved here from `MeetingNoteScreen` unchanged, for the reason at the top of
 * this file — it is a sentence about a record, and the panel needs it too.
 */
export function rejectionNotice(rejection: { code: string; message: string }): string {
  if (rejection.code === ERRORS.forbidden) {
    return "This machine's access to your context was refused. Connect it again from Settings.";
  }
  if (rejection.code === ERRORS.conflict) {
    return "Something else changed this meeting while it was being written. Try again.";
  }
  if (rejection.code === ERRORS.invalid) {
    return `Your context would not accept it: ${rejection.message}`;
  }
  return rejection.message;
}

/**
 * What a meeting filed somewhere other than the folder it named is told.
 *
 * `folderRejected` covers two things. The gateway sets it for a folder it will
 * not file into, and it also sets it when the folder was perfectly legal and *a
 * different one had already been claimed* — a second finalize naming somewhere
 * else, or a retry after a failed write. In that case the note is in the folder
 * the first finalize claimed, which is neither the default nor the one on
 * screen.
 *
 * So the sentence says what is true in both: not where you chose, here instead,
 * move it if you want it elsewhere. It names no folder, because the ack carries
 * no copy of what was sent — the note's own path is what answers "where".
 *
 * Moved here from `MeetingNoteScreen`, which re-exports it; it is a sentence
 * about a record and both surfaces say it.
 */
export const FOLDER_REJECTED_NOTICE =
  "Your context did not file this meeting in the folder you chose, so this is where the note is. Move it if you want it elsewhere.";
