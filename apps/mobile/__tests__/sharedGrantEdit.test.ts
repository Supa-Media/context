/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A grant you may edit opens writable, and every other one reads.
 *
 * `SharedNoteShown` is mounted with the editor stubbed, so the test reads what
 * the page hands the editor: `canEdit`, reading mode, and whose save handler
 * it calls. The editor itself is the one every note uses and is tested there.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   canEdit always false                                           1
 *   pill always "Can read"                                         1
 *   onSave wired to the no-op for an editor                        1
 */

const editorProps: Record<string, unknown>[] = [];

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("../features/console/files/NoteEditor", () => ({
  NoteEditor: (props: Record<string, unknown>) => {
    editorProps.push(props);
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SharedNoteShown } =
  require("../features/console/shared/SharedNoteView") as typeof import("../features/console/shared/SharedNoteView");
const { editorReducer, emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
type GrantEditing = import("../features/console/shared/useGrantEditor").GrantEditing;

const PATH = "1-projects/plan.md";
const TEXT = "# Plan\n\nWords.\n";
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  editorProps.length = 0;
});

function mount(editing: GrantEditing | null): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(SharedNoteShown, {
        loaded: { kind: "note", path: PATH, text: TEXT },
        token: null,
        item: null,
        phone: false,
        now: 0,
        onList: () => {},
        onGo: () => {},
        editing,
      }),
    );
  });
  return host;
}

function editingWith(onSave: () => void): GrantEditing {
  const state = editorReducer(emptyEditor, {
    type: "opened",
    note: { path: PATH, text: TEXT, etag: "e1", visibility: "team", inherited: "team", exception: false, readOnly: false },
  });
  const nothing = () => {};
  return { state, onChange: nothing, onSave, onDiscard: nothing, onUseTheirs: nothing, onKeepMine: nothing };
}

describe("a granted note", () => {
  test("with edit, the editor is writable and saves through the grant", () => {
    const onSave = jest.fn();
    const page = mount(editingWith(onSave));
    const props = editorProps[editorProps.length - 1];
    expect(props.canEdit).toBe(true);
    expect(props.reading).toBe(false);
    (props.onSave as () => void)();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(page.textContent).toContain("Can edit");
  });

  test("without edit, it reads", () => {
    const page = mount(null);
    const props = editorProps[editorProps.length - 1];
    expect(props.canEdit).toBe(false);
    expect(props.reading).toBe(true);
    expect(page.textContent).toContain("Can read");
    expect(page.textContent).not.toContain("Can edit");
  });
});
