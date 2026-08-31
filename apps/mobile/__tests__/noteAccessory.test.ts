/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number.

  Every screen now clears them through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero. Mocking the hook is the same trade
  `appFrameRender.test.ts` makes: the insets are the platform's business, and a
  provider here would be a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * THE KEYBOARD ACCESSORY BAR.
 *
 * The complaint it answers is one sentence long: on a phone, with a note open,
 * "it is also impossible to dismiss the keyboard". The keyboard covers the
 * bottom bar, so while it is up the app has no controls at all — including no
 * way to put it away. Obsidian's answer is a row of keys riding above the
 * keyboard with a dismiss key on the end of it, and this is ours.
 *
 * Two kinds of thing are pinned here, and only one of them is about pixels.
 *
 * **When the bar exists at all.** Three conditions, each of which is a real bug
 * if it inverts: a desktop showing a floating toolbar it has chords for, a bar
 * of write commands over a note the viewer may not write, and a bar hanging
 * over a keyboard that is not up.
 *
 * **What a key actually does to the file**, which is the one that would cost
 * somebody their data. On a phone `NoteEditor` hands the editor the note's
 * *body* and re-attaches the frontmatter in front of every edit before it
 * reaches `onChange`. The accessory bar's keys are the editor's own commands
 * precisely so they travel that same path — press bold and what leaves the
 * component has to be the whole file again. A bar that wrote to the buffer by
 * any other route would silently drop the YAML block of every captured note the
 * first time somebody bolded a word on their phone, with nothing on screen to
 * say so. That is the assertion this file exists for.
 */

/**
 * The editor is stubbed, and — as in `noteProperties.test.ts` — that is the
 * point rather than a shortcut past it.
 *
 * What is under test is a contract between three components: the bar calls a
 * command, the editor turns it into text, and `NoteEditor` puts the frontmatter
 * back. Driving the real editor means typing into CodeMirror's contenteditable
 * under jsdom, which tests CodeMirror's DOM handling far more than it tests any
 * of that — and `liveEditorMount.test.ts` already owns CodeMirror.
 *
 * So the stub is a *real* implementation of `EditorControls` over the value it
 * was handed: `wrap` and `toggleLinePrefix` do the string surgery the native
 * half does and send the result back through the real `onChange` the component
 * built. Undo, redo and blur are counted, because on the two real platforms
 * they are the platform's business and there is nothing here to assert about
 * them beyond "the press reached the editor".
 *
 * Everything the factory touches is `mock`-prefixed: `jest.mock` is hoisted
 * above these declarations, and Jest only permits a factory to reach
 * out-of-scope names under that convention.
 */
type MockControls = {
  wrap(before: string, after: string): void;
  toggleLinePrefix(prefix: string): void;
  undo(): void;
  redo(): void;
  blur(): void;
};

interface MockEditorProps {
  value: string;
  onChange: (text: string) => void;
  controls?: (api: MockControls | null) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/** The caret/selection the commands act on, in the *body*'s coordinates. */
const mockSelection = { start: 0, end: 0 };
const mockCalls = { undo: 0, redo: 0, blur: 0 };
let mockProps: MockEditorProps | null = null;

jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: MockEditorProps) => {
    mockProps = props;
    props.controls?.({
      wrap(before: string, after: string) {
        const text = props.value;
        const { start, end } = mockSelection;
        props.onChange(
          text.slice(0, start) +
            before +
            text.slice(start, end) +
            after +
            text.slice(end),
        );
      },
      toggleLinePrefix(prefix: string) {
        const text = props.value;
        const from = text.lastIndexOf("\n", mockSelection.start - 1) + 1;
        props.onChange(
          text.startsWith(prefix, from)
            ? text.slice(0, from) + text.slice(from + prefix.length)
            : text.slice(0, from) + prefix + text.slice(from),
        );
      },
      undo() {
        mockCalls.undo += 1;
      },
      redo() {
        mockCalls.redo += 1;
      },
      blur() {
        mockCalls.blur += 1;
      },
    });
    return null;
  },
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { splitNote } =
  require("../features/console/files/frontmatter") as typeof import("../features/console/files/frontmatter");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "0-inbox/email/3efac11d4eead8832e5b1236.md";

const FRONTMATTER = [
  "---",
  'captured: "2026-08-29T02:51:47.360Z"',
  'source: "email"',
  'subject: "Re: the storage binding"',
  "---",
].join("\n");

const BODY = ["", "# Notes", "", "The first paragraph of the note itself.", ""].join("\n");

const FILE = `${FRONTMATTER}\n${BODY}`;

/**
 * Every key on the bar, and the name a screen reader reads for it.
 *
 * Written out rather than imported from the component: a table that is the same
 * object the code uses asserts that the code equals itself. `tag` and `attach`
 * are deliberately absent — Context has no tag model and no attachment upload,
 * and the component says so where the row is defined.
 */
const KEYS: [id: string, label: string][] = [
  ["undo", "Undo"],
  ["redo", "Redo"],
  ["task", "Task checkbox"],
  ["heading", "Heading"],
  ["bold", "Bold"],
  ["italic", "Italic"],
  ["dismiss", "Hide the keyboard"],
];

function stateFor(over: Partial<EditorState> = {}): EditorState {
  return { ...emptyEditor, status: "clean", path: PATH, baseline: FILE, draft: FILE, ...over };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockProps = null;
});

beforeEach(() => {
  mockSelection.start = 0;
  mockSelection.end = 0;
  mockCalls.undo = 0;
  mockCalls.redo = 0;
  mockCalls.blur = 0;
});

/**
 * A phone, mounted for real.
 *
 * react-native-web measures `document.documentElement.clientWidth`, which jsdom
 * reports as 0 — the trap `appFrameRender.test.ts` documents at length. Without
 * the stub every density reads as `compact` by accident, and the pointer test
 * below would pass for the wrong reason.
 */
function mountEditor(
  width: number,
  { state = stateFor(), canEdit = true }: { state?: EditorState; canEdit?: boolean } = {},
) {
  const changes: string[] = [];

  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  // Inside `act` because a root mounted by an earlier `mountEditor` in the same
  // test is still alive and subscribed: `useWindowDimensions` sets state from
  // this event, and React warns about an update it did not see coming.
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

  act(() => {
    root.render(
      createElement(NoteEditor, {
        state,
        canEdit,
        onChange: (text: string) => changes.push(text),
        onSave: jest.fn() as () => void,
        onDiscard: jest.fn() as () => void,
        onUseTheirs: jest.fn() as () => void,
        onKeepMine: jest.fn() as () => void,
      }),
    );
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  return {
    container,
    changes,
    find,
    bar: () => find("note-accessory"),
    editor: () => {
      if (mockProps === null) throw new Error("the editor was never rendered");
      return mockProps;
    },
    focus: () => act(() => mockProps?.onFocus?.()),
    blur: () => act(() => mockProps?.onBlur?.()),
    /**
     * A finger dragging the note.
     *
     * Dispatched on the element the real `ScrollView` rendered, so what is
     * exercised is the handler the component actually attached rather than a
     * callback this file invented for itself.
     */
    scroll: () => {
      const scroller = find("note-scroll");
      if (scroller === null) throw new Error("the note has no scroller");
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
    },
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("when the bar is on screen", () => {
  test("not until the note is focused, and not once it is let go of again", () => {
    const app = mountEditor(390);
    expect(app.bar()).toBeNull();

    app.focus();
    expect(app.bar()).not.toBeNull();

    app.blur();
    expect(app.bar()).toBeNull();
  });

  /**
   * **A scroll gesture is not an edit intent**, and on a phone it was one.
   *
   * The editable surface at this density *is* the text view — `LiveEditor` on
   * native is a `TextInput` with `scrollEnabled={false}` growing inside the
   * note's scroller — so a swipe hands the pan to the scroller and then hands
   * the caret to the input on touch-up. Verified on an iPhone 16 Pro Max:
   * swiping to read a long note raised the formatting bar, put the frame's own
   * toolbar away, and left no way to read to the end of a note without being
   * dropped into an editor nobody asked for.
   *
   * The rule is `SCROLL_GRACE_MS` in `NoteEditor`: a focus that arrives while
   * the note is still moving is part of the swipe, and the caret goes straight
   * back. `blur` is counted as well as the bar, because a bar that is merely
   * hidden over a focused input is a keyboard covering the note with no way to
   * dismiss it.
   */
  test("never because somebody scrolled the note", () => {
    const app = mountEditor(390);
    app.scroll();
    app.focus();

    expect(app.bar()).toBeNull();
    expect(mockCalls.blur).toBe(1);
  });

  /**
   * And the other half, which is what stops the fix being "the phone cannot be
   * typed into": once the note has come to rest, a press still opens the
   * keyboard. Driven by moving the clock past the grace rather than by waiting,
   * so the test does not spend a quarter of a second proving it.
   */
  test("but a press after the note has come to rest still opens it", () => {
    const app = mountEditor(390);
    app.scroll();

    const settled = Date.now() + 1_000;
    const clock = jest.spyOn(Date, "now").mockReturnValue(settled);
    try {
      app.focus();
    } finally {
      clock.mockRestore();
    }

    expect(app.bar()).not.toBeNull();
    expect(mockCalls.blur).toBe(0);
  });

  /**
   * A pointer already has a keyboard, and the chords that come with it. A
   * floating toolbar over a desktop editor is chrome nobody asked for — and
   * there is no soft keyboard for it to ride above in the first place.
   */
  test("never on a pointer, focused or not", () => {
    const app = mountEditor(1440);
    app.focus();
    expect(app.bar()).toBeNull();
  });

  /**
   * Every key on this bar writes to the note. On `privacy.md`, or in somebody
   * else's context you were invited into as a reader, all of them would fail —
   * and a row of controls that cannot do anything is worse than no row.
   */
  test("never over a note this viewer may not write", () => {
    const readerView = mountEditor(390, { canEdit: false });
    readerView.focus();
    expect(readerView.bar()).toBeNull();

    const manifest = mountEditor(390, { state: stateFor({ readOnly: true }) });
    manifest.focus();
    expect(manifest.bar()).toBeNull();
  });
});

describe("what the keys do", () => {
  /**
   * THE ONE THAT WOULD COST SOMEBODY THEIR DATA.
   *
   * The editor is handed the body; what leaves `NoteEditor` has to be the whole
   * file again — for a key press exactly as for a keystroke. If this fails,
   * every captured note loses its `captured:`, `source:` and `subject:` lines
   * the first time anybody bolds a word on their phone.
   */
  test("bold wraps the selection and the frontmatter is still in front of it", () => {
    const app = mountEditor(390);
    app.focus();

    const { frontmatter, body } = splitNote(FILE);
    // The editor is given the body alone, so the selection is in its
    // coordinates — which is the offset bug this would catch if the two ever
    // stopped agreeing.
    expect(app.editor().value).toBe(body);

    const start = body.indexOf("first");
    mockSelection.start = start;
    mockSelection.end = start + "first".length;

    app.press(app.find("note-accessory-bold"));

    expect(app.changes).toHaveLength(1);
    expect(app.changes[0]).toBe(
      frontmatter +
        body.slice(0, start) +
        "**first**" +
        body.slice(start + "first".length),
    );
    expect(app.changes[0]!.startsWith(FRONTMATTER)).toBe(true);
  });

  test("italic wraps with a single marker, and still carries the block", () => {
    const app = mountEditor(390);
    app.focus();

    const { frontmatter, body } = splitNote(FILE);
    const start = body.indexOf("first");
    mockSelection.start = start;
    mockSelection.end = start + "first".length;

    app.press(app.find("note-accessory-italic"));
    expect(app.changes[0]).toBe(
      frontmatter + body.slice(0, start) + "*first*" + body.slice(start + "first".length),
    );
  });

  /**
   * The two prefix keys, on the line the caret is on — and off it again, which
   * is what makes a bar with one key per prefix usable at all.
   */
  test.each([
    ["heading", "# "],
    ["task", "- [ ] "],
  ])("%s toggles its prefix on the caret's line", (id, prefix) => {
    const app = mountEditor(390);
    app.focus();

    const { frontmatter, body } = splitNote(FILE);
    const line = body.indexOf("The first paragraph");
    mockSelection.start = line + 4;
    mockSelection.end = line + 4;

    app.press(app.find(`note-accessory-${id}`));
    expect(app.changes[0]).toBe(
      frontmatter + body.slice(0, line) + prefix + body.slice(line),
    );
    expect(app.changes[0]!.startsWith(FRONTMATTER)).toBe(true);
  });

  test("undo and redo reach the editor rather than being reimplemented here", () => {
    const app = mountEditor(390);
    app.focus();

    app.press(app.find("note-accessory-undo"));
    app.press(app.find("note-accessory-redo"));

    expect(mockCalls).toMatchObject({ undo: 1, redo: 1 });
    // Nothing was written: undo is the editor's own history on both platforms,
    // and a bar that emitted text of its own would be a second one.
    expect(app.changes).toEqual([]);
  });

  /** The key the whole bar exists for. */
  test("dismiss releases the editing surface", () => {
    const app = mountEditor(390);
    app.focus();

    app.press(app.find("note-accessory-dismiss"));
    expect(mockCalls.blur).toBe(1);
  });
});

/**
 * An icon carries nothing to a screen reader, and on a phone there is no menu
 * and no keymap to reach these commands by instead — so an unlabelled key here
 * is a command that, for one reader, does not exist. `BottomBar`'s rule.
 */
describe("every key says what it is", () => {
  test.each(KEYS)("%s is announced as %s", (id, label) => {
    const app = mountEditor(390);
    app.focus();
    expect(app.find(`note-accessory-${id}`)?.getAttribute("aria-label")).toBe(label);
  });

  test("and there is nothing on the bar that is not on that list", () => {
    const app = mountEditor(390);
    app.focus();

    const keys = Array.from(
      app.container.querySelectorAll<HTMLElement>('[data-testid^="note-accessory-"]'),
    );
    expect(keys.map((key) => key.getAttribute("data-testid"))).toEqual(
      KEYS.map(([id]) => `note-accessory-${id}`),
    );
    for (const key of keys) {
      expect(key.getAttribute("aria-label")).not.toBe("");
      expect(key.getAttribute("aria-label")).not.toBeNull();
    }
  });
});
