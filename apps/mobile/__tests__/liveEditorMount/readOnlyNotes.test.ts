/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { deleteCharBackward } from "@codemirror/commands";
import { mount, viewIn } from "./fixtures";

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
