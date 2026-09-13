/**
 * @jest-environment jsdom
 */

/**
 * EVERY DIALOG ACTION ROW IS DRAWN AT ONE SIZE.
 *
 * The defect, in the owner's words: "why is one of the buttons so much
 * bigger". `Confirm` drew `Cancel` with `Button`'s default `mini` variant
 * (6/12 padding, a 12.5pt label) and its confirm with `white` — the **landing
 * page's hero CTA** (14/27 padding, a 15.5pt label, and a white glow). Over
 * twice the padding in both axes, side by side, inside a 460pt card. The same
 * pair sat in `NamePrompt` and `MovePicker`, so it was three sites of one
 * mistake rather than one dialog to patch.
 *
 * Primary is a matter of weight and colour, never of size: a confirm button
 * physically twice the area of Cancel does not read as "this one is the
 * default", it reads as a layout bug — and on the archive dialog the oversized
 * one is the destructive half.
 *
 * ## Why this is a render test and not a unit test on a style object
 *
 * The failure is geometric and lives in whatever `Button` maps a variant to.
 * Asserting on an exported constant would pass for a dialog that never uses
 * it — which is exactly how the three sites drifted apart in the first place.
 * `react-native-web` injects real CSS and jsdom computes it, so these read the
 * padding off the buttons a person actually presses.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. 6 checks in this file.
 *
 *   `Confirm`'s confirm put back to `variant="white"`                        1
 *     — one dialog, one failure, which is the file's reason for covering
 *       all three: patching the dialog somebody complained about would
 *       have left the other two failing here rather than silently wrong
 *   `dialogPrimary` given its own `paddingHorizontal`, drifting from the     3
 *     shared constant
 *   `dialogPrimary`'s label variant swapped back to `cta`                    3
 *   `dialogPrimary` given `dialog`'s own fill — primary stops reading as     3
 *     primary — caught by the distinguishability half below
 *
 * Nudging the shared `DIALOG_ACTION` constant itself is **not** detected, and
 * should not be: moving both halves together is a taste decision about how
 * large a dialog's buttons are, which is the one thing this file has no
 * opinion on. What it holds is that the two agree.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { Confirm, MovePicker, NamePrompt } from "../features/console/files/Dialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * Mounts a dialog and hands back `document.body`.
 *
 * `Shell` renders through `Modal`, which `react-native-web` portals to the
 * body — asserting against the mount container would be a test that passes on
 * a dialog drawing nothing.
 */
function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return document.body;
}

interface Box {
  paddingTop: string;
  paddingBottom: string;
  paddingLeft: string;
  paddingRight: string;
  borderTopWidth: string;
  fontSize: string;
}

/** The drawn box of the button with this label, plus the size of its words. */
function box(host: HTMLElement, label: string): Box {
  const button = host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  if (button === null) throw new Error(`no button labelled ${label}`);
  const style = getComputedStyle(button);
  const text = button.firstElementChild as HTMLElement | null;
  if (text === null) throw new Error(`the button labelled ${label} drew no label`);
  return {
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    // Part of the drawn box: a bordered button beside an unbordered one of the
    // same padding is 2pt wider and 2pt taller than it.
    borderTopWidth: style.borderTopWidth,
    fontSize: getComputedStyle(text).fontSize,
  };
}

/** Which of the two a person can tell apart without a ruler. */
function fill(host: HTMLElement, label: string): string {
  const button = host.querySelector(`[aria-label="${label}"]`) as HTMLElement;
  return getComputedStyle(button).backgroundColor;
}

/**
 * The three dialogs, each named with its own cancel and confirm labels.
 *
 * `MovePicker`'s confirm starts disabled — nothing is chosen yet — which is
 * irrelevant to its geometry and is the state the dialog opens in, so it is
 * the state worth measuring.
 */
const DIALOGS: Array<{ name: string; cancel: string; confirm: string; render: () => ReturnType<typeof createElement> }> = [
  {
    name: "Confirm",
    cancel: "Cancel",
    confirm: "Archive it",
    render: () =>
      createElement(Confirm, {
        title: "Archive",
        body: "It moves into 4-archive/. Nothing is deleted.",
        confirmLabel: "Archive it",
        onCancel: () => {},
        onConfirm: () => {},
      }),
  },
  {
    name: "NamePrompt",
    cancel: "Cancel",
    confirm: "Create",
    render: () =>
      createElement(NamePrompt, {
        title: "New note",
        confirmLabel: "Create",
        onCancel: () => {},
        onConfirm: () => {},
      }),
  },
  {
    name: "MovePicker",
    cancel: "Cancel",
    confirm: "Move here",
    render: () =>
      createElement(MovePicker, {
        title: "Move note.md",
        folders: ["", "1-projects"],
        currentFolder: "",
        onCancel: () => {},
        onConfirm: () => {},
      }),
  },
];

describe("a dialog's two actions are the same size", () => {
  for (const dialog of DIALOGS) {
    test(`${dialog.name} draws Cancel and its confirm identically`, () => {
      const host = mount(dialog.render());
      expect(box(host, dialog.confirm)).toEqual(box(host, dialog.cancel));
    });
  }
});

describe("and the confirm still reads as the primary one", () => {
  for (const dialog of DIALOGS) {
    test(`${dialog.name}'s confirm is filled differently from Cancel`, () => {
      // The other half of the rule. Making the two identical is trivially
      // achievable by making them the *same* button, and that is a different
      // defect: primary has to survive in weight and colour, since it no
      // longer survives in size.
      const host = mount(dialog.render());
      expect(fill(host, dialog.confirm)).not.toEqual(fill(host, dialog.cancel));
    });
  }
});
