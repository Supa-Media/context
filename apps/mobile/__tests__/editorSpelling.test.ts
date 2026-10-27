/**
 * @jest-environment jsdom
 */

/**
 * SPELLING IN THE NOTE, THE GOOGLE DOCS WAY (Dev2, 2026-10-27, boards 1–5).
 *
 * The real `LiveEditor` on web, with Context's own checker and the real US
 * dictionary handed to the store instead of fetched:
 *
 *  - misspelled prose is underlined, code / links / tags / front matter are not,
 *    and a note nobody may write is not underlined at all;
 *  - a plain click on an underlined word opens a card with only the fixes,
 *    Add to dictionary and Ignore in this note — and pressing one does it;
 *  - right-click has the same rows on top of the formatting menu, with no
 *    Shift-right-click signpost;
 *  - the browser's checker is off while ours runs, on while ours has no
 *    dictionary, and off when the person turned checking off.
 *
 * jsdom lays nothing out, so `posAtCoords` is stubbed to the position the
 * click is meant to land on, as `editorContextMenu.test.ts` does.
 *
 * ## Sabotage record
 *
 *   drop "InlineCode" from SKIPPED_NODES                     1 fail
 *   underline a read-only note                                1 fail
 *   click opens the card on a correct word                    1 fail
 *   Ignore does not dispatch the effect                       1 fail
 *   browserChecker always answers "true"                      1 fail
 *   passiveKeys ignored by the popover                        1 fail
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LiveEditor } from "../features/console/files/LiveEditor.web";
import {
  getSpelling,
  resetSpellingForTests,
  setSpellingEnabled,
  setSpellingSaver,
} from "../features/console/files/spelling/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DICTIONARY = path.join(__dirname, "..", "node_modules", "dictionary-en");
const aff = readFileSync(path.join(DICTIONARY, "index.aff"), "utf8");
const dic = readFileSync(path.join(DICTIONARY, "index.dic"), "utf8");

const teardown: (() => void)[] = [];
afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

beforeEach(() => {
  resetSpellingForTests(async () => ({ aff, dic }));
});

/** Let the dictionary promise, the store's microtask and React settle. */
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

async function mount(options: { value: string; editable?: boolean }) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1280, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 900, configurable: true });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      createElement(LiveEditor, {
        value: options.value,
        editable: options.editable ?? true,
        onChange: () => {},
        onSave: () => {},
        accessibilityLabel: "note markdown",
        notePath: "areas/exodus-study.md",
      }),
    );
  });
  teardown.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await settle();

  const view = (): EditorView => {
    const found = EditorView.findFromDOM(container);
    if (found === null) throw new Error("the editor is not mounted");
    return found;
  };
  const content = container.querySelector(".cm-content") as HTMLElement;
  const find = (testID: string) => document.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
  const aimAt = (position: number) => {
    (view() as unknown as { posAtCoords: () => number | null }).posAtCoords = () => position;
  };

  return {
    view,
    content,
    find,
    doc: () => view().state.doc.toString(),
    underlined: () => Array.from(container.querySelectorAll(".cm-misspelled")).map((node) => node.textContent),
    click: (position: number) => {
      aimAt(position);
      act(() => {
        view().dispatch({ selection: EditorSelection.cursor(position) });
        content.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: 100, clientY: 100 }));
      });
    },
    rightClick: (position: number) => {
      aimAt(position);
      act(() => {
        content.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      });
    },
    press: (testID: string) => {
      const node = find(testID);
      if (node === null) throw new Error(`no ${testID}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    labels: () =>
      Array.from(document.querySelectorAll('[data-testid^="menu-item-"]')).map(
        (node) => (node as HTMLElement).getAttribute("aria-label") ?? node.textContent ?? "",
      ),
  };
}

describe("the underline", () => {
  test("misspelled prose is underlined once the dictionary is in", async () => {
    const m = await mount({ value: "the israelites took elevn days\n" });
    expect(getSpelling().status).toBe("ready");
    expect(m.underlined()).toEqual(["israelites", "elevn"]);
  });

  test("code, addresses, tags, note links and front matter are left alone", async () => {
    const m = await mount({
      value: "---\ntitel: draft\n---\n\nmispeled `the wrod here` https://exmaple.com #tagg [[exodsu]]\n",
    });
    expect(m.underlined()).toEqual(["mispeled"]);
  });

  test("a note nobody may write is not underlined, and never downloads the dictionary", async () => {
    let fetched = 0;
    resetSpellingForTests(async () => {
      fetched += 1;
      return { aff, dic };
    });
    const m = await mount({ value: "the israelites took elevn days\n", editable: false });
    expect(m.underlined()).toEqual([]);
    expect(fetched).toBe(0);
  });

  test("the word being typed waits until the caret leaves it", async () => {
    const m = await mount({ value: "hello " });
    act(() => {
      m.view().dispatch({ changes: { from: 6, insert: "wrold" }, selection: { anchor: 11 }, userEvent: "input.type" });
    });
    expect(m.underlined()).toEqual([]);
    act(() => {
      m.view().dispatch({ changes: { from: 11, insert: " " }, selection: { anchor: 12 }, userEvent: "input.type" });
    });
    expect(m.underlined()).toEqual(["wrold"]);
  });
});

describe("the click card", () => {
  test("a click on an underlined word opens only the fixes, and one press replaces it", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.click(11);
    expect(m.labels()).toEqual(["eleven", "elev", "Add to dictionary", "Ignore in this note"]);
    expect(m.find("menu-item-bold")).toBeNull();
    m.press("menu-item-spelling:0");
    expect(m.doc()).toBe("it takes eleven days");
    expect(m.underlined()).toEqual([]);
  });

  test("a click on a correct word opens nothing", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.click(4);
    expect(m.labels()).toEqual([]);
  });

  test("the next key closes the card and goes to the note", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.click(11);
    expect(m.find("menu-item-spelling:0")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(m.find("menu-item-spelling:0")).toBeNull();
  });

  test("Ignore in this note takes the underline away from every copy of the word", async () => {
    const m = await mount({ value: "elevn and elevn" });
    m.click(2);
    m.press("menu-item-spellingIgnore");
    expect(m.underlined()).toEqual([]);
    expect(m.doc()).toBe("elevn and elevn");
  });

  test("Add to dictionary saves the word on the account and it stops being red", async () => {
    const learned: string[] = [];
    setSpellingSaver({
      learn: async (word) => learned.push(word),
      forget: async () => undefined,
      setEnabled: async () => undefined,
      setLanguage: async () => undefined,
    });
    const m = await mount({ value: "ask Kayode today, Kayode's turn" });
    expect(m.underlined()).toEqual(["Kayode", "Kayode's"]);
    m.click(6);
    m.press("menu-item-spellingAdd");
    await settle();
    expect(learned).toEqual(["Kayode"]);
    // Its possessive goes with it.
    expect(m.underlined()).toEqual([]);
  });
});

describe("right-click", () => {
  test("the fixes sit on top of the formatting menu, with no signpost to the browser", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.rightClick(11);
    expect(m.labels().slice(0, 4)).toEqual(["eleven", "elev", "Add to dictionary", "Ignore in this note"]);
    expect(m.find("menu-item-bold")).not.toBeNull();
    expect(m.find("menu-item-spellingHint")).toBeNull();
  });
});

describe("the browser's own checker", () => {
  test("off while ours runs, so nothing is underlined twice", async () => {
    const m = await mount({ value: "words" });
    expect(m.content.getAttribute("spellcheck")).toBe("false");
  });

  test("on while ours has no dictionary, so checking never goes silent", async () => {
    resetSpellingForTests(async () => {
      throw new Error("offline");
    });
    const m = await mount({ value: "it takes elevn days" });
    expect(getSpelling().status).toBe("failed");
    expect(m.content.getAttribute("spellcheck")).toBe("true");
    expect(m.underlined()).toEqual([]);
  });

  test("off, with no underline of ours either, when the person turned checking off", async () => {
    const m = await mount({ value: "it takes elevn days" });
    act(() => setSpellingEnabled(false));
    await settle();
    expect(m.content.getAttribute("spellcheck")).toBe("false");
    expect(m.underlined()).toEqual([]);
  });
});
