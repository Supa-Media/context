/**
 * @jest-environment jsdom
 */

/**
 * SPELLING IN THE NOTE: FIXES ON RIGHT-CLICK, NO RED LINE (Dev2, 2026-10-27
 * boards; the line left out 2026-10-28).
 *
 * The real `LiveEditor` on web, with Context's own checker and the real US
 * dictionary handed to the store instead of fetched:
 *
 *  - nothing is drawn under any word, by us or by the browser;
 *  - right-click on misspelled prose puts the fixes, Add to dictionary and
 *    Ignore in this note on top of the formatting menu, and each one works;
 *    code / links / tags / front matter / note links get no fixes, and a note
 *    nobody may write gets none and never downloads the dictionary;
 *  - a plain click is only a click;
 *  - the browser's checker is off while ours runs or loads, on only when ours
 *    could not load, and off when the person turned checking off.
 *
 * jsdom lays nothing out, so `posAtCoords` is stubbed to the position the
 * click is meant to land on, as `editorContextMenu.test.ts` does.
 *
 * ## Sabotage record
 *
 *   drop "InlineCode" from SKIPPED_NODES                     1 fail
 *   Ignore does not dispatch the effect                       1 fail
 *   browserChecker always answers "true"                      3 fail
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

describe("nothing is drawn", () => {
  test("misspelled words get no line once the dictionary is in, and the browser draws none either", async () => {
    const m = await mount({ value: "the israelites took elevn days\n" });
    expect(getSpelling().status).toBe("ready");
    expect(m.content.querySelectorAll("[class*='misspell']").length).toBe(0);
    expect(m.content.getAttribute("spellcheck")).toBe("false");
  });

  test("a plain click on a misspelled word is only a click", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.click(11);
    expect(m.labels()).toEqual([]);
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

  test("a fix replaces the word", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.rightClick(11);
    m.press("menu-item-spelling:0");
    expect(m.doc()).toBe("it takes eleven days");
  });

  test("a correct word gets the plain menu", async () => {
    const m = await mount({ value: "it takes elevn days" });
    m.rightClick(4);
    expect(m.find("menu-item-spelling:0")).toBeNull();
    expect(m.find("menu-item-bold")).not.toBeNull();
  });

  test("code, addresses, tags, note links and front matter get no fixes", async () => {
    const value = "---\ntitel: draft\n---\n\nmispeled `the wrod here` https://exmaple.com #tagg [[exodsu]]\n";
    const m = await mount({ value });
    for (const word of ["titel", "wrod", "exmaple", "tagg", "exodsu"]) {
      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      m.rightClick(value.indexOf(word) + 1);
      expect([word, m.find("menu-item-spelling:0")]).toEqual([word, null]);
    }
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    m.rightClick(value.indexOf("mispeled") + 1);
    expect(m.find("menu-item-spelling:0")).not.toBeNull();
  });

  test("a note nobody may write gets no fixes, and never downloads the dictionary", async () => {
    let fetched = 0;
    resetSpellingForTests(async () => {
      fetched += 1;
      return { aff, dic };
    });
    const m = await mount({ value: "the israelites took elevn days\n", editable: false });
    m.rightClick(22);
    expect(m.find("menu-item-spelling:0")).toBeNull();
    expect(fetched).toBe(0);
  });

  test("Ignore in this note stops offering fixes for every copy of the word", async () => {
    const m = await mount({ value: "elevn and elevn" });
    m.rightClick(2);
    m.press("menu-item-spellingIgnore");
    m.rightClick(12);
    expect(m.find("menu-item-spelling:0")).toBeNull();
    expect(m.doc()).toBe("elevn and elevn");
  });

  test("Add to dictionary saves the word on the account, possessive included", async () => {
    const learned: string[] = [];
    setSpellingSaver({
      learn: async (word) => learned.push(word),
      forget: async () => undefined,
      setEnabled: async () => undefined,
      setLanguage: async () => undefined,
    });
    const m = await mount({ value: "ask Kayode today, Kayode's turn" });
    m.rightClick(6);
    expect(m.find("menu-item-spellingAdd")).not.toBeNull();
    m.press("menu-item-spellingAdd");
    await settle();
    expect(learned).toEqual(["Kayode"]);
    m.rightClick(20);
    expect(m.find("menu-item-spelling:0")).toBeNull();
    expect(m.find("menu-item-noSuggestions")).toBeNull();
  });
});

describe("the browser's own checker", () => {
  test("off while ours is still loading, so no line flashes up first", async () => {
    resetSpellingForTests(() => new Promise(() => undefined));
    const m = await mount({ value: "it takes elevn days" });
    expect(getSpelling().status).toBe("loading");
    expect(m.content.getAttribute("spellcheck")).toBe("false");
  });

  test("on when ours could not load, so checking never goes silent", async () => {
    resetSpellingForTests(async () => {
      throw new Error("offline");
    });
    const m = await mount({ value: "it takes elevn days" });
    expect(getSpelling().status).toBe("failed");
    expect(m.content.getAttribute("spellcheck")).toBe("true");
  });

  test("off, with no fixes of ours either, when the person turned checking off", async () => {
    const m = await mount({ value: "it takes elevn days" });
    act(() => setSpellingEnabled(false));
    await settle();
    expect(m.content.getAttribute("spellcheck")).toBe("false");
    m.rightClick(11);
    expect(m.find("menu-item-spelling:0")).toBeNull();
  });
});
