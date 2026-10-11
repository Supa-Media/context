/**
 * @jest-environment jsdom
 *
 * Note text is read in Libron, and nothing else is (decided by the owner,
 * 2026-10-11: "only update the text inside notes"). The interface keeps
 * Instrument Sans, and so does a published website page, which is drawn by
 * the same renderer as a shared note. See docs/decisions/app-and-console/
 * design-tokens-and-interaction.md, "Note text is read in Libron".
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fonts, lightColors } from "../features/design/tokens";
import { ensureStyles } from "../features/console/files/liveEditorWeb/stylesheet";
import { NoteBody, type NoteLook } from "../features/share/NoteBody";
import { parseNote } from "../features/share/markdown";

// react-native-web's sheet, which react-native's types do not declare.
const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const NOTE = "# Plan\n\nA paragraph.\n\n#### A small heading\n\n- an item\n\n> a quote\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";

function faces(look: NoteLook): string[] {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(NoteBody, { blocks: parseNote(NOTE).blocks, look })));
  const texts = [...container.querySelectorAll("*")].filter((node) =>
    [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent!.trim() !== ""),
  );
  expect(texts.length).toBeGreaterThan(5);
  // jsdom does not cascade react-native-web's atomic classes, so walk up to
  // the nearest element that sets a font-family class and read the rule back
  // out of the sheet it was injected in. Inline runs inherit their block's.
  const sheet = StyleSheet.getSheet().textContent;
  const own = (node: Element): string | undefined =>
    [...node.classList]
      .map((name) => new RegExp(`\\.${name}\\{font-family:([^;}]+)`).exec(sheet)?.[1])
      .filter((family): family is string => family !== undefined)
      .pop();
  return texts.map((node) => {
    for (let at: Element | null = node; at !== null && at !== container; at = at.parentElement) {
      const family = own(at);
      if (family !== undefined) return family;
    }
    return "";
  });
}

describe("the tokens", () => {
  test("reading is Libron with a serif stand-in; the interface faces are not", () => {
    expect(fonts.reading).toMatch(/^Libron, /);
    expect(fonts.reading).toContain("serif");
    expect(fonts.body).toContain("Instrument Sans");
    expect(fonts.display).toContain("Instrument Sans");
    expect(fonts.body).not.toContain("Libron");
    expect(fonts.display).not.toContain("Libron");
  });
});

describe("the note editor", () => {
  function rule(css: string, selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  }

  test("the note's text and the blocks inside it are Libron; the title-line status is not", () => {
    ensureStyles(lightColors);
    const css = [...document.head.querySelectorAll("style")].map((node) => node.textContent).join("\n");
    expect(rule(css, ".cm-lp-root .cm-scroller")).toContain(`font-family: ${fonts.reading};`);
    expect(css).toContain(`--lp-body: ${fonts.reading};`);
    expect(rule(css, ".cm-lp-root .cm-lp-title-note")).toContain(`font-family: ${fonts.body};`);
  });
});

describe("a rendered note", () => {
  test("a shared note's every line of text is Libron", () => {
    const families = faces("note");
    expect(families.every((family) => family.startsWith("Libron"))).toBe(true);
  });

  test.each(["site", "siteWide"] as const)("a %s page keeps the site's own voice", (look) => {
    const families = faces(look);
    expect(families.every((family) => family !== "")).toBe(true);
    expect(families.some((family) => family.includes("Libron"))).toBe(false);
  });
});
