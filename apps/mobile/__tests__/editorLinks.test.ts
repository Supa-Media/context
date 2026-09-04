/**
 * @jest-environment jsdom
 */

/**
 * FOLLOWING A LINK, AGAINST A REAL EDITOR.
 *
 * `noteLinks.test.ts` proves which text becomes a link. This proves the part
 * that cannot be proved without mounting one: that a ⌘-click on it navigates,
 * that a plain click still puts the caret where somebody aimed, and that a long
 * press is told apart from a tap and from a scroll.
 *
 * Every one of those is a *gesture*, and a gesture is exactly the kind of thing
 * a pure test asserts about a description of rather than about the behaviour.
 * The failure that made this file worth writing is the second one: an
 * implementation that follows a plain click reads as working — links open! —
 * and has quietly made the editor impossible to edit inside a link, which is
 * where a typo in a path lives.
 *
 * ## What jsdom can and cannot do here
 *
 * It lays nothing out, so `posAtCoords` cannot be driven by real coordinates.
 * The tests below therefore dispatch events at coordinates jsdom resolves to
 * position 0 and assert on the *decision* the extension made — which link it
 * found and whether it acted — rather than on pixels. The one thing that would
 * make that a false green is a document whose position 0 is not inside a link,
 * so each fixture starts with one.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests across
 * this file and `noteLinks.test.ts`.
 *
 *   the modifier check dropped, so a plain click follows a link      1
 *   the slop check dropped, so a scroll becomes a press              1
 *   a press navigating instead of asking                             1
 *   the span narrowed to the target, dropping the brackets           2
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  LONG_PRESS_MS,
  PRESS_CANCEL_FLOOR_MS,
  noteLinks,
  type NoteLinkContext,
} from "../features/console/files/noteLinks";

const NOTE = "1-projects/persistence/overview.md";
const TARGET = "2-products/context-lc/overview.md";
const DOC = "[[../../2-products/context-lc/overview]] trailing words";

interface Mounted {
  view: EditorView;
  opened: string[];
  pressed: string[];
  content: HTMLElement;
  destroy: () => void;
}

function mount(): Mounted {
  const opened: string[] = [];
  const pressed: string[] = [];
  const ref = {
    current: {
      path: NOTE,
      paths: [NOTE, TARGET],
      onOpen: (path: string) => opened.push(path),
      onPress: (path: string) => pressed.push(path),
    } satisfies NoteLinkContext,
  };

  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [noteLinks(ref)] }),
    parent,
  });

  return {
    view,
    opened,
    pressed,
    content: view.contentDOM,
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  jest.useRealTimers();
});

/** A mouse event jsdom will resolve inside the first line. */
function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1, clientY: 1, ...init });
}

/**
 * A touch event jsdom does not construct on its own.
 *
 * `TouchEvent` is not implemented there, so this is a plain `Event` with the
 * touch lists bolted on. That is honest about what is being tested — the
 * handler's own logic — and stays honest because the handler reads nothing off
 * an event but `touches`.
 */
function touch(type: string, points: { clientX: number; clientY: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  // All three lists, because CodeMirror's own touch observers run first and
  // read `changedTouches`; a fixture carrying only what *our* handler reads
  // takes the whole editor down before reaching it.
  for (const key of ["touches", "targetTouches", "changedTouches"]) {
    Object.defineProperty(event, key, { value: points });
  }
  return event;
}

describe("a link is followed with the modifier and not without it", () => {
  test("⌘-click opens the note the link names", () => {
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown", { metaKey: true }));
    expect(mounted.opened).toEqual([TARGET]);
  });

  test("Ctrl-click does too, for everywhere that is not a Mac", () => {
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown", { ctrlKey: true }));
    expect(mounted.opened).toEqual([TARGET]);
  });

  test("a plain click opens nothing", () => {
    /*
      The one that matters. This is an editor, and the text under the pointer is
      text somebody may be about to fix — a mistyped path lives *inside* a link.
      An implementation that followed a plain click would read as working and
      would have made those characters unreachable.
    */
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown"));
    expect(mounted.opened).toEqual([]);
  });

  test("and the modified click is claimed, so the browser does nothing else with it", () => {
    // Not politeness: an unclaimed ⌘-click also moves the caret, and on macOS a
    // Ctrl-click raises the context menu over the note.
    mounted = mount();
    const event = mouse("mousedown", { metaKey: true });
    mounted.content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a modified click on text that is not a link is left alone", () => {
    mounted = mount();
    mounted.view.dispatch({
      changes: { from: 0, to: mounted.view.state.doc.length, insert: "plain words" },
    });
    mounted.content.dispatchEvent(mouse("mousedown", { metaKey: true }));
    /*
      Only that nothing was followed. `defaultPrevented` is deliberately not
      asserted here: CodeMirror's own mousedown handling claims the event for
      its selection logic, so the flag says nothing about whether *this*
      extension acted. The assertion above is the one that can only be true for
      the right reason.
    */
    expect(mounted.opened).toEqual([]);
  });
});

describe("a long press asks, and a tap and a scroll do not", () => {
  test("holding still for long enough is a press", () => {
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(mounted.pressed).toEqual([TARGET]);
    // It asks; it does not navigate. The host puts a confirmation up.
    expect(mounted.opened).toEqual([]);
  });

  test("letting go first is a tap", () => {
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(LONG_PRESS_MS - 50);
    mounted.content.dispatchEvent(touch("touchend", []));
    jest.advanceTimersByTime(500);
    expect(mounted.pressed).toEqual([]);
  });

  test("drifting past the slop is a scroll", () => {
    /*
      A note is a scroller and most of them have links in them, so a press that
      survived a drag would fire on an ordinary flick down the page — the
      gesture people make most.
    */
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchmove", [{ clientX: 1, clientY: 60 }]));
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(mounted.pressed).toEqual([]);
  });

  test("a small wobble is still a press", () => {
    // A thumb held on a phone rolls a few pixels. A zero-tolerance rule would
    // make the gesture impossible to perform rather than hard.
    jest.useFakeTimers();
    mounted = mount();
    // The same origin every other touch test uses: jsdom resolves only that
    // coordinate to a position, so a different one would test the "found no
    // link" branch while claiming to test the slop.
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchmove", [{ clientX: 4, clientY: 3 }]));
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(mounted.pressed).toEqual([TARGET]);
  });

  test("a second finger cancels, rather than starting a second press", () => {
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(
      touch("touchstart", [{ clientX: 1, clientY: 1 }, { clientX: 40, clientY: 40 }]),
    );
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(mounted.pressed).toEqual([]);
  });

  test("a touch never claims the event, so the note still scrolls", () => {
    // Claiming it would break scrolling over any note with a link in it, which
    // is most of them.
    jest.useFakeTimers();
    mounted = mount();
    const event = touch("touchstart", [{ clientX: 1, clientY: 1 }]);
    mounted.content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("an editor destroyed mid-press does not fire into nothing", () => {
    jest.useFakeTimers();
    mounted = mount();
    const held = mounted;
    held.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    held.destroy();
    mounted = null;
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    // The callback is the app's and outlives the view; what must not happen is
    // a navigation somebody did not ask for after leaving the note.
    expect(held.pressed).toEqual([TARGET]);
  });
});

describe("the platform's own long press is the same press", () => {
  /**
   * **Reported from a phone: long pressing a link does nothing.**
   *
   * Driven as real touch events in a real browser, the timer above works. On
   * iOS it fired approximately never, and the reason is that the page is not
   * the only thing watching the finger: WebKit's own long-press recogniser —
   * the one that raises the selection magnifier over editable text — claims a
   * stationary touch and tells the page by sending `touchcancel`. The handler
   * treated that as "give up", so the gesture was cancelled by the very thing
   * that had recognised it.
   *
   * Reproduced before it was fixed, by dispatching the sequence WebKit
   * dispatches — `touchstart`, then `touchcancel` at 300ms with the finger
   * still on the link — against the built extension in headless Chromium under
   * touch emulation: no press. The same sequence here.
   */
  test("a cancel over a finger that has not moved still becomes a press", () => {
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(300);
    mounted.content.dispatchEvent(touch("touchcancel", []));
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(mounted.pressed).toEqual([TARGET]);
  });

  test("but one that arrives before the gesture was anything is dropped", () => {
    /*
      The control on the rule above, and the reason it is a floor rather than
      "never cancel": a call arriving twenty milliseconds after a finger lands
      is an interruption, and turning every interruption into a dialog about a
      link somebody happened to touch is its own bug.
    */
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(PRESS_CANCEL_FLOOR_MS - 50);
    mounted.content.dispatchEvent(touch("touchcancel", []));
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(mounted.pressed).toEqual([]);
  });

  test("a drifting touch that is then cancelled is still a scroll", () => {
    // Cancelling is not a second chance for a gesture already ruled out.
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchmove", [{ clientX: 1, clientY: 60 }]));
    jest.advanceTimersByTime(300);
    mounted.content.dispatchEvent(touch("touchcancel", []));
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(mounted.pressed).toEqual([]);
  });

  test("`contextmenu` during a touch is the platform reporting the press", () => {
    // The second signal: some browsers announce the long press rather than
    // silently taking it. Both are the same gesture and both reach the host.
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(300);
    const event = mouse("contextmenu");
    mounted.content.dispatchEvent(event);
    expect(mounted.pressed).toEqual([TARGET]);
    // The system menu would otherwise come up over the dialog.
    expect(event.defaultPrevented).toBe(true);
  });

  test("a right-click with no touch behind it keeps the browser's menu", () => {
    /*
      The control that decides the shape of the rule. `contextmenu` is also a
      right-click on a pointer device, and answering that with "open this
      note?" would take the browser's menu away from every note on a desktop.
      The handler reads whether one of *our* touch gestures is live, not the
      event.
    */
    jest.useFakeTimers();
    mounted = mount();
    const event = mouse("contextmenu");
    mounted.content.dispatchEvent(event);
    expect(mounted.pressed).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test("both signals for one gesture ask once", () => {
    // Two dialogs for one press is the failure this pair invites.
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(300);
    mounted.content.dispatchEvent(mouse("contextmenu"));
    jest.advanceTimersByTime(LONG_PRESS_MS);
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.pressed).toEqual([TARGET]);
  });

  test("and a second gesture can still press", () => {
    // The control on the deduplication: a flag that never reset would make the
    // feature work exactly once per note.
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    mounted.content.dispatchEvent(touch("touchend", []));
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(mounted.pressed).toEqual([TARGET, TARGET]);
  });
});

describe("the link is drawn as one", () => {
  test("a decoration marks the link and nothing else", () => {
    mounted = mount();
    const marks = mounted.content.querySelectorAll(".cm-note-link");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe("[[../../2-products/context-lc/overview]]");
  });

  test("text with no link in it gets no decoration", () => {
    mounted = mount();
    mounted.view.dispatch({
      changes: { from: 0, to: mounted.view.state.doc.length, insert: "no links here at all" },
    });
    expect(mounted.content.querySelectorAll(".cm-note-link")).toHaveLength(0);
  });
});
