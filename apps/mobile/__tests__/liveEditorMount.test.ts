/**
 * @jest-environment jsdom
 */

/**
 * THE LIVE EDITOR, MOUNTED.
 *
 * `livePreview.test.ts` proves the decoration logic without a DOM. This proves
 * the part that logic cannot: that a real CodeMirror instance and React's idea
 * of the document stay in agreement.
 *
 * There is one bug worth this whole file, and it is invisible to every test
 * that does not mount:
 *
 *   Editor fires `onChange` → parent re-renders with the same text → the effect
 *   writes it back into the editor → CodeMirror replaces the document → the
 *   selection resets.
 *
 * On screen that is **the caret jumping to the end of the document on every
 * keystroke**, and the editor is unusable. A string renderer sees none of it,
 * because nothing about the rendered output is wrong; what is wrong is that a
 * document was dispatched at all. So the tests below count dispatches and read
 * the selection, rather than asserting on markup.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { deleteCharBackward, insertNewline } from "@codemirror/commands";
import { forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { LiveEditor, type EditorControls } from "../features/console/files/LiveEditor.web";

/**
 * React logs a warning unless the environment claims act() support, and a
 * warning in a suite that is otherwise silent is noise somebody will learn to
 * ignore.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  /** Re-render with new props, the way the parent component would. */
  update: (props: Partial<Props>) => void;
  changes: string[];
  saves: number;
  /** The imperative handle, read at press time the way `NoteAccessory` does. */
  controls: () => EditorControls | null;
  /** Every handle this editor has handed out, `null`s included. */
  handles: (EditorControls | null)[];
  focus: boolean[];
  unmount: () => void;
}

interface Props {
  value: string;
  editable: boolean;
}

function mount(initial: Props): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const changes: string[] = [];
  const handles: (EditorControls | null)[] = [];
  const focus: boolean[] = [];
  const state = { saves: 0 };
  let props = initial;

  const render = () => {
    act(() => {
      root.render(
        createElement(LiveEditor, {
          value: props.value,
          editable: props.editable,
          onChange: (text: string) => changes.push(text),
          onSave: () => {
            state.saves += 1;
          },
          // A fresh arrow on every render, which is the normal way a parent
          // writes this — and the case the mount-only effect exists to survive.
          controls: (api: EditorControls | null) => handles.push(api),
          onFocus: () => focus.push(true),
          onBlur: () => focus.push(false),
          accessibilityLabel: "note markdown",
        }),
      );
    });
  };

  render();

  return {
    container,
    root,
    update: (next) => {
      props = { ...props, ...next };
      render();
    },
    changes,
    handles,
    focus,
    controls: () => handles[handles.length - 1] ?? null,
    get saves() {
      return state.saves;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  } as Mounted;
}

/**
 * The live `EditorView`, through CodeMirror's own public lookup.
 *
 * `EditorView.findFromDOM` rather than reaching for an internal handle on the
 * element: a test that pokes at internals passes or fails on a detail the
 * library never promised, and this one is asserting behaviour the library does
 * promise.
 */
function viewIn(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor");
  const view = dom === null ? null : EditorView.findFromDOM(dom as HTMLElement);
  if (view === null) throw new Error("no EditorView mounted");
  return view;
}

/**
 * Table grids in the decoration set, rather than in the DOM.
 *
 * CodeMirror renders only the viewport, so a widget below the fold is absent
 * from the DOM whether or not it was computed — asserting on `querySelector`
 * would pass for the wrong reason on a short note and fail for the wrong reason
 * on a long one. The decorations are the thing under test.
 */
function gridsIn(view: EditorView): number {
  let found = 0;
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { widget?: { constructor: { name: string } } };
      if (spec.widget?.constructor.name === "TableGridWidget") found += 1;
      iter.next();
    }
  }
  return found;
}

/** The editor's text, read out of the DOM CodeMirror actually built. */
function renderedText(container: HTMLElement): string {
  const content = container.querySelector(".cm-content");
  return content?.textContent ?? "";
}

describe("mounting", () => {
  test("the note's text is in the editor", () => {
    const m = mount({ value: "# Heading\n\nbody", editable: true });
    expect(renderedText(m.container)).toContain("Heading");
    m.unmount();
  });

  test("the accessibility label reaches the DOM", () => {
    const m = mount({ value: "x", editable: true });
    expect(m.container.querySelector('[aria-label="note markdown"]')).not.toBeNull();
    m.unmount();
  });

  test("unmounting destroys the view rather than leaking it", () => {
    const m = mount({ value: "x", editable: true });
    expect(m.container.querySelector(".cm-editor")).not.toBeNull();
    m.unmount();
    expect(m.container.querySelector(".cm-editor")).toBeNull();
  });
});

describe("React must not fight the editor", () => {
  /**
   * THE test this file exists for.
   *
   * The parent re-renders with the *same* text — which is what happens on every
   * keystroke once `onChange` has run — and the editor must not be written to.
   * If it is, the selection resets and the caret jumps to the end of the
   * document.
   */
  test("the parent echoing back what was just typed leaves the caret alone", () => {
    const m = mount({ value: "hello world", editable: true });
    const view = viewIn(m.container);

    // Type an X at position 5, the way a person would. The caret lands after
    // it, in the middle of the document.
    view.dispatch({
      changes: { from: 5, insert: "X" },
      selection: { anchor: 6 },
    });
    expect(view.state.doc.toString()).toBe("helloX world");
    expect(view.state.selection.main.head).toBe(6);

    // The reducer now re-renders with that same text. This is the echo, and it
    // is a *changed* prop — which is why an earlier version of this test, which
    // re-rendered with unchanged text, proved nothing: React skips the effect
    // entirely when the dependency is referentially equal, so the guard was
    // never reached and removing it did not fail anything.
    m.update({ value: "helloX world" });

    // Without the `value === latestValue.current` guard the effect replaces the
    // whole document here, and the caret is thrown to the end.
    expect(view.state.doc.toString()).toBe("helloX world");
    expect(view.state.selection.main.head).toBe(6);
    m.unmount();
  });

  /**
   * The other direction: text that genuinely came from outside — a different
   * note opened, a draft discarded, a conflict resolved with "load theirs" —
   * must land in the editor. Suppressing this to avoid the loop above would
   * mean opening a second note and seeing the first one's contents.
   */
  test("authoritative text from outside is written in", () => {
    const m = mount({ value: "first note", editable: true });
    m.update({ value: "second note entirely" });
    expect(renderedText(m.container)).toContain("second note entirely");
    m.unmount();
  });

  test("typing reaches onChange exactly once per change", () => {
    const m = mount({ value: "", editable: true });
    viewIn(m.container).dispatch({ changes: { from: 0, insert: "typed" } });

    expect(m.changes).toEqual(["typed"]);
    m.unmount();
  });
});

describe("editability", () => {
  test("a read-only note is not editable, and stays wired up", () => {
    const m = mount({ value: "text", editable: true });
    m.update({ editable: false });

    const view = viewIn(m.container);
    expect(view.state.facet(EditorView.editable)).toBe(false);

    /**
     * The important half of this test is the second assertion. Toggling
     * editability by replacing the whole configuration — which an earlier draft
     * did — silently rebuilds the update listener and detaches typing from
     * `onChange`. A compartment swaps one facet and leaves the listener alone,
     * so a change still reports after the swap.
     *
     * It used to make that change while read-only, which read as the tidier
     * test and stopped being possible when `editability` grew a `changeFilter`:
     * a read-only note now refuses the change itself, so an `onChange` after it
     * would mean the gate had failed rather than that the listener had
     * survived. Toggling back exercises the compartment twice instead, which is
     * the same claim proved harder.
     */
    m.update({ editable: true });
    view.dispatch({ changes: { from: 0, insert: "more " } });
    expect(m.changes).toEqual(["more text"]);
    m.unmount();
  });

  /**
   * The other half of the `changeFilter`, on the surface it was written for.
   *
   * `EditorState.readOnly` is what `@codemirror/view`'s drop, paste and cut
   * handlers consult, and it is what `deleteCharBackward` consults — but it is
   * a convention rather than a gate, and `@codemirror/commands` breaks it
   * itself: `insertNewline` replaces the selection and returns `true` without
   * looking. The filter is what makes "read-only" mean the document.
   */
  test("and nothing at all can change a read-only document", () => {
    const m = mount({ value: "text", editable: false });
    const view = viewIn(m.container);

    insertNewline(view);
    view.dispatch({ changes: { from: 0, insert: "INJECTED" } });

    expect(view.state.doc.toString()).toBe("text");
    expect(m.changes).toEqual([]);
    m.unmount();
  });
});

/**
 * A READING SURFACE THAT IS ONLY VISUALLY READ-ONLY.
 *
 * `EditorView.editable.of(false)` drops `contenteditable` and nothing else.
 * CodeMirror says so itself, in the installed source at
 * `@codemirror/view/dist/index.js`:
 *
 *   "Note that this doesn't affect API calls that change the editor content,
 *    even when those are bound to keys or buttons. See the `readOnly` facet
 *    for that."
 *
 * So the facet has to be set too, and `readOnly` in this product means
 * `privacy.md` — `OpenNote.readOnly` is `key === PRIVACY_KEY`, never "the
 * viewer lacks write access". A member reading a note they cannot write is
 * `editable: false` with `readOnly` unset, and before this the editing
 * commands, the `Mod-s` binding and the drop handler all still ran.
 *
 * Nothing here is a server-side breach: the control plane refuses the write.
 * What it costs is a viewer whose note silently diverges from the file, a Save
 * that lights up to fail — "a Save button that always fails is worse than no
 * Save button", in the console's own words — and, because CodeMirror only sets
 * `aria-readonly` when the facet is on, a screen reader telling a member the
 * note is editable.
 */
describe("a note the viewer may not write", () => {
  test("the readOnly facet tracks `editable`, not just `contenteditable`", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    expect(viewIn(m.container).state.readOnly).toBe(true);

    // ...and back, so this is about the prop rather than a constant.
    m.update({ editable: true });
    expect(viewIn(m.container).state.readOnly).toBe(false);
    m.unmount();
  });

  test("an editing command cannot change a note the viewer may not write", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const view = viewIn(m.container);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    // The path CodeMirror's own note is about: a command bound to a key, which
    // `EditorView.editable` does not stop.
    const before = view.state.doc.toString();
    const handled = deleteCharBackward(view);

    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
    expect(m.changes).toEqual([]);
    m.unmount();
  });

  test("and Mod-s on it does not fire a save that is going to be refused", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const before = m.saves;
    const content = m.container.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
    );
    expect(m.saves).toBe(before);

    // The binding still works where it should, so this is a gate rather than a
    // deletion — losing ⌘S for everybody would pass the assertion above.
    const editableMount = mount({ value: "# mine\n", editable: true });
    const editableContent = editableMount.container.querySelector(
      ".cm-content",
    ) as HTMLElement;
    editableContent.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
    );
    expect(editableMount.saves).toBe(1);

    m.unmount();
    editableMount.unmount();
  });

  /**
   * ...and it still swallows the browser's own Save-Page dialog while doing so.
   *
   * The check above counts saves, and a gate that returns `false` satisfies it
   * perfectly while handing ⌘S back to the browser — which is what the first
   * version of this fix did, on exactly the notes somebody is most likely to be
   * reading rather than writing. `privacy.md` was strictly worse than before it:
   * `save()` already refused the manifest, so the keystroke did nothing and
   * swallowed the dialog, and briefly did nothing and opened it.
   *
   * `preventDefault()` is called by CodeMirror only for a truthy return, and a
   * binding's own `preventDefault` defaults to false, so this is the difference
   * between a no-op and a browser dialog over the app.
   */
  test("and the keystroke is still swallowed, so no Save-Page dialog opens", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const content = m.container.querySelector(".cm-content") as HTMLElement;
    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(m.saves).toBe(0);
    m.unmount();
  });
});

/**
 * THE ACCESSORY BAR'S SEAM, ON THE HALF THAT HOLDS A REAL `EditorView`.
 *
 * `webviewBridge.test.ts` proves the same five verbs over the JSON bridge. This
 * proves them here — where there is no bridge and the handle points straight at
 * CodeMirror — because the two halves run the *same* `runCommand` and the thing
 * that would break silently is one of them not being wired to it.
 *
 * The bar itself never renders on this surface: it is compact-only, and a
 * pointer has a keyboard and the chords that come with it. What is tested here
 * is the contract underneath it.
 */
describe("the imperative handle", () => {
  test("arrives once, on mount, and is not re-handed on every render", () => {
    const m = mount({ value: "hello", editable: true });
    expect(m.handles).toHaveLength(1);
    expect(m.handles[0]).not.toBeNull();

    m.update({ value: "hello there" });
    m.update({ value: "hello there!" });
    expect(m.handles).toHaveLength(1);
    m.unmount();
  });

  /**
   * The `null` is not politeness. The bar outlives a note change on a phone,
   * and a handle held past unmount points at a destroyed `EditorView`, where
   * CodeMirror's `dispatch` throws rather than no-ops.
   */
  test("and is handed back as null before the view is destroyed", () => {
    const m = mount({ value: "hello", editable: true });
    m.unmount();
    expect(m.handles).toEqual([expect.anything(), null]);
  });

  test("wrap puts the markers round the selection and leaves it selected", () => {
    const m = mount({ value: "one two three", editable: true });
    const view = viewIn(m.container);
    act(() => view.dispatch({ selection: { anchor: 4, head: 7 } }));

    act(() => m.controls()?.wrap("**", "**"));

    expect(view.state.doc.toString()).toBe("one **two** three");
    expect(m.changes[m.changes.length - 1]).toBe("one **two** three");
    expect(view.state.selection.main.from).toBe(6);
    expect(view.state.selection.main.to).toBe(9);
    m.unmount();
  });

  test("toggleLinePrefix goes on and comes off the caret's line", () => {
    const m = mount({ value: "first\nsecond", editable: true });
    const view = viewIn(m.container);
    act(() => view.dispatch({ selection: { anchor: 8 } }));

    act(() => m.controls()?.toggleLinePrefix("# "));
    expect(view.state.doc.toString()).toBe("first\n# second");

    act(() => m.controls()?.toggleLinePrefix("# "));
    expect(view.state.doc.toString()).toBe("first\nsecond");
    m.unmount();
  });

  /**
   * One history, not two.
   *
   * This is the platform with a hardware keyboard, so `undo()` and ⌘Z have to
   * step through the same past. A value stack kept beside the editor would be a
   * second history that disagrees with the one the keymap drives.
   */
  test("undo and redo are the same history the keymap drives", () => {
    const m = mount({ value: "one", editable: true });
    const view = viewIn(m.container);
    act(() => view.dispatch({ changes: { from: 3, insert: " two" } }));
    expect(view.state.doc.toString()).toBe("one two");

    act(() => m.controls()?.undo());
    expect(view.state.doc.toString()).toBe("one");

    act(() => m.controls()?.redo());
    expect(view.state.doc.toString()).toBe("one two");
    m.unmount();
  });

  /**
   * The same bug the iOS half had, and it was here too: an authoritative
   * document replacement — a different note, a discarded draft, a resolved
   * conflict — used to land in the undo history, so one press of undo after
   * switching notes pulled the previous note back. See `replaceDocument`.
   */
  test("undo does not reach back into the note that was open before this one", () => {
    const m = mount({ value: "first note", editable: true });
    const view = viewIn(m.container);
    m.update({ value: "second note entirely" });

    act(() => m.controls()?.undo());
    act(() => m.controls()?.undo());
    expect(view.state.doc.toString()).toBe("second note entirely");
    m.unmount();
  });

  test("blur lets go of the editing surface", () => {
    const m = mount({ value: "hello", editable: true });
    const view = viewIn(m.container);
    act(() => view.focus());
    expect(m.focus[m.focus.length - 1]).toBe(true);

    act(() => m.controls()?.blur());
    expect(m.focus[m.focus.length - 1]).toBe(false);
    m.unmount();
  });

  /**
   * EVERY KEY ON THE BAR IS A PROGRAMMATIC EDIT.
   *
   * Which is what `EditorView.editable.of(false)` does not stop. The bar is not
   * rendered over a note the viewer may not write — `accessoryUp` takes
   * `editable` — and this is the refusal that does not depend on that staying
   * true, on the surface where the handle is a direct pointer at the view.
   */
  test("and none of them can change a note the viewer may not write", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const view = viewIn(m.container);
    act(() => view.dispatch({ selection: { anchor: 10, head: 14 } }));

    act(() => {
      const api = m.controls();
      api?.wrap("**", "**");
      api?.toggleLinePrefix("# ");
      api?.undo();
      api?.redo();
    });

    expect(view.state.doc.toString()).toBe("# secret\n\nbody");
    expect(m.changes).toEqual([]);
    m.unmount();
  });

  /** The dismiss key is the one that must never be refused. */
  test("except blur, which writes nothing", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const view = viewIn(m.container);
    act(() => view.focus());
    act(() => m.controls()?.blur());
    expect(m.focus).toEqual([true, false]);
    m.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE EYE REDRAWS THE NOTE, RATHER THAN ARMING THE NEXT CLICK TO REDRAW IT.
 *
 * Reading mode is not a repaint — several decorations are a function of
 * `state.readOnly`, and the two loudest are the ones a reader is there for: a
 * `form` fence becomes a form and a table becomes a grid only when the note
 * cannot be typed into (`formFences`, `tableGrids`, and `revealSelection`
 * behind both).
 *
 * The toggle reaches the editor as a **compartment reconfigure** and nothing
 * else: no document change, no selection change. `livePreview`'s state field
 * used to return its cached set unless one of those two had happened, so
 * pressing the eye left every read-mode decoration computed under the previous
 * value of `readOnly` — and the note stayed as its own source until the next
 * click put a cursor in it, which is exactly how it was reported.
 *
 * Every existing test of this logic builds a **fresh** `EditorState` with
 * `EditorState.readOnly.of(true)`, which runs the field's `create` and can
 * never see it. So this one has to mount and flip the prop, which is the only
 * way the transaction under test gets built at all.
 */
describe("toggling reading mode redraws the note on the spot", () => {
  const FORM = [
    "# Request a feature",
    "",
    "```form",
    "id: feature-requests",
    "responses: feature-requests-responses.md",
    "layout: table",
    "submit: member",
    "edit_own: true",
    "votes: named",
    "fields:",
    "  - { name: title, type: line, max: 120, required: true }",
    "```",
    "",
  ].join("\n");

  test("a form fence becomes a form with no click in between", () => {
    const m = mount({ value: FORM, editable: true });
    expect(m.container.querySelector(".cm-lp-form")).toBeNull();

    // The only thing that happens is the prop changing. No dispatch, no focus,
    // no selection — the same as pressing the eye and touching nothing.
    m.update({ editable: false });
    expect(m.container.querySelector(".cm-lp-form")).not.toBeNull();

    m.unmount();
  });

  test("a table becomes a grid on the same press", () => {
    const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const m = mount({ value: `# Notes\n\n${TABLE}`, editable: true });
    expect(m.container.querySelector(".cm-lp-grid")).toBeNull();

    m.update({ editable: false });
    const grid = m.container.querySelector(".cm-lp-grid table");
    expect(grid).not.toBeNull();
    // The header's own cells, rather than the dashes that described them.
    expect([...(grid?.querySelectorAll("th") ?? [])].map((th) => th.textContent)).toEqual(["a", "b"]);
    expect(grid?.textContent).not.toContain("---");

    m.unmount();
  });

  test("and turning it back off puts the source back, also with no click", () => {
    const m = mount({ value: FORM, editable: false });
    expect(m.container.querySelector(".cm-lp-form")).not.toBeNull();

    m.update({ editable: true });
    expect(m.container.querySelector(".cm-lp-form")).toBeNull();
    expect(renderedText(m.container)).toContain("layout: table");

    m.unmount();
  });

  /**
   * THE TREE IS THE THIRD INPUT, AND IT ARRIVES BY A FOURTH ROUTE.
   *
   * `decorationsFor` reads the document, the selection and `readOnly` — but it
   * reads all three *through the syntax tree*, and on a note of any size that
   * tree is not there yet. CodeMirror parses roughly the first three thousand
   * characters up front and finishes the rest as idle work, announcing each
   * advance with a transaction that carries no document change, no selection
   * and no change of `readOnly`.
   *
   * So a note long enough to matter — which is most notes worth reading —
   * would draw its first screen and leave everything below it as raw markdown
   * until something else happened to invalidate the set. Same symptom as the
   * eye doing nothing, one input over.
   *
   * The test forces the parse rather than waiting for the idle callback,
   * because the callback only advances as far as the *viewport* and a jsdom
   * editor has no height to scroll. What is being pinned is the predicate: a
   * transaction whose only news is a longer tree must rebuild the decorations.
   */
  test("a table below the first parsed chunk becomes a grid when the parse reaches it", () => {
    const filler = Array.from(
      { length: 140 },
      (_, index) => `Paragraph ${index} of ordinary prose in this note.`,
    ).join("\n\n");
    const doc = `${filler}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n`;

    const m = mount({ value: doc, editable: false });
    const view = viewIn(m.container);

    // The premise: the note really is longer than the first parse.
    expect(syntaxTreeAvailable(view.state, doc.length)).toBe(false);
    expect(gridsIn(view)).toBe(0);

    act(() => {
      forceParsing(view, doc.length, 5000);
    });

    expect(syntaxTree(view.state).length).toBe(doc.length);
    expect(gridsIn(view)).toBe(1);

    m.unmount();
  });

  /**
   * The narrow reading of the bug is "recompute on a reconfigure". The rule is
   * "recompute when the answer can have changed", and `readOnly` is the only
   * part of the configuration these decorations read — so a reconfigure that
   * leaves it alone must not throw the set away. The decorations are rebuilt
   * from the tree on every recompute, and doing that on configuration changes
   * that cannot matter is work on a path that already runs per keystroke.
   */
  test("a reconfigure that does not touch readOnly is not a redraw", () => {
    const m = mount({ value: FORM, editable: false });
    const before = m.container.querySelector(".cm-lp-form");
    expect(before).not.toBeNull();

    // Same value in: `editability(false)` again, a real reconfigure transaction
    // whose answer is identical.
    m.update({ editable: false });
    // The same DOM node, not an equal one — a rebuilt widget would lose
    // whatever somebody had typed into it. See `FormWidget.eq`.
    expect(m.container.querySelector(".cm-lp-form")).toBe(before);

    m.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE PALETTE THIS HALF DECLARES AND THE PALETTE ITS STYLES READ ARE THE SAME
 * SET.
 *
 * Everything drawn inside the editor names its colours as `--lp-*` custom
 * properties rather than as values, because the identical rules run inside the
 * iOS WebView where the palette arrives over a bridge (`webview/host.ts`'s
 * `themeVars`). That only works while both hosts declare the whole set.
 *
 * The bug this exists to stop shipped, and shipped invisibly: `--lp-content`
 * and `--lp-body` were declared by the guest and not by this half. An unknown
 * custom property makes its *whole declaration* invalid at computed-value time
 * — it is not an error and it is not a fallback to something sensible — so
 * `color: var(--lp-content)` silently became `inherit`, and CodeMirror's own
 * base theme (`li[aria-selected] { background: #17c; color: white }`) won the
 * completion list instead. That is white ink on the light ground, in a
 * dropdown, on the surface most people use. On a phone it was correct the whole
 * time, which is why looking at the app never found it.
 *
 * So this asserts the relationship rather than the two lists: mount the editor,
 * read every stylesheet actually in the document, and require that every
 * property any of them *reads* is one `ensureStyles` *declares*. A rule added
 * later that reaches for `--lp-danger` fails here rather than in a screenshot.
 */
describe("every --lp-* the editor's styles read is one this half declares", () => {
  /**
   * The `--lp-*` properties the **base** `.cm-lp-root` rule declares.
   *
   * Deliberately not "declared anywhere in the sheet". The compact media query
   * re-declares `--lp-content` at the phone measure, and counting that would
   * let a property that exists only inside the query pass this test while being
   * undefined at every width above the breakpoint — which is the desktop
   * console, which is where the bug was reported. The first `.cm-lp-root {` in
   * the sheet is the unconditional one; brace-matching from it takes that block
   * and nothing nested after it.
   */
  function declaredIn(css: string): Set<string> {
    const open = css.indexOf(".cm-lp-root {");
    if (open === -1) return new Set();
    let depth = 0;
    let end = open;
    for (let at = css.indexOf("{", open); at < css.length; at += 1) {
      if (css[at] === "{") depth += 1;
      else if (css[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = at;
          break;
        }
      }
    }
    const block = css.slice(open, end);
    return new Set([...block.matchAll(/(--lp-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  }

  /** The `--lp-*` properties read by `var()` anywhere in a block of CSS. */
  function readIn(css: string): Set<string> {
    return new Set([...css.matchAll(/var\(\s*(--lp-[a-z0-9-]+)/g)].map((m) => m[1]));
  }

  /**
   * Every stylesheet in the document, as text.
   *
   * CodeMirror's `EditorView.theme` goes in through `style-mod`, which may use
   * `insertRule` rather than `textContent` — so both are read. Taking them out
   * of the live document rather than importing the modules is the point: a
   * theme this file forgot to import would be a hole in the guard, and a theme
   * the editor really mounts cannot be.
   */
  function stylesheetsInDocument(): string {
    const sheets: string[] = [];
    for (const element of [...document.querySelectorAll("style")]) {
      const text = element.textContent ?? "";
      if (text !== "") {
        sheets.push(text);
        continue;
      }
      const sheet = (element as HTMLStyleElement).sheet;
      if (sheet === null) continue;
      try {
        for (const rule of [...sheet.cssRules]) sheets.push(rule.cssText);
      } catch {
        // A stylesheet jsdom will not enumerate is one this guard skips rather
        // than fails on; the interesting ones are all readable.
      }
    }
    return sheets.join("\n");
  }

  test("nothing reads a property that was never set", () => {
    const m = mount({ value: "# note\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", editable: true });

    const ours = document.getElementById("context-live-preview-styles");
    expect(ours).not.toBeNull();
    const declared = declaredIn(ours?.textContent ?? "");

    // The four the bug was about, named so a regression says which is missing
    // rather than only that one is.
    for (const property of ["--lp-content", "--lp-bg", "--lp-body", "--lp-mono"]) {
      expect([...declared]).toContain(property);
    }

    const missing = [...readIn(stylesheetsInDocument())].filter(
      (property) => !declared.has(property),
    );
    expect(missing).toEqual([]);

    m.unmount();
  });

  /**
   * The completion list is the surface the bug was reported on, so it is named
   * rather than left to the sweep above: it is themed by `linkComplete.ts`,
   * which is a different file from the one that declares the palette, and that
   * distance is the whole reason the two drifted.
   */
  test("including the completion list, which is themed in another file", () => {
    const m = mount({ value: "x", editable: true });
    const declared = declaredIn(
      document.getElementById("context-live-preview-styles")?.textContent ?? "",
    );

    const completion = stylesheetsInDocument()
      .split("\n")
      .filter((line) => line.includes("tooltip-autocomplete") || line.includes("cm-completion"))
      .join("\n");
    // If this is empty the guard below proves nothing — the theme did not mount.
    expect(completion).not.toBe("");

    for (const property of readIn(completion)) expect([...declared]).toContain(property);
    m.unmount();
  });

  /**
   * The reading measure is a `--lp-*` like any other, so it is subject to the
   * sweep above — but it is the first one that is not a colour or a face, and
   * a missing colour is at least visible. A missing *measure* is a note that
   * still looks fine and reads at 150 characters a line, which is the failure
   * this whole change exists to stop, so it is named here too.
   */
  test("including the reading measure, which the iOS host also has to send", () => {
    const m = mount({ value: "# note\n\nprose\n", editable: true });
    const declared = declaredIn(
      document.getElementById("context-live-preview-styles")?.textContent ?? "",
    );
    expect([...declared]).toContain("--lp-measure");
    m.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE NOTE IS A COLUMN, NOT THE WIDTH OF THE WINDOW.
 *
 * Measured in Chromium at 1440x900 before this existed: the element holding
 * the first sentence of the console's own demo note was 1160px wide, with
 * `max-width: none` on every one of its first eight ancestors — about 150
 * characters to a line, twice a comfortable measure. It survived because the
 * fixture note was hard-wrapped in `placeholderData.ts`, so every screenshot
 * showed a tidy column that the layout had nothing to do with.
 *
 * jsdom does not lay anything out, so these assert the *rules* and
 * `e2e/webkit/readingMeasure.spec.ts` asserts the rendered result in a real
 * engine at both viewports. Both are needed: a rule that is present and does
 * not bind is exactly what was there before.
 */
describe("the rendered note has a reading measure", () => {
  /**
   * One rule's declarations, by its selector, out of the mounted stylesheet.
   *
   * Comments are stripped rather than left in: these rules carry long ones,
   * and a test asserting a property is *absent* would otherwise be satisfied
   * or defeated by prose about it.
   */
  function block(selector: string): string {
    const css = (
      document.getElementById("context-live-preview-styles")?.textContent ?? ""
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf(`${selector} {`);
    if (at === -1) return "";
    return css.slice(at, css.indexOf("}", at));
  }

  test("the column is measured and centred, and it is the column rather than the line", () => {
    const m = mount({ value: "# note\n\nprose\n", editable: true });

    const content = block(".cm-lp-root .cm-content");
    expect(content).toContain("padding-inline: max(0px, calc((100% - var(--lp-measure)) / 2))");

    /*
      Padding rather than `max-width: var(--lp-measure); margin-inline: auto`,
      which draws the identical column. Measured in Chromium: the max-width
      recipe leaves `.cm-content` 572px wide inside a 1192px pane, and a click
      in the 310px either side lands on `.cm-scroller` and does not focus the
      editor — half the note's apparent area stops being the editing surface.
      With padding the element stays full width, so CodeMirror still maps a
      click in the margin to the nearest position.
    */
    expect(content).not.toContain("max-width");

    /*
      On `.cm-content` rather than on `.cm-line`: a table, a form and a
      rendered diagram are block children of the same element, and measuring
      the lines alone would leave each of those starting at a different left
      edge from the paragraph above it. If a future edit moves the constraint
      down to the line, this is the test that should have to be deleted
      deliberately.
    */
    expect(block(".cm-lp-root .cm-line")).not.toContain("max-width");

    m.unmount();
  });

  /**
   * WHAT IS ALLOWED TO BE WIDER THAN THE PROSE: nothing.
   *
   * A table is the case with a real argument on the other side — twelve
   * columns in 68 characters is cramped — and it still loses, because a block
   * wider than the text it sits between has to start left of that text, and a
   * document with two left edges reads as broken layout rather than as a wide
   * table. What a wide table gets instead is its own horizontal scroller, so
   * it stays inside the column and the note never scrolls sideways as a whole.
   */
  test("a table wider than the measure scrolls inside the column rather than widening it", () => {
    const m = mount({
      value: "# note\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
      editable: false,
    });

    // The rendered grid really is on screen: without this the rules below are
    // about a selector nothing matches.
    expect(document.querySelectorAll(".cm-lp-grid").length).toBeGreaterThan(0);

    expect(block(".cm-lp-grid")).toContain("overflow-x: auto");
    // And the table inside it is sized by its content up to the column's own
    // width — never past it, which is what would drag the column open.
    expect(block(".cm-lp-grid-table")).toContain("max-width: 100%");

    m.unmount();
  });
});
