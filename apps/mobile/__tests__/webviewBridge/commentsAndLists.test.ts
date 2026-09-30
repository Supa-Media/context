/**
 * @jest-environment jsdom
 */

/**
 * Comments and folder lists in the iOS editor (`webview/guestExtras.ts` and
 * `webview/host/extras.ts`): a commented note no longer shows its markers or
 * its log as raw text, a thread opens in the inline sheet and can be replied
 * to once the host says who is commenting, and a ```list block is drawn from
 * notes the host hands across, as on the web.
 */

import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { parseComments } from "@context/shared/src/comments.cjs";
import { setActiveThread } from "../../features/console/files/comments/extension";
import { listSource } from "../../features/console/files/webview/guestExtras";
import { hostExtras, wireListSource } from "../../features/console/files/webview/host/extras";
import { PROTOCOL_VERSION, type ToGuest, type WireListSource } from "../../features/console/files/webview/protocol";
import { connect, type Wired } from "./fixtures";

const COMMENTED = [
  "# Pricing",
  "",
  "It is <!--c:k7f2-->free, you cheapo<!--/c:k7f2--> for now.",
  "",
  "```comments",
  'k7f2 "free, you cheapo"',
  "- 2026-09-27T07:30:12Z Codex: hey, this seems a little unprofessional.",
  "```",
  "",
].join("\n");

const LISTED = ["# Projects", "", "```list", "from: 1-projects", "show: owner", "```", "", "The end.", ""].join("\n");

const NOTES: WireListSource = {
  complete: true,
  notes: [
    { path: "1-projects/website.md", updatedAt: 3, properties: { owner: "Seyi", title: "Website" } },
    { path: "1-projects/mobile.md", updatedAt: 5, properties: { owner: "Ada" } },
  ],
};

let wired: Wired | null = null;
afterEach(() => {
  wired?.destroy();
  wired = null;
  document.body.replaceChildren();
});

/** Let the host's promise and the guest's reply settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("comments in the iOS editor", () => {
  test("the markers and the comments log are hidden, and the words are highlighted", () => {
    wired = connect({ doc: COMMENTED, editable: false });
    const shown = wired.view.contentDOM.textContent ?? "";
    expect(shown).toContain("free, you cheapo");
    expect(shown).not.toContain("<!--c:");
    expect(shown).not.toContain("```comments");
    expect(shown).not.toContain("unprofessional");
    expect(wired.view.contentDOM.querySelector("[data-comment='k7f2']")).not.toBeNull();
  });

  test("a thread opens under its line, readable by anybody", () => {
    wired = connect({ doc: COMMENTED, editable: false });
    wired.view.dispatch({ effects: setActiveThread.of("k7f2") });
    const sheet = wired.view.scrollDOM.querySelector<HTMLElement>(".cm-cmt-sheet-inline")!;
    expect(sheet.hidden).toBe(false);
    expect(sheet.textContent).toContain("hey, this seems a little unprofessional.");
    expect(sheet.querySelector("textarea")).toBeNull();
  });

  test("once the host says who is commenting, a reply is written into the note and reaches the host", () => {
    wired = connect({ doc: COMMENTED, editable: true });
    wired.host.setCommenter("@dev2");
    wired.view.dispatch({ effects: setActiveThread.of("k7f2") });
    const input = wired.view.scrollDOM.querySelector<HTMLTextAreaElement>(".cm-cmt-sheet-inline textarea")!;
    input.value = "fair, toned down";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    wired.flush();
    const sent = wired.changes.at(-1)!;
    expect(parseComments(sent).threads[0]!.events.at(-1)).toMatchObject({ author: "@dev2", text: "fair, toned down" });
  });

  test("your own comment has a Delete that asks first; somebody else's has none unless you own the workspace", () => {
    const mine = COMMENTED.replace("\n```\n", "\n- 2026-09-27T07:31:40Z @dev2: fair\n```\n");
    const on = connect({ doc: mine, editable: true });
    wired = on;
    on.host.setCommenter("@dev2");
    on.view.dispatch({ effects: setActiveThread.of("k7f2") });
    const sheet = () => on.view.scrollDOM.querySelector<HTMLElement>(".cm-cmt-sheet-inline")!;
    expect(sheet().querySelectorAll(".cm-cmt-del")).toHaveLength(1);
    sheet().querySelector<HTMLButtonElement>(".cm-cmt-del")!.click();
    expect(sheet().textContent).toContain("Delete this comment?");
    // Nothing is deleted until the question is answered.
    expect(on.view.state.doc.toString()).toBe(mine);
    sheet().querySelector<HTMLButtonElement>(".cm-cmt-danger")!.click();
    on.flush();
    expect(on.changes.at(-1)).toBe(COMMENTED);

    on.host.setCommenter("@dev2", true);
    on.view.dispatch({ effects: setActiveThread.of(null) });
    on.view.dispatch({ effects: setActiveThread.of("k7f2") });
    const del = sheet().querySelector<HTMLButtonElement>(".cm-cmt-del")!;
    expect(del.getAttribute("aria-label")).toBe("Delete this thread");
    del.click();
    expect(sheet().textContent).toContain("Delete this thread and its replies?");
    sheet().querySelector<HTMLButtonElement>(".cm-cmt-danger")!.click();
    on.flush();
    expect(on.changes.at(-1)).toBe("# Pricing\n\nIt is free, you cheapo for now.\n");
  });

  test("a name that is not an @handle signs nothing", () => {
    wired = connect({ doc: COMMENTED, editable: true });
    wired.host.setCommenter("Codex");
    wired.view.dispatch({ effects: setActiveThread.of("k7f2") });
    expect(wired.view.scrollDOM.querySelector(".cm-cmt-sheet-inline textarea")).toBeNull();
  });
});

describe("folder lists in the iOS editor", () => {
  // jsdom has no layout; a drawn list makes CodeMirror measure. As `listBlock.test.ts` does.
  beforeAll(() => {
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  });

  test("without a source the block stays as its source, as before", () => {
    wired = connect({ doc: LISTED, editable: false });
    expect(wired.view.contentDOM.querySelector(".cm-lp-list")).toBeNull();
    expect(wired.view.contentDOM.textContent).toContain("from: 1-projects");
  });

  test("with one, it is drawn from the notes the host hands across, and reloads when they change", async () => {
    const load = jest.fn(async (_folder: string, _subfolders: boolean) => NOTES);
    wired = connect({ doc: LISTED, editable: false }, { onLoadList: load });
    wired.host.setLists(true, false);
    await settle();
    expect(load).toHaveBeenCalledWith("1-projects", false);
    const rows = [...wired.view.contentDOM.querySelectorAll(".cm-lp-list-row")].map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows.join(" ")).toContain("Website");
    expect(rows.join(" ")).toContain("Ada");

    const calls = load.mock.calls.length;
    wired.host.listsChanged();
    await settle();
    expect(load.mock.calls.length).toBe(calls + 1);
  });
});

describe("the host's half", () => {
  test("every list request is answered, and with nothing where lists are not offered", async () => {
    const replies: ToGuest[] = [];
    const extras = hostExtras(() => {}, { onLoadList: async () => NOTES, onSetListProperty: async () => null });
    const reply = (message: ToGuest) => replies.push(message);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-load", token: "l1", folder: "1-projects", subfolders: false }, reply);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-set", token: "w1", path: "a.md", key: "status", value: "done" }, reply);
    await settle();
    expect(replies).toEqual([
      { v: PROTOCOL_VERSION, type: "list-loaded", token: "l1", source: null },
      { v: PROTOCOL_VERSION, type: "list-set-result", token: "w1", error: "This list can’t be changed here." },
    ]);

    // Readable but not writable: loads answer, writes are still refused.
    extras.setLists(true, false);
    replies.length = 0;
    extras.receive({ v: PROTOCOL_VERSION, type: "list-load", token: "l2", folder: "1-projects", subfolders: true }, reply);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-set", token: "w2", path: "a.md", key: "status", value: "done" }, reply);
    await settle();
    expect(replies).toContainEqual({ v: PROTOCOL_VERSION, type: "list-loaded", token: "l2", source: NOTES });
    expect(replies).toContainEqual({ v: PROTOCOL_VERSION, type: "list-set-result", token: "w2", error: "This list can’t be changed here." });
  });

  test("the web view cannot choose which note a list writes to: only a note it was handed", async () => {
    const replies: ToGuest[] = [];
    const set = jest.fn(async (_path: string, _key: string, _value: string | null) => null);
    const extras = hostExtras(() => {}, { onLoadList: async () => NOTES, onSetListProperty: set });
    const reply = (message: ToGuest) => replies.push(message);
    extras.setLists(true, true);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-set", token: "w0", path: "1-projects/website.md", key: "owner", value: "Ada" }, reply);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-load", token: "l1", folder: "1-projects", subfolders: false }, reply);
    await settle();
    extras.receive({ v: PROTOCOL_VERSION, type: "list-set", token: "w1", path: "1-projects/website.md", key: "owner", value: "Ada" }, reply);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-set", token: "w2", path: "privacy.md", key: "owner", value: "Ada" }, reply);
    await settle();
    expect(set.mock.calls).toEqual([["1-projects/website.md", "owner", "Ada"]]);
    const results = replies.filter((message) => message.type === "list-set-result");
    // Refusals answer at once and a write answers when it lands, so by token.
    expect(results.map((message) => [message.token, message.error]).sort()).toEqual([
      ["w0", "This list can’t be changed here."],
      ["w1", null],
      ["w2", "This list can’t be changed here."],
    ]);
  });

  test("a note handed to one page is not writable from the next", async () => {
    const set = jest.fn(async (_path: string, _key: string, _value: string | null) => null);
    const extras = hostExtras(() => {}, { onLoadList: async () => NOTES, onSetListProperty: set });
    const replies: ToGuest[] = [];
    const reply = (message: ToGuest) => replies.push(message);
    const write = (token: string) =>
      extras.receive({ v: PROTOCOL_VERSION, type: "list-set", token, path: "1-projects/website.md", key: "owner", value: "Ada" }, reply);
    extras.setLists(true, true);
    extras.receive({ v: PROTOCOL_VERSION, type: "list-load", token: "l1", folder: "1-projects", subfolders: false }, reply);
    await settle();

    // The web view starts over: nothing it was handed before counts.
    extras.resend(() => {});
    write("w1");
    // Lists go read-only and back: the same.
    extras.receive({ v: PROTOCOL_VERSION, type: "list-load", token: "l2", folder: "1-projects", subfolders: false }, reply);
    await settle();
    extras.setLists(true, false);
    extras.setLists(true, true);
    write("w2");
    await settle();
    expect(set).not.toHaveBeenCalled();

    // And loading again is all it takes to write.
    extras.receive({ v: PROTOCOL_VERSION, type: "list-load", token: "l3", folder: "1-projects", subfolders: false }, reply);
    await settle();
    write("w3");
    await settle();
    expect(set.mock.calls).toEqual([["1-projects/website.md", "owner", "Ada"]]);
  });

  test("notes off the wire are checked field by field before a list draws them", () => {
    const read = listSource({
      complete: true,
      notes: [
        { path: "ok.md", properties: { owner: "Ada", tags: ["a", "b"], bad: { toString: "x" }, mixed: ["a", 1] } },
        { path: 7, properties: {} },
        "nonsense",
        { path: "", properties: {} },
      ],
    });
    expect(read).toEqual({ complete: true, notes: [{ path: "ok.md", properties: { owner: "Ada", tags: ["a", "b"] } }] });
    expect(listSource({ notes: "nope" })).toBeNull();
    expect(listSource(null)).toBeNull();
  });

  test("a source crosses as plain JSON with only what a row draws", () => {
    const wire = wireListSource({
      complete: false,
      notes: [{ path: "a.md", properties: { tags: ["x"] }, heading: "A", lede: null }],
    });
    expect(JSON.parse(JSON.stringify(wire))).toEqual({
      complete: false,
      notes: [{ path: "a.md", properties: { tags: ["x"] }, heading: "A", lede: null }],
    });
  });
});
