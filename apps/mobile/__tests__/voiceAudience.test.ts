import { describe, expect, test } from "@jest/globals";
import type { DestinationContext } from "../features/meetings/destination";
import {
  NO_NOTE,
  READ_ONLY,
  offerDictation,
  reasonFor,
} from "../features/voice/audience";

/**
 * Who is told that they are about to be overheard.
 *
 * Dictation has no destination picker — the destination is the note under the
 * caret — so the whole of what stands between somebody and speaking a private
 * thought into a file six colleagues read is **the sentence in the sheet**.
 * `destination.ts` gets to protect a meeting by *offering* the person's own
 * workspace first; there is no equivalent move here, which makes this string
 * load-bearing rather than decorative.
 *
 * ## Sabotage record
 *
 * Applied to `features/voice/audience.ts`, suite run, named test observed
 * failing, reverted.
 *
 *  1. `kind !== "shared"` used in place of `kind === PERSONAL`, so an unknown
 *     kind reads as private.
 *     → `a kind this build does not recognise is never called private` fails.
 *     This is the one that matters: it is the shape of bug where a newer
 *     control plane ships a third kind and every note in it is labelled
 *     "Only you".
 *  2. The shared line drops the context name.
 *     → `a shared context is named, not merely called shared` fails.
 *  3. The `writable` check dropped, leaving only the role check.
 *     → `a note that is read-only for its own sake refuses dictation` fails —
 *     `privacy.md` and an encrypted envelope are read-only inside a context
 *     you own, so the role says nothing about them.
 *  4. The role check dropped, leaving only `writable`.
 *     → `a member who may read but not write is refused` fails.
 *  5. `engineAvailable` checked after the note checks.
 *     → `a browser with no engine says so, even with no note open` fails: the
 *     person is told to open a note, does, and is then told the browser cannot
 *     dictate anyway.
 */

function context(over: Partial<DestinationContext> = {}): DestinationContext {
  return { slug: "seyi", kind: "personal", role: "owner", ...over };
}

const ENGINE = { engineAvailable: true, unavailable: "no engine here" };
const OPEN = {
  noteOpen: true,
  writable: true,
  path: "1-projects/weekly-sync.md",
  // A note whose own visibility is `private`. Every case below that does not
  // say otherwise is about one, which is what "only you" was always meant to
  // describe — the workspace being personal never established it.
  noteVisibility: "private" as const,
};

describe("who can hear this", () => {
  test("a note in your own workspace is only yours", () => {
    const offer = offerDictation({ ...ENGINE, ...OPEN, context: context() });
    expect(offer.refusal).toBeNull();
    expect(offer.audience).toEqual({ tone: "private", line: "Only you." });
  });

  test("a note shared out of your own workspace is never called only yours", () => {
    /*
      A personal workspace takes members — `inviteMember` has no `kind` check,
      and `invitations.ts` opens by saying a shared context is the same row as
      a personal one with more membership. So `team` on a note in a personal
      context means real people, and "Only you." over it is the sentence this
      module exists to prevent, said about the note instead of the workspace.
    */
    const offer = offerDictation({
      ...ENGINE,
      ...OPEN,
      noteVisibility: "team",
      context: context(),
    });
    expect(offer.refusal).toBeNull();
    expect(offer.audience?.tone).toBe("shared");
    expect(offer.audience?.line).not.toContain("Only you");
    expect(offer.audience?.line).toContain("1-projects/weekly-sync.md");
  });

  test("a note pointed at a group names the group", () => {
    const offer = offerDictation({
      ...ENGINE,
      ...OPEN,
      noteVisibility: "@writers",
      context: context(),
    });
    expect(offer.audience?.tone).toBe("shared");
    expect(offer.audience?.line).toContain("@writers");
  });

  test("a note whose visibility this build was not told is never called only yours", () => {
    /*
      The same rule the `kind` field already has, applied to the field that
      actually answers the question. `NoteEditor`'s own `visibility` prop says
      it in as many words: a component that was not told has no honest answer,
      and "inventing `private` would be a claim about access made by a
      component that was not told".
    */
    const offer = offerDictation({ ...ENGINE, ...OPEN, noteVisibility: undefined, context: context() });
    expect(offer.refusal).toBeNull();
    expect(offer.audience?.line).not.toContain("Only you");
  });

  test("a shared context is named, not merely called shared", () => {
    const offer = offerDictation({
      ...ENGINE,
      ...OPEN,
      path: "2-areas/apps/context/runbook.md",
      context: context({ slug: "supa", kind: "shared", role: "editor" }),
    });
    expect(offer.audience?.tone).toBe("shared");
    expect(offer.audience?.line).toBe(
      "Everyone in @supa can read 2-areas/apps/context/runbook.md.",
    );
  });

  test("a kind this build does not recognise is never called private", () => {
    for (const kind of ["shared", "org", "team", "", "PERSONAL", "personal-v2"]) {
      const offer = offerDictation({
        ...ENGINE,
        ...OPEN,
        context: context({ slug: "supa", kind, role: "owner" }),
      });
      expect(offer.audience?.tone).toBe("shared");
    }
  });

  test("a slug that already carries its @ is not given a second one", () => {
    const offer = offerDictation({
      ...ENGINE,
      ...OPEN,
      context: context({ slug: "@supa", kind: "shared", role: "owner" }),
    });
    expect(offer.audience?.line).toContain("@supa");
    expect(offer.audience?.line).not.toContain("@@");
  });
});

describe("when dictation is not offered", () => {
  test("a folder on screen is told to open a note, not merely greyed out", () => {
    const offer = offerDictation({ ...ENGINE, ...OPEN, noteOpen: false, context: context() });
    expect(offer.audience).toBeNull();
    expect(offer.refusal).toBe(NO_NOTE);
  });

  test("a note that is read-only for its own sake refuses dictation", () => {
    // `privacy.md` and an encrypted envelope, in a context you own outright.
    const offer = offerDictation({ ...ENGINE, ...OPEN, writable: false, context: context() });
    expect(offer.refusal).toBe(READ_ONLY);
  });

  test("a member who may read but not write is refused", () => {
    const offer = offerDictation({
      ...ENGINE,
      ...OPEN,
      context: context({ slug: "supa", kind: "shared", role: "member" }),
    });
    expect(offer.refusal).toBe(READ_ONLY);
    expect(offer.audience).toBeNull();
  });

  test("a browser with no engine says so, even with no note open", () => {
    const offer = offerDictation({
      engineAvailable: false,
      unavailable: "This browser has no dictation engine.",
      ...OPEN,
      noteOpen: false,
      context: null,
    });
    expect(offer.refusal).toBe("This browser has no dictation engine.");
  });

  test("no context at all is the same answer as no note", () => {
    const offer = offerDictation({ ...ENGINE, ...OPEN, context: null });
    expect(offer.refusal).toBe(NO_NOTE);
  });
});

describe("the sentence a failure gets", () => {
  test("a refusal says the note was not touched", () => {
    expect(reasonFor("denied", "")).toContain("as you left it");
  });

  test("an unreachable engine says dictation stopped rather than pretending", () => {
    expect(reasonFor("unreachable", "")).toContain("rather than look live");
  });

  test("an unsupported surface repeats the engine's own sentence", () => {
    expect(reasonFor("unsupported", "Use the mic on your keyboard.")).toBe(
      "Use the mic on your keyboard.",
    );
  });

  test("every failure has a sentence, so no state can render empty", () => {
    for (const failure of ["denied", "no-microphone", "unreachable", "unsupported"] as const) {
      expect(reasonFor(failure, "fallback").length).toBeGreaterThan(0);
    }
  });
});
