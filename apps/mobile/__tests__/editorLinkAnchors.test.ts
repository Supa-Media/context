/**
 * @jest-environment jsdom
 */

/**
 * FOLLOWING A LINK TO A PLACE INSIDE A NOTE, AGAINST A REAL EDITOR.
 *
 * `[[day#msg-…|label]]` opens the day *at that message*. Split from
 * `editorLinks.test.ts`, which proves following itself; the helpers here are
 * that file's, kept identical.
 *
 * ## Sabotage record
 *
 *   the tap's copy of the link drops its anchor                     1
 *   `follow` drops the anchor for click and tap alike               2
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { noteLinks, type NoteLinkContext, type NoteLinkOpen } from "../features/console/files/noteLinks";

afterEach(() => {
  jest.useRealTimers();
});

/** A mouse event jsdom will resolve inside the first line. */
function mouse(type: string): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1, clientY: 1, button: 0 });
}

/** A touch event jsdom does not construct on its own (see `editorLinks.test.ts`). */
function touch(type: string, points: { clientX: number; clientY: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const key of ["touches", "targetTouches", "changedTouches"]) {
    Object.defineProperty(event, key, { value: points });
  }
  return event;
}
/**
 * A link that names a place inside a note opens the note *there*: the anchor
 * reaches `onOpen` from a click and from a tap alike. The tap keeps its own
 * copy of the link between `touchstart` and `touchend`, and that copy is
 * where the anchor was lost — the WebKit case in `commsInbox.spec.ts` found it.
 */
describe("the place a link names travels with it", () => {
  const DAY = "0-inbox/email/a/2026/09/2026-09-07.md";
  function anchored() {
    const opened: [string, string | undefined][] = [];
    const ref = {
      current: {
        path: "0-inbox/contacts/a/adam.md",
        onOpen: (path: string, _mode: NoteLinkOpen, anchor?: string) => opened.push([path, anchor]),
      } satisfies NoteLinkContext,
    };
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "[[0-inbox/email/a/2026/09/2026-09-07#msg-0123abcd|Board]] on the day",
        extensions: [noteLinks(ref)],
      }),
      parent,
    });
    const link = view.contentDOM.querySelector<HTMLElement>(".cm-note-link")!;
    return { opened, link, destroy: () => (view.destroy(), parent.remove()) };
  }

  test("a click", () => {
    const { opened, link, destroy } = anchored();
    link.dispatchEvent(mouse("mousedown"));
    expect(opened).toEqual([[DAY, "msg-0123abcd"]]);
    destroy();
  });

  test("a tap", () => {
    jest.useFakeTimers();
    const { opened, link, destroy } = anchored();
    link.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    link.dispatchEvent(touch("touchend", []));
    expect(opened).toEqual([[DAY, "msg-0123abcd"]]);
    destroy();
  });
});
