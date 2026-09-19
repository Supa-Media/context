/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number — the same trade
  `noteAccessory.test.ts` makes, and for the same reason: `useSafeAreaInsets`
  throws outside a `SafeAreaProvider`, and the insets are the platform's
  business rather than a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * THERE IS ONE MICROPHONE ON A PHONE, AND ONE BUTTON FOR IT.
 *
 * The complaint this file exists for is four words long — *"why are there 2
 * microphones?"* — over a screenshot of a note on a 390pt screen with the
 * floating microphone 24pt above the seventh key of the bottom row, both
 * wearing the same `mic` glyph and doing different things.
 *
 * `VoiceButton`'s own header already argued the rule and applied it to exactly
 * one case: *"there is a single microphone on this machine and the meeting has
 * it"*, so a running meeting takes the corner. The bottom row's key is the same
 * argument with nothing running — a control that opens a microphone, on the
 * glass, 24pt away.
 *
 * **Which one stands down is not a taste question and was not decided here.**
 * `docs/decisions/meetings.md` records the seventh key as the phone's only way
 * into meeting capture, and — after somebody recorded a meeting on their phone
 * and could not find it again — the only route to a *finished* meeting hangs off
 * the sheet that key raises. So the key is the phone's microphone, and the
 * floating one yields to it, exactly as it already yields to a recording.
 *
 * ## Why this is a test of `NoteEditor` and not of `VoiceButton`
 *
 * `voiceButton.test.ts` holds the component's half: given "something else
 * carries the microphone", it draws no button. That assertion passes just as
 * happily if nothing in the product ever passes `true` — which is precisely the
 * defect being fixed, one layer up. What the product has to get right is the
 * *condition*, and the condition has two halves that no unit test of either
 * component can see together: the toolbar exists at `compact`, and the keyboard
 * accessory bar takes it away again while somebody is typing. Both states are
 * driven here, through the real editor, the real `accessoryUp`, and the real
 * `VoiceButton`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `microphoneElsewhere` hard-coded to `false` at the mount site.
 *     → **2 fail**: `a phone with a note open draws one microphone, on the
 *     bottom row` — the bug exactly as reported — and the second half of `the
 *     keyboard takes the bottom row away, so the microphone comes back`, which
 *     is the same screen again once the keyboard has gone.
 *  2. `microphoneElsewhere` hard-coded to `true`.
 *     → **2 fail**: `the keyboard takes the bottom row away, so the microphone
 *     comes back` and `a pointer layout has no bottom row, so the floating one
 *     is it`. Dictation would be unreachable on a phone browser and on every
 *     desktop — the *other* way to have no microphone at all.
 *  3. The condition written as `compact` alone, dropping `!barUp`.
 *     → **1 fails**: `the keyboard takes the bottom row away, so the microphone
 *     comes back`. While the accessory bar is up the toolbar is hidden, so a
 *     phone being typed into would carry no microphone anywhere on the glass —
 *     and the two tests either side of it pass, which is what makes this the
 *     one worth writing down.
 */

/** The editor is stubbed, as in `noteAccessory.test.ts`; focus is what matters. */
interface MockEditorProps {
  value: string;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

let mockProps: MockEditorProps | null = null;

jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: MockEditorProps) => {
    mockProps = props;
    return null;
  },
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { VoiceHostProvider } =
  require("../features/voice/VoiceHost") as typeof import("../features/voice/VoiceHost");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;
type VoicePage = import("../features/voice/VoiceButton").VoicePage;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "1-projects/weekly-sync.md";
const FILE = ["# Weekly sync", "", "The first paragraph of the note itself.", ""].join("\n");

/** Wired as `(app)/console/_layout.tsx` wires it, for a note you own. */
const PAGE: VoicePage = {
  context: { slug: "seyi", kind: "personal", role: "owner" },
  notePath: PATH,
  writable: true,
  noteVisibility: "private",
};

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockProps = null;
});

beforeEach(() => {
  mockProps = null;
});

/**
 * The console's note pane at a given width, with the voice host the real
 * layout provides.
 *
 * react-native-web measures `document.documentElement.clientWidth`, which jsdom
 * reports as 0 — so without the stub every density reads as `compact` by
 * accident and the pointer case below would pass for the wrong reason.
 */
function mountNote(width: number, createButton = true) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const state: EditorState = {
    ...emptyEditor,
    status: "clean",
    path: PATH,
    baseline: FILE,
    draft: FILE,
  };

  act(() => {
    root.render(
      createElement(VoiceHostProvider, {
        value: { page: PAGE, onRecordMeeting: () => {}, createButton },
        children: createElement(NoteEditor, {
          state,
          canEdit: true,
          onChange: () => {},
          onSave: jest.fn() as () => void,
          onDiscard: jest.fn() as () => void,
          onUseTheirs: jest.fn() as () => void,
          onKeepMine: jest.fn() as () => void,
        }),
      }),
    );
  });

  /*
    `document`, not the container: the sheet is a `Modal`, which react-native-web
    portals out of the mount point. The button itself is in the container, but
    one query that finds both is what makes "how many microphones are on this
    screen" a question this file can ask.
  */
  const find = (testId: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  return {
    find,
    accessory: () => find("note-accessory"),
    focus: () => act(() => mockProps?.onFocus?.()),
    blur: () => act(() => mockProps?.onBlur?.()),
  };
}

describe("the phone", () => {
  test("a phone with a note open draws one microphone, on the bottom row", () => {
    const app = mountNote(390);

    // The keyboard is down, so the frame's toolbar — and its seventh key — is
    // the microphone on this screen. This pane draws none.
    expect(app.accessory()).toBeNull();
    expect(app.find("voice-button")).toBeNull();
  });

  test("the keyboard takes the bottom row away, so the microphone comes back", () => {
    /*
      Dictation types at the caret, so the state in which somebody wants it is
      the state in which they are in the note with the keyboard up — which is
      exactly the state `AppFrame` hides the toolbar in (`toolbarHidden`). The
      microphone is therefore not merely restored here, it is offered at the one
      moment it has somewhere to type.
    */
    const app = mountNote(390);
    app.focus();

    expect(app.accessory()).not.toBeNull();
    expect(app.find("voice-button")).not.toBeNull();

    // And put away again with the keyboard, rather than joining the key.
    app.blur();
    expect(app.accessory()).toBeNull();
    expect(app.find("voice-button")).toBeNull();
  });
});

describe("a pointer layout", () => {
  test("the corner is the + now, so the editor draws no microphone at rest", () => {
    /*
      THE RULE THIS FILE HOLDS, ARRIVING AT THE OTHER DENSITY.

      It used to read "a pointer layout has no bottom row, so the floating one
      is it", and that was true while nothing else was in the corner. The
      console mounts a `+` there now — `features/console/CreateButton.tsx`, and
      the owner's words for why: *"we need to get rid of the microphone button
      bottom right and instead it should be a + button"* — so the same rule as
      the phone's applies for a different control. One corner, one control.

      Dictation did not lose its door with the glyph: "Dictate here" is on the
      note's own context menu, where there is a caret to type into, and
      `editorVoiceMenu.test.ts` drives it from there through this same
      component.
    */
    const app = mountNote(1280);
    expect(app.accessory()).toBeNull();
    expect(app.find("voice-button")).toBeNull();
  });

  test("...and a pointer surface with no + keeps it, because nothing replaced it", () => {
    /*
      The E2E fixture and the landing page's demo console: desktop-width
      consoles that render `BrowsePane` with no layout around them, so no `+`
      is drawn in that corner. Taking the microphone away from them on a rule
      keyed off the width would delete dictation from the one surface
      `e2e/webkit/voice.spec.ts` drives it on — which is why the host publishes
      the fact rather than the editor deriving it.
    */
    const app = mountNote(1280, false);
    expect(app.find("voice-button")).not.toBeNull();
  });
});
