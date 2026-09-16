/**
 * @jest-environment jsdom
 */

/**
 * THE JOIN: ESCAPE AT A TREE ROW REACHES THE FIND BAR IN THE NOTE.
 *
 * Two halves of this already have tests, and neither of them is the bug.
 * `appFrameRender.test.ts` proves the frame runs a registered closer and
 * answers honestly; `liveEditorMount.test.ts` proves the editor hands out a
 * `closeFind` that closes a real bar. What was reported — ⌘F opens something
 * Escape cannot close once focus has left the editor — lives exactly in
 * between: the editor's handle has to be *in* the frame's overlay stack, for
 * as long as the note is mounted and not a moment longer.
 *
 * So `LiveEditor` is stubbed, the way `noteEditorReadOnly.test.ts` stubs it:
 * what is under test is the wiring `NoteEditor` does with the handle, not
 * CodeMirror's DOM, which the editor's own suite already mounts for real.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * What the stub hands back, and what the console's Escape ends up calling.
 *
 * `mock`-prefixed so `jest.mock`'s hoisted factory may close over it, the same
 * arrangement `appFrameRender.test.ts` uses for the safe-area insets.
 */
const mockEditor = { closeFind: jest.fn(() => false) };

interface StubProps {
  controls?: (api: unknown) => void;
}

jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: StubProps) => {
    props.controls?.({
      wrap: () => {},
      toggleLinePrefix: () => {},
      insertLink: () => {},
      undo: () => {},
      redo: () => {},
      blur: () => {},
      closeFind: mockEditor.closeFind,
    });
    return null;
  },
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { AppFrame, useFrame } =
  require("../features/app/AppFrame") as typeof import("../features/app/AppFrame");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "1-projects/gateway.md";
const FILE = ["# Gateway", "", "The bucket is the boundary."].join("\n");

function stateFor(): EditorState {
  return { ...emptyEditor, status: "clean", path: PATH, baseline: FILE, draft: FILE };
}

const answers: boolean[] = [];
const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockEditor.closeFind.mockClear();
  mockEditor.closeFind.mockImplementation(() => false);
  answers.length = 0;
});

/**
 * Escape, as the console presses it.
 *
 * `console/_layout.tsx`'s `dismiss` case is one line — `frame.closeOverlays()`
 * — and `useKeymap` turns the boolean into whether the browser still sees the
 * key. Pressing it through the frame's own API is what that file does.
 */
function EscapeProbe() {
  const frame = useFrame();
  return createElement(
    "button",
    { "data-testid": "escape", onClick: () => answers.push(frame.closeOverlays()) },
    "escape",
  );
}

/**
 * The console, with one note open in it and a way to close that note.
 *
 * The close is a real unmount rather than a fresh render with different props,
 * because that is what a tab close is and what the registration's cleanup has
 * to survive.
 */
function Host() {
  const [open, setOpen] = useState(true);
  return createElement(
    "span",
    null,
    open
      ? createElement(NoteEditor, {
          state: stateFor(),
          canEdit: true,
          onChange: () => {},
          onSave: () => {},
          onDiscard: () => {},
          onUseTheirs: () => {},
          onKeepMine: () => {},
        })
      : null,
    createElement(EscapeProbe),
    createElement(
      "button",
      { "data-testid": "close-note", onClick: () => setOpen(false) },
      "close the tab",
    ),
  );
}

interface Mounted {
  /** Escape, pressed with focus anywhere in the console. */
  escape: () => void;
  /** ⌘W, more or less: the note goes away. */
  closeNote: () => void;
}

function mount(): Mounted {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1280,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(AppFrame, {
        switcher: null,
        rail: () => null,
        status: null,
        onSearch: () => {},
        children: createElement(Host),
      }),
    );
  });

  const press = (testId: string) => {
    const button = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId}`);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  return { escape: () => press("escape"), closeNote: () => press("close-note") };
}

describe("the note's find bar is in Escape's reach", () => {
  test("Escape from anywhere in the console asks the editor to close it", () => {
    mockEditor.closeFind.mockImplementation(() => true);
    const app = mount();

    app.escape();

    expect(mockEditor.closeFind).toHaveBeenCalledTimes(1);
    // And the frame passes the editor's own answer back out, which is what
    // makes `dismiss` call `preventDefault` for this press and not for one
    // with nothing open.
    expect(answers).toEqual([true]);
  });

  test("with no bar open the press answers false, and the browser keeps its Escape", () => {
    const app = mount();

    app.escape();

    expect(mockEditor.closeFind).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([false]);
  });

  /**
   * A note is unmounted on every tab close and every context switch. A closer
   * the frame kept would answer for an editor that is gone — and, on the app's
   * most frequent unmount, accumulate one per note opened for the life of the
   * session.
   */
  test("closing the note takes its closer out of the stack", () => {
    mockEditor.closeFind.mockImplementation(() => true);
    const app = mount();

    app.closeNote();
    app.escape();

    expect(mockEditor.closeFind).not.toHaveBeenCalled();
    expect(answers).toEqual([false]);
  });
});
