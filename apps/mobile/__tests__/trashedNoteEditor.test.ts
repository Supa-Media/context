/**
 * @jest-environment jsdom
 */

/**
 * A note in the trash, drawn in place (design A, `noteEditor/trashed.tsx`):
 * the editor is read-only whatever `canEdit` says, the line under the title
 * says who moved it, the page is dimmed, and a phone gets Restore at its foot
 * with the toolbar put away.
 *
 * Sabotage:
 *  - drop `trashed === undefined` from `editable` and the read-only case fails;
 *  - drop the `toolbarAway` trashed half and the phone case fails;
 *  - drop the byline from `flow.tsx` and both copy cases fail;
 *  - drop `trashed === undefined` from `flow.tsx`'s `ManifestNotice` arm and
 *    a trashed note opened by its address (read-only, as `showTrashedInstead`
 *    opens it) carries the privacy.md banner again (Dev2, 2026-10-14).
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

const accessory: boolean[] = [];
jest.mock("../features/app/AppFrame", () => {
  const actual = jest.requireActual("../features/app/AppFrame") as typeof import("../features/app/AppFrame");
  return {
    ...actual,
    useFrame: () => ({
      ...actual.useFrame(),
      setAccessoryOpen: (open: boolean) => void accessory.push(open),
    }),
  };
});

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
const { trashedLine } =
  require("../features/console/files/noteEditor/trashed") as typeof import("../features/console/files/noteEditor/trashed");

type EditorState = import("../features/console/files/editor").EditorState;
type TrashedView = import("../features/console/files/noteEditor/trashed").TrashedView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "1-projects/offsite-plan.md";
const FILE = ["Three days in Lisbon, the second week of March.", "", "Flights are cheapest on the Tuesday."].join("\n");

function stateFor(readOnly = false): EditorState {
  return { ...emptyEditor, status: "clean", path: PATH, baseline: FILE, draft: FILE, readOnly };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  lastProps = null;
  accessory.length = 0;
});

function mount(width: number, trashed?: TrashedView, readOnly = false): HTMLDivElement {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 900, configurable: true });
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
        state: stateFor(readOnly),
        canEdit: true,
        commenter: "@seyi",
        trashed,
        onChange: () => {},
        onSave: () => {},
        onDiscard: () => {},
        onUseTheirs: () => {},
        onKeepMine: () => {},
      }),
    );
  });
  return container;
}

const press = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("a trashed note on screen", () => {
  test("is read-only even for somebody who may edit, and keeps its text", () => {
    mount(1280, { byYou: true, byName: null, at: Date.now() });
    expect(lastProps!.editable).toBe(false);
    expect(lastProps!.value).toContain("Three days in Lisbon");
  });

  test("opened read-only by its address, it carries no privacy.md banner", () => {
    const banner = "generated from your visibility settings";
    expect(mount(1280, { byYou: true, byName: null, at: Date.now() }, true).textContent).not.toContain(banner);
    // The banner is still privacy.md's: a read-only note out of the trash keeps it.
    expect(mount(1280, undefined, true).textContent).toContain(banner);
  });

  test("an ordinary note in the same editor is still editable", () => {
    mount(1280);
    expect(lastProps!.editable).toBe(true);
  });

  test("says who moved it and when, under the title", () => {
    const view = mount(1280, { byYou: false, byName: "@ana", at: Date.now() - 3 * 60_000 });
    const line = view.querySelector('[data-testid="trashed-byline"]');
    expect(line?.textContent).toBe("@ana moved this to trash · 3 minutes ago");
  });

  test("the copy: you, just now; a name; nobody to name", () => {
    const now = 1_000_000_000;
    const say = (byYou: boolean, byName: string | null, at: number) => {
      const { who, rest } = trashedLine({ byYou, byName, at }, now);
      return who + rest;
    };
    expect(say(true, null, now)).toBe("You moved this to trash · just now");
    expect(say(false, "@ana", now - 2 * 60_000)).toBe("@ana moved this to trash · 2 minutes ago");
    expect(say(false, null, now)).toBe("Someone moved this to trash · just now");
  });

  test("a phone gets Restore at the foot of the note, the toolbar put away, and the pill over the title", () => {
    const onRestore = jest.fn();
    const view = mount(390, { byYou: true, byName: null, at: Date.now(), onRestore });
    expect(view.querySelector('[data-testid="in-trash-pill"]')?.textContent).toBe("In trash");
    // "Saved in your bucket" is not what a note in the trash is.
    expect(view.querySelector('[data-testid="note-durability"]')).toBeNull();
    expect(accessory[accessory.length - 1]).toBe(true);
    press(view.querySelector('[data-testid="trashed-restore-wide"]')!);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  test("a phone's ordinary note keeps its toolbar and has no Restore", () => {
    const view = mount(390);
    expect(view.querySelector('[data-testid="trashed-restore-wide"]')).toBeNull();
    expect(view.querySelector('[data-testid="note-durability"]')).not.toBeNull();
    expect(accessory.every((open) => !open)).toBe(true);
  });

  test("Restore does nothing until there is a trash key to restore from", () => {
    const view = mount(390, { byYou: true, byName: null, at: Date.now() });
    const button = view.querySelector('[data-testid="trashed-restore-wide"]')!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});
