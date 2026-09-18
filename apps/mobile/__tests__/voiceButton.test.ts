/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorControls } from "../features/console/files/LiveEditor";
import type { DictationEngine, DictationHandlers } from "../features/voice/engine";
import { VoiceButton, type VoicePage } from "../features/voice/VoiceButton";
import { useVoiceHost, VoiceHostProvider } from "../features/voice/VoiceHost";
import {
  DICTATE_TITLE,
  DICTATION_SENTENCE,
  MEETING_TITLE,
} from "../features/voice/VoiceSheet";
import { meetings } from "../features/meetings/controller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Pressing the microphone, and what happens before the microphone opens.
 *
 * The property this file exists for is the one `meetingsFlow.test.ts` holds for
 * meetings, with one difference that makes it matter more rather than less.
 * For a meeting, the sheet is where the sentence about the audio lives. For
 * dictation the sheet is **also the only place anybody is told who can read the
 * note they are about to speak into** — there is no destination picker to
 * disclose it on afterwards, because the destination is the caret. A press that
 * opened the microphone directly would not move that disclosure; it would
 * delete it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `ask` calls `start()` as well as opening the sheet.
 *     → `pressing the button opens no microphone` fails.
 *  2. The sheet renders the audience line only for shared contexts, leaving
 *     personal notes with nothing.
 *     → `a note in your own context still says who can hear it` fails. A row
 *     that is silent for the common case teaches people the line means
 *     "warning" and not "audience", so the one time it appears it is read as
 *     an error and dismissed.
 *  3. `DICTATION_SENTENCE` emptied out of the sheet.
 *     → `the sheet says what happens to what you say` fails.
 *  4. The `meetingRunning` yield removed.
 *     → `a running meeting takes the corner, and the microphone with it` fails
 *     — two floating controls at one edge, which `RecordingBar` argues at
 *     length cannot be arbitrated by `zIndex`.
 *  5. The unmount cleanup dropped from `useDictation`.
 *     → `navigating away closes the microphone` fails. This is the one nobody
 *     would ever see: a tab left listening after the page moved on.
 *  6. `useDictation`'s note-change effect dropped.
 *     → `opening another note stops dictation rather than typing into it`
 *     fails.
 *  7. The note-change effect dispatches `discard` rather than `cancel`.
 *     → `opening another note keeps the sentences already dictated into this
 *     one` fails. This is what the self-review pass found: the two reads the
 *     same in the app today only because the document replacement invalidates
 *     the run before the effect runs.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(element: ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

/*
  `document`, not the host element: `Modal` renders through a portal on
  react-native-web, so the sheet is a sibling of the mount point rather than a
  child of it. A query scoped to the host finds the button and never the sheet,
  which is the half of this feature worth asserting.
*/
function findByTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function press(id: string): void {
  const node = findByTestId(id);
  if (node === null) throw new Error(`no element with testID ${id}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

/** A dictation engine that records what it was asked to do. */
function fakeEngine(over: Partial<DictationEngine> = {}) {
  const calls: string[] = [];
  let sink: DictationHandlers | null = null;
  const engine: DictationEngine = {
    available: true,
    unavailable: "",
    open: (handlers) => {
      calls.push("open");
      sink = handlers;
    },
    finalize: () => calls.push("finalize"),
    abandon: () => calls.push("abandon"),
    ...over,
  };
  return {
    engine,
    calls,
    say: (text: string, settled: boolean) =>
      act(() => {
        if (settled) sink?.final(text);
        else sink?.interim(text);
      }),
  };
}

function fakeControls() {
  const dictated: string[] = [];
  const ghosts: string[] = [];
  let discarded = 0;
  const controls = {
    wrap: () => {},
    toggleLinePrefix: () => {},
    insertLink: () => {},
    undo: () => {},
    redo: () => {},
    blur: () => {},
    dictate: (t: string) => dictated.push(t),
    showInterim: (t: string) => ghosts.push(t),
    discardDictation: () => {
      discarded += 1;
      return true;
    },
  } satisfies EditorControls;
  return {
    get: () => controls as EditorControls,
    dictated,
    ghosts,
    get discarded() {
      return discarded;
    },
  };
}

const OWN: VoicePage = {
  context: { slug: "seyi", kind: "personal", role: "owner" },
  notePath: "1-projects/weekly-sync.md",
  writable: true,
};

const SHARED: VoicePage = {
  context: { slug: "supa", kind: "shared", role: "editor" },
  notePath: "2-areas/apps/context/runbook.md",
  writable: true,
};

function button(props: Partial<Parameters<typeof VoiceButton>[0]> = {}): ReactElement {
  return createElement(VoiceButton, {
    page: OWN,
    controls: () => null,
    compact: false,
    onRecordMeeting: () => {},
    ...props,
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  jest.restoreAllMocks();
});

describe("the press", () => {
  test("pressing the button opens no microphone", () => {
    const fake = fakeEngine();
    render(button({ engine: fake.engine }));
    press("voice-button");
    expect(fake.calls).toEqual([]);
    expect(findByTestId("voice-sheet")).not.toBeNull();
  });

  test("the sheet says what happens to what you say", () => {
    render(button({ engine: fakeEngine().engine }));
    press("voice-button");
    expect(text()).toContain(DICTATION_SENTENCE);
  });

  test("the sheet offers both answers and neither is preselected into happening", () => {
    const fake = fakeEngine();
    render(button({ engine: fake.engine }));
    press("voice-button");
    expect(text()).toContain(DICTATE_TITLE);
    expect(text()).toContain(MEETING_TITLE);
    expect(fake.calls).toEqual([]);
  });

  test("a note in your own context still says who can hear it", () => {
    render(button({ engine: fakeEngine().engine }));
    press("voice-button");
    expect(findByTestId("voice-sheet-audience")?.textContent).toBe("Only you.");
  });

  test("a note in somebody else's context names them before the microphone opens", () => {
    render(button({ page: SHARED, engine: fakeEngine().engine }));
    press("voice-button");
    expect(findByTestId("voice-sheet-audience")?.textContent).toContain("@supa");
    expect(findByTestId("voice-sheet-audience")?.textContent).toContain(
      "2-areas/apps/context/runbook.md",
    );
  });

  test("a folder on screen is told to open a note", () => {
    render(button({ page: { ...OWN, notePath: null }, engine: fakeEngine().engine }));
    press("voice-button");
    expect(findByTestId("voice-sheet-refusal")).not.toBeNull();
    expect(findByTestId("voice-sheet-audience")).toBeNull();
  });

  test("the meeting row hands off rather than recording", () => {
    let handed = 0;
    const fake = fakeEngine();
    render(button({ engine: fake.engine, onRecordMeeting: () => (handed += 1) }));
    press("voice-button");
    press("voice-sheet-meeting");
    expect(handed).toBe(1);
    expect(fake.calls).toEqual([]);
  });
});

describe("dictating", () => {
  test("choosing dictate is what opens the microphone", () => {
    const fake = fakeEngine();
    render(button({ engine: fake.engine }));
    press("voice-button");
    press("voice-sheet-dictate");
    expect(fake.calls).toEqual(["open"]);
    expect(findByTestId("voice-capsule")).not.toBeNull();
    expect(findByTestId("voice-sheet")).toBeNull();
  });

  test("a guess is drawn and never dictated; a settled phrase is dictated", () => {
    const fake = fakeEngine();
    const controls = fakeControls();
    render(button({ engine: fake.engine, controls: controls.get }));
    press("voice-button");
    press("voice-sheet-dictate");
    fake.say("the handover is", false);
    fake.say("the handover is the", false);
    expect(controls.dictated).toEqual([]);
    expect(controls.ghosts).toEqual(["the handover is", "the handover is the"]);
    fake.say("The handover is the blocker.", true);
    expect(controls.dictated).toEqual(["The handover is the blocker."]);
  });

  test("Stop settles what is pending rather than throwing it away", () => {
    const fake = fakeEngine();
    render(button({ engine: fake.engine }));
    press("voice-button");
    press("voice-sheet-dictate");
    press("voice-stop");
    expect(fake.calls).toEqual(["open", "finalize"]);
  });

  test("Discard settles nothing and takes the run back out of the note", () => {
    const fake = fakeEngine();
    const controls = fakeControls();
    render(button({ engine: fake.engine, controls: controls.get }));
    press("voice-button");
    press("voice-sheet-dictate");
    fake.say("One sentence that landed.", true);
    press("voice-discard");
    expect(fake.calls).toEqual(["open", "abandon"]);
    expect(controls.discarded).toBe(1);
  });

  test("the capsule shows a clock, and it starts at zero", () => {
    const fake = fakeEngine();
    render(button({ engine: fake.engine, now: () => 1_000_000 }));
    press("voice-button");
    press("voice-sheet-dictate");
    expect(findByTestId("voice-elapsed")?.textContent).toBe("0:00");
  });

  test("a refused microphone says the note was left alone", () => {
    const fake = fakeEngine({
      open: (handlers) => handlers.error("denied"),
    });
    render(button({ engine: fake.engine }));
    press("voice-button");
    press("voice-sheet-dictate");
    expect(findByTestId("voice-failure")?.textContent).toContain("as you left it");
    expect(findByTestId("voice-capsule")).toBeNull();
  });

  test("a browser with no engine says so instead of offering a dead row", () => {
    const fake = fakeEngine({ available: false, unavailable: "This browser has no engine." });
    render(button({ engine: fake.engine }));
    press("voice-button");
    expect(findByTestId("voice-sheet-refusal")?.textContent).toBe("This browser has no engine.");
    press("voice-sheet-dictate");
    expect(fake.calls).toEqual([]);
  });
});

describe("what else is going on", () => {
  test("navigating away closes the microphone", () => {
    const fake = fakeEngine();
    render(button({ engine: fake.engine }));
    press("voice-button");
    press("voice-sheet-dictate");
    act(() => root!.unmount());
    expect(fake.calls).toEqual(["open", "abandon"]);
  });

  test("opening another note stops dictation rather than typing into it", () => {
    const fake = fakeEngine();
    const controls = fakeControls();
    render(button({ engine: fake.engine, controls: controls.get }));
    press("voice-button");
    press("voice-sheet-dictate");
    render(
      button({
        engine: fake.engine,
        controls: controls.get,
        page: { ...OWN, notePath: "1-projects/something-else.md" },
      }),
    );
    expect(fake.calls).toEqual(["open", "abandon"]);
    expect(findByTestId("voice-capsule")).toBeNull();
  });

  test("opening another note keeps the sentences already dictated into this one", () => {
    const fake = fakeEngine();
    const controls = fakeControls();
    render(button({ engine: fake.engine, controls: controls.get }));
    press("voice-button");
    press("voice-sheet-dictate");
    fake.say("Three sentences that landed.", true);

    render(
      button({
        engine: fake.engine,
        controls: controls.get,
        page: { ...OWN, notePath: "1-projects/something-else.md" },
      }),
    );

    /*
      The finding this test was written for. Navigating away used to `discard`,
      which takes the run back out — deleting writing somebody had dictated and
      meant, because they clicked a different note. It works out either way in
      the app today, because replacing the document invalidates the run first,
      but the intent was wrong and the ordering it relied on is not one this
      component controls.
    */
    expect(controls.discarded).toBe(0);
    expect(controls.dictated).toEqual(["Three sentences that landed."]);
    expect(fake.calls).toEqual(["open", "abandon"]);
  });

  test("a surface that provides no voice host draws no microphone", () => {
    /*
      The landing page's demo console, the visual fixture and any future
      embedder all render `BrowsePane` without a `VoiceHostProvider`. The
      landing page is a public marketing surface with no workspace behind it,
      and a microphone on it would be a control that cannot work and a
      permission prompt nobody asked for. `useVoiceHost` answering `null` is
      what keeps it off them, so that is what is asserted rather than the
      absence being left to whoever next edits `NoteEditor`.
    */
    let seen: unknown = "not read";
    function Probe() {
      seen = useVoiceHost();
      return null;
    }
    render(createElement(Probe));
    expect(seen).toBeNull();

    // And with one, the same hook hands it straight back.
    const host = { page: OWN, onRecordMeeting: () => {} };
    render(
      createElement(VoiceHostProvider, {
        value: host,
        children: createElement(Probe),
      }),
    );
    expect(seen).toBe(host);
  });

  test("the button announces itself as the disclosure control it is", () => {
    render(button({ engine: fakeEngine().engine }));
    const node = findByTestId("voice-button")!;
    expect(node.getAttribute("aria-label")).toBe("Voice capture");
    expect(node.getAttribute("aria-haspopup")).toBe("menu");
    expect(node.getAttribute("aria-expanded")).toBe("false");
    press("voice-button");
    expect(findByTestId("voice-button")!.getAttribute("aria-expanded")).toBe("true");
  });

  test("a running meeting takes the corner, and the microphone with it", () => {
    const fake = fakeEngine();
    const live = {
      session: { id: "mt_fake", state: "recording" },
    } as unknown as ReturnType<typeof meetings.getSnapshot>["live"];
    jest
      .spyOn(meetings, "getSnapshot")
      .mockReturnValue({ ...meetings.getSnapshot(), live });
    render(button({ engine: fake.engine }));
    expect(findByTestId("voice-button")).toBeNull();
    expect(findByTestId("voice-capsule")).toBeNull();
  });
});
