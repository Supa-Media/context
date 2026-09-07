/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
} from "../features/console/files/autosave";
import { SAVE_TIMEOUT_MS } from "../features/console/files/editor";
import { ConvexError } from "convex/values";
import type { FolderListing, OpenNote, SaveResult } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * AUTOSAVE, AGAINST THE REAL HOOK.
 *
 * `autosave.test.ts` owns the timers and the policy, both pure. This owns the
 * part that only exists once the scheduler is wired to a `writeNote`: what is
 * actually sent to the customer's bucket, how often, and — the one that would
 * be worth the whole feature being reverted — **which note it is sent for**.
 *
 * ## The failure this file is really about
 *
 * A timer armed while one note was open, firing after another has been opened.
 * `editorRef.current` is whatever is on screen *now*, so a fire that does not
 * check would write the old note's text to the new note's path, against the new
 * note's etag: one person's words over another file, through a write the server
 * cannot tell from a legitimate one because it carries a legitimate etag.
 *
 * The sequence below reaches it without any test-only seam. `select` flushes
 * the pending draft on the way out, so the timer is normally gone by the time
 * the next note lands — but the *read* for that next note is a round trip, and
 * the editor keeps holding the old note until it answers. Typing in that window
 * arms a timer for a note that is about to be replaced.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file unless another is named.
 *
 *   the path check in `autosaveNow` dropped                             1
 *   the `autosaves` re-check at fire time dropped                       1
 *   the flush in `select` dropped                                       5
 *   `saveSucceeded` dispatched without comparing the path               1
 *   `saveFailed` dispatched without comparing the path                  2
 *   `saveTimedOut` dispatched without comparing the path                1
 *   two notes sharing one save generation                               2
 *   `expectedEtag` dropped from the autosaved write                     2
 *
 * **One went undetected and is recorded rather than quietly fixed.**
 * `performSave` cancelling the timer it supersedes fails nothing, because
 * every state a save in flight can produce — `saving`, then `saved`, `error`,
 * `conflict` or `queued` — is one the fire-time `autosaves` check already
 * refuses, so the two guards shadow each other completely. The cancel stays as
 * belt and braces and because it is the cheaper of the two (a timer that never
 * runs costs nothing), but nothing here can distinguish it, and claiming
 * coverage for it would be the kind of guard this repository keeps finding was
 * never really checked. The first two sabotages above are the isolating
 * cases for its partner: a note that arrives dirty, and a conflict landing
 * after the typing that followed the save.
 */

/** `useAction` returns a stable function per query reference; the mock must too. */
const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import { draftIsKept, useFileBrowser } from "../features/console/files/useFileBrowser";

const NOTE_PATH = "1-projects/note.md";
const OTHER_PATH = "1-projects/other.md";
const MANIFEST_PATH = "privacy.md";

const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "file",
      path: NOTE_PATH,
      name: "note.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

function noteAt(path: string): OpenNote {
  return {
    path,
    text: `# ${path}\n\noriginal\n`,
    etag: `etag-${path}`,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: path === MANIFEST_PATH,
  };
}

interface Write {
  path: string;
  text: string;
  expectedEtag?: string;
}

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;
let writes: Write[];
/** Reads that have been asked for but not answered, by path. */
let reads: Map<string, (note: OpenNote) => void>;
/** How `writeNote` answers. Replaced per test. */
let respond: (write: Write) => Promise<SaveResult>;
/**
 * Writes that have been sent and not answered, oldest first.
 *
 * A test opts in with `gateWrites`, and several of the ones below need it: the
 * whole family of bugs here is about *when* an answer arrives relative to what
 * the person did next, and a mock that answers inside the same microtask can
 * only ever test one of those orderings.
 */
let gateWrites = false;
let inFlight: Array<{
  write: Write;
  resolve: (result: SaveResult) => void;
  reject: (error: unknown) => void;
}>;

/** The refusal the server sends when somebody else got there first. */
function conflictError() {
  return new ConvexError({
    code: "CONFLICT",
    message: "Somebody else saved this note first.",
    currentEtag: "etag-theirs",
  });
}

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

/** Let pending promise callbacks run without advancing the fake clock. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Move the clock, then let whatever that started settle. */
async function tick(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

/** Type, the way a person does: a burst of keystrokes over `ms`. */
async function type(text: string, ms: number) {
  act(() => browser.setDraft(text));
  if (ms > 0) await tick(ms);
}

describe("autosave", () => {
  let unmount: () => void;

  beforeEach(async () => {
    jest.useFakeTimers();
    /*
      The offline layer writes drafts to `localStorage`, and jsdom keeps one
      per file. A draft left by the previous test is restored into this one —
      as a *conflict*, because its base etag no longer matches — which is
      `restoreFor` doing exactly its job and has nothing to do with autosave.
    */
    window.localStorage.clear();
    writes = [];
    reads = new Map();
    inFlight = [];
    gateWrites = false;
    respond = async (write) => ({
      path: write.path,
      etag: `${write.expectedEtag ?? "none"}+1`,
      conflictCheck: "conditional",
    });

    actions[name("listFiles")] = async () => ROOT_LISTING;
    actions[name("readNote")] = (async (args: { path: string }) =>
      await new Promise<OpenNote>((resolve) => {
        /*
          Answered immediately unless a test has said otherwise by putting the
          path in `slowReads` — the note-switch race needs a read it can hold
          open, because the editor goes on holding the *previous* note until
          one lands.
        */
        if (slowReads.has(args.path)) reads.set(args.path, resolve);
        else resolve(noteAt(args.path));
      })) as (args: never) => Promise<unknown>;
    actions[name("writeNote")] = (async (args: Write) => {
      const write = { path: args.path, text: args.text, expectedEtag: args.expectedEtag };
      writes.push(write);
      if (!gateWrites) return await respond(args);
      return await new Promise<SaveResult>((resolve, reject) => {
        inFlight.push({ write, resolve, reject });
      });
    }) as (args: never) => Promise<unknown>;

    unmount = mount();
    await settle();

    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    expect(browser.editor.status).toBe("clean");
  });

  afterEach(() => {
    slowReads.clear();
    unmount();
    jest.useRealTimers();
  });

  const slowReads = new Set<string>();

  /* ------------------------------ the schedule ---------------------------- */

  test("a draft is written once typing stops, and not before", async () => {
    await type("# note\n\nsomething\n", AUTOSAVE_IDLE_MS - 100);
    expect(writes).toEqual([]);
    expect(browser.editor.status).toBe("dirty");

    await tick(200);
    expect(writes).toHaveLength(1);
    expect(browser.editor.status).toBe("saved");
  });

  test("it is one write per pause, not one per keystroke", async () => {
    /*
      The cost constraint, made a test. Each save is a Convex action → the
      gateway → a conditional PUT on the customer's own bucket plus a LIST to
      refresh the folder, all on their request quota. Nine edits inside one
      pause must cost one write.
    */
    for (const word of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh"]) {
      await type(`# note\n\n${word}\n`, 200);
    }
    expect(writes).toEqual([]);

    await tick(AUTOSAVE_IDLE_MS);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe("# note\n\nabcdefgh\n");
  });

  test("continuous input is written at the ceiling, without a pause", async () => {
    // Dictation, or a fast typist: the idle timer never comes due, and an
    // idle-only debounce would leave the whole paragraph unwritten.
    for (let elapsed = 0; elapsed < AUTOSAVE_MAX_WAIT_MS + 400; elapsed += 400) {
      await type(`# note\n\ndictated ${elapsed}\n`, 400);
    }
    // Exactly one, at the ceiling — and it carried what had been dictated by
    // then rather than the text from when the timer was armed.
    expect(writes).toHaveLength(1);
    const lastBeforeTheCeiling = Math.floor((AUTOSAVE_MAX_WAIT_MS - 1) / 400) * 400;
    expect(writes[0]!.text).toBe(`# note\n\ndictated ${lastBeforeTheCeiling}\n`);
    // Still `dirty`, because the dictation carried on after that write. The
    // next ceiling is already running for the rest of it.
    expect(browser.editor.status).toBe("dirty");
  });

  test("the write is conditional on the etag the draft was typed against", async () => {
    /*
      Non-negotiable: an autosaved write is the same conditional write Save
      makes. No force flag, no second path. If this ever sends `undefined` the
      server has nothing to check against and the next person to save this note
      from Obsidian is overwritten without being asked.
    */
    await type("# note\n\nsomething\n", AUTOSAVE_IDLE_MS);
    expect(writes).toEqual([
      {
        path: NOTE_PATH,
        text: "# note\n\nsomething\n",
        expectedEtag: `etag-${NOTE_PATH}`,
      },
    ]);
    // And the editor moved onto the etag that write produced, so the *next*
    // autosave is conditional on this one rather than on the version before it.
    await type("# note\n\nsomething more\n", AUTOSAVE_IDLE_MS);
    expect(writes[1]!.expectedEtag).toBe(`etag-${NOTE_PATH}+1`);
  });

  test("nothing is written for a read-only note", async () => {
    await act(async () => {
      browser.select(MANIFEST_PATH);
    });
    await settle();
    expect(browser.editor.readOnly).toBe(true);

    await type("everything: team\n", AUTOSAVE_MAX_WAIT_MS * 2);
    expect(writes).toEqual([]);
  });

  /* --------------------------- the note switch ---------------------------- */

  test("a timer armed for one note cannot write into another", async () => {
    /*
      The failure this whole file is about, reached the way it actually
      happens: the read for the next note is a round trip, and the editor holds
      the old note until it answers. A keystroke in that window arms a timer
      for a note that is about to be replaced.

      Without the path check in `autosaveNow`, the fire two seconds later reads
      `editorRef.current` — now the *other* note — and writes this note's text
      to that path, against that etag. A conditional write the server has no
      way to refuse.
    */
    slowReads.add(OTHER_PATH);

    await type("# note\n\nmine\n", 0);
    act(() => {
      browser.select(OTHER_PATH);
    });
    // Leaving flushed the draft, which is the ordinary path and not what this
    // test is about.
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(NOTE_PATH);

    // The read has not answered, so the editor is still holding the old note.
    expect(browser.editor.path).toBe(NOTE_PATH);
    await type("# note\n\nmine, still being typed\n", 0);

    // Now the other note lands.
    act(() => reads.get(OTHER_PATH)!(noteAt(OTHER_PATH)));
    await settle();
    expect(browser.editor.path).toBe(OTHER_PATH);

    // …and the old note's timer comes due under it.
    await tick(AUTOSAVE_MAX_WAIT_MS * 2);

    expect(writes).toHaveLength(1);
    expect(browser.editor.path).toBe(OTHER_PATH);
    expect(browser.editor.draft).toBe(noteAt(OTHER_PATH).text);
    expect(browser.editor.status).toBe("clean");
  });

  test("a timer armed for one note cannot write into another that is also dirty", async () => {
    /*
      The same guard as above, against the arrangement where nothing else stops
      it. The test above leaves a *clean* note in the editor, so the fire-time
      `autosaves` check refuses on its own; here the note that arrives is dirty
      too — it had a draft waiting on the device — and the path comparison is
      the only thing between a timer and somebody's file.

      What that timer would write is worth being exact about, because it is not
      "the wrong note saved twice". `autosaveNow` is handed the path it was
      armed with and reads the text and etag off the editor, so a fire without
      the comparison writes **this note's text to that note's path, against
      this note's etag** — a conditional write the server has every reason to
      accept.
    */
    gateWrites = true;
    const otherDraft = "# other\n\nwaiting on the device\n";

    /*
      Give the other note a draft that will come back when it is opened: type
      into it, let the device copy be written down, and leave while the save is
      still in flight — an answered save clears the draft (`forgetDraft`), and
      an unanswered one is the ordinary state of a slow bucket.
    */
    await act(async () => {
      browser.select(OTHER_PATH);
    });
    await settle();
    await type(otherDraft, 0);
    await tick(1_000);
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    expect(browser.editor.path).toBe(NOTE_PATH);

    // Type here, then go back to the other note with the read held open.
    await type("# note\n\nmine\n", 0);
    slowReads.add(OTHER_PATH);
    act(() => {
      browser.select(OTHER_PATH);
    });
    await settle();
    expect(browser.editor.path).toBe(NOTE_PATH);
    await type("# note\n\nmine, still typing\n", 0);

    // The other note lands, and its waiting draft comes with it.
    act(() => reads.get(OTHER_PATH)!(noteAt(OTHER_PATH)));
    await settle();
    expect(browser.editor.path).toBe(OTHER_PATH);
    expect(browser.editor.status).toBe("dirty");
    expect(browser.editor.draft).toBe(otherDraft);

    const before = writes.length;
    await tick(AUTOSAVE_MAX_WAIT_MS * 2);

    expect(writes).toHaveLength(before);
    expect(
      writes.some((write) => write.path === NOTE_PATH && write.text === otherDraft),
    ).toBe(false);
    expect(browser.editor.draft).toBe(otherDraft);
  });

  test("a conflict disarms the timer that was already running for the same note", async () => {
    /*
      Why `autosaves` is asked again when the timer fires rather than trusted
      from when it was armed. The state moves in between, and this is the move
      that matters: a save is in flight, the person keeps typing — which arms a
      fresh timer, because typing over a `saving` note is an ordinary dirty
      draft — and *then* the refusal comes back. Nothing cancelled that timer;
      the only thing standing between it and a write against an etag somebody
      else has moved past is the re-check.
    */
    gateWrites = true;

    await type("# note\n\nmine\n", 0);
    act(() => browser.save());
    await settle();
    expect(browser.editor.status).toBe("saving");
    expect(writes).toHaveLength(1);

    // Typing on top of the save in flight arms a new timer.
    await type("# note\n\nmine, and more\n", 0);

    act(() => inFlight[0]!.reject(conflictError()));
    await settle();
    expect(browser.editor.status).toBe("conflict");

    await tick(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(writes).toHaveLength(1);
    expect(browser.editor.status).toBe("conflict");
  });

  test("leaving a note writes what was pending, without asking", async () => {
    /*
      "Stop bugging people to save": this used to be a refusal and a notice
      reading "has unsaved changes. Save them, or discard them, before opening
      something else."
    */
    await type("# note\n\nwritten on the way out\n", 0);
    expect(writes).toEqual([]);

    await act(async () => {
      browser.select(OTHER_PATH);
    });
    await settle();

    expect(browser.notice).toBeNull();
    expect(browser.selectedPath).toBe(OTHER_PATH);
    expect(writes).toEqual([
      {
        path: NOTE_PATH,
        text: "# note\n\nwritten on the way out\n",
        expectedEtag: `etag-${NOTE_PATH}`,
      },
    ]);
  });

  test("a flush leaves no timer behind to write the same text twice", async () => {
    await type("# note\n\nonce\n", 0);
    act(() => {
      browser.flushAutosave();
    });
    await settle();
    expect(writes).toHaveLength(1);

    await tick(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(writes).toHaveLength(1);
  });

  /* ------------------------------ the refusals ---------------------------- */

  test("a conflict is never autosaved, however much more is typed", async () => {
    /*
      The draft is based on an etag somebody else has moved past. Autosaving it
      is a refusal every two seconds against a bucket that does conditional
      writes, and a silent clobber against one that can only read-compare. The
      three answers in `ConflictResolver` stay the only way out.
    */
    respond = async () => {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Somebody else saved this note first.",
        currentEtag: "etag-theirs",
      });
    };

    await type("# note\n\nmine\n", AUTOSAVE_IDLE_MS);
    expect(writes).toHaveLength(1);
    expect(browser.editor.status).toBe("conflict");

    await type("# note\n\nmine, and more\n", AUTOSAVE_MAX_WAIT_MS * 2);
    expect(writes).toHaveLength(1);
    expect(browser.editor.status).toBe("conflict");
    expect(browser.editor.draft).toBe("# note\n\nmine, and more\n");
  });

  test("a failed save is not retried on its own — and typing re-arms it", async () => {
    let failing = true;
    respond = async (write) => {
      if (failing) throw new ConvexError({ code: "UNKNOWN", message: "That did not work." });
      return { path: write.path, etag: "etag-later", conflictCheck: "conditional" };
    };

    await type("# note\n\nmine\n", AUTOSAVE_IDLE_MS);
    expect(writes).toHaveLength(1);
    expect(browser.editor.status).toBe("error");

    // No retry loop: a save that failed for a reason nobody has read gets one
    // attempt, not one every two seconds.
    await tick(AUTOSAVE_MAX_WAIT_MS * 3);
    expect(writes).toHaveLength(1);

    // But the next keystroke is a fresh draft, and a fresh draft is saved like
    // any other. That is what every editor does, and why there is no retry.
    failing = false;
    await type("# note\n\nmine, again\n", AUTOSAVE_IDLE_MS);
    expect(writes).toHaveLength(2);
    expect(browser.editor.status).toBe("saved");
  });

  test("a refusal for a note nobody is looking at cannot land on the open one", async () => {
    /*
      `saveFailed` puts the state it is given into `conflict` or `error`, and a
      conflict carries `conflictEtag` — so a late refusal about the note you
      left would offer *its* version as a merge candidate for the note you are
      typing in now. The path is compared before the reducer sees it, and the
      fact goes to the notice line instead, which says where the draft is.

      Gated, because the order is the whole point: the refusal has to arrive
      *after* the other note has landed in the editor.
    */
    gateWrites = true;

    await type("# note\n\nmine\n", 0);
    await act(async () => {
      browser.select(OTHER_PATH);
    });
    await settle();
    expect(browser.editor.path).toBe(OTHER_PATH);
    expect(inFlight).toHaveLength(1);

    act(() => inFlight[0]!.reject(conflictError()));
    await settle();

    expect(browser.editor.path).toBe(OTHER_PATH);
    expect(browser.editor.status).toBe("clean");
    expect(browser.editor.conflictEtag).toBeUndefined();
    expect(browser.notice).toContain(NOTE_PATH);
    expect(browser.notice).toContain("kept on this device");
  });

  test("a save that timed out for a note you left does not put this one in error", async () => {
    /*
      The same rule for the other way a save ends. `saveTimedOut` only checks
      that the state is `saving`, and after a switch that state belongs to
      another note — so a timeout inherited from the note you left would tell
      you *this* note might not have been written, and offer Discard for a
      draft that was never at risk.
    */
    gateWrites = true;

    await type("# note\n\nmine\n", 0);
    await act(async () => {
      browser.select(OTHER_PATH);
    });
    await settle();
    expect(browser.editor.path).toBe(OTHER_PATH);

    // The write for the note we left never answers, and its deadline passes.
    await type("# other\n\ntyping here now\n", 0);
    await tick(SAVE_TIMEOUT_MS + 1_000);

    expect(browser.editor.path).toBe(OTHER_PATH);
    expect(browser.editor.status).not.toBe("error");
    expect(browser.editor.draft).toBe("# other\n\ntyping here now\n");
    expect(browser.notice).toContain(NOTE_PATH);
    expect(browser.notice).toContain("stopped waiting");
  });

  test("two notes can be in flight at once, and each gets its own answer", async () => {
    /*
      Why the generation counter is keyed by path. It was one number, which was
      enough while the guard refused to leave a note with a save in flight —
      only one could exist. Leaving flushes now, so the write for the note you
      left is routinely still in the air when the next one starts, and a single
      counter would let the second save discard the first one's answer:
      silently, including the cache bookkeeping that keeps a written draft from
      being restored as unsaved work later.
    */
    gateWrites = true;

    await type("# note\n\nmine\n", 0);
    await act(async () => {
      browser.select(OTHER_PATH);
    });
    await settle();
    await type("# other\n\nalso mine\n", 0);
    act(() => {
      browser.flushAutosave();
    });
    await settle();

    expect(inFlight.map((entry) => entry.write.path)).toEqual([NOTE_PATH, OTHER_PATH]);

    // The older save answers last, and its refusal still reaches somebody.
    act(() =>
      inFlight[1]!.resolve({ path: OTHER_PATH, etag: "etag-new", conflictCheck: "conditional" }),
    );
    await settle();
    expect(browser.editor.status).toBe("saved");

    act(() => inFlight[0]!.reject(conflictError()));
    await settle();
    expect(browser.notice).toContain(NOTE_PATH);
  });

  test("what it says about where that draft is depends on the store", () => {
    /*
      A notice about a save that did not land has to answer "so where is what I
      typed", and the answer is worth exactly as much as the store is. A
      browser refusing `localStorage` gives a copy that lives as long as the
      tab, and the same sentence there would be a durability claim the console
      cannot make — the rule the queued-save message already follows.
    */
    expect(draftIsKept(true)).toContain("kept on this device");
    expect(draftIsKept(false)).not.toContain("kept on this device");
    expect(draftIsKept(false)).toContain("Closing the app loses it");
  });

  test("discarding a draft cancels the write that was coming for it", async () => {
    await type("# note\n\ntyped by mistake\n", 0);
    act(() => browser.discard());
    await tick(AUTOSAVE_MAX_WAIT_MS * 2);

    expect(writes).toEqual([]);
    expect(browser.editor.status).toBe("clean");
  });

  test("typing back to what the bucket already has writes nothing", async () => {
    await type("# note\n\nsomething\n", 200);
    await type(noteAt(NOTE_PATH).text, AUTOSAVE_MAX_WAIT_MS * 2);

    expect(writes).toEqual([]);
    expect(browser.editor.status).toBe("clean");
  });
});
