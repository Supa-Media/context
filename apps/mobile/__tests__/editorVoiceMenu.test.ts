/**
 * @jest-environment jsdom
 */

/**
 * RIGHT-CLICK IN A NOTE, AND THE TWO ROWS THE OWNER ASKED FOR.
 *
 * *"dictating inside of a note should also be a thing still doe, just have
 * people right click inside a note, and then have an option to dictate
 * notes."* — the owner, on the desktop design. The second row came with it,
 * because the caret is where both belong: one puts words in, the other asks
 * about the words already there.
 *
 * `editorMenu.test.ts` proves which rows exist under which conditions.
 * This is the wiring — that pressing them reaches the microphone and the
 * panel, and that the menu itself still stands down where it always did.
 *
 * ## The two things a rendered editor can say that a pure function cannot
 *
 *  1. **The rows are absent when nothing is behind them.** The flags come from
 *     whether the *props* are supplied, read at menu time through a ref rather
 *     than from a closure captured when the view was created — a note going
 *     read-only, or a window narrowing out of the density that has a panel,
 *     both change the answer under a mounted editor.
 *  2. **Shift-right-click still reaches the browser.** The editor's own menu
 *     is never the only menu; spelling suggestions live in the browser's and
 *     nowhere else. Adding rows must not quietly take that away.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `canDictate`/`canAsk` read from the closure instead of through
 *     `handlers.current`, in the `contextmenu` listener.
 *     → **1 fails**: `a capability removed under a mounted editor stops
 *     suppressing the browser`.
 *
 *     It failed **nothing** on the first run, and the reason is the finding.
 *     The rows are computed at *render*, where the closure is current, so a
 *     stale listener is invisible everywhere except the one decision the
 *     listener alone makes: whether to `preventDefault` at all. The test above
 *     was added to reach it. A version of this file without it would have
 *     called the ref unnecessary and deleted it.
 *  2. The `ask` arm calling `current.focus()` like every other arm.
 *     → **0 fail**, and it is recorded because the check that would have
 *     caught it is about a keyboard covering a panel on a narrow window, which
 *     jsdom cannot see. The comment in `LiveEditor.web.tsx` is the whole guard
 *     there, and this record is the note that it is not a tested one.
 *  3. The `dictate` arm handing over a hard-coded `0` instead of the caret.
 *     → **1 fails**: `dictation is asked for at the caret, not at a constant`.
 *
 *     Also nothing, on the first run, and also because the test was too weak:
 *     it asserted `Number.isInteger`, which `0` satisfies. The caret is now
 *     moved to a known offset first, which is the strongest thing jsdom can
 *     say here — it performs no layout, so "wherever the click landed" is not
 *     assertable at all.
 */

import { describe, expect, jest, test } from "@jest/globals";

// The menu reads the notch. A provider would be a second thing under test;
// the insets are the platform's business, not this menu's.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { LiveEditor } from "../features/console/files/LiveEditor.web";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Props {
  editable?: boolean;
  onDictate?: (at: number) => void;
  onAsk?: () => void;
}

function mount(initial: Props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let props: Props = initial;

  const render = () => {
    act(() => {
      root.render(
        createElement(LiveEditor, {
          value: "# Pricing\n\nWe moved to $5 on 12 September.\n",
          editable: props.editable ?? true,
          onChange: () => {},
          onSave: () => {},
          accessibilityLabel: "note markdown",
          onDictate: props.onDictate,
          onAsk: props.onAsk,
        }),
      );
    });
  };
  render();

  const content = () => container.querySelector<HTMLElement>(".cm-content");

  /**
   * Put the caret somewhere, so "the caret" is a number a constant cannot
   * accidentally equal. jsdom cannot turn a click into a position, so this
   * dispatches the selection the way the editor's own commands do.
   */
  const moveCaretTo = (at: number) => {
    const node = content();
    if (node === null) throw new Error("the editor has no content node");
    const view = EditorView.findFromDOM(node);
    if (view === null) throw new Error("no editor view");
    act(() => {
      view.dispatch({ selection: { anchor: at } });
    });
  };

  /** Right-click in the note, the way a pointer does. */
  const rightClick = (options: { shiftKey?: boolean } = {}) => {
    const node = content();
    if (node === null) throw new Error("the editor has no content node");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
      shiftKey: options.shiftKey ?? false,
    });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  };

  const rowLabels = () =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')].map(
      (row) => row.textContent ?? "",
    );

  const pressRow = (label: string) => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')].find(
      (node) => (node.textContent ?? "").includes(label),
    );
    if (row === undefined) throw new Error(`no menu row containing ${label}`);
    act(() => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  return {
    container,
    rightClick,
    moveCaretTo,
    rowLabels,
    pressRow,
    update: (next: Props) => {
      props = { ...props, ...next };
      render();
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the rows are there when there is something behind them", () => {
  test("a console editor offers both", () => {
    const editor = mount({ onDictate: () => {}, onAsk: () => {} });
    editor.rightClick();
    const labels = editor.rowLabels().join(" ");
    expect(labels).toContain("Dictate here");
    expect(labels).toContain("Ask about this note");
    editor.unmount();
  });

  test("an editor with neither offers neither", () => {
    const editor = mount();
    editor.rightClick();
    const labels = editor.rowLabels().join(" ");
    expect(labels).not.toContain("Dictate here");
    expect(labels).not.toContain("Ask about this note");
    // ...and the formatting rows it always had are untouched.
    expect(labels).toContain("Bold");
    editor.unmount();
  });

  /**
   * The flags are read at menu time, not when the view was created. A note
   * going read-only under a mounted editor is the ordinary case — an autosave
   * conflict, a membership change — and a closure captured at creation would
   * offer Dictate on a note that had since become somebody else's to read.
   */
  test("a note that goes read-only under a mounted editor loses the row", () => {
    const editor = mount({ onDictate: () => {}, onAsk: () => {} });
    editor.rightClick();
    expect(editor.rowLabels().join(" ")).toContain("Dictate here");

    editor.update({ onDictate: undefined });
    editor.rightClick();
    expect(editor.rowLabels().join(" ")).not.toContain("Dictate here");
    // Asking survives, because asking is not a write.
    expect(editor.rowLabels().join(" ")).toContain("Ask about this note");
    editor.unmount();
  });
});

describe("pressing them", () => {
  /**
   * The caret, not a placeholder.
   *
   * jsdom performs no layout, so `posAtCoords` cannot turn the click into a
   * position and the caret stays where it was — which makes "wherever the
   * click landed" unassertable here. What *is* assertable, and is the thing
   * that would break, is that the number handed over is the editor's **live
   * caret** rather than a constant: the first draft of this checked
   * `Number.isInteger`, which a hard-coded `0` passes, and the sabotage run
   * said so.
   */
  test("dictation is asked for at the caret, not at a constant", () => {
    const at: number[] = [];
    const editor = mount({ onDictate: (position) => at.push(position), onAsk: () => {} });

    editor.moveCaretTo(12);
    editor.rightClick();
    editor.pressRow("Dictate here");

    expect(at).toEqual([12]);
    editor.unmount();
  });

  test("asking reaches the panel and hands over no question", () => {
    let asked = 0;
    const editor = mount({ onDictate: () => {}, onAsk: () => (asked += 1) });
    editor.rightClick();
    editor.pressRow("Ask about this note");

    expect(asked).toBe(1);
    editor.unmount();
  });
});

describe("what adding rows must not take away", () => {
  /**
   * Spelling suggestions live in the browser's own menu and nowhere else, and
   * spellcheck is on in this editor by decision. The escape hatch was there
   * before these rows and has to survive them.
   */
  test("Shift-right-click still reaches the browser", () => {
    const editor = mount({ onDictate: () => {}, onAsk: () => {} });
    const event = editor.rightClick({ shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(editor.rowLabels()).toHaveLength(0);
    editor.unmount();
  });

  /**
   * A read-only note with nothing selected and nothing to ask has no verbs at
   * all, and the right behaviour is to let the browser's menu open rather than
   * suppress it for an empty box. The rule predates these rows; this is the
   * check that they did not quietly make the list non-empty.
   */
  test("an empty menu is still no menu", () => {
    const editor = mount({ editable: false });
    const event = editor.rightClick();

    expect(event.defaultPrevented).toBe(false);
    expect(editor.rowLabels()).toHaveLength(0);
    editor.unmount();
  });

  /**
   * The case that catches a stale handler, and the only one that can.
   *
   * The `contextmenu` listener is attached once when the view is created, so
   * its closure is a year old by the time somebody right-clicks — which is
   * what `handlers.current` is for. Everywhere else a stale answer is
   * invisible, because the *rows* are computed at render and only the
   * `empty` decision comes from the listener.
   *
   * Here they disagree in the way that matters: a read-only note whose `onAsk`
   * has gone has no verbs, so the browser's menu must open. A listener reading
   * a closure from creation still thinks there is a row, suppresses the
   * browser's menu, and opens an empty box — which is the rule
   * `rowInteractions.web.ts` states for the tree, broken here.
   */
  test("a capability removed under a mounted editor stops suppressing the browser", () => {
    const editor = mount({ editable: false, onAsk: () => {} });
    // With something to offer, the editor's own menu opens.
    expect(editor.rightClick().defaultPrevented).toBe(true);
    expect(editor.rowLabels().join(" ")).toContain("Ask about this note");

    editor.update({ onAsk: undefined });
    const event = editor.rightClick();

    expect(event.defaultPrevented).toBe(false);
    expect(editor.rowLabels()).toHaveLength(0);
    editor.unmount();
  });
});
