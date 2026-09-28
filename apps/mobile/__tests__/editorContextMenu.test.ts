/**
 * @jest-environment jsdom
 */

/**
 * RIGHT-CLICKING A NOTE, END TO END.
 *
 * `editorMenu.test.ts` pins the items as a model and `markdownFormat.test.ts`
 * pins the verbs against a real `EditorView`. Neither can see the seam between
 * them, which is where everything here lives: a `contextmenu` on the editor's
 * own content element, a menu drawn over it, a row pressed, and a transaction
 * arriving in the document the person was looking at.
 *
 * Three of these are bugs that would look like nothing on screen:
 *
 *  - **Suppressing a menu nobody answers.** A read-only note with no selection
 *    has no verbs; `preventDefault` there takes the browser's own menu — and
 *    with it Paste and every spelling suggestion — away and gives nothing back.
 *  - **Losing the click's position.** A formatting menu that acts three lines
 *    from where somebody clicked is worse than no menu.
 *  - **Standing on `noteLinks`.** A long press on a note link arrives as a
 *    `contextmenu` in WebKit and is already answered; answering it twice opens
 *    a formatting menu over a link somebody was trying to follow.
 *
 * jsdom lays nothing out, so `posAtCoords` answers `null` here and the caret
 * cannot be checked against a pixel. What is checked is everything either side
 * of that: which menu opens, whether the event was suppressed, and what the
 * document says afterwards.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LiveEditor } from "../features/console/files/LiveEditor.web";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const teardown: (() => void)[] = [];
afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

interface Mounted {
  container: HTMLDivElement;
  content: HTMLElement;
  changes: string[];
  /** The text the editor is actually holding, straight off its own state. */
  doc: () => string;
  select: (from: number, to?: number) => void;
  selection: () => { from: number; to: number };
  rightClick: (options?: { shiftKey?: boolean; prevented?: boolean; at?: number | null }) => MouseEvent;
  press: (testID: string) => void;
  find: (testID: string) => HTMLElement | null;
  /** Re-render with a different authoritative note, the way the parent does. */
  update: (next: { value: string }) => void;
  labels: () => string[];
}

function mount(options: { value: string; editable?: boolean }): Mounted {
  /*
    react-native-web measures the window from `document.documentElement`, which
    jsdom reports as 0×0 — and `Menu` picks its presentation from the width, so
    an unstubbed document gets the phone's bottom sheet for the wrong reason.
    A desktop window is what a right-click implies.
  */
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
  const root: Root = createRoot(container);
  const changes: string[] = [];
  let value = options.value;

  const render = () =>
    act(() => {
    root.render(
      createElement(LiveEditor, {
        value,
        editable: options.editable ?? true,
        onChange: (text: string) => changes.push(text),
        onSave: () => {},
        accessibilityLabel: "note markdown",
        notePath: "1-projects/plan.md",
      }),
    );
  });

  render();

  teardown.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const content = container.querySelector(".cm-content") as HTMLElement;
  /*
    `findFromDOM` rather than reaching for an internal field: it is CodeMirror's
    own supported way back from a mounted element to the view, so this harness
    keeps working across versions of a library the whole editor is built on.
  */
  const view = (): EditorView => {
    const found = EditorView.findFromDOM(container);
    if (found === null) throw new Error("the editor is not mounted");
    return found;
  };

  const find = (testID: string) =>
    document.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

  return {
    container,
    content,
    changes,
    doc: () => view().state.doc.toString(),
    selection: () => {
      const { from, to } = view().state.selection.main;
      return { from, to };
    },
    select: (from, to = from) => {
      act(() => {
        view().dispatch({ selection: EditorSelection.single(from, to) });
      });
    },
    /**
     * `at` is the document position the click lands on.
     *
     * Stubbed rather than measured, because jsdom lays nothing out:
     * `posAtCoords` there either throws or maps every point to the end of the
     * document, so a real coordinate would test the geometry of an empty
     * rectangle instead of the branch that matters — does this click sit inside
     * the selection, or somewhere else? Both answers are reachable this way,
     * and the default (`null`) is "the editor could not say", which is the case
     * the handler has to survive rather than throw on.
     */
    rightClick: ({ shiftKey = false, prevented = false, at: position = null } = {}) => {
      (view() as unknown as { posAtCoords: () => number | null }).posAtCoords = () => position;
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 200,
        shiftKey,
      });
      if (prevented) event.preventDefault();
      act(() => {
        content.dispatchEvent(event);
      });
      return event;
    },
    press: (testID) => {
      const node = find(testID);
      if (node === null) throw new Error(`no ${testID}`);
      /*
        `click` alone, and deliberately not the mousedown/mouseup pair most
        press helpers in this suite send. CodeMirror's DOM observer re-reads the
        browser's own selection when the mouse goes down, and jsdom has no
        selection to read — so the pair silently moved the caret to the end of
        the document before the row ever ran, and every assertion about *what*
        was formatted was measuring the wrong range.
      */
      act(() => {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    find,
    update: (next) => {
      value = next.value;
      render();
    },
    labels: () =>
      Array.from(document.querySelectorAll('[data-testid^="menu-item-"]')).map(
        (node) => (node as HTMLElement).getAttribute("aria-label") ?? node.textContent ?? "",
      ),
  };
}

describe("the menu opens over the note", () => {
  test("a right-click is answered, and the browser's menu is suppressed", () => {
    const m = mount({ value: "some words here" });
    const event = m.rightClick();

    expect(event.defaultPrevented).toBe(true);
    expect(m.find("menu-item-bold")).not.toBeNull();
    expect(m.find("menu-item-table")).not.toBeNull();
  });

  test("Shift-right-click falls through to the browser", () => {
    const m = mount({ value: "some words here" });
    const event = m.rightClick({ shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(m.find("menu-item-bold")).toBeNull();
  });

  /**
   * `noteLinks` answers a long press on a note link — WebKit reports one as a
   * `contextmenu` — and it gets there first. A press something has already
   * answered is not this one's to answer again.
   */
  test("a contextmenu something else already handled is left alone", () => {
    const m = mount({ value: "see [[plan]]" });
    m.rightClick({ prevented: true });

    expect(m.find("menu-item-bold")).toBeNull();
  });

  test("Cut and Copy appear only with something selected", () => {
    const m = mount({ value: "some words here" });
    m.rightClick();
    expect(m.find("menu-item-copy")).toBeNull();
    expect(m.find("menu-item-cut")).toBeNull();

    m.press("menu-item-bold");
    m.select(5, 10);
    m.rightClick({ at: 7 });
    expect(m.find("menu-item-copy")).not.toBeNull();
    expect(m.find("menu-item-cut")).not.toBeNull();
  });
});

/**
 * Where the click landed decides what the menu is about.
 *
 * A formatting menu that acts three lines from where somebody clicked is worse
 * than no menu, and the engines disagree about whether a right button places a
 * caret in a contenteditable at all — so the handler places it rather than
 * hoping. The exception is the one everybody relies on: right-clicking *inside*
 * a selection keeps that selection, because Copy and Bold are then about it.
 */
describe("the click's position", () => {
  test("a right-click outside the selection moves the caret there", () => {
    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 13 });

    expect(m.selection()).toEqual({ from: 13, to: 13 });
    // …and the menu is the no-selection one, because there is no selection now.
    expect(m.find("menu-item-copy")).toBeNull();
  });

  test("and a right-click inside it keeps the selection", () => {
    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });

    expect(m.selection()).toEqual({ from: 5, to: 10 });
  });

  test("an unmeasurable position leaves the selection exactly where it was", () => {
    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick();

    expect(m.selection()).toEqual({ from: 5, to: 10 });
  });

  test("and a read-only note never has its caret moved by a right-click", () => {
    const m = mount({ value: "some words here", editable: false });
    m.select(5, 10);
    m.rightClick({ at: 13 });

    expect(m.selection()).toEqual({ from: 5, to: 10 });
  });
});

describe("a note this viewer may not write", () => {
  test("keeps the browser's menu when there is nothing to offer", () => {
    const m = mount({ value: "some words here", editable: false });
    const event = m.rightClick();

    expect(event.defaultPrevented).toBe(false);
    expect(m.find("menu-item-bold")).toBeNull();
  });

  test("and offers Copy, and only Copy, over a selection", () => {
    const m = mount({ value: "some words here", editable: false });
    m.select(5, 10);
    const event = m.rightClick({ at: 7 });

    expect(event.defaultPrevented).toBe(true);
    expect(m.find("menu-item-copy")).not.toBeNull();
    expect(m.find("menu-item-cut")).toBeNull();
    expect(m.find("menu-item-bold")).toBeNull();
  });
});

describe("pressing a row edits the note", () => {
  test("Bold wraps the selection, and the change reaches onChange", () => {
    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });
    m.press("menu-item-bold");

    expect(m.doc()).toBe("some **words** here");
    expect(m.changes[m.changes.length - 1]).toBe("some **words** here");
  });

  test("Strikethrough uses the same markers the chord does", () => {
    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });
    m.press("menu-item-strikethrough");

    expect(m.doc()).toBe("some ~~words~~ here");
  });

  test("Quote is a line prefix and toggles off again", () => {
    const m = mount({ value: "some words here" });
    m.select(2);
    m.rightClick();
    m.press("menu-item-quote");
    expect(m.doc()).toBe("> some words here");

    m.rightClick();
    m.press("menu-item-quote");
    expect(m.doc()).toBe("some words here");
  });

  test("the menu closes once a row has run", () => {
    const m = mount({ value: "some words here" });
    m.rightClick();
    m.press("menu-item-bold");

    expect(m.find("menu-item-bold")).toBeNull();
  });
});

/**
 * Cut is a copy that then deletes, and the order is the whole safety of it.
 *
 * `writeClipboard` falls back to `execCommand` where the async API is refused
 * and still answers `false` when neither works — an insecure origin, a
 * permission denied, an embedded webview. A cut that deleted first, or deleted
 * regardless, would take somebody's text out of their note and put it nowhere.
 */
describe("Cut waits for the copy to land", () => {
  const clipboard = (write: (text: string) => Promise<void>) => {
    const original = (navigator as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    teardown.push(() => {
      Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
    });
  };

  test("a copy that succeeded takes the text out of the note", async () => {
    const written: string[] = [];
    clipboard(async (text: string) => {
      written.push(text);
    });

    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });
    m.press("menu-item-cut");
    await act(async () => {});

    expect(written).toEqual(["words"]);
    expect(m.doc()).toBe("some  here");
  });

  test("and a copy that failed leaves the note exactly as it was", async () => {
    clipboard(async () => {
      throw new Error("no clipboard here");
    });

    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });
    m.press("menu-item-cut");
    await act(async () => {});

    expect(m.doc()).toBe("some words here");
  });

  test("Copy never deletes, however well it went", async () => {
    clipboard(async () => {});

    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });
    m.press("menu-item-copy");
    await act(async () => {});

    expect(m.doc()).toBe("some words here");
  });

  /**
   * The positions are read before an `await`, and the document can be replaced
   * in that window — an autosave conflict resolving, another note opening. The
   * range has to still hold what was copied, or the delete takes out whatever
   * moved into it.
   */
  test("and a document that moved under the copy is not cut", async () => {
    let release: (() => void) | null = null;
    clipboard(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const m = mount({ value: "some words here" });
    m.select(5, 10);
    m.rightClick({ at: 7 });
    m.press("menu-item-cut");

    m.update({ value: "a completely different note" });
    await act(async () => {
      release?.();
    });

    expect(m.doc()).toBe("a completely different note");
  });
});

/**
 * A submenu parent is never dispatched — `Menu` opens its `items` instead — so
 * the level that actually writes anything is the child. `menu.ts` records why
 * that matters: an id with no handler is a no-op, an id with the wrong handler
 * silently rewrites the line somebody right-clicked.
 */
describe("the heading submenu", () => {
  test("opening Heading writes nothing, and a level writes its own prefix", () => {
    const m = mount({ value: "some words here" });
    m.select(2);
    m.rightClick();

    m.press("menu-item-heading");
    expect(m.doc()).toBe("some words here");

    m.press("menu-item-heading2");
    expect(m.doc()).toBe("## some words here");
  });
});

describe("the table picker", () => {
  test("Table… opens the grid rather than inserting anything", () => {
    const m = mount({ value: "" });
    m.rightClick();
    m.press("menu-item-table");

    expect(m.find("table-size-picker")).not.toBeNull();
    expect(m.doc()).toBe("");
  });

  test("a cell inserts a table of exactly that size, header row included", () => {
    const m = mount({ value: "" });
    m.rightClick();
    m.press("menu-item-table");
    // Three columns, two rows *including the header* — so one body row.
    m.press("table-size-3x2");

    expect(m.doc()).toBe("|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n");
    expect(m.find("table-size-picker")).toBeNull();
  });

  test("the caption follows the pointer, in columns × rows", () => {
    const m = mount({ value: "" });
    m.rightClick();
    m.press("menu-item-table");

    const cell = m.find("table-size-4x3");
    act(() => {
      cell?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      cell?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    expect(m.find("table-size-caption")?.textContent).toBe("4 × 3");
  });

  test("Escape closes it without writing a table", () => {
    const m = mount({ value: "" });
    m.rightClick();
    m.press("menu-item-table");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(m.find("table-size-picker")).toBeNull();
    expect(m.doc()).toBe("");
  });

  test("and the arrows size it, with Enter committing what they set", () => {
    const m = mount({ value: "" });
    m.rightClick();
    m.press("menu-item-table");
    act(() => {
      // From 2 × 2: one column right, one row down.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(m.find("table-size-caption")?.textContent).toBe("3 × 3");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(m.doc()).toBe(
      "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n",
    );
  });
});

/**
 * Spelling. The browser's suggestions are behind Shift-right-click and the
 * menu says so; the desktop app asks the operating system's checker and puts
 * its suggestions at the top, where every browser puts them.
 */
describe("spelling", () => {
  const scope = globalThis as { desktop?: unknown };
  const flush = () => act(async () => {});
  afterEach(() => {
    delete scope.desktop;
  });
  const shell = (answer: (word: string) => { misspelled: boolean; suggestions: string[] }) => {
    scope.desktop = fakeDesktopBridge({ spelling: answer }).bridge;
  };
  const flagged = (word: string) =>
    word === "permissoning"
      ? { misspelled: true, suggestions: ["permissioning", "positioning"] }
      : { misspelled: false, suggestions: [] };

  test("a browser is pointed at Shift-right-click", () => {
    const m = mount({ value: "proper permissoning" });
    m.rightClick({ at: 10 });
    expect(m.find("menu-item-spellingHint")).not.toBeNull();
    // Inert: it names a gesture, so pressing it leaves the note and the menu be.
    m.press("menu-item-spellingHint");
    expect(m.doc()).toBe("proper permissoning");
    expect(m.find("menu-item-bold")).not.toBeNull();
  });

  test("the desktop app offers the checker's suggestions, first", async () => {
    shell(flagged);
    const m = mount({ value: "proper permissoning" });
    const event = m.rightClick({ at: 10 });
    expect(event.defaultPrevented).toBe(true);
    await flush();

    expect(m.labels().slice(0, 2)).toEqual(["permissioning", "positioning"]);
    expect(m.find("menu-item-spellingHint")).toBeNull();

    m.press("menu-item-spelling:1");
    expect(m.doc()).toBe("proper positioning");
    expect(m.find("menu-item-bold")).toBeNull();
  });

  test("a word the checker accepts gets the ordinary menu, with no hint", async () => {
    shell(flagged);
    const m = mount({ value: "proper permissoning" });
    m.rightClick({ at: 2 });
    await flush();

    expect(m.find("menu-item-spelling:0")).toBeNull();
    expect(m.find("menu-item-spellingHint")).toBeNull();
    expect(m.find("menu-item-bold")).not.toBeNull();
  });

  test("a flagged word with nothing to offer says so", async () => {
    shell(() => ({ misspelled: true, suggestions: [] }));
    const m = mount({ value: "zzqx" });
    m.rightClick({ at: 1 });
    await flush();

    expect(m.find("menu-item-noSuggestions")).not.toBeNull();
    m.press("menu-item-noSuggestions");
    expect(m.doc()).toBe("zzqx");
    expect(m.find("menu-item-bold")).not.toBeNull();
  });

  test("a suggestion is not written over text that moved in meanwhile", async () => {
    shell(flagged);
    const m = mount({ value: "proper permissoning" });
    m.rightClick({ at: 10 });
    await flush();
    m.update({ value: "an entirely different note" });
    const before = m.doc();

    expect(m.find("menu-item-spelling:0")).not.toBeNull();
    m.press("menu-item-spelling:0");
    expect(m.doc()).toBe(before);
  });

  test("a note nobody may write is never asked about", async () => {
    const calls: string[] = [];
    shell((word) => (calls.push(word), flagged(word)));
    const m = mount({ value: "proper permissoning", editable: false });
    m.select(7, 19);
    m.rightClick({ at: 10 });
    await flush();

    expect(calls).toEqual([]);
    expect(m.find("menu-item-spelling:0")).toBeNull();
    expect(m.find("menu-item-copy")).not.toBeNull();
  });
});
