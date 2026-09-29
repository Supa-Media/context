/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { prepareCopy } from "../features/feedback/screenshot.web";

/**
 * "Words hidden" is the whole promise of the report's screenshot: a tester can
 * send a picture of the screen without the note in it. html2canvas draws the
 * copy `prepareCopy` leaves, so this proves on that copy that no character of
 * any word survives, pictures are hidden, and the report dialog itself is not
 * in the picture — and that only "Show text" leaves the words.
 */

function page(): Document {
  const doc = document.implementation.createHTMLDocument("Context");
  doc.body.innerHTML = `
    <div id="tree"><span>Launch checklist</span><span>Order signage</span></div>
    <div contenteditable="true"><p>Secret plan for the <b>opening</b> night</p></div>
    <input id="field" value="typed words" />
    <img src="data:image/png;base64,AAAA" alt="face" />
    <div data-feedback-exclude="true"><p>Send feedback</p></div>
  `;
  return doc;
}

function visibleLetters(doc: Document): string {
  return (doc.body.textContent ?? "").replace(/[\s•]/g, "");
}

describe("the report's screenshot", () => {
  test("covers every word, leaving no letter of it", () => {
    const doc = page();
    prepareCopy(doc, { showText: false });
    expect(visibleLetters(doc)).toBe("");
    // The bars keep each word's length, so the layout still reads.
    expect(doc.body.textContent).toContain("•••••••");
  });

  test("hides pictures and field contents", () => {
    const doc = page();
    prepareCopy(doc, { showText: false });
    const css = Array.from(doc.querySelectorAll("style"))
      .map((style) => style.textContent)
      .join("\n");
    expect(css).toMatch(/img[^{]*\{\s*visibility: hidden/);
    expect(css).toMatch(/input, textarea, \[contenteditable\] \{ color: transparent/);
  });

  test("leaves the report dialog out of the picture", () => {
    const doc = page();
    prepareCopy(doc, { showText: false });
    expect(doc.querySelector("[data-feedback-exclude]")).toBeNull();
  });

  test("shows the words only when the person asked to", () => {
    const doc = page();
    prepareCopy(doc, { showText: true });
    expect(doc.body.textContent).toContain("Secret plan for the");
    expect(doc.querySelector("[data-feedback-exclude]")).toBeNull();
  });
});
