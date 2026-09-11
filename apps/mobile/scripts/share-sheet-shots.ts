/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the rebuilt share sheet, for the five-move sweep the owner
 * asked for after "this shared dialogue doesn't really make sense to me".
 *
 * Same technique as `design-shots.ts` and `editor-accessory-shots.ts`: the
 * shipped component, rendered by react-dom into a real DOM, written out as a
 * self-contained `.html`, and photographed by Playwright — never a mock-up. A
 * picture of a component nobody ships is worth nothing in a review.
 *
 *     pnpm exec jest --testMatch '**\/scripts/share-sheet-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(__dirname, "../../../docs/design/share-sheet");

const { ShareDialog } = require("../features/console/files/ShareDialog") as typeof import("../features/console/files/ShareDialog");
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

function mount(node: ReturnType<typeof createElement>, width: number, height: number): void {
  stampViewport(width, height);
  container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root!.render(node);
  });
}

/** The sheet is a `Modal`: react-native-web portals it outside the container. */
const sheet = () => document.body.querySelector<HTMLElement>('[aria-label^="Share "]');
const byId = (testId: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function press(node: HTMLElement | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function type(node: HTMLElement | null, value: string): void {
  if (node === null) throw new Error("nothing to type into");
  act(() => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function write(name: string, width: number, height: number): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  // The sheet, not the empty container it portalled out of.
  writeFileSync(file, page(name, sheet()!.outerHTML, css, width, height));
}

const MEMBERS = [
  { userId: "u1", role: "owner", name: "seyi@example.invalid", isMe: true },
  { userId: "u2", role: "editor", name: "agent@example.invalid", isMe: false },
  { userId: "u3", role: "editor", name: "dimelu@example.invalid", isMe: false },
  { userId: "u4", role: "editor", name: "shyoh@example.invalid", isMe: false },
];

const GROUPS = [{ name: "supa-leads", label: "leads", liveCount: 2 }];

function dialog(overrides: Record<string, unknown> = {}) {
  return createElement(ShareDialog as never, {
    path: "2-areas/apps/ai-brain/overview.md",
    shares: [],
    origin: "https://example.invalid",
    onShare: () => {},
    onCopyLink: async () => ({ ok: true, message: null }),
    onRevoke: () => {},
    onSetPreviewTitle: () => {},
    onClose: () => {},
    onShareWithGroup: () => {},
    onRemovalRoute: () => {},
    onCreateGroup: () => {},
    onSetScope: () => {},
    groupSlug: "supa",
    entryKind: "file",
    groups: GROUPS,
    access: { visibility: "team", exception: false, members: MEMBERS },
    ...overrides,
  } as never);
}

describe("share sheet shots", () => {
  /** The sheet at rest: audience named, every person carrying a verb. */
  test("at rest, on a phone", () => {
    mount(dialog(), 390, 844);
    // Asserted before it is photographed — `design-shots.ts`'s own rule.
    expect(byId("share-audience")).not.toBeNull();
    expect(byId("share-access-remove-u3")).not.toBeNull();
    expect(byId("share-make-group")).not.toBeNull();
    write("sheet-at-rest", 390, 844);
  });

  /**
   * The defect that started this: typing a colleague's name produced an empty
   * box, because every member of the context was excluded from the list.
   */
  test("typing a name offers people, groups and a way to make one", () => {
    mount(dialog({ access: { visibility: "private", exception: true, members: MEMBERS } }), 390, 844);
    type(document.body.querySelector('[aria-label="Share with"]'), "d");
    expect(byId("share-suggestions")).not.toBeNull();
    write("sheet-typing", 390, 844);
  });

  /** Somebody who already reaches the note is shown and marked, never hidden. */
  test("a name that already has access is answered rather than swallowed", () => {
    mount(dialog(), 390, 844);
    type(document.body.querySelector('[aria-label="Share with"]'), "dimelu");
    expect(byId("share-reaching-u3")).not.toBeNull();
    write("sheet-already-has-access", 390, 844);
  });

  /** The two honest routes, with their blast radius on each. */
  test("removing somebody offers routes, not a button that picks one silently", () => {
    mount(dialog(), 390, 844);
    press(byId("share-access-remove-u3"));
    expect(byId("share-route-note-private")).not.toBeNull();
    expect(byId("share-route-workspace-remove")).not.toBeNull();
    write("sheet-removal-routes", 390, 844);
  });

  /** The step the padlock used to take on one unlabelled tap. */
  test("going public asks first", () => {
    mount(dialog(), 390, 844);
    press(byId("share-audience-anyone"));
    expect(byId("share-confirm-public")).not.toBeNull();
    write("sheet-going-public", 390, 844);
  });

  /** A group, made from the note that needed it. */
  test("a group can be made here", () => {
    mount(dialog(), 390, 844);
    press(byId("share-make-group"));
    expect(byId("share-group-maker")).not.toBeNull();
    press(byId("share-group-pick-u3"));
    write("sheet-new-group", 390, 844);
  });
});
