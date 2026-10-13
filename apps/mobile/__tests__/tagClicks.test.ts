/**
 * @jest-environment jsdom
 */

/**
 * A #TAG DRAWN IN A NOTE SHOWS THE NOTES CARRYING IT WHEN IT IS CLICKED OR TAPPED.
 *
 * The board the owner was shown with inline tags (2026-10-13): a tag is drawn
 * as one, and pressing it is how you get to the others. The click is read the
 * way a link's is, off the drawn element, so a tag the caret is in (drawn as
 * plain text, `livePreview/tags.test.ts`) takes the click as text. The native host re-checks what the web
 * view sends, since the guest is the side that would be compromised.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `targetUnder` never asks `tagUnder`                     2
 *   the host's `open-tag` case drops its `isTagBody` check  1
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview, markdownLanguage } from "../features/console/files/livePreview";
import { noteLinks, type NoteLinkContext } from "../features/console/files/noteLinks";
import { createHostBridge } from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";

const DOC = "#bible-character and more words\n\nend";

function mount(options: { canOpen?: boolean } = {}) {
  const tags: string[] = [];
  const ref: { current: NoteLinkContext } = {
    current: {
      path: "3-resources/bible/barnabas.md",
      onOpen: () => {},
      ...(options.canOpen === false ? {} : { onOpenTag: (tag: string) => tags.push(tag) }),
    },
  };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [markdownLanguage(), livePreview(), noteLinks(ref)],
    }),
    parent,
  });
  return {
    tags,
    tag: () => view.contentDOM.querySelector<HTMLElement>(".cm-lp-tag"),
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
});

function mouse(): MouseEvent {
  return new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 1, clientY: 1, button: 0 });
}

function touch(type: string, points: { clientX: number; clientY: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const key of ["touches", "targetTouches", "changedTouches"]) {
    Object.defineProperty(event, key, { value: points });
  }
  return event;
}

describe("pressing a drawn tag", () => {
  test("a click opens the tag, and is claimed", () => {
    mounted = mount();
    const event = mouse();
    mounted.tag()!.dispatchEvent(event);
    expect(mounted.tags).toEqual(["bible-character"]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a tap opens it too", () => {
    mounted = mount();
    mounted.tag()!.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.tag()!.dispatchEvent(touch("touchend", []));
    expect(mounted.tags).toEqual(["bible-character"]);
  });

  test("a surface with nowhere to show tags leaves it as text", () => {
    mounted = mount({ canOpen: false });
    mounted.tag()!.dispatchEvent(mouse());
    expect(mounted.tags).toEqual([]);
  });
});

describe("the native host re-checks what the web view asks it to show", () => {
  function host() {
    const shown: string[] = [];
    const bridge = createHostBridge(() => {}, {
      onChange: () => {},
      onSave: () => {},
      onOpenTag: (tag) => shown.push(tag),
    });
    const ask = (tag: unknown) => bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "open-tag", tag }));
    return { shown, ask };
  }

  test("a tag reaches the sink", () => {
    const { shown, ask } = host();
    ask("bible-character");
    expect(shown).toEqual(["bible-character"]);
  });

  test("anything that is not a tag is refused", () => {
    const { shown, ask } = host();
    ask("2026");
    ask("has space");
    ask("x".repeat(201));
    ask(42);
    expect(shown).toEqual([]);
  });
});
