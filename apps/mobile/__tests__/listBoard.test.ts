/**
 * @jest-environment jsdom
 */
/**
 * `as: board`: the grouped rows drawn as columns of cards, and a card dropped
 * on another column writing that one property, the same write the value menu
 * makes.
 */

import { beforeAll, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { boardColumns } from "../features/console/files/listBlock/board";
import { listHost, type ListHostContext, type ListNote, type ListRow } from "../features/console/files/listBlock/model";
import { livePreview, markdownLanguage } from "../features/console/files/livePreview";

const NOTES: ListNote[] = [
  { path: "p/web.md", updatedAt: 3, properties: { status: "active", owner: "Seyi" } },
  { path: "p/app.md", updatedAt: 2, properties: { status: "planned", owner: "Ada" } },
  { path: "p/old.md", updatedAt: 1, properties: { status: "done" } },
  { path: "p/new.md", updatedAt: 0, properties: {} },
];

const doc = (...lines: string[]) => ["# P", "", "```list", ...lines, "```", ""].join("\n");

beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});

type Call = [path: string, key: string, value: string | null];

function mount(text: string, writes: Call[] | null): EditorView {
  const host: ListHostContext = {
    load: async () => ({ notes: NOTES, complete: true }),
    open: () => undefined,
    selfPath: "p/README.md",
    ...(writes !== null
      ? {
          setProperty: async (path: string, key: string, value: string | null) => {
            writes.push([path, key, value]);
            return null;
          },
        }
      : {}),
  };
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: [markdownLanguage(), livePreview(), listHost.of({ current: host })] }),
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const lanes = (view: EditorView) => [...view.dom.querySelectorAll<HTMLElement>(".cm-lp-board-col")];
const heads = (view: EditorView) => lanes(view).map((lane) => lane.querySelector(".cm-lp-board-head")?.firstChild?.textContent);
const cardsIn = (lane: HTMLElement) => [...lane.querySelectorAll(".cm-lp-board-card .cm-lp-list-title")].map((t) => t.firstChild?.textContent);

/** A drag event carrying a card, as jsdom has no DataTransfer of its own. */
function drag(type: string, data: Map<string, string>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: [...data.keys()],
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
    },
  });
  return event;
}

describe("a board", () => {
  test("columns run in group order, and No status comes last only while something is in it", () => {
    const rows = (groups: Array<string | null>): ListRow[] => groups.map((group, i) => ({ path: `${i}.md`, group }) as unknown as ListRow);
    expect(boardColumns(rows(["done", "active", null]), NOTES, "status")).toEqual(["active", "planned", "done", ""]);
    expect(boardColumns(rows(["done"]), NOTES, "status")).toEqual(["active", "planned", "done"]);
  });

  test("draws a column per value with its cards, and only when the block is grouped", async () => {
    const view = mount(doc("from: p", "group: status", "as: board"), null);
    await flush();
    expect(heads(view)).toEqual(["Active", "Planned", "Done", "No status"]);
    expect(lanes(view).map(cardsIn)).toEqual([["web"], ["app"], ["old"], ["new"]]);
    expect(view.dom.querySelectorAll(".cm-lp-list-group")).toHaveLength(0);
    view.destroy();
  });

  test("a card dropped on another column writes that one property", async () => {
    const writes: Call[] = [];
    const view = mount(doc("from: p", "group: status", "as: board"), writes);
    await flush();
    const card = view.dom.querySelector<HTMLElement>(".cm-lp-board-card")!;
    expect(card.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    card.dispatchEvent(drag("dragstart", data));
    const done = lanes(view)[2];
    const over = drag("dragover", data);
    done.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    done.dispatchEvent(drag("drop", data));
    await flush();
    await flush();
    expect(writes).toEqual([["p/web.md", "status", "done"]]);
    expect(cardsIn(lanes(view)[heads(view).indexOf("Done")])).toEqual(["web", "old"]);
    view.destroy();
  });

  test("the unset column clears, and a stranger's drag is not taken", async () => {
    const writes: Call[] = [];
    const view = mount(doc("from: p", "group: status", "as: board"), writes);
    await flush();
    const unset = lanes(view)[3];
    const stranger = drag("dragover", new Map([["text/plain", "x"]]));
    unset.dispatchEvent(stranger);
    expect(stranger.defaultPrevented).toBe(false);
    const data = new Map<string, string>();
    view.dom.querySelector<HTMLElement>(".cm-lp-board-card")!.dispatchEvent(drag("dragstart", data));
    unset.dispatchEvent(drag("drop", data));
    await flush();
    expect(writes).toEqual([["p/web.md", "status", null]]);
    view.destroy();
  });

  test("someone who cannot write gets cards that do not move, and every card keeps its menu otherwise", async () => {
    const reader = mount(doc("from: p", "group: status", "as: board"), null);
    const writer = mount(doc("from: p", "group: status", "as: board"), []);
    await flush();
    expect(reader.dom.querySelector<HTMLElement>(".cm-lp-board-card")!.getAttribute("draggable")).toBeNull();
    expect(reader.dom.querySelectorAll(".cm-lp-board-card .cm-lp-list-edit")).toHaveLength(0);
    // Drag and drop does not reach a keyboard or a phone: the card's own value is the way there.
    expect(writer.dom.querySelectorAll(".cm-lp-board-card .cm-lp-list-edit")).toHaveLength(4);
    reader.destroy();
    writer.destroy();
  });
});
