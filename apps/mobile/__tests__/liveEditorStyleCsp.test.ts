/**
 * @jest-environment jsdom
 *
 * The live editor's rules reach the page without a `<style>` whose text
 * script writes, where the browser can adopt a constructed sheet: that text
 * is inline style to a Content Security Policy, and the CASA scan's
 * "CSP: style-src unsafe-inline" is what it would cost
 * (`features/console/files/liveEditorWeb/stylesheet.ts`). Where it cannot,
 * including a browser that claims the API and then refuses the sheet, the
 * editor still mounts, with the `<style>` element.
 *
 * jsdom has neither constructable sheets nor `document.adoptedStyleSheets`,
 * so each test installs them as own properties and removes them after.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `ensureStyles` without the `adoptStyles` call fails "adopts one sheet".
 *  2. `adoptStyles` appending the sheet on every call fails "replaces it".
 *  3. The adoption outside the `try` fails "a document that throws".
 *  4. No re-check after adopting fails "a document that ignores".
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { darkColors, lightColors } from "../features/design/tokens";

type Stylesheet = typeof import("../features/console/files/liveEditorWeb/stylesheet");

class FakeSheet {
  cssText = "";
  replaceSync(text: string) {
    this.cssText = text;
  }
}

function load(): Stylesheet {
  let loaded: Stylesheet | undefined;
  jest.isolateModules(() => {
    loaded = require("../features/console/files/liveEditorWeb/stylesheet") as Stylesheet;
  });
  if (loaded === undefined) throw new Error("stylesheet module did not load");
  return loaded;
}

/** Give jsdom constructable sheets, with `set` deciding what adopting does. */
function installAdoption(set: (next: unknown[]) => unknown[] | Error): { list: () => unknown[] } {
  let list: unknown[] = [];
  Object.defineProperty(globalThis, "CSSStyleSheet", { value: FakeSheet, configurable: true, writable: true });
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => list,
    set: (next: unknown[]) => {
      const outcome = set(next);
      if (outcome instanceof Error) throw outcome;
      list = outcome;
    },
  });
  return { list: () => list };
}

function cssOf(sheet: unknown): string {
  expect(sheet).toBeInstanceOf(FakeSheet);
  return sheet instanceof FakeSheet ? sheet.cssText : "";
}

function styleElements() {
  return document.head.querySelectorAll("style#context-live-preview-styles");
}

const realSheet = Object.getOwnPropertyDescriptor(globalThis, "CSSStyleSheet");

afterEach(() => {
  Reflect.deleteProperty(document, "adoptedStyleSheets");
  if (realSheet) Object.defineProperty(globalThis, "CSSStyleSheet", realSheet);
  else Reflect.deleteProperty(globalThis, "CSSStyleSheet");
  document.head.innerHTML = "";
});

describe("the live editor's stylesheet", () => {
  test("adopts one sheet, and writes no style element, where the browser can", () => {
    const adoption = installAdoption((next) => next);
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);

    expect(styleElements()).toHaveLength(0);
    expect(adoption.list()).toHaveLength(1);
    expect(cssOf(adoption.list()[0])).toBe(liveEditorCss(lightColors));
  });

  test("replaces it when the palette changes, rather than adding another", () => {
    const adoption = installAdoption((next) => next);
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);
    ensureStyles(darkColors);

    expect(adoption.list()).toHaveLength(1);
    expect(cssOf(adoption.list()[0])).toBe(liveEditorCss(darkColors));
  });

  test("a document that throws on adopting falls back to the style element, and the mount does not throw", () => {
    installAdoption(() => new Error("NotAllowedError"));
    const { ensureStyles, liveEditorCss } = load();

    expect(() => ensureStyles(lightColors)).not.toThrow();

    expect(styleElements()).toHaveLength(1);
    expect(styleElements()[0]?.textContent).toBe(liveEditorCss(lightColors));
  });

  test("a document that ignores the sheet falls back to the style element", () => {
    const adoption = installAdoption(() => []);
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);

    expect(adoption.list()).toHaveLength(0);
    expect(styleElements()).toHaveLength(1);
    expect(styleElements()[0]?.textContent).toBe(liveEditorCss(lightColors));
  });

  test("falls back to one style element where there is no API", () => {
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);
    ensureStyles(darkColors);

    expect(styleElements()).toHaveLength(1);
    expect(styleElements()[0]?.textContent).toBe(liveEditorCss(darkColors));
  });
});
