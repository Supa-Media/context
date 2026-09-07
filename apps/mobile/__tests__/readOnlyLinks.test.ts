/**
 * @jest-environment jsdom
 */

/**
 * R2's other half: a read-only note renders through the same Live Preview
 * renderer as an editable one, and that renderer's links still work.
 *
 * `noteEditorReadOnly.test.ts` proves `NoteEditor` reaches for `LiveEditor`
 * rather than the old raw-source view on a read-only pointer layout, but it
 * stubs `LiveEditor` itself, so it cannot see whether a link inside that
 * renderer is still followable once editing is switched off. This mounts the
 * real `editorExtensions` — the same configuration both `LiveEditor` hosts
 * share — with `editable: false`, the shape `privacy.md` and every shared
 * note actually reach the editor in, and drives a real ⌘-click the way
 * `editorLinks.test.ts` does for the editable case.
 *
 * Two things matter here, not one: the link opens, *and* nothing about
 * driving it wrote to the buffer — the read-only path has to stay unable to
 * write no matter which control is pressed.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../features/console/files/editorSetup";
import type { NoteLinkRef } from "../features/console/files/noteLinks";

const NOTE = "0-inbox/privacy.md";
const TARGET = "3-resources/team.md";
// Position 0 has to be inside the link — jsdom lays nothing out, so every
// mouse event below resolves to position 0 regardless of clientX/clientY.
const DOC = "[[../3-resources/team]] is who can see this note.";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
});

function mount(editable: boolean) {
  const opened: string[] = [];
  const links: NoteLinkRef = {
    current: { path: NOTE, paths: [NOTE, TARGET], onOpen: (path) => opened.push(path), onPress: () => {} },
  };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: editorExtensions({
        editable,
        editableCompartment: new Compartment(),
        handlers: { current: { onChange: () => {}, onSave: () => {} } },
        links,
      }),
    }),
    parent,
  });
  views.push(view);
  return { view, opened };
}

function metaMousedown(): MouseEvent {
  return new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    clientX: 1,
    clientY: 1,
    metaKey: true,
  });
}

describe("R2 — a read-only note keeps its links followable", () => {
  test("a read-only note still opens a ⌘-clicked link", () => {
    const { view, opened } = mount(false);
    view.contentDOM.dispatchEvent(metaMousedown());
    expect(opened).toEqual([TARGET]);
  });

  test("an editable note opens the same link the same way — the read-only case is not special-cased into brokenness", () => {
    const { view, opened } = mount(true);
    view.contentDOM.dispatchEvent(metaMousedown());
    expect(opened).toEqual([TARGET]);
  });

  test("following the link on a read-only note does not write to the buffer", () => {
    const { view, opened } = mount(false);
    view.contentDOM.dispatchEvent(metaMousedown());
    expect(opened).toEqual([TARGET]);
    expect(view.state.doc.toString()).toBe(DOC);
  });
});
