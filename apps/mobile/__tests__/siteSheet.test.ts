/**
 * A designed site's CSS as an adopted sheet (`features/site/website/siteSheet.ts`):
 * a style policy cannot refuse it, and where the browser cannot adopt, the
 * page keeps its `<style>` element rather than drawing unstyled.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import { adoptSiteSheet, canAdoptSheets } from "../features/site/website/siteSheet";

class FakeSheet {
  css = "";
  replaceSync(text: string) {
    this.css = text;
  }
}

function adoptingDocument(): Document & { adoptedStyleSheets: FakeSheet[] } {
  return { adoptedStyleSheets: [] } as unknown as Document & { adoptedStyleSheets: FakeSheet[] };
}

describe("a site's adopted stylesheet", () => {
  const real = (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet;
  afterEach(() => {
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = real;
  });

  it("is adopted with the site's CSS, and taken off again", () => {
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = FakeSheet;
    const doc = adoptingDocument();
    expect(canAdoptSheets(doc)).toBe(true);
    const release = adoptSiteSheet(".ctx-site h1{color:red}", doc);
    expect(release).not.toBeNull();
    expect(doc.adoptedStyleSheets.map((sheet) => (sheet as unknown as FakeSheet).css)).toEqual([".ctx-site h1{color:red}"]);
    release!();
    expect(doc.adoptedStyleSheets).toEqual([]);
  });

  it("leaves the document's other sheets where they are", () => {
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = FakeSheet;
    const doc = adoptingDocument();
    const editor = new FakeSheet();
    doc.adoptedStyleSheets.push(editor);
    const release = adoptSiteSheet("a{}", doc)!;
    expect(doc.adoptedStyleSheets).toHaveLength(2);
    release();
    expect(doc.adoptedStyleSheets).toEqual([editor]);
  });

  it("says it could not, where the browser has no constructable sheets", () => {
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = undefined;
    const doc = adoptingDocument();
    expect(canAdoptSheets(doc)).toBe(false);
    expect(adoptSiteSheet("a{}", doc)).toBeNull();
  });

  it("says it could not, where the document ignores the sheet it was given", () => {
    (globalThis as { CSSStyleSheet?: unknown }).CSSStyleSheet = FakeSheet;
    const doc = {} as Document & { adoptedStyleSheets: FakeSheet[] };
    let held: FakeSheet[] = [];
    Object.defineProperty(doc, "adoptedStyleSheets", { get: () => held, set: () => {} });
    expect(adoptSiteSheet("a{}", doc)).toBeNull();
    held = [];
  });
});
