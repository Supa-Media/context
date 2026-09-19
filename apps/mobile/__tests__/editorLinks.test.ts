/**
 * @jest-environment jsdom
 */

/**
 * FOLLOWING A LINK, AGAINST A REAL EDITOR.
 *
 * `noteLinks.test.ts` proves which text becomes a link. This proves the part
 * that cannot be proved without mounting one: that a **plain click** on it
 * navigates, that the two gestures meaning "I am editing this link" still put
 * the caret where somebody aimed, and that a tap is told apart from a long
 * press and from a scroll.
 *
 * ## What this file used to assert, and why it is the reverse now
 *
 * It used to require that a plain click open nothing, and called that "the one
 * that matters": this is an editor, a mistyped path lives *inside* a link, and
 * an implementation that followed a plain click would read as working while
 * making those characters unreachable.
 *
 * The premise was right and the conclusion was wrong. What made a modifier
 * necessary was the belief that a click is the *only* way to reach a link's
 * text — and it is not. ⌥-click reaches it, and so does clicking a link that
 * is already showing its source. Both are tested below, and they are what buys
 * the plain click: the gesture everybody already has follows the link, and the
 * two that mean "edit" are unambiguous rather than merely unmodified.
 *
 * ## What jsdom can and cannot do here
 *
 * It lays nothing out, so `posAtCoords` cannot be driven by real coordinates.
 * The tests below therefore dispatch events at coordinates jsdom resolves to
 * position 0 and assert on the *decision* the extension made — which link it
 * found, whether it acted, and how — rather than on pixels. The one thing that
 * would make that a false green is a document whose position 0 is not inside a
 * link, so each fixture starts with one.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests across
 * this file and `noteLinks.test.ts`.
 *
 *   the ⌥ check dropped, so editing a path navigates instead        2
 *   the `editing` check dropped, so a caret inside a link is lost   1
 *   `hasFocus` dropped, so a note opening on a link eats its click  1
 *   the mode always `foreground`, so ⌘-click moves you              2
 *   Ctrl honoured on an Apple keyboard, taking the context menu     1
 *   the tap's slop check dropped, so a scroll navigates             1
 *   the tap's ceiling dropped, so a long press navigates            1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  TAP_MAX_MS,
  noteLinks,
  type NoteLinkContext,
  type NoteLinkOpen,
} from "../features/console/files/noteLinks";

const NOTE = "1-projects/persistence/overview.md";
const TARGET = "2-products/context-lc/overview.md";
const DOC = "[[../../2-products/context-lc/overview]] trailing words";
/** Past the link, and past the space after it. */
const OUTSIDE = DOC.length - 3;

interface Opened {
  path: string;
  mode: NoteLinkOpen;
}

interface Mounted {
  view: EditorView;
  opened: Opened[];
  paths: () => string[];
  content: HTMLElement;
  destroy: () => void;
}

/**
 * A mounted editor over `DOC`.
 *
 * `caretAt` puts a caret in the document the way a person does, because two of
 * the rules below are about what happens when there is one. jsdom will not
 * focus a `contenteditable` on its own, so focusing it here is the only honest
 * way to reach the state a click-then-click produces.
 */
function mount(options: { caretAt?: number } = {}): Mounted {
  const opened: Opened[] = [];
  const ref = {
    current: {
      path: NOTE,
      paths: [NOTE, TARGET],
      onOpen: (path: string, mode: NoteLinkOpen) => opened.push({ path, mode }),
    } satisfies NoteLinkContext,
  };

  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [noteLinks(ref)] }),
    parent,
  });
  if (options.caretAt !== undefined) {
    view.contentDOM.focus();
    view.dispatch({ selection: { anchor: options.caretAt } });
  }

  return {
    view,
    opened,
    paths: () => opened.map((entry) => entry.path),
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
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 1,
    clientY: 1,
    button: 0,
    ...init,
  });
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

describe("one click follows the link", () => {
  test("a plain click opens the note the link names, and goes to it", () => {
    /*
      THE ONE THAT MATTERS, and it is the inverse of what this file used to
      require. The owner's words: "I should be able to go to a link just by
      clicking it once, similar to Obsidian, shouldnt have to command click".
    */
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown"));
    expect(mounted.opened).toEqual([{ path: TARGET, mode: "foreground" }]);
  });

  test("and the click is claimed, so the caret does not move into the link", () => {
    // Not politeness: an unclaimed click also places the caret, so the note
    // you have just left would take a caret on its way out.
    mounted = mount();
    const event = mouse("mousedown");
    mounted.content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a click on text that is not a link is left alone", () => {
    mounted = mount();
    mounted.view.dispatch({
      changes: { from: 0, to: mounted.view.state.doc.length, insert: "plain words" },
    });
    mounted.content.dispatchEvent(mouse("mousedown"));
    /*
      Only that nothing was followed. `defaultPrevented` is deliberately not
      asserted here: CodeMirror's own mousedown handling claims the event for
      its selection logic, so the flag says nothing about whether *this*
      extension acted. The assertion above is the one that can only be true for
      the right reason.
    */
    expect(mounted.opened).toEqual([]);
  });

  test("the secondary button is the context menu's, not this extension's", () => {
    // `rightClick.web.ts` draws the note's own menu over a link like any other
    // text. Claiming button 2 here would delete that menu over every link.
    mounted = mount();
    const event = mouse("mousedown", { button: 2 });
    mounted.content.dispatchEvent(event);
    expect(mounted.opened).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("⌘-click and middle-click open it behind", () => {
  /**
   * jsdom's user agent is not an Apple one, so `Ctrl` is this environment's
   * "open behind" modifier and `⌘` is not. That is the rule under test rather
   * than a quirk being worked around — see `opensBehind` in `noteLinks.ts` and
   * the keyboard cases in `noteLinks.test.ts`, which drive it directly against
   * all three agents.
   */
  test("Ctrl-click opens the note without moving anybody", () => {
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown", { ctrlKey: true }));
    expect(mounted.opened).toEqual([{ path: TARGET, mode: "background" }]);
  });

  test("the middle button does the same", () => {
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown", { button: 1 }));
    expect(mounted.opened).toEqual([{ path: TARGET, mode: "background" }]);
  });

  test("and both are claimed, so no caret moves and nothing is pasted", () => {
    // X11 pastes the primary selection on a middle click. Over a link that
    // would be an edit nobody asked for, in a note they were not even reading.
    mounted = mount();
    const event = mouse("mousedown", { button: 1 });
    mounted.content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("the two ways to edit a link instead of following it", () => {
  test("⌥-click never navigates — it belongs to the caret", () => {
    /*
      The deliberate "I am editing this path" gesture, and the whole of what
      buys the plain click above. Without it, the characters inside a link are
      unreachable, which is the argument that used to require a modifier to
      *follow* rather than one to edit.
    */
    mounted = mount();
    const event = mouse("mousedown", { altKey: true });
    mounted.content.dispatchEvent(event);
    expect(mounted.opened).toEqual([]);
  });

  test("⌥ wins over the background modifier too, rather than racing it", () => {
    mounted = mount();
    mounted.content.dispatchEvent(mouse("mousedown", { altKey: true, ctrlKey: true }));
    expect(mounted.opened).toEqual([]);
  });

  test("a click on a link that already holds the caret places the caret", () => {
    /*
      The second way in, and the one nobody has to be told about: live preview
      unfolds the link the selection touches, so what is under the pointer is
      `[[…]]` source rather than a rendered link — and clicking source puts a
      caret in it, as clicking any other text does. So fixing a path is
      click, then click, which is what somebody would try anyway.
    */
    mounted = mount({ caretAt: 4 });
    mounted.content.dispatchEvent(mouse("mousedown"));
    expect(mounted.opened).toEqual([]);
  });

  test("a tap on a link that already holds the caret places the caret too", () => {
    /*
      A touch screen has no ⌥, so this is the *only* one of the two escape
      hatches it has. Without it the characters inside a link are unreachable
      on a phone — which is exactly the objection the old ⌘-click rule was
      built around, surviving on one platform.
    */
    mounted = mount({ caretAt: 4 });
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.opened).toEqual([]);
  });

  test("but a caret elsewhere in the note does not make the link inert", () => {
    // The control on the rule above. A note being typed into has a caret
    // somewhere at all times; if any caret counted, links would stop working
    // the moment somebody started writing.
    mounted = mount({ caretAt: OUTSIDE });
    mounted.content.dispatchEvent(mouse("mousedown"));
    expect(mounted.opened).toEqual([{ path: TARGET, mode: "foreground" }]);
  });

  test("a note that OPENS on a link still follows the first click", () => {
    /*
      `hasFocus` is what makes this true, and without it this is the bug the
      rule above would have shipped: an editor nobody has clicked into still
      has a selection, at position 0 — so a note whose first characters are a
      link would count as "the caret is in it" before anybody touched it, and
      the first click on the first link would do nothing at all.

      `mount()` with no caret is exactly that state: `DOC` starts with the
      link and the view is unfocused.
    */
    mounted = mount();
    expect(mounted.view.hasFocus).toBe(false);
    mounted.content.dispatchEvent(mouse("mousedown"));
    expect(mounted.paths()).toEqual([TARGET]);
  });
});

describe("a tap follows, and a long press and a scroll do not", () => {
  test("touch down and up on a link is a tap", () => {
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(80);
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.opened).toEqual([{ path: TARGET, mode: "foreground" }]);
  });

  test("the tap claims its `touchend`, so no caret lands in the note being left", () => {
    // The synthetic click a browser sends after a touch would otherwise reach
    // the arriving note, which has scrolled to wherever the finger was.
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    const end = touch("touchend", []);
    mounted.content.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);
  });

  test("holding past the ceiling is a long press, and a long press is a selection", () => {
    /*
      **This replaced the feature, rather than merely bounding it.** A long
      press used to be how a link was followed on a phone, behind a
      confirmation dialog — because a press is also how a selection starts, so
      acting on one would have thrown away the note being edited on an
      ambiguous gesture. A tap is not ambiguous, so the dialog and the whole
      `touchcancel`/`contextmenu` reading of WebKit's recogniser are gone, and
      a long press belongs to the platform again.
    */
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    jest.advanceTimersByTime(TAP_MAX_MS + 50);
    const end = touch("touchend", []);
    mounted.content.dispatchEvent(end);
    expect(mounted.opened).toEqual([]);
    // And it is not claimed, so the selection the platform started survives.
    expect(end.defaultPrevented).toBe(false);
  });

  test("drifting past the slop is a scroll", () => {
    /*
      A note is a scroller and most of them have links in them, so a tap that
      survived a drag would fire on an ordinary flick down the page — the
      gesture people make most.
    */
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchmove", [{ clientX: 1, clientY: 60 }]));
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.opened).toEqual([]);
  });

  test("a small wobble is still a tap", () => {
    // A thumb rolls a few pixels on the way down. A zero-tolerance rule would
    // make the gesture impossible to perform rather than hard.
    jest.useFakeTimers();
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchmove", [{ clientX: 4, clientY: 3 }]));
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.paths()).toEqual([TARGET]);
  });

  test("a second finger cancels, rather than starting a second tap", () => {
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(
      touch("touchstart", [{ clientX: 1, clientY: 1 }, { clientX: 40, clientY: 40 }]),
    );
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.opened).toEqual([]);
  });

  test("a touch never claims its `touchstart`, so the note still scrolls", () => {
    // Claiming it would break scrolling over any note with a link in it, which
    // is most of them.
    mounted = mount();
    const event = touch("touchstart", [{ clientX: 1, clientY: 1 }]);
    mounted.content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("a cancelled touch is not a tap, however still the finger was", () => {
    /*
      An ordinary give-up, which it could not be while a long press lived here:
      a cancel over a stationary finger was iOS *recognising* that gesture, so
      the handler had to keep a timer running through it and tell a
      recogniser's interruption from a phone call's. Nothing now reads a
      cancel as anything but a touch that stopped being one.
    */
    mounted = mount();
    mounted.content.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.content.dispatchEvent(touch("touchcancel", []));
    mounted.content.dispatchEvent(touch("touchend", []));
    expect(mounted.opened).toEqual([]);
  });

  test("a right-click keeps the browser's menu, with no touch anywhere near it", () => {
    /*
      `contextmenu` used to be handled here as "the platform reporting a long
      press", and the handler had to check whether one of our own touch
      gestures was live so a desktop right-click kept its menu. No handler
      remains; this is the test that the removal is complete.
    */
    mounted = mount();
    const event = mouse("contextmenu");
    mounted.content.dispatchEvent(event);
    expect(mounted.opened).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
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

  /**
   * L3 (`docs/decisions/app-and-console.md` and the editor-polish sweep): a
   * touch screen has no hover and no modifier, so the tooltip that told a
   * pointer user "⌘-click to open" told a phone nothing at all. The one
   * affordance that reaches every input device is the mark itself actually
   * *looking* clickable — and the class existing is not that: F5→F6→F7's own
   * lesson is that a control has to be **drawn**, not merely present in the
   * DOM under a name. The test above only ever checked the name.
   *
   * `.cm-note-link`'s underline (`linkTheme` in `noteLinks.ts`) carries no
   * density condition — no media query, no prop — so it is already exactly
   * the "always-visible underline" the sweep's recommendation asks for rather
   * than a heavier accessory-bar target. This is the test that was missing:
   * it reads the *computed* style CodeMirror's `EditorView.theme` actually
   * injected, not the class name, so a change that renamed the class or
   * dropped the CSS rule while leaving the decoration in place would still be
   * caught.
   */
  test("the affordance is actually drawn, not merely named — density-independent", () => {
    mounted = mount();
    const mark = mounted.content.querySelector(".cm-note-link");
    expect(mark).not.toBeNull();
    const style = getComputedStyle(mark as Element);
    expect(style.textDecorationLine || style.textDecoration).toContain("underline");
    expect(style.cursor).toBe("pointer");
    // No compact/pointer branch exists in `linkTheme` at all, which is what
    // makes this the phone's affordance too rather than a desktop-only one.
    // Asserted on the theme's own CSS text so a density conditional added
    // later would fail this rather than pass it silently.
    const sheets = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText);
      } catch {
        return [];
      }
    });
    const rule = sheets.find((text) => text.includes(".cm-note-link") && text.includes("underline"));
    expect(rule).toBeDefined();
    expect(rule).not.toMatch(/@media/);
  });

  test("the system's own long-press callout is no longer suppressed over a link", () => {
    /*
      It was off here because long press *was* this feature's gesture and the
      callout was the other thing answering to it. A link is now the one piece
      of text in the note with no reason left to behave differently from the
      rest of it, so `-webkit-touch-callout: none` has to be gone rather than
      merely unused.
    */
    mounted = mount();
    const sheets = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText);
      } catch {
        return [];
      }
    });
    const rule = sheets.find((text) => text.includes(".cm-note-link") && text.includes("underline"));
    expect(rule).toBeDefined();
    expect(rule).not.toMatch(/touch-callout/i);
  });
});
