/**
 * @jest-environment jsdom
 */

/**
 * /lab Testing tab (Dev2, 2026-11-15: "make sure to build this EXACTLY how it is here"; prototype
 * https://claude.ai/artifact/GAScQuRxZyASpH8xes4n9K): the sets, the chat as a grid of message × node, the selected
 * cell's label and input, and every edit sent as the store's ops.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `cellOf` ignoring `run: "must"` -> "a must-run label on a node that didn't run shows !" fails;
 *  2. the hidden Test list showing titles -> "the Test Set stays hidden" fails;
 *  3. `saveCols` not writing to this browser -> "the Columns menu hides a column and the choice is kept" fails.
 * (Dropping the Tex-row check from T is caught twice: the tab and `texSetOps.cjs` both refuse a label on a Tex row.)
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      mockCalls.push({ fn: getFunctionName(reference), args });
      return { status: "ok", rev: 1 };
    },
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => true }));
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "fake-token" }) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};

const fetched: string[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  fetched.push(String(url));
  if (String(url).endsWith("/tex-eval/counts")) return { status: 200, json: async () => ({ stars: 2, perChat: [{ kind: "one", msgs: 4, stars: 2 }] }) };
  return { status: 200, json: async () => ({ chats: [{ id: "secret-chat", title: "Words only people see", kind: "one", members: ["Ivo"], msgs: [{ id: "m1", who: "Ivo", text: "a sealed line" }] }] }) };
};

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../features/tex/lab/TexLab.web";
import { clone, G, MAIN, set } from "../features/tex/lab/engine/state";
import { bodyOf, cellOf, defaultCols, fitCols, setsRatio, stepNodes, type Conversation } from "../features/tex/lab/engine/sets";
import { hiddenOf, mergeDrafts } from "../features/tex/lab/engine/setsData";
import { sets, undo } from "../features/tex/lab/engine/setsStore";

const CHAT: Conversation = {
  id: "picnic",
  title: "Picnic planning",
  set: "dev",
  kind: "group",
  members: ["Ana", "Bo"],
  msgs: [
    { id: "m1", who: "Ana", text: "Tex what's the weather on Sunday?", labels: { decide: { act: "respond", star: true } }, rec: { triage: { to: "judge" }, decide: { act: "respond" } } },
    { id: "m2", who: "Tex", tex: true, text: "Sunny and mild." },
    { id: "m3", who: "Bo", text: "👍", kind: "react", to: "m2" },
    { id: "m4", who: "Bo", text: "Ana are you bringing chairs", rec: { triage: { to: "judge" } } },
  ],
};
const TRAIN: Conversation = { id: "errands", title: "Errands", set: "training", kind: "one", members: ["Cy"], msgs: [{ id: "m1", who: "Cy", text: "find a pharmacy open late", labels: { decide: { act: "respond", star: true }, fd: { must: ["name one open late"], star: true } } }] };
const draft = (c: Conversation) => ({ id: c.id, set: c.set, conv: JSON.stringify(c), rev: 3, by: "u1", at: 1 });

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockCalls.length = 0;
  fetched.length = 0;
  Object.assign(sets, { convs: [], hiddenTest: [], testStars: 0, showTest: false, chat: null, msg: null, col: null, editing: false, colMenu: false, fresh: null, cols: null, loaded: false, problem: null, fold: { sets: false, insp: false }, history: false });
  for (let i = 0; sets.undo && i < 500; i++) undo();
  localStorage.clear();
});
beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  mockAnswers.set("functions/texSets:list", { drafts: [draft(CHAT), draft(TRAIN)] });
  mockAnswers.set("functions/workspaces:listMyWorkspaces", [{ workspaceId: "w1", slug: "context-lc", kind: "shared", role: "editor" }]);
  act(() => set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, mode: "lab", setChat: null }));
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
  click("#modeTesting");
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  // The repo's own conversations are there too; these tests work in the invented one.
  click('.chat[data-chat="picnic"]');
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
function click(s: string | HTMLElement) {
  const el = typeof s === "string" ? q(s) : s;
  expect(el).not.toBeNull();
  act(() => el!.click());
}
const key = (k: string, extra: KeyboardEventInit = {}) => act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra })));
const lastOps = () => (mockCalls.filter((c) => c.fn === "functions/texSets:edit").pop()?.args.ops ?? []) as Array<Record<string, unknown>>;

describe("the Testing tab", () => {
  test("opens on the sets, the ratio and the first chat as a grid of message × node", async () => {
    await mount();
    expect(q("[data-testid=tex-testing]")).not.toBeNull();
    expect(q('.set[data-set="training"]')?.textContent).toContain("Errands");
    expect(q('.set[data-set="dev"]')?.textContent).toContain("Picnic planning");
    expect(q("#ratio")?.textContent).toContain("starred tests");
    const heads = qa("table.chatgrid thead th[data-col]").map((h) => h.dataset.col);
    expect(heads.slice(0, 4)).toEqual(["who", "text", "triage", "decide"]);
    expect(heads).not.toContain("router");
    expect(qa("tr.mr")).toHaveLength(4);
    expect(q('tr.mr[data-id="m3"] td[data-c="text"]')?.textContent).toContain("reacted to #2");
  });

  test("a node's cell shows its input from the config and its label form; a pick is sent as a field op", async () => {
    await mount();
    click('tr.mr[data-id="m4"] td[data-c="decide"]');
    expect(q("#insp")?.textContent).toContain("Reads, in order");
    for (const id of G().nodes.find((n) => n.id === "decide")!.ctx) expect(q("#insp")?.textContent).toContain(id);
    expect(q("#insp")?.textContent).toContain("Wires in");
    expect(q('#insp a[href="/lab?node=decide"]')).not.toBeNull();
    click('.seg[data-f="act"] button[data-v="quiet"]');
    expect(lastOps()).toEqual([{ op: "field", msg: "m4", node: "decide", field: "act", value: "quiet" }]);
    expect(q('tr.mr[data-id="m4"] td[data-c="decide"]')?.textContent).toContain("quiet");
  });

  test("T stars a node cell, never a Tex row", async () => {
    await mount();
    click('tr.mr[data-id="m4"] td[data-c="decide"]');
    key("t");
    expect(lastOps()).toEqual([{ op: "field", msg: "m4", node: "decide", field: "star", value: true }]);
    mockCalls.length = 0;
    click('tr.mr[data-id="m2"] td[data-c="text"]');
    key("ArrowRight");
    key("t");
    expect(mockCalls).toHaveLength(0);
  });

  test("+ Add row adds a message as the last speaker and its words are sent as an edit", async () => {
    await mount();
    click("#addRow");
    const add = lastOps()[0] as { op: string; msg: { who: string } };
    expect(add).toMatchObject({ op: "addMsg", at: 4, msg: { who: "Bo", text: "" } });
    const ta = q("td.dc.on textarea") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "see you at noon");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => void ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(lastOps()).toEqual([{ op: "edit", msg: "m5", field: "text", value: "see you at noon" }]);
  });

  test("the Test Set stays hidden: counts only, until a person shows it", async () => {
    await mount();
    const test = q('.set[data-set="test"]')!;
    expect(test.textContent).toContain("Hidden chat 1");
    expect(test.textContent).toContain("★ 2");
    expect(document.body.textContent).not.toContain("Words only people see");
    expect(fetched.some((u) => u.endsWith("/tex-test-set"))).toBe(false);
    await act(async () => click("#showTest"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(q('.set[data-set="test"]')?.textContent).toContain("Words only people see");
  });

  test("the Columns menu hides a column and the choice is kept in this browser", async () => {
    await mount();
    click("#colBtn");
    const box = q('#colMenu input[data-show="triage"]') as HTMLInputElement;
    act(() => box.click());
    expect(qa("table.chatgrid thead th[data-col]").map((h) => h.dataset.col)).not.toContain("triage");
    expect(JSON.parse(localStorage.getItem("texLab.testing.cols") || "{}").hidden).toContain("triage");
  });
});

// Dev2's comments on the live tab, 2026-11-16.
describe("Dev2's changes to the tab", () => {
  test("both side panels fold to a strip and open again, and the choice is kept in this browser", async () => {
    await mount();
    click("#foldSets");
    expect(q("#tstSets")).toBeNull();
    expect(q("#openSets")).not.toBeNull();
    click("#foldInsp");
    expect(q("#insp")).toBeNull();
    expect(JSON.parse(localStorage.getItem("texLab.testing.fold") || "{}")).toEqual({ sets: true, insp: true });
    click("#openSets");
    click("#openInsp");
    expect(q("#tstSets")).not.toBeNull();
    expect(q("#insp")).not.toBeNull();
  });

  test("no keyboard hint line and no list of the cases a chat came from", async () => {
    await mount();
    expect(q(".legend")?.textContent).not.toContain("Click a cell");
    expect(q("#middle .ph")?.textContent).not.toContain("from ");
  });

  test("Undo puts the last change back as a whole chat, Redo does it again, and Cmd+Z does the same", async () => {
    await mount();
    click('tr.mr[data-id="m4"] td[data-c="decide"]');
    key("t");
    expect(q('tr.mr[data-id="m4"] td[data-c="decide"] .starc')).not.toBeNull();
    click("#undoBtn");
    expect(q('tr.mr[data-id="m4"] td[data-c="decide"] .starc')).toBeNull();
    const put = lastOps()[0] as { op: string; convo: Conversation };
    expect(put.op).toBe("put");
    expect(put.convo.msgs.find((m) => m.id === "m4")?.labels?.decide).toBeUndefined();
    click("#redoBtn");
    expect(q('tr.mr[data-id="m4"] td[data-c="decide"] .starc')).not.toBeNull();
    key("z", { metaKey: true });
    expect(q('tr.mr[data-id="m4"] td[data-c="decide"] .starc')).toBeNull();
    key("z", { metaKey: true, shiftKey: true });
    expect(q('tr.mr[data-id="m4"] td[data-c="decide"] .starc')).not.toBeNull();
  });

  test("History lists the saved revisions and Put back asks the store for that one", async () => {
    mockAnswers.set("functions/texSets:history", { rev: 3, isNew: false, revs: [{ rev: 3, by: "@ana", via: "lab", said: ["labelled decide on m4"], at: 1, restorable: true }, { rev: 2, by: "@ana", via: "lab", said: ["m1 text → hi"], at: 1, restorable: true }] });
    await mount();
    click("#histBtn");
    expect(q("#histMenu")?.textContent).toContain("Revision 3");
    expect(q("#histMenu")?.textContent).toContain("Original");
    await act(async () => click('#histMenu button[data-back="2"]'));
    expect(mockCalls.find((c) => c.fn === "functions/texSets:restoreTo")?.args).toEqual({ id: "picnic", to: 2 });
  });

  test("a message shows its pictures, and removing one is an edit of its pics", async () => {
    await mount();
    const pic = { url: "https://example.invalid/chairs.png", type: "image/png", name: "chairs.png" };
    click('tr.mr[data-id="m4"] td[data-c="text"]');
    act(() => {
      const c = sets.convs.find((x) => x.id === "picnic")!;
      sets.convs = sets.convs.map((x) => (x === c ? { ...c, msgs: c.msgs.map((m) => (m.id === "m4" ? { ...m, pics: [pic] } : m)) } : x));
      Object.assign(sets, { msg: "m4", col: "text" });
    });
    key("ArrowLeft");
    key("ArrowRight");
    expect(q('tr.mr[data-id="m4"] td[data-c="text"] img')?.getAttribute("src")).toBe(pic.url);
    click('#insp .pic button[aria-label="Remove picture"]');
    expect(lastOps()).toEqual([{ op: "edit", msg: "m4", field: "pics", value: [] }]);
  });
});

describe("the tab's reading of a chat", () => {
  test("a must-run label on a node that didn't run shows !", () => {
    const fd = G().nodes.find((n) => n.id === "fd")!;
    expect(cellOf({ id: "x", who: "Ana", text: "hi", labels: { fd: { run: "must" } } }, fd).sym).toBe("!");
    expect(cellOf({ id: "x", who: "Ana", text: "hi", labels: { fd: { run: "must not" } }, rec: { fd: {} } }, fd).cls).toBe("c-bad");
    expect(cellOf({ id: "x", who: "Ana", text: "hi", rec: { fd: {} } }, fd).sym).toBe("○");
    expect(cellOf({ id: "x", who: "Ana", text: "hi" }, fd).sym).toBe("–");
  });

  test("a special message moved above the one it points at is flagged", () => {
    const c: Conversation = { ...CHAT, msgs: [CHAT.msgs[2], CHAT.msgs[0], CHAT.msgs[1]] };
    expect(bodyOf(c, c.msgs[0]).late).toBe(true);
  });

  test("the ratio counts Training and Dev stars and the Test Set's count", () => {
    const r = setsRatio([TRAIN, CHAT], 1);
    expect(r.counts).toEqual({ training: 2, dev: 1, test: 1 });
  });

  test("saved columns lay over the graph: unknown ones drop, new nodes join hidden", () => {
    const g = G();
    const base = defaultCols(g);
    const cols = fitCols({ order: ["text", "who", "gone"], hidden: ["gone"], w: { text: 300 } }, g);
    expect(cols.order.slice(0, 2)).toEqual(["text", "who"]);
    expect(cols.order).not.toContain("gone");
    expect(cols.order).toHaveLength(base.order.length);
    expect(cols.hidden).toContain(stepNodes(g)[0].id);
  });

  test("drafts lay over the repo; a removed one goes", () => {
    const m = mergeDrafts([TRAIN, CHAT], [{ id: "errands", set: "training", conv: JSON.stringify({ ...TRAIN, title: "Errands, edited" }), rev: 2 }, { id: "picnic", set: "dev", conv: "", rev: 4, removed: true }]);
    expect(m.convs.map((c) => c.title)).toEqual(["Errands, edited"]);
    expect(m.revs).toEqual({ errands: 2, picnic: 4 });
  });

  test("the hidden list reads counts by position, never words", () => {
    expect(hiddenOf({ perChat: [{ kind: "group", msgs: 3, stars: 1, title: "leak" }] })).toEqual({ hidden: [{ kind: "group", msgs: 3, stars: 1 }], stars: 1 });
  });
});
