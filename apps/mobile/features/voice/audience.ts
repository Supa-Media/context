import type { DestinationContext } from "../meetings/destination";
import type { Visibility } from "../console/files/types";
import { isGroupVisibility } from "../console/files/types";
import type { DictationFailure } from "./dictation";

/**
 * What the sheet has to say before the microphone opens, and what it may
 * refuse.
 *
 * ## Why dictation needs its own audience rule at all
 *
 * A meeting asks *where should this go*, and `destination.ts` answers it with a
 * list whose first offer is always the person's own workspace — because
 * "somebody reading a note in a shared workspace who presses record is, on any
 * current-context default, dropping a transcript of a conversation they have
 * not read yet into a folder their colleagues are watching".
 *
 * Dictation cannot be answered that way. It has no destination to choose: the
 * destination is the note under the caret, and moving it somewhere else would
 * not be dictation. So the protection `destination.ts` gets from *offering a
 * safer default* has to come from somewhere else here, and the only thing left
 * is **saying who is listening, in the sheet, before the microphone opens.**
 *
 * That is the same disclosure argument `docs/decisions/meetings.md` makes for
 * the record control — the control belongs beside the sentence — applied to the
 * one fact a person cannot recover by looking at the screen. A note in a shared
 * workspace looks exactly like a note in your own.
 *
 * Pure, and tested as a table, because "did the sheet say `@supa` out loud"
 * is a claim about a string and should not need a renderer to check.
 */

export type AudienceTone =
  /** Nobody but the person speaking. Wears no hue: private is the default. */
  | "private"
  /** A named group of people who can read this note. Wears the shared hue. */
  | "shared";

export interface Audience {
  tone: AudienceTone;
  /** One sentence, shown under the dictate row. Never empty. */
  line: string;
}

export interface DictationOffer {
  /** Absent when dictation cannot be offered at all; then `refusal` says why. */
  audience: Audience | null;
  /**
   * Why the row is inert, in a sentence somebody can act on — or `null` when it
   * is not.
   */
  refusal: string | null;
}

/** Roles that may write to a context. Anything else is a reader. */
const WRITERS = new Set(["owner", "editor"]);

/** What a context's `kind` has to be for "only you" to be true. */
const PERSONAL = "personal";

export const NO_NOTE = "Open a note first — dictation types into the one you are looking at.";
export const READ_ONLY = "You can read this note but not write to it.";

/** The reason a failed engine gives, as the sentence the row shows. */
export function reasonFor(failure: DictationFailure, unavailable: string): string {
  switch (failure) {
    case "denied":
      return "Your browser is blocking the microphone. Nothing was heard and the note is as you left it.";
    case "no-microphone":
      return "No microphone is attached, so there is nothing to listen with.";
    case "unreachable":
      return "The words cannot be made right now. Dictation stops rather than look live while producing nothing.";
    case "unsupported":
      return unavailable;
  }
}

/**
 * Whether dictation may be offered here, and who would hear it.
 *
 * `noteOpen` is separate from `path` because a folder is on screen often enough
 * to be worth its own sentence: a person looking at `1-projects/` and pressing
 * the microphone has nowhere for words to land, and "open a note first" is a
 * better answer than a row that is merely grey.
 */
export function offerDictation(input: {
  /** The context the open note lives in, or `null` when none is open. */
  context: DestinationContext | null;
  /** The note's bucket path, for naming it in the audience sentence. */
  path: string;
  /** False when what is on screen is a folder, or nothing. */
  noteOpen: boolean;
  /** False for `privacy.md`, an encrypted envelope, or a reader's membership. */
  writable: boolean;
  /**
   * The open note's own visibility, as the access map answers it.
   *
   * **The question this sheet asks is about the note, and `kind` cannot answer
   * it.** A personal workspace takes members — `inviteMember` has no `kind`
   * check, and `invitations.ts` opens by saying a shared context is the same
   * row as a personal one with more membership — so a `team` note in a
   * personal context is readable by every one of them. Answering from the
   * workspace alone wrote "Only you." over exactly that note, in the one
   * sentence somebody reads before speaking into it.
   *
   * Optional, because the entry beside the editor is what knows, and
   * `NoteEditor` states the rule for its own copy of this field: a component
   * that was not told has no honest answer, and "inventing `private` would be
   * a claim about access made by a component that was not told". Absent is
   * therefore **not** private here, the same way an unrecognised `kind` is not
   * personal.
   */
  noteVisibility?: Visibility | undefined;
  /** From the engine. False on a phone, and in a browser with none. */
  engineAvailable: boolean;
  /** The engine's own sentence, shown when it is not available. */
  unavailable: string;
}): DictationOffer {
  if (!input.engineAvailable) return { audience: null, refusal: input.unavailable };
  if (!input.noteOpen || input.context === null) return { audience: null, refusal: NO_NOTE };
  if (!input.writable || !WRITERS.has(input.context.role)) {
    return { audience: null, refusal: READ_ONLY };
  }

  /*
    A `kind` this build does not recognise is **not** treated as personal, which
    is the same rule `destination.ts` states for the same field and for the same
    reason: an unknown value arriving from a newer control plane must fail
    towards saying more about who can read a note, never less. Getting this
    backwards writes "Only you" over a workspace several people are watching.
  */
  if (input.context.kind === PERSONAL) {
    /*
      "Only you." is a claim about the NOTE, so the note has to have said so.
      A folder set to `team`, an exception pointed at a group, or a field this
      build was not given are each a reason not to say it — and the last one is
      the same fail-towards-more rule the `kind` check above states, applied to
      the field that actually answers the question.
    */
    if (input.noteVisibility === "private") {
      return { audience: { tone: "private", line: "Only you." }, refusal: null };
    }
    if (input.noteVisibility !== undefined && isGroupVisibility(input.noteVisibility)) {
      return {
        audience: {
          tone: "shared",
          line: `Everyone in ${atName(input.noteVisibility)} can read ${input.path}.`,
        },
        refusal: null,
      };
    }
    /*
      True whatever the answer turns out to be, which is the point: it names
      nobody the sheet has not been told about, and it does not claim the note
      is unshared. A sentence that is never false is the right shape for the
      case where the honest answer has not arrived.
    */
    return {
      audience: {
        tone: "shared",
        line: `Anyone you have shared ${input.path} with can read it.`,
      },
      refusal: null,
    };
  }
  if (input.noteVisibility !== undefined && isGroupVisibility(input.noteVisibility)) {
    return {
      audience: {
        tone: "shared",
        line: `Everyone in ${atName(input.noteVisibility)} can read ${input.path}.`,
      },
      refusal: null,
    };
  }
  return {
    audience: {
      tone: "shared",
      line: `Everyone in ${atName(input.context.slug)} can read ${input.path}.`,
    },
    refusal: null,
  };
}

/** `@slug`, however the slug arrived. Shared with the meetings sheet's rule. */
export function atName(slug: string): string {
  return slug.startsWith("@") ? slug : `@${slug}`;
}
