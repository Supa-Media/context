/**
 * @jest-environment jsdom
 */

/**
 * Screenshots for three of the editor-polish sweep's "cheap keymap and
 * attribute wins" (`1-projects/context-lc-editor-polish/ux-sweep.md`):
 * K1 (Tab indents a list), P1 (spellcheck is on) and R3 (a fenced code block
 * is highlighted by its own language).
 *
 * Same technique as `design-shots.ts` and for the same reason stated there:
 * `LiveEditor.web.tsx` is rendered by react-dom into a real DOM, written out
 * as a self-contained `.html` with every stylesheet CodeMirror and the app
 * inject, and Playwright opens it and takes the picture — nothing here is
 * screenshotting a mock-up, it is the shipped component with a fixed note in
 * it.
 *
 * Not run by `pnpm test` — same as `design-shots.ts`, `jest.config.js` only
 * matches `__tests__/`:
 *
 *     pnpm exec jest --testMatch '**\/scripts/editor-polish-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 390;
const HEIGHT = 844;
const OUT = resolve(__dirname, "../../../docs/design/editor-polish");

const { LiveEditor } = require("../features/console/files/LiveEditor.web") as typeof import("../features/console/files/LiveEditor.web");
const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};

const NOTE = [
  "# Editor polish",
  "",
  "- one",
  "- two",
  "",
  "```js",
  "// running total",
  "const total = 1 + 2;",
  "```",
  "",
].join("\n");

function page(title: string, body: string, css: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

/** Mount `LiveEditor` with a fixed note, write the page, and return the view. */
function mount(): HTMLDivElement {
  container = document.createElement("div");
  container.style.width = `${WIDTH}px`;
  container.style.height = `${HEIGHT}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root!.render(
      createElement(LiveEditor, {
        value: NOTE,
        editable: true,
        onChange: () => {},
        onSave: () => {},
        accessibilityLabel: "Editor polish demo",
      }),
    );
  });
  const view = (container.querySelector(".cm-content") as HTMLElement | null)?.closest(
    ".cm-editor",
  ) as HTMLElement | null;
  expect(view).not.toBeNull();
  return container as HTMLDivElement;
}

function write(name: string, body: string): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(name, body, css));
}

describe("editor-polish shots", () => {
  test("R3 — a JS fence is highlighted; K1/P1 — the surface Tab and spellcheck act on", () => {
    const node = mount();
    // Asserts the surface is what it claims before photographing it — the
    // rule `design-shots.ts` learned the hard way (see its own header).
    expect(node.querySelector(".cm-lp-code-keyword")?.textContent).toBe("const");
    expect(node.querySelector(".cm-lp-code-comment")?.textContent).toContain("running total");
    expect(node.querySelector(".cm-content")?.getAttribute("spellcheck")).toBe("true");
    write("editing", node.innerHTML);
  });
});
