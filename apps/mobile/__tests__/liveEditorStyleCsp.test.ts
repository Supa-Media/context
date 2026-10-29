/**
 * @jest-environment jsdom
 *
 * The live editor's rules reach the page without a `<style>` whose text
 * script writes, where the browser can adopt a constructed sheet: that text
 * is inline style to a Content Security Policy, and the CASA scan's
 * "CSP: style-src unsafe-inline" is what it would cost
 * (`features/console/files/liveEditorWeb/stylesheet.ts`).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `ensureStyles` without the `adoptStyles` call fails "adopts one sheet".
 *  2. `adoptStyles` appending the sheet on every call fails "replaces it".
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
  return loaded!;
}

const doc = document as Document & { adoptedStyleSheets?: unknown[] };
const realSheet = (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet;

afterEach(() => {
  delete doc.adoptedStyleSheets;
  (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = realSheet;
  document.head.innerHTML = "";
});

describe("the live editor's stylesheet", () => {
  test("adopts one sheet, and writes no style element, where the browser can", () => {
    doc.adoptedStyleSheets = [];
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = FakeSheet;
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);

    expect(document.getElementById("context-live-preview-styles")).toBeNull();
    expect(doc.adoptedStyleSheets).toHaveLength(1);
    expect((doc.adoptedStyleSheets[0] as FakeSheet).cssText).toBe(liveEditorCss(lightColors));
  });

  test("replaces it when the palette changes, rather than adding another", () => {
    doc.adoptedStyleSheets = [];
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = FakeSheet;
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);
    ensureStyles(darkColors);

    expect(doc.adoptedStyleSheets).toHaveLength(1);
    expect((doc.adoptedStyleSheets[0] as FakeSheet).cssText).toBe(liveEditorCss(darkColors));
  });

  test("falls back to one style element where it cannot", () => {
    const { ensureStyles, liveEditorCss } = load();

    ensureStyles(lightColors);
    ensureStyles(darkColors);

    const styles = document.head.querySelectorAll("style#context-live-preview-styles");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(liveEditorCss(darkColors));
  });
});
