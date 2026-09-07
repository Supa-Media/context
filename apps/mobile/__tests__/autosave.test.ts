/**
 * THE SCHEDULE, AND WHICH DRAFTS ARE ALLOWED ON IT.
 *
 * `autosaveEditor.test.ts` mounts the real hook and proves the wiring — that a
 * timer firing after a note switch cannot write note A's text into note B, that
 * leaving flushes, that the write stays conditional. This file is the half that
 * needs no renderer: the two timers, and the pure policy that says which
 * editor states may be written without anybody pressing anything.
 *
 * The policy is worth testing on its own because every "no" in it is a state
 * where an automatic write is not merely wasteful but wrong — a conflict
 * autosaved is a clobber of a version nobody has seen, an error autosaved is a
 * refusal loop — and `autosaves` is checked when the timer *fires*, so each of
 * those has to hold for a state that was armed while it was still `dirty`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests across
 * this file, `autosaveEditor.test.ts`, `fileEditor.test.ts` and
 * `offlineEditor.test.ts`.
 *
 *   the ceiling restarted on every edit, so dictation never saves       5
 *   the idle timer not re-armed by an edit, so it fires mid-sentence    6
 *   `flush` ignoring its path argument                                  1
 *   `autosaves` accepting `conflict`                                    3
 *   `autosaves` accepting `error`                                       1
 *   `autosaves` accepting `queued`                                      1
 *   `autosaves` dropping the `isDirty` half                             1
 *   `needsDecision` returning false for a conflict                      2
 *   `guardLeaving` refusing an ordinary dirty draft again              10
 *   the resting button reading "Save" again                             1
 *   a cached body's button reading "Saved"                              1
 */

import { describe, expect, test } from "@jest/globals";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  createAutosaveController,
} from "../features/console/files/autosave";
import {
  autosaves,
  editorReducer,
  emptyEditor,
  guardLeaving,
  needsDecision,
  saveButton,
  type EditorState,
} from "../features/console/files/editor";
import type { OpenNote } from "../features/console/files/types";

/* ------------------------------- the clock -------------------------------- */

/**
 * A hand-driven clock, so a test says "12 seconds pass" rather than waiting.
 *
 * Fake timers would do it too, but the controller takes its `schedule` and
 * `cancel` as arguments precisely so that the thing under test is the
 * arithmetic and not jest's timer queue — and a scheduler that cancels the
 * wrong handle passes under fake timers and fails here.
 */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (id: number) => {
      timers.delete(id);
    },
    /** Run every timer due within `ms`, in due order, advancing as it goes. */
    advance: (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    live: () => timers.size,
  };
}

function controller(saved: string[]) {
  const c = clock();
  return {
    clock: c,
    autosave: createAutosaveController({
      schedule: c.schedule,
      cancel: c.cancel,
      save: (path) => saved.push(path),
    }),
  };
}

/* --------------------------------- states --------------------------------- */

const NOTE: OpenNote = {
  path: "1-projects/plan.md",
  text: "original\n",
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};

function opened(): EditorState {
  return editorReducer(emptyEditor, { type: "opened", note: NOTE });
}

function dirty(): EditorState {
  return editorReducer(opened(), { type: "edited", text: "original\nand more\n" });
}

/* -------------------------------------------------------------------------- */

describe("the idle debounce", () => {
  test("writes once the draft stops changing", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    c.advance(AUTOSAVE_IDLE_MS - 1);
    expect(saved).toEqual([]);

    c.advance(1);
    expect(saved).toEqual(["a.md"]);
  });

  test("every keystroke pushes it back, so it never fires mid-sentence", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    // Nine keystrokes a second and a half apart: eleven seconds of typing, and
    // not one of them may produce a write.
    for (let i = 0; i < 8; i++) {
      autosave.edited("a.md");
      c.advance(AUTOSAVE_IDLE_MS - 500);
    }
    expect(saved).toEqual([]);

    c.advance(AUTOSAVE_IDLE_MS);
    expect(saved).toEqual(["a.md"]);
  });

  test("nothing is left running once it has fired", () => {
    // A leaked timer here is a write per keystroke arriving one debounce later,
    // which is the cost this whole module exists to bound.
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    c.advance(AUTOSAVE_MAX_WAIT_MS * 2);

    expect(saved).toEqual(["a.md"]);
    expect(c.live()).toBe(0);
    expect(autosave.pending()).toBeNull();
  });
});

describe("the ceiling", () => {
  test("dictation gets written even though it never pauses", () => {
    /*
      The case an idle-only debounce cannot serve. iOS dictation inserts a
      partial result every few hundred milliseconds, so the idle timer is
      pushed back forever and a whole dictated paragraph would sit in the
      editor, unwritten, for as long as somebody kept talking.
    */
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    for (let elapsed = 0; elapsed < AUTOSAVE_MAX_WAIT_MS + 400; elapsed += 400) {
      autosave.edited("a.md");
      c.advance(400);
    }

    expect(saved).toEqual(["a.md"]);
  });

  test("it is a deadline from the first edit, not a second debounce", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);
    // A keystroke every 400ms, which is faster than the idle timer and slower
    // than nothing: the idle timer is pushed back on every one of them.
    const typing = (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 400) {
        c.advance(400);
        autosave.edited("a.md");
      }
    };

    autosave.edited("a.md");
    typing(AUTOSAVE_MAX_WAIT_MS - 800);
    expect(saved).toEqual([]);

    // The ceiling comes due while they are still typing, which is the whole
    // point of it, and it is measured from the first edit rather than the last.
    typing(800);
    expect(saved).toEqual(["a.md"]);
  });

  test("it starts again for the typing that follows a save", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    c.advance(AUTOSAVE_IDLE_MS);
    expect(saved).toEqual(["a.md"]);

    for (let elapsed = 0; elapsed < AUTOSAVE_MAX_WAIT_MS + 400; elapsed += 400) {
      autosave.edited("a.md");
      c.advance(400);
    }
    expect(saved).toEqual(["a.md", "a.md"]);
  });
});

describe("switching notes", () => {
  test("the old note's timers do not fire under the new one", () => {
    /*
      The controller drops them rather than firing them, because the caller
      flushes on the way out of a note — see `select` in `useFileBrowser`. A
      fire here would be a second write of text the flush has already sent,
      against an etag that first write has moved past.
    */
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    c.advance(500);
    autosave.edited("b.md");
    c.advance(AUTOSAVE_IDLE_MS);

    expect(saved).toEqual(["b.md"]);
    expect(c.live()).toBe(0);
  });

  test("the new note gets its own ceiling", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);
    const typing = (path: string, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 400) {
        c.advance(400);
        autosave.edited(path);
      }
    };

    autosave.edited("a.md");
    typing("a.md", AUTOSAVE_MAX_WAIT_MS - 2_000);
    expect(saved).toEqual([]);

    autosave.edited("b.md");
    /*
      Two seconds later a's ceiling would have come due. It must not: it was
      dropped when the note changed, and firing it here would write b's path
      against a deadline a's typing set — the shape of the cross-note bug this
      whole module is careful about.
    */
    typing("b.md", AUTOSAVE_MAX_WAIT_MS - 2_000);
    expect(saved).toEqual([]);

    typing("b.md", 2_000);
    expect(saved).toEqual(["b.md"]);
  });
});

describe("flush and cancel", () => {
  test("flush writes what is waiting and leaves nothing behind", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    expect(autosave.flush()).toBe(true);
    expect(saved).toEqual(["a.md"]);

    // And the timer it pre-empted cannot fire a second write.
    c.advance(AUTOSAVE_MAX_WAIT_MS);
    expect(saved).toEqual(["a.md"]);
    expect(autosave.flush()).toBe(false);
  });

  test("a flush for another note leaves this one armed", () => {
    /*
      Closing tab B must not write tab A early — and, more to the point, must
      not report that it handed anything over. The caller uses the answer to
      decide whether to ask a question.
    */
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    expect(autosave.flush("b.md")).toBe(false);
    expect(saved).toEqual([]);

    expect(autosave.flush("a.md")).toBe(true);
    expect(saved).toEqual(["a.md"]);
    c.advance(AUTOSAVE_MAX_WAIT_MS);
    expect(saved).toEqual(["a.md"]);
  });

  test("cancel drops the write entirely", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    autosave.cancel();
    c.advance(AUTOSAVE_MAX_WAIT_MS);

    expect(saved).toEqual([]);
    expect(c.live()).toBe(0);
  });

  test("dispose is final", () => {
    const saved: string[] = [];
    const { clock: c, autosave } = controller(saved);

    autosave.edited("a.md");
    autosave.dispose();
    autosave.edited("a.md");
    c.advance(AUTOSAVE_MAX_WAIT_MS);

    expect(saved).toEqual([]);
    expect(c.live()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("which drafts may be written without being asked for", () => {
  test("an ordinary unsaved draft, and nothing that matches the bucket", () => {
    expect(autosaves(dirty())).toBe(true);
    expect(autosaves(opened())).toBe(false);
    expect(autosaves(emptyEditor)).toBe(false);
  });

  test("never a conflict", () => {
    /*
      The draft is based on an etag somebody else has moved past. An automatic
      write is a refusal every two seconds on a bucket that does conditional
      writes, and a silent clobber of a version nobody has been shown on a
      bucket that can only read-compare. Typing more does not clear it — see
      `edited` in the reducer — so the state persists exactly as long as the
      decision does.
    */
    const conflicted = editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "CONFLICT", message: "Somebody else saved first.", currentEtag: "etag-9" },
    });
    expect(conflicted.status).toBe("conflict");
    expect(autosaves(conflicted)).toBe(false);

    const typedMore = editorReducer(conflicted, { type: "edited", text: "original\nmore still\n" });
    expect(typedMore.status).toBe("conflict");
    expect(autosaves(typedMore)).toBe(false);
  });

  test("never a queued draft", () => {
    const queued = editorReducer(dirty(), { type: "saveQueued", message: "No connection." });
    expect(autosaves(queued)).toBe(false);
    expect(autosaves(editorReducer(queued, { type: "edited", text: "more\n" }))).toBe(false);
  });

  test("no automatic retry after a failure — but typing re-arms it", () => {
    const failed = editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "UNKNOWN", message: "That did not work." },
    });
    expect(failed.status).toBe("error");
    expect(autosaves(failed)).toBe(false);

    // What every editor does, and the reason there is no retry loop: the next
    // keystroke is a fresh draft, and a fresh draft is saved like any other.
    const typedMore = editorReducer(failed, { type: "edited", text: "original\nand again\n" });
    expect(typedMore.status).toBe("dirty");
    expect(autosaves(typedMore)).toBe(true);
  });

  test("never while a write is already in flight, and never a read-only note", () => {
    expect(autosaves(editorReducer(dirty(), { type: "saveStarted" }))).toBe(false);
    expect(autosaves({ ...dirty(), readOnly: true })).toBe(false);
  });

  test("never a note that is only different because it was just saved", () => {
    const saved = editorReducer(editorReducer(dirty(), { type: "saveStarted" }), {
      type: "saveSucceeded",
      etag: "etag-2",
      conflictCheck: "conditional",
    });
    expect(saved.status).toBe("saved");
    expect(autosaves(saved)).toBe(false);
  });
});

describe("which drafts nothing will ever write for you", () => {
  /*
    The other half of the policy, and the reason a prompt still exists at all.
    `guardLeaving` and the tab-close confirm both ask this rather than asking
    "is it dirty", so the question a person is interrupted with is only ever
    one autosave cannot answer for them.
  */
  test("a conflict and a failed save; nothing else", () => {
    expect(needsDecision(dirty())).toBe(false);
    expect(needsDecision(opened())).toBe(false);
    expect(needsDecision(editorReducer(dirty(), { type: "saveStarted" }))).toBe(false);
    expect(
      needsDecision(editorReducer(dirty(), { type: "saveQueued", message: "No connection." })),
    ).toBe(false);

    expect(
      needsDecision(
        editorReducer(dirty(), {
          type: "saveFailed",
          error: { code: "CONFLICT", message: "Somebody else saved first.", currentEtag: "e9" },
        }),
      ),
    ).toBe(true);
    expect(
      needsDecision(
        editorReducer(dirty(), {
          type: "saveFailed",
          error: { code: "UNKNOWN", message: "That did not work." },
        }),
      ),
    ).toBe(true);
  });
});

describe("what leaving still asks about", () => {
  test("an ordinary draft no longer stops anybody", () => {
    // The prompt this replaces is the "bugging people to save" the whole
    // change is about. The draft is written on the way out and is on the
    // device besides.
    expect(guardLeaving(dirty())).toEqual({ allowed: true });
    expect(needsDecision(dirty())).toBe(false);
  });

  test("a conflict does, and the sentence does not offer a Save that cannot help", () => {
    const conflicted = editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "CONFLICT", message: "Somebody else saved first.", currentEtag: "etag-9" },
    });
    expect(needsDecision(conflicted)).toBe(true);
    const guard = guardLeaving(conflicted);
    expect(guard.allowed).toBe(false);
    expect(guard.prompt).toContain("written by somebody else");
    expect(guard.prompt).not.toMatch(/Save them/);
  });

  test("a failed save does", () => {
    const failed = editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "UNKNOWN", message: "That did not work." },
    });
    expect(needsDecision(failed)).toBe(true);
    expect(guardLeaving(failed).allowed).toBe(false);
  });

  test("a queued draft still does not, and a clean note never did", () => {
    const queued = editorReducer(dirty(), { type: "saveQueued", message: "No connection." });
    expect(guardLeaving(queued).allowed).toBe(true);
    expect(guardLeaving(opened()).allowed).toBe(true);
  });
});

describe("the button stops asking for something", () => {
  test("a note that matches the bucket reads as saved, not as a chore", () => {
    expect(saveButton(opened())).toEqual({ label: "Saved", disabled: true });
    const saved = editorReducer(editorReducer(dirty(), { type: "saveStarted" }), {
      type: "saveSucceeded",
      etag: "etag-2",
      conflictCheck: "conditional",
    });
    expect(saveButton(saved)).toEqual({ label: "Saved", disabled: true });
  });

  test("a body read off the device does not claim to be saved", () => {
    // `fromCache` means nothing has asked the bucket about this note since it
    // was read. "Saved" there would be the console vouching for a bucket it
    // has not spoken to.
    const cached = editorReducer(emptyEditor, { type: "opened", note: NOTE, fromCache: true });
    expect(saveButton(cached).label).toBe("Save");
  });

  /**
   * AN ENCRYPTED NOTE IS NOT "READ-ONLY", AND THE DIFFERENCE IS THE COPY.
   *
   * Both flags are true for one — the control plane forces `readOnly`, which is
   * what actually holds the editor shut and what an older console honours. This
   * is the sentence: `privacy.md` is read-only because this product generates
   * it, and an encrypted note is shut because the console has no key. Telling
   * somebody their own note is "read-only" would send them looking for the
   * setting that unlocks it.
   *
   * See `docs/decisions/encryption.md`.
   */
  test("an encrypted note says what it is, and neither flag alone would say it", () => {
    const encrypted = editorReducer(emptyEditor, {
      type: "opened",
      note: { ...NOTE, readOnly: true, encrypted: true },
    });
    expect(saveButton(encrypted)).toEqual({ label: "Encrypted", disabled: true });
    // The other half of the pair, so this is a distinction rather than a
    // relabelling of every locked note.
    const manifest = editorReducer(emptyEditor, {
      type: "opened",
      note: { ...NOTE, readOnly: true },
    });
    expect(saveButton(manifest)).toEqual({ label: "Read-only", disabled: true });
    // And an ordinary note is neither, so the flag is not always on.
    expect(opened().encrypted).toBe(false);
  });

  test("...and typing into one changes nothing, through the flag that already existed", () => {
    const encrypted = editorReducer(emptyEditor, {
      type: "opened",
      note: { ...NOTE, readOnly: true, encrypted: true },
    });
    const typed = editorReducer(encrypted, { type: "edited", text: "# plaintext now\n" });
    // `readOnly` is what the reducer checks, and it is forced true by the
    // server for an encrypted note — so the protection does not depend on any
    // client having heard of `encrypted`.
    expect(typed.draft).toBe(NOTE.text);
    expect(typed).toBe(encrypted);
  });

  test("the manual route stays for the two states autosave refuses", () => {
    const failed = editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "UNKNOWN", message: "That did not work." },
    });
    expect(saveButton(failed)).toEqual({ label: "Save", disabled: false });
    const conflicted = editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "CONFLICT", message: "Somebody else saved first.", currentEtag: "etag-9" },
    });
    expect(saveButton(conflicted)).toEqual({ label: "Overwrite theirs", disabled: false });
  });
});
