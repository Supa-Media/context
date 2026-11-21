/**
 * @jest-environment jsdom
 */

/**
 * Comments on a wide pane (`files/comments/popover.ts`, `seltool.ts`,
 * `popoverDom.ts`): ⌘M and ⌘L, the selection toolbar's buttons, the thread
 * popover's Keep and Undo, its mention menu, and what Enter writes or asks Tex
 * to do. The runner is mocked here: its streams and state are its own tests'
 * business, and what matters is what the popover calls.
 *
 * jsdom lays nothing out, so the pane's width and focus are stubbed: a desktop
 * pane is 1200px wide and the editor reports focus.
 *
 * Sabotage (2026-11-20): dropping the `texInNoteHost` check from the toolbar's
 * Tex button (`seltool.ts`, `state.facet(texInNoteHost) !== null` replaced by
 * `true`) fails "with no host, the toolbar has one button and no Tex button".
 * Restored before the run that stands.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseComments } from "@context/shared/src/comments.cjs";
import { comments, commentSent, commentUi, setActiveThread } from "../features/console/files/comments/extension";
import { popover } from "../features/console/files/comments/popover";
import { seltool } from "../features/console/files/comments/seltool";
import { texInNoteHost, type TexInNoteHost } from "../features/console/files/comments/tex/contract";
import { keepPending, shouldAskTex, startTexRun, texMessageState, texRuns, undoPending } from "../features/console/files/comments/tex/runner";

jest.mock("../features/console/files/comments/tex/runner", () => {
  const { StateField } = require("@codemirror/state");
  return {
    texRuns: StateField.define({ create: () => new Map(), update: (value: unknown) => value }),
    shouldAskTex: jest.fn((_thread: unknown, body: string) => /(^|[^\w@])@tex\b/i.test(body)),
    startTexRun: jest.fn(),
    stopTexRun: jest.fn(),
    keepPending: jest.fn(() => null),
    undoPending: jest.fn(() => null),
    texMessageState: jest.fn(() => null),
  };
});

const NOTE = ["# Pricing", "", "It is free for now.", ""].join("\n");

const WITH_TEX = [
  "# Pricing",
  "",
  "It is <!--c:k7f2-->free<!--/c:k7f2--> for now.",
  "",
  "```comments",
  'k7f2 "free"',
  "- 2026-09-27T07:30:12Z @dev2: can you reword this?",
  "- 2026-09-27T07:31:40Z Tex: Here is a shorter version.",
  "```",
  "",
].join("\n");

const host: TexInNoteHost = {
  run: async function* () {},
  runs: async () => [],
  note: () => null,
  people: () => [{ handle: "@sayo", name: "Sayo" }],
};

let views: EditorView[] = [];

beforeEach(() => {
  jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  jest.spyOn(EditorView.prototype, "hasFocus", "get").mockReturnValue(true);
});

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  document.body.replaceChildren();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

function mount(doc: string, options: { withHost?: boolean; author?: string } = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const { withHost = true, author = "@dev2" } = options;
  // Tex hears of a sent comment through commentSent, as texInNote() wires it (proven for real in texInNoteRunner.test.ts).
  const askTex = commentSent.of((v, sent) => {
    if (v.state.facet(texInNoteHost) !== null && shouldAskTex(sent.before, sent.body)) startTexRun(v, sent.thread, sent.body);
  });
  const extensions = [comments({ author: () => author }), texRuns, popover, seltool, askTex, ...(withHost ? [texInNoteHost.of(host)] : [])];
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  views.push(view);
  const card = () => view.scrollDOM.querySelector<HTMLElement>(".cm-cw");
  const input = () => view.scrollDOM.querySelector<HTMLInputElement>(".cm-cwin");
  const toolbar = () => view.scrollDOM.querySelector<HTMLElement>(".cm-seltool")!;
  const select = (from: number, to: number) => view.dispatch({ selection: { anchor: from, head: to } });
  const type = (value: string) => {
    const field = input()!;
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new Event("input"));
  };
  const press = (key: string) => {
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  };
  const chord = (key: string) => {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
  };
  return { view, card, input, toolbar, select, type, press, chord };
}

describe("starting a comment from the keyboard", () => {
  test("Mod-m with a selection opens a draft on those words, and nothing without one", () => {
    const { view, select, chord, press } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("free");
    select(at, at + 4);
    chord("m");
    expect(view.state.field(commentUi).draft).toEqual({ from: at, to: at + 4 });
    expect(view.scrollDOM.querySelector(".cm-cw-draft")).not.toBeNull();
    // Escape drops the draft, as it would on screen; then a bare caret asks for nothing.
    press("Escape");
    select(at, at);
    chord("m");
    expect(view.state.field(commentUi).draft).toBeNull();
  });

  test("Mod-l at a collapsed caret opens a point draft prefilled \"@Tex \", and writes nothing yet", () => {
    const { view, input, select, chord } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("for now");
    select(at, at);
    chord("l");
    expect(view.state.field(commentUi).draft).toEqual({ from: at, to: at, prefill: "@Tex " });
    expect(input()!.value).toBe("@Tex ");
    expect(view.state.doc.toString()).toBe(NOTE);
  });
});

describe("the popover", () => {
  test("sending a draft writes a thread at its words and makes it the open one", () => {
    const { view, select, chord, type, press } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("free");
    select(at, at + 4);
    chord("m");
    type("call it Plans?");
    press("Enter");
    const threads = parseComments(view.state.doc.toString()).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.quote).toBe("free");
    expect(threads[0]!.events[0]).toMatchObject({ author: "@dev2", text: "call it Plans?" });
    expect(view.state.field(commentUi).draft).toBeNull();
    expect(view.state.field(commentUi).active).toBe(threads[0]!.id);
    expect(shouldAskTex).toHaveBeenCalledWith(null, "call it Plans?");
    expect(startTexRun).not.toHaveBeenCalled();
  });

  test("a Mod-l point thread is written as a point, and \"@Tex ...\" starts a Tex run on it", () => {
    const { view, select, chord, type, press } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("for now");
    select(at, at);
    chord("l");
    type("@Tex explain the price");
    press("Enter");
    const parsed = parseComments(view.state.doc.toString());
    const thread = parsed.threads[0]!;
    const anchor = parsed.anchors.get(thread.id)!;
    expect(anchor.from).toBe(anchor.to);
    expect(startTexRun).toHaveBeenCalledTimes(1);
    expect(startTexRun).toHaveBeenCalledWith(view, thread.id, "@Tex explain the price");
  });

  test("a reply to an open thread is appended to it, and an @Tex reply starts a run", () => {
    const { view, type, press } = mount(WITH_TEX);
    view.dispatch({ effects: setActiveThread.of("k7f2") });
    type("@Tex make it shorter");
    press("Enter");
    const thread = parseComments(view.state.doc.toString()).threads[0]!;
    expect(thread.events.at(-1)).toMatchObject({ author: "@dev2", text: "@Tex make it shorter" });
    expect(startTexRun).toHaveBeenCalledWith(view, "k7f2", "@Tex make it shorter");
  });

  test("Escape drops a draft and writes nothing", () => {
    const { view, select, chord, press } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("free");
    select(at, at + 4);
    chord("m");
    press("Escape");
    expect(view.state.field(commentUi).draft).toBeNull();
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test("a Tex message with a pending edit shows Keep and Undo, and they act on the thread", () => {
    (texMessageState as jest.Mock).mockReturnValue("decide");
    const { view, card } = mount(WITH_TEX);
    view.dispatch({ effects: setActiveThread.of("k7f2") });
    const buttons = [...card()!.querySelectorAll<HTMLButtonElement>(".cm-cacts button")];
    expect(buttons.map((node) => node.textContent)).toEqual(["Keep", "Undo"]);
    // Event 1 is Tex's line; the comment at 0 is not asked about.
    expect(texMessageState).toHaveBeenLastCalledWith(expect.objectContaining({ id: "k7f2" }), 1);
    buttons[0]!.click();
    expect(keepPending).toHaveBeenCalledWith(view, "k7f2");
    buttons[1]!.click();
    expect(undoPending).toHaveBeenCalledWith(view, "k7f2");
  });

  test("after an @ the mention menu offers Tex, then the people; Enter takes Tex", () => {
    const { view, card, input, type } = mount(WITH_TEX);
    view.dispatch({ effects: setActiveThread.of("k7f2") });
    const menu = () => card()!.querySelector<HTMLElement>(".cm-mention")!;
    expect(menu().hidden).toBe(true);
    type("ask @");
    expect(menu().hidden).toBe(false);
    const names = [...menu().querySelectorAll("button")].map((node) => node.textContent);
    expect(names).toEqual(["Tex", "Sayo"]);
    // Tex is its one blue mark (an SVG), never a "#" glyph (Dev2 2026-11-21).
    expect(menu().querySelector("button .cm-cav-tex svg")).not.toBeNull();
    type("no mention here");
    expect(menu().hidden).toBe(true);
    type("@");
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(input()!.value).toBe("@Tex ");
    expect(startTexRun).not.toHaveBeenCalled();
    expect(parseComments(view.state.doc.toString()).threads[0]!.events).toHaveLength(2);
  });

  test("the send button is disabled while the field is empty", () => {
    const { view, card, type } = mount(WITH_TEX);
    view.dispatch({ effects: setActiveThread.of("k7f2") });
    const send = card()!.querySelector<HTMLButtonElement>(".cm-send")!;
    expect(send.disabled).toBe(true);
    type("ok");
    expect(send.disabled).toBe(false);
  });
});

describe("the selection toolbar", () => {
  test("with Tex in the note it has two buttons: the comment and the Tex ask, each with its shortcut", () => {
    const { view, toolbar, select } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("free");
    select(at, at + 4);
    const buttons = [...toolbar().querySelectorAll<HTMLButtonElement>("button")];
    expect(toolbar().hidden).toBe(false);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.querySelector("svg")).not.toBeNull();
    const mark = buttons[1]!.querySelector(".cm-texbtn")!;
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.textContent).toBe("");
    expect(buttons.map((node) => node.querySelector("kbd")!.textContent)).toEqual(["Ctrl+M", "Ctrl+L"]);
  });

  test("with no host there is no Tex button: one button, the comment", () => {
    const { view, toolbar, select } = mount(NOTE, { withHost: false });
    const at = view.state.doc.toString().indexOf("free");
    select(at, at + 4);
    expect(toolbar().hidden).toBe(false);
    expect(toolbar().querySelectorAll("button")).toHaveLength(1);
    expect(toolbar().querySelector(".cm-texbtn")).toBeNull();
  });

  test("it is not drawn on a narrow pane, and Escape hides it", () => {
    const { view, toolbar, select } = mount(NOTE);
    const at = view.state.doc.toString().indexOf("free");
    jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
    select(at, at + 4);
    expect(toolbar().hidden).toBe(true);
    jest.restoreAllMocks();
    jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    jest.spyOn(EditorView.prototype, "hasFocus", "get").mockReturnValue(true);
    select(at, at + 3);
    expect(toolbar().hidden).toBe(false);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(toolbar().hidden).toBe(true);
  });
});

describe("the card's subtitle", () => {
  // Dev2's mock (2026-11-20): the header says Tex is in the thread as soon as a
  // message asks it, before Tex has written a word.
  const { buildCard } = jest.requireActual<typeof import("../features/console/files/comments/popoverDom")>("../features/console/files/comments/popoverDom");
  const thread = (text: string) =>
    parseComments(`<!--c:abcd-->x<!--/c:abcd-->\n\n\`\`\`comments\nabcd "x"\n- 2026-11-20T10:00:00Z @seyi: ${text}\n\`\`\`\n`).threads[0]!;
  const model = (text: string) => ({
    draft: false,
    thread: thread(text),
    prefill: "",
    viewer: "@seyi",
    editable: true,
    tex: true,
    people: [],
    run: null,
    texStates: [null],
    deletable: [true],
  });
  const actions = { send: () => null, close: () => {}, resolve: () => null, keep: () => null, undo: () => null, remove: () => null };
  const sub = (text: string) => buildCard(model(text) as never, actions as never).root.textContent ?? "";

  test("a message that asks Tex puts Tex in the thread", () => {
    expect(sub("@Tex who picks up the cake?")).toContain("Tex is in this thread");
  });

  test("a message to nobody still invites Tex", () => {
    expect(sub("who picks up the cake?")).toContain("Type @ to bring in Tex");
    expect(sub("email me at a@tex.com")).not.toContain("Tex is in this thread");
  });
});
