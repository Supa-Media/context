/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VoiceButton, type VoicePage } from "../features/voice/VoiceButton";
import { AGENT_TITLE, DICTATE_TITLE } from "../features/voice/VoiceSheet";
import { agentPage, consoleRoute } from "../features/agent/page";
import { createStubEngine, type AgentEngine } from "../features/agent/engine";
import { emptyEditor } from "../features/console/files/editor";
import { meetings } from "../features/meetings/controller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE FOURTH FACE, AND THE THREE RULES IT HAD TO FIT BETWEEN.
 *
 * The conversation is raised from the same control and the same sheet as
 * dictation, because there is no room in that corner for anything else —
 * `RecordingBar` and `VoiceButton` each argue at length that a second floating
 * control there is a defect, and #700 closed the version of that defect where
 * the second control was the bottom row's seventh key.
 *
 * So this file holds the three ways the new row has to compose with what was
 * already there, and one of them is a bug that only exists *because* of #700.
 *
 * ## The one that is not obvious: opening the panel hides the bar that hides
 * the button
 *
 * `NoteEditor` passes `microphoneElsewhere={compact && !barUp}`. Raising a `Modal`
 * takes the caret out of the editor, which puts the keyboard accessory bar
 * away, which puts the frame's toolbar back — so `microphoneElsewhere` flips to
 * `true` a frame after the panel opens. `VoiceButton` stands down when that is
 * true, and a control that stands down unmounts the `Modal` it owns.
 *
 * The panel would therefore open and vanish, on a phone, every time. The
 * existing yield already carried `!asking` for exactly this reason — the
 * comment there says a sheet "that vanished under the thumb that opened it
 * would be this button answering a press by disappearing" — and `!talking` is
 * the same clause for the same reason. It is asserted here rather than left to
 * that comment, because the two states are independent and a future edit that
 * touches one will not be told about the other.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `!talking` dropped from the yield in `VoiceButton`.
 *     → **1 fails**: `the panel survives the bar coming back underneath it`.
 *     This is the phone bug above, and nothing else in the suite catches it —
 *     `oneMicrophone.test.ts` never opens the conversation.
 *  2. The agent row's `onPress` gated on `canDictate`, the way the dictate row
 *     above it is.
 *     → **5 fail**, every test that opens the panel, `the conversation is
 *     offered with no note open` among them. That test asserted only that the
 *     row was *drawn* at first and passed the sabotage happily; a row that is
 *     drawn and inert is the same refusal wearing none of the words that would
 *     explain it, so it presses the row now. A question has no destination, so
 *     there is nothing for "open a note first" to protect.
 *  3. `setTalking(false)` removed from the meeting effect.
 *     → **1 fails**: `and the conversation does not come back when the meeting
 *     ends`, and — worth recording — `a meeting closes the conversation` keeps
 *     passing. That was the whole test at first, and it was checking nothing:
 *     the control renders `null` for the length of a meeting, so the panel
 *     goes whether or not the effect clears the flag. Only the *end* of the
 *     meeting separates them, and without the effect a finished recording
 *     reopens a conversation somebody left twenty minutes ago.
 *  4. `onAskAgent` passed unconditionally, so the row is drawn on a surface
 *     with no place behind it.
 *     → **1 fails**: `a surface with no context does not offer the row at
 *     all`. The first version of this diff drew the row there and let the
 *     press do nothing, which this file's own words call a refusal wearing
 *     none of the words that would explain it.
 */

const OWN: VoicePage = {
  context: { slug: "seyi", kind: "personal", role: "owner" },
  notePath: "1-projects/weekly-sync.md",
  writable: true,
  noteVisibility: "private",
};

/** A folder on screen: dictation is refused, a question is not. */
const NO_NOTE: VoicePage = {
  context: { slug: "seyi", kind: "personal", role: "owner" },
  notePath: null,
  writable: false,
};

const SECRET = "zarquon-plumbago-9471";

function placeFor(page: VoicePage, draft = `# Sync\n\n${SECRET}\n`) {
  return agentPage({
    context: page.context,
    editor: {
      ...emptyEditor,
      status: "clean",
      path: page.notePath,
      baseline: draft,
      draft,
      etag: 'W/"a1b2c3"',
      visibility: page.noteVisibility ?? "private",
    },
    route: consoleRoute(page.context),
    meetingLive: false,
    query: null,
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function render(element: ReactElement): void {
  act(() => root?.render(element));
}

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

function button(props: Partial<Parameters<typeof VoiceButton>[0]> = {}): ReactElement {
  return createElement(VoiceButton, {
    page: OWN,
    controls: () => null,
    compact: false,
    onRecordMeeting: () => {},
    place: placeFor(OWN),
    ...props,
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host, { onUncaughtError: () => {}, onCaughtError: () => {} });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  jest.restoreAllMocks();
});

describe("the row", () => {
  test("the sheet offers a third answer", () => {
    render(button());
    press("voice-button");

    expect(text()).toContain(DICTATE_TITLE);
    expect(text()).toContain(AGENT_TITLE);
  });

  test("the conversation is offered with no note open", () => {
    /*
      Dictation is refused here — there is no caret for words to land at — and
      the agent row is not, because a question has no destination. Somebody
      looking at a folder can perfectly well ask what is in it.
    */
    render(button({ page: NO_NOTE, place: placeFor(NO_NOTE) }));
    press("voice-button");
    expect(findByTestId("voice-sheet-refusal")).not.toBeNull();

    // Pressed, not merely present: a row that is drawn and inert is the same
    // refusal wearing none of the words that would explain it.
    press("voice-sheet-agent");
    expect(findByTestId("agent-panel")).not.toBeNull();
  });

  test("pressing it closes the sheet and opens the conversation", () => {
    render(button());
    press("voice-button");
    press("voice-sheet-agent");

    expect(findByTestId("voice-sheet")).toBeNull();
    expect(findByTestId("agent-panel")).not.toBeNull();
  });

  test("a surface with no context does not offer the row at all", () => {
    /*
      The fixtures and the landing page's demo console mount this pane with no
      workspace behind it. The row is absent rather than inert: there is no
      sentence to put under an inert one, because the surface is not part of
      the product rather than temporarily unable.
    */
    render(button({ place: null }));
    press("voice-button");

    expect(findByTestId("voice-sheet")).not.toBeNull();
    expect(findByTestId("voice-sheet-agent")).toBeNull();
    expect(findByTestId("agent-panel")).toBeNull();
  });
});

describe("composing with the one microphone", () => {
  test("the panel survives the bar coming back underneath it", () => {
    /*
      The phone sequence, driven as `NoteEditor` drives it: the keyboard is up
      so the floating control is drawn, the conversation opens, and the `Modal`
      takes the caret — which puts the accessory bar away and the frame's
      toolbar back, flipping `microphoneElsewhere` to true a frame later.
    */
    render(button({ compact: true, microphoneElsewhere: false }));
    press("voice-button");
    press("voice-sheet-agent");
    expect(findByTestId("agent-panel")).not.toBeNull();

    render(button({ compact: true, microphoneElsewhere: true }));

    expect(findByTestId("agent-panel")).not.toBeNull();
  });

  test("the button itself still stands down for the bottom row", () => {
    // The rule #700 established is untouched: nothing is drawn at rest.
    render(button({ compact: true, microphoneElsewhere: true }));

    expect(findByTestId("voice-button")).toBeNull();
    expect(findByTestId("agent-panel")).toBeNull();
  });

  test("a meeting closes the conversation", () => {
    render(button());
    press("voice-button");
    press("voice-sheet-agent");
    expect(findByTestId("agent-panel")).not.toBeNull();

    /*
      The meeting starts *after* the panel is open, which is the sequence that
      matters: the effect that closes it fires on the transition, not on the
      mount. Driven the way `voiceButton.test.ts` drives the same store.
    */
    const live = {
      session: { id: "mt_fake", state: "recording" },
    } as unknown as ReturnType<typeof meetings.getSnapshot>["live"];
    jest.spyOn(meetings, "getSnapshot").mockReturnValue({ ...meetings.getSnapshot(), live });
    render(button());

    expect(findByTestId("agent-panel")).toBeNull();
  });

  test("and the conversation does not come back when the meeting ends", () => {
    /*
      The half a `null` return cannot do on its own, and the reason
      `setTalking(false)` is in the meeting effect rather than left to the
      yield: while the meeting runs this control renders nothing, so the panel
      is gone either way. It is the *end* of the meeting that tells them apart.
      With `talking` still true, finishing a recording reopens a conversation
      somebody left twenty minutes ago, over whatever they are now looking at.
    */
    render(button());
    press("voice-button");
    press("voice-sheet-agent");
    expect(findByTestId("agent-panel")).not.toBeNull();

    const live = {
      session: { id: "mt_fake", state: "recording" },
    } as unknown as ReturnType<typeof meetings.getSnapshot>["live"];
    const snapshot = jest
      .spyOn(meetings, "getSnapshot")
      .mockReturnValue({ ...meetings.getSnapshot(), live });
    render(button());

    // The meeting finishes, and the corner is ours again.
    snapshot.mockReturnValue({ ...meetings.getSnapshot(), live: null });
    render(button());

    expect(findByTestId("voice-button")).not.toBeNull();
    expect(findByTestId("agent-panel")).toBeNull();
  });
});

describe("what the stub answers with", () => {
  test("it describes the room and carries no note text", async () => {
    /*
      The end-to-end version of `agentPage.test.ts`'s guarantee: the place
      reaches the seam intact — it names the note — and the note's body is not
      in it, even though the editor this was built from was holding the whole
      file.
    */
    const engine: AgentEngine = createStubEngine();
    const answer = await engine.ask({
      question: "what is this note about?",
      place: placeFor(OWN),
    });

    expect(answer).toContain("1-projects/weekly-sync.md");
    expect(answer).not.toContain(SECRET);
  });
});
