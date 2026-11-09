/**
 * @jest-environment jsdom
 */

/**
 * HOLDING A LINK OPENS ITS MENU.
 *
 * Owner, 2026-11-09: "for links can't it be a long hold to open a menu". With
 * Show Markdown off, a link's address is never on screen, so the menu is how
 * it is changed: Open, Edit link (the Link sheet, over the link's words),
 * Remove link (the words stay), Copy link.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the late `touchend` no longer fires the hold                       1
 *   the selection path (iOS) no longer fires the hold                  1
 *   `applyLink` writes `text` instead of the held link's `label`       2
 *   the bridge passes a held link without checking its address         1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview, markdownLanguage } from "../features/console/files/livePreview";
import { noteLinks, type NoteLinkContext } from "../features/console/files/noteLinks";
import { decodeHeldLink, heldForEdit, holdLink, linkLabel, unlinkHeld, type HeldLink } from "../features/console/files/linkHold";
import { applyLink, requestLinkEdit } from "../features/console/files/linkSelection";
import { linkHoldActions } from "../features/console/files/LinkHoldMenu";
import { createHostBridge } from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";

describe("the words a link shows", () => {
  test("a link's label, a wiki link's alias or name", () => {
    expect(linkLabel("[the mint](https://example.com)")).toBe("the mint");
    expect(linkLabel("[[areas/garden/Basil]]")).toBe("Basil");
    expect(linkLabel("[[areas/garden/Basil|my basil]]")).toBe("my basil");
    expect(linkLabel("[plan](../plan.md)")).toBe("plan");
  });

  test("a bare address has no words apart from itself", () => {
    expect(linkLabel("https://example.com")).toBeNull();
    expect(linkLabel("<https://example.com>")).toBeNull();
  });
});

function viewOf(doc: string, onHold?: (link: HeldLink) => void, opened: string[] = []) {
  const ref: { current: NoteLinkContext } = {
    current: {
      path: "1-projects/a/note.md",
      onOpen: (path) => opened.push(path),
      onOpenUrl: (url) => opened.push(url),
      ...(onHold === undefined ? {} : { onHold }),
    },
  };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdownLanguage(), livePreview(), noteLinks(ref)] }),
    parent,
  });
  return { view, destroy: () => (view.destroy(), parent.remove()) };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  jest.useRealTimers();
});

describe("Remove link and Edit link act on the link that was held", () => {
  test("Remove link keeps the words, caret after them", () => {
    const mounted = viewOf("near [the mint](https://example.com) end");
    cleanup = mounted.destroy;
    const { view } = mounted;
    const held = holdLink(view, { from: 5, to: 36, url: "https://example.com" });
    expect(held).toEqual({ label: "the mint", url: "https://example.com", removable: true });
    unlinkHeld(view);
    expect(view.state.doc.toString()).toBe("near the mint end");
    expect(view.state.selection.main.head).toBe("near the mint".length);
  });

  test("a link changed since it was held is left alone", () => {
    const mounted = viewOf("near [the mint](https://example.com) end");
    cleanup = mounted.destroy;
    const { view } = mounted;
    holdLink(view, { from: 5, to: 36, url: "https://example.com" });
    view.dispatch({ changes: { from: 6, to: 9, insert: "a" } });
    unlinkHeld(view);
    expect(view.state.doc.toString()).toBe("near [a mint](https://example.com) end");
  });

  test("Edit link: the sheet names the words, and the pick replaces the whole link", () => {
    const mounted = viewOf("near [the mint](https://example.com) end");
    cleanup = mounted.destroy;
    const { view } = mounted;
    holdLink(view, { from: 5, to: 36, url: "https://example.com" });
    const asked: string[] = [];
    requestLinkEdit(view, heldForEdit(view.state)!, (text) => asked.push(text));
    expect(asked).toEqual(["the mint"]);
    applyLink(view, { kind: "url", url: "https://mint.example" });
    expect(view.state.doc.toString()).toBe("near [the mint](https://mint.example) end");
  });

  test("a wiki link edited to a note keeps its words as the alias", () => {
    const mounted = viewOf("see [[areas/garden/Basil]] today");
    cleanup = mounted.destroy;
    const { view } = mounted;
    holdLink(view, { from: 4, to: 26, path: "areas/garden/Basil.md" });
    requestLinkEdit(view, heldForEdit(view.state)!, () => {});
    applyLink(view, { kind: "note", target: "areas/garden/Mint" });
    expect(view.state.doc.toString()).toBe("see [[areas/garden/Mint|Basil]] today");
  });
});

function touch(type: string, points: { clientX: number; clientY: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const key of ["touches", "targetTouches", "changedTouches"]) {
    Object.defineProperty(event, key, { value: points });
  }
  return event;
}

describe("the gesture", () => {
  const DOC = "[site](https://example.com/) trailing words";
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function press() {
    const held: HeldLink[] = [];
    const opened: string[] = [];
    const mounted = viewOf(DOC, (link) => held.push(link), opened);
    cleanup = mounted.destroy;
    const link = mounted.view.contentDOM.querySelector<HTMLElement>(".cm-lp-link")!;
    link.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    return { view: mounted.view, link, held, opened };
  }

  test("a tap still opens the link, and opens no menu", () => {
    const { link, held, opened } = press();
    now += 120;
    link.dispatchEvent(touch("touchend", []));
    expect(opened).toEqual(["https://example.com/"]);
    expect(held).toEqual([]);
  });

  test("a finger held still and lifted late opens the menu, not the link", () => {
    const { link, held, opened } = press();
    now += 700;
    const end = touch("touchend", []);
    link.dispatchEvent(end);
    expect(held).toEqual([{ label: "site", url: "https://example.com/", removable: true }]);
    expect(opened).toEqual([]);
    expect(end.defaultPrevented).toBe(true);
  });

  test("a finger that moves is a scroll", () => {
    const { link, held } = press();
    link.dispatchEvent(touch("touchmove", [{ clientX: 1, clientY: 40 }]));
    now += 700;
    link.dispatchEvent(touch("touchend", []));
    expect(held).toEqual([]);
  });

  test("iOS: the platform claims the touch and selects inside the words, and that is the hold", async () => {
    const { view, link, held } = press();
    now += 350;
    link.dispatchEvent(touch("touchcancel", []));
    view.dispatch({ selection: EditorSelection.range(1, 5), userEvent: "select.pointer" });
    await Promise.resolve();
    expect(held).toHaveLength(1);
    expect(held[0]!.label).toBe("site");
  });

  test("a selection long after the touch is just a selection", async () => {
    const { view, held } = press();
    now += 5_000;
    view.dispatch({ selection: EditorSelection.range(1, 5), userEvent: "select.pointer" });
    await Promise.resolve();
    expect(held).toEqual([]);
  });
});

describe("the menu and the bridge", () => {
  test("a reader gets Open and Copy; a writer gets Edit and Remove too", () => {
    const web: HeldLink = { label: "site", url: "https://example.com/", removable: true };
    expect(linkHoldActions(web, false)).toEqual(["open", "copy"]);
    expect(linkHoldActions(web, true)).toEqual(["open", "edit", "copy", "remove"]);
    const note: HeldLink = { label: "Basil", path: "areas/Basil.md", removable: true };
    expect(linkHoldActions(note, true)).toEqual(["open", "edit", "remove"]);
    expect(linkHoldActions({ ...web, removable: false }, true)).toEqual(["open", "edit", "copy"]);
  });

  test("the host checks a held link before showing it", () => {
    expect(decodeHeldLink({ label: "x", url: "javascript:alert(1)", removable: true })).toBeNull();
    expect(decodeHeldLink({ label: "x", removable: true })).toBeNull();
    expect(decodeHeldLink({ label: 3, path: "a.md", removable: true })).toBeNull();
    const shown: HeldLink[] = [];
    const bridge = createHostBridge(() => {}, { onChange: () => {}, onSave: () => {}, onLinkHold: (link) => shown.push(link) });
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "link-hold", link: { label: "x", url: "javascript:alert(1)", removable: true } }));
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "link-hold", link: { label: "site", url: "https://example.com/", removable: true } }));
    expect(shown).toEqual([{ label: "site", url: "https://example.com/", removable: true }]);
  });
});
