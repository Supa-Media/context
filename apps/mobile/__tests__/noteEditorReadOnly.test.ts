/**
 * @jest-environment jsdom
 */

/**
 * R2 IN THE SWEEP: READ-ONLY NOTES GET A DIFFERENT RENDERER ON DESKTOP.
 *
 * `NoteEditor.tsx`'s own comment records that this branch — `editable ||
 * compact` — "used to branch on `editable`" alone, was narrowed once to spare
 * a phone, and names the finish: "narrowing it to nothing". Until this file,
 * a *pointer* layout still fell through to `highlightMarkdown`'s raw source
 * view for any note a member may read but not write — `privacy.md`, or any
 * note in a context somebody was invited into as a viewer — with no links, no
 * headings, no lists, while a phone reading the identical note already got
 * the real Live Preview. Two answers to "what does this file look like".
 *
 * `LiveEditor` is stubbed here for the same reason `noteProperties.test.ts`
 * stubs it: what is under test is which renderer `NoteEditor` reaches for,
 * not CodeMirror's own DOM.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

let lastProps: { value: string; editable: boolean } | null = null;
jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: { value: string; editable: boolean }) => {
    lastProps = props;
    return null;
  },
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "privacy.md";
const FILE = ["# Privacy", "", "Who can see what, and why."].join("\n");

function stateFor(): EditorState {
  return { ...emptyEditor, status: "clean", path: PATH, baseline: FILE, draft: FILE };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  lastProps = null;
});

/** A pointer layout at the given width, canEdit as given — see noteProperties.test.ts. */
function mount(width: number, canEdit: boolean): HTMLDivElement {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(NoteEditor, {
        state: stateFor(),
        canEdit,
        onChange: () => {},
        onSave: jest.fn() as () => void,
        onDiscard: () => {},
        onUseTheirs: () => {},
        onKeepMine: () => {},
      }),
    );
  });
  return container;
}

describe("R2 — a read-only note is read by the same renderer everywhere", () => {
  test("a pointer layout reads a note it may not write through LiveEditor, not the raw-source view", () => {
    mount(1280, false);
    expect(lastProps).not.toBeNull();
    expect(lastProps!.editable).toBe(false);
    expect(lastProps!.value).toContain("Who can see what");
  });

  test("a phone already did this, and keeps doing it", () => {
    mount(390, false);
    expect(lastProps).not.toBeNull();
    expect(lastProps!.editable).toBe(false);
  });

  test("an editable note on a pointer layout is unaffected", () => {
    mount(1280, true);
    expect(lastProps).not.toBeNull();
    expect(lastProps!.editable).toBe(true);
  });
});
