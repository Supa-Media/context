/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import { emptyEditor } from "../features/console/files/editor";

/**
 * THE FILE TREE'S HEADER IS QUIET UNTIL SOMEBODY COMES NEAR IT.
 *
 * The column's job is to be a legible list of names. Above that list sat four
 * lit icon buttons and an empty bordered input — six boxes of chrome, at rest,
 * over a list of about twenty rows. Nothing in the header is pressed often
 * enough to earn a resting pixel, and together they were the loudest thing in
 * the quietest region.
 *
 * So the header draws on approach: the buttons fade in when the pointer enters
 * the column, and the filter gains its border and its fill at the same moment.
 * At rest what is left is the word `Filter` in muted type, which reads as the
 * column's label.
 *
 * **This behaviour shipped with no test at all**, which is the reason this file
 * exists rather than a second reason for it: `features/app/frame.ts` and this
 * repository's testing rule both say a guard nobody has checked is not a guard,
 * and "it fades" is precisely the kind of claim that goes on passing a green
 * suite while somebody deletes the condition.
 *
 * ## What is asserted here, and what is asserted in a browser
 *
 * jsdom lays nothing out, so none of this is a layout assertion. What it can
 * resolve is react-native-web's injected stylesheet, and the *resting* state
 * lives entirely there: `opacity: 0` on the tools, a transparent border and no
 * fill on the field.
 *
 * **The approach itself cannot be driven here, and that was measured rather
 * than assumed.** `View`'s `onPointerEnter` is a real pointer event, and jsdom
 * defines no `PointerEvent` constructor at all — a dispatched `MouseEvent`
 * named `pointerenter` reaches nothing, and a test built on one would report
 * the feature broken while Chromium drew it correctly. So the lit half is
 * `e2e/webkit/explorerChrome.spec.ts`, measured in a real engine; what is here
 * is the state a screenshot of the console shows, plus the two structural
 * rules that make fading the right technique at all.
 *
 * That split is the same one `readingMeasure.spec.ts` makes and for a
 * neighbouring reason: this repository's unit suite cannot see layout, and its
 * browser suite is where the facts that need an engine go.
 */

const METRICS =
  initialWindowMetrics ??
  ({
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
  } as never);

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const noop = () => {};

/**
 * The least `FileBrowser` the header reads.
 *
 * `canEdit` decides whether the four buttons are offered at all, so it is
 * `true` here — a column with nothing to fade would make every case below pass
 * by finding nothing, which is the shape of vacuity this file is guarding
 * against in the first place.
 */
function browser(): FileBrowser {
  return {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "note" as const,
            path: "index.md",
            name: "index.md",
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: noop,
    selectedPath: null,
    select: noop,
    deselect: () => true,
    editor: emptyEditor,
    setDraft: noop,
    save: noop,
    useTheirs: noop,
    keepMine: noop,
    conflict: null,
    resolveWith: noop,
    discard: noop,
    notice: null,
    dismissNotice: noop,
    toasts: [],
    dismissToast: noop,
    clipboard: null,
    copy: noop,
    cut: noop,
    paste: noop,
    createNote: noop,
    createFolder: noop,
    rename: noop,
    move: noop,
    duplicate: noop,
    archive: noop,
    destroy: noop,
    setVisibility: noop,
  } as unknown as FileBrowser;
}

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(Explorer, { files: browser(), contextLabel: "@somebody" }),
      ),
    );
  });
  return container;
}

/** The resolved value react-native-web actually gave this node. */
function styleOf(node: Element, property: string): string {
  return window.getComputedStyle(node).getPropertyValue(property);
}

/**
 * Is this colour nothing?
 *
 * react-native-web normalises `"transparent"` to `rgba(0,0,0,0.00)` and jsdom
 * hands that back with its own spacing depending on how it round-trips, so the
 * three spellings are one fact and matching on a literal is a test that fails
 * on a version bump rather than on a regression.
 */
function invisible(colour: string): boolean {
  return /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0(\.0+)?\s*\))$/.test(colour.trim());
}

const filterOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="explorer-filter"]')!;

/** The group the four buttons are faded as one. */
const toolsOf = (container: HTMLElement) =>
  filterOf(container).parentElement!.lastElementChild!;

/* -------------------------------------------------------------------------- */

describe("the tree's header at rest", () => {
  test("the tools are invisible and the filter has no box", () => {
    const container = mount();

    expect(styleOf(toolsOf(container), "opacity")).toBe("0");
    // `transparent`, not absent: a border that arrives would move the header
    // 2pt under the hand reaching for it.
    expect(styleOf(filterOf(container), "border-top-width")).toBe("1px");
    expect(invisible(styleOf(filterOf(container), "border-top-color"))).toBe(true);
  });

  test("but the field is a real field, and the buttons are still in the tree", () => {
    /*
      The reason this is opacity rather than a mount: chrome that leaves the
      tree is chrome a keyboard cannot tab to, and a toolbar that grows its
      buttons back under the pointer is a layout jumping under the hand.
    */
    const container = mount();

    const filter = filterOf(container);
    expect(filter.tagName.toLowerCase()).toBe("input");
    expect(filter.getAttribute("aria-label")).toBe("Filter notes and folders");
    expect(filter.getAttribute("placeholder")).toBe("Filter");

    expect(toolsOf(container).querySelectorAll('[role="button"]').length).toBeGreaterThan(0);
  });
});

describe("a field somebody is using is not chrome", () => {
  test("focus gives it its box, and blur takes it back", () => {
    /*
      Tabbing to the filter must not land the caret in something that looks
      like a heading. `focusin`, not `focus`: React attaches at the root and
      listens for the bubbling pair, so a non-bubbling `focus` dispatched at
      the node reaches no handler — which is a way to write this test green
      against a component with no `onFocus` at all.
    */
    const container = mount();
    const filter = filterOf(container);

    act(() => {
      filter.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(invisible(styleOf(filter, "border-top-color"))).toBe(false);

    act(() => {
      filter.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(invisible(styleOf(filter, "border-top-color"))).toBe(true);
  });
});
