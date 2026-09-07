/**
 * @jest-environment jsdom
 */

/**
 * Screenshots for two more of the editor-polish sweep's small, no-decision
 * items (`1-projects/context-lc-editor-polish/ux-sweep.md`):
 *
 *  - **A1** — the accessory bar had no bullet key, only a task checkbox.
 *  - **R2** — a read-only note on a pointer layout fell through to a raw,
 *    syntax-highlighted source view instead of Live Preview.
 *
 * Same technique as `design-shots.ts` and `editor-polish-shots.ts`: the
 * shipped component, rendered by react-dom into a real DOM, written out as a
 * self-contained `.html`, and photographed by Playwright — never a mock-up.
 *
 *     pnpm exec jest --testMatch '**\/scripts/editor-accessory-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(__dirname, "../../../docs/design/editor-polish");

const { NoteAccessory } = require("../features/console/files/NoteAccessory") as typeof import("../features/console/files/NoteAccessory");
const { LiveEditor } = require("../features/console/files/LiveEditor.web") as typeof import("../features/console/files/LiveEditor.web");
const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

function stampViewport(width: number, height: number): void {
  for (const [key, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function page(title: string, body: string, css: string, width: number, height: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

function mount(node: ReturnType<typeof createElement>, width: number, height: number): HTMLElement {
  stampViewport(width, height);
  container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root!.render(node);
  });
  return container;
}

function write(name: string, width: number, height: number): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(name, container!.innerHTML, css, width, height));
}

describe("editor-accessory shots", () => {
  test("A1 — the accessory bar carries a bulleted-list key", () => {
    const node = mount(
      createElement(NoteAccessory, { controls: () => null }),
      390,
      120,
    );
    // Asserted before it is photographed — design-shots.ts's own rule.
    expect(node.querySelector('[data-testid="note-accessory-bullet"]')).not.toBeNull();
    expect(
      node.querySelector('[data-testid="note-accessory-bullet"]')?.getAttribute("aria-label"),
    ).toBe("Bulleted list");
    write("accessory-bar", 390, 120);
  });

  test("R2 — a read-only note on a pointer layout renders through Live Preview", () => {
    const note = [
      "# A note you may read",
      "",
      "This is **formatted** prose, not a code face.",
      "",
      "- one",
      "- [[../3-resources/team]]",
    ].join("\n");
    const node = mount(
      createElement(LiveEditor, {
        value: note,
        editable: false,
        onChange: () => {},
        onSave: () => {},
        accessibilityLabel: "Read-only demo",
        // A read-only note is still a note somebody navigates *from* — R2 is
        // one renderer for reading and editing, not one renderer that can
        // also no longer follow a link. Wired the same way `NoteEditor`
        // wires it in the real app, unconditionally on `editable`.
        onOpenNote: () => {},
        onPressNote: () => {},
        notePath: "0-inbox/privacy.md",
        notePaths: ["0-inbox/privacy.md", "3-resources/team.md"],
      }),
      900,
      260,
    );
    // The old raw-source view drew `# `/`**` as text; Live Preview hides them.
    expect(node.textContent).not.toContain("**formatted**");
    expect(node.querySelector(".cm-lp-h1")).not.toBeNull();
    // And the link is still the followable kind, not plain text — a read-only
    // note is still a note somebody navigates from.
    expect(node.querySelector(".cm-note-link")).not.toBeNull();
    write("readonly-pointer", 900, 260);
  });
});
