/**
 * @jest-environment jsdom
 */

/**
 * In-app test conversations in the Lab (Dev, 2026-11-27, approved artboards `in-app-tests-artboards/`): the kind word,
 * + New chat's kinds, what was on screen under a person's message (the Testing grid, the Inspector, the test chat's
 * bubbles and dock grid), the one popover that edits it as `screen` ops, the composer sending it with each text and
 * keeping it, and the picker's In the app section. 1:1 and group conversations show none of it.
 *
 * Every name, path and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-27):
 *  1. `kindWord` answering "group" for "app" -> "the kind word" and "+ New chat" fail;
 *  2. `onScreen` true for Tex's rows -> "the grid line" fails (Tex rows show a line);
 *  3. `screenFrom` not checking with `screenProblems` -> "the popover" and "never a screen" fail (a .txt path sent);
 *  4. `useComposer` dropping `screen` -> "the composer sends what is on screen" fails;
 *  5. the picker's app row opening chatId "me" -> "the picker" fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockEdits: Array<Record<string, unknown>> = [];
jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      mockEdits.push({ fn: getFunctionName(reference), ...args });
      return { status: "ok", rev: 1 };
    },
    useAction: () => async () => null,
    useConvex: () => ({ query: async () => null, mutation: async () => null, action: async () => null }),
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../../../apps/mobile/features/site/host", () => ({ isTexHost: () => true }));
jest.mock("../../../apps/mobile/features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "fake-token" }) }));

type Row = { id: string; who: string; text: string; prod?: boolean; reply?: string; screen?: unknown };
const mockCalls: Array<{ op: string; body: Record<string, unknown> }> = [];
let mockRows: Row[] = [];
let mockSeq = 0;
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => {
  const { setSandboxCall } = jest.requireActual<typeof import("@context/lab/app/engine/sandbox")>("@context/lab/app/engine/sandbox");
  setSandboxCall(async (op: string, body: Record<string, unknown>) => {
    mockCalls.push({ op, body });
    if (op === "chats") return { chats: [{ chatId: "me", name: "me" }, { chatId: "band", name: "Band", kind: "group", people: 3 }] };
    if (op === "open") {
      mockRows = [];
      return { sandboxId: "sb1", people: [{ handle: "", name: "You" }], rows: [] };
    }
    if (op === "send") {
      const id = "t" + ++mockSeq;
      mockRows.push({ id, who: "You", text: String(body.text), ...(body.screen ? { screen: body.screen } : {}) }, { id: id + "r", reply: id, who: "Tex", text: "Done." });
      return { msgId: id };
    }
    return { sandboxId: "sb1", rows: mockRows, writes: [], running: null };
  });
  return { useSandboxCall: () => true };
});

jest.setTimeout(20_000);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};
(globalThis as { fetch?: unknown }).fetch = async () => ({ status: 200, json: async () => ({ chats: [], counts: {}, runs: [], stars: 0, perChat: [] }) });

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "@context/lab/app/TexLab.web";
import { clone, MAIN, set } from "@context/lab/app/engine/state";
import { kindWord, type Conversation } from "@context/lab/app/engine/sets";
import { sets, undo } from "@context/lab/app/engine/setsStore";
import { resetSandboxState, sandbox } from "@context/lab/app/engine/sandbox";
import { resetPlay, setDockView } from "@context/lab/app/engine/sandboxPlay";
import { screenFrom } from "@context/lab/app/views/testing/OnScreen.web";

const PLAN = { workspace: "@acme", path: "plans/q3.md" };
const APP: Conversation = {
  id: "open-plan",
  title: "Asks about the open plan",
  set: "dev",
  kind: "app",
  members: ["Maya"],
  msgs: [
    { id: "m1", who: "Maya", text: "what's still open in this?", screen: { note: PLAN, tabs: [{ workspace: "@acme", path: "plans/q2.md" }, { workspace: "@acme", path: "finance/budget.csv" }] } },
    { id: "m2", who: "Tex", tex: true, text: "Three things." },
    { id: "m3", who: "Maya", text: "make this a task", screen: { note: PLAN, selection: "Ship date moves to Oct 14" }, labels: { decide: { act: "respond" } } },
    { id: "m4", who: "Maya", text: "what did I decide about hiring?" },
  ],
};
const ONE: Conversation = { id: "errands", title: "Errands", set: "training", kind: "one", members: ["Cy"], msgs: [{ id: "m1", who: "Cy", text: "find a pharmacy" }] };
const draft = (c: Conversation) => ({ id: c.id, set: c.set, conv: JSON.stringify(c), rev: 3, by: "u1", at: 1 });

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockEdits.length = 0;
  mockCalls.length = 0;
  mockSeq = 0;
  Object.assign(sets, { convs: [], hiddenTest: [], testStars: 0, showTest: false, chat: null, msg: null, col: null, editing: false, colMenu: false, fresh: null, cols: null, loaded: false, problem: null, fold: { sets: false, insp: false }, history: false });
  for (let i = 0; sets.undo && i < 500; i++) undo();
  resetSandboxState();
  resetPlay();
  localStorage.clear();
  // The Testing tab writes its mode into the address; each test starts on the Lab.
  history.replaceState(null, "", "/");
});
beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  mockAnswers.set("functions/texSets:list", { drafts: [draft(APP), draft(ONE)] });
  mockAnswers.set("functions/workspaces:listMyWorkspaces", [{ workspaceId: "w1", slug: "acme", kind: "shared", role: "editor" }]);
  act(() => set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, mode: "lab", setChat: null }));
});

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
  await tick();
  await tick();
}
const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
async function click(s: string | HTMLElement | null) {
  const el = typeof s === "string" ? q(s) : s;
  if (!el) throw new Error("nothing to click: " + String(s));
  act(() => el.click());
  await tick();
}
function typeIn(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const blur = (el: HTMLElement) => act(() => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const editOps = () => mockEdits.filter((e) => e.fn === "functions/texSets:edit").map((e) => e.ops) as Array<Array<Record<string, unknown>>>;
async function openTesting(chat: string) {
  await mount();
  await click("#modeTesting");
  await click(`.ts-ci[data-chat="${chat}"]`);
}

describe("the kind word", () => {
  test("1:1, group and in app, in the Testing header and a Tests page pill alike", async () => {
    expect([kindWord("one"), kindWord("group"), kindWord("app"), kindWord(undefined)]).toEqual(["1:1", "group", "in app", "1:1"]);
    await openTesting("open-plan");
    expect(q("#chatMeta")?.textContent).toMatch(/^in app · ★ 0/);
    await click('.ts-ci[data-chat="errands"]');
    expect(q("#chatMeta")?.textContent).toMatch(/^1:1 · ★ 0/);
  });

  test("+ New chat asks which kind, and makes that kind", async () => {
    await openTesting("errands");
    await click("#newChat");
    expect(q("#newChatMenu .h")?.textContent).toBe("New chat");
    const items = qa("#newChatMenu .it");
    expect(items.map((b) => b.textContent)).toEqual(["1:1a person and Tex", "Grouppeople and Tex", "In the appTex in the Context app"]);
    await click(items[2]);
    const made = mockEdits.find((e) => e.fn === "functions/texSets:create") as { conv: Conversation } | undefined;
    expect(made?.conv).toMatchObject({ kind: "app", members: ["Jo"], msgs: [] });
    expect(q("#chatMeta")?.textContent).toMatch(/^in app/);
  });
});

describe("what was on screen, in the Testing grid", () => {
  test("the grid line: set, Nothing open, and never on Tex's rows or in a 1:1", async () => {
    await openTesting("open-plan");
    const line = (id: string) => q(`tr.mr[data-id="${id}"] td[data-c="text"] .osl`);
    expect(line("m1")?.dataset.osl).toBe("set");
    expect(line("m1")?.textContent).toBe("On screen@acme\u00a0·\u00a0plans/q3.md+2 tabs");
    expect(line("m3")?.textContent).toContain("· selection");
    expect(line("m3")?.title).toBe("On screen when this was sent: “Ship date moves to Oct 14”");
    expect(line("m4")?.dataset.osl).toBe("none");
    expect(line("m4")?.textContent).toBe("Nothing open");
    expect(line("m2")).toBeNull();
    await click('.ts-ci[data-chat="errands"]');
    expect(qa("td .osl")).toHaveLength(0);
  });

  test("the Inspector quotes the line with its label, and the selection whole beneath", async () => {
    await openTesting("open-plan");
    await click('tr.mr[data-id="m3"] td[data-c="decide"]');
    expect(q("#insp .quote .osl")?.textContent).toBe("On screen@acme\u00a0·\u00a0plans/q3.md");
    expect(q("#insp .quote .osq")?.textContent).toBe("“Ship date moves to Oct 14”");
  });

  test("the popover: each kept change is one screen edit; a path the app could not send is marked and never sent", async () => {
    await openTesting("open-plan");
    await click('tr.mr[data-id="m1"] td[data-c="text"]');
    await click('tr.mr[data-id="m1"] td[data-c="text"]');
    expect(q("#osBtn")?.textContent).toBe("On screen:@acme · plans/q3.md+2▾");
    await click("#osBtn");
    expect(q("#osPop .oh")?.textContent).toBe("On screenin Maya's app when #1 was sent");
    expect(q("#osTabs .add")?.textContent).toBe("+ Add a tab2 of 8");
    // A tab removed: one edit, the rest kept.
    await click('#osTabs [data-untab="0"]');
    expect(editOps().pop()).toEqual([{ op: "edit", msg: "m1", field: "screen", value: { note: PLAN, tabs: [{ workspace: "@acme", path: "finance/budget.csv" }] } }]);
    // A path that is not .md or .csv: marked, and nothing sent.
    const path = q<HTMLInputElement>("#osPath")!;
    typeIn(path, "plans/q3.txt");
    blur(path);
    expect(path.getAttribute("aria-invalid")).toBe("true");
    const sent = editOps().length;
    await click("#osDone");
    expect(editOps().length).toBe(sent);
    // Never even tried: the store would refuse it and say so in the header.
    expect(sets.problem).toBeNull();
    expect(q("#osPop")).toBeNull();
    // A selection, kept by Done.
    await click("#osBtn");

    typeIn(q<HTMLTextAreaElement>("#osSel")!, "QA signs off");
    expect(q("#osPop .cnt")?.textContent).toBe("12 / 2000");
    await click("#osDone");
    expect(editOps().pop()).toEqual([{ op: "edit", msg: "m1", field: "screen", value: { note: PLAN, tabs: [{ workspace: "@acme", path: "finance/budget.csv" }], selection: "QA signs off" } }]);
    // Clear: Nothing open.
    await click("#osBtn");
    await click("#osClear");
    expect(editOps().pop()).toEqual([{ op: "edit", msg: "m1", field: "screen", value: null }]);
    expect(q("#osBtn")?.textContent).toBe("On screen:Nothing open▾");
  });

  test("a workspace without @, or a path that is not .md or .csv, is never a screen", () => {
    expect(screenFrom({ ws: "acme", path: "plans/q3.md", tabs: [], sel: "" })).toBe("bad");
    expect(screenFrom({ ws: "@acme", path: "plans/q3.md", tabs: [], sel: "" })).toEqual({ note: PLAN });
    expect(screenFrom({ ws: "", path: "", tabs: [], sel: "" })).toBeNull();
    expect(screenFrom({ ws: "@acme", path: "plans/q3.txt", tabs: [], sel: "" })).toBe("bad");
  });

  test("a 1:1's row editor has no On screen chip", async () => {
    await openTesting("errands");
    await click('tr.mr[data-id="m1"] td[data-c="text"]');
    await click('tr.mr[data-id="m1"] td[data-c="text"]');
    expect(q("td.dc.on textarea")).not.toBeNull();
    expect(q("#osBtn")).toBeNull();
  });
});

describe("the in-app test chat", () => {
  async function openApp() {
    await mount();
    await click("#sbChat");
    await click('#sbPickTabs [data-tab="mine"]');
    await click('#sbChatList [data-chat="app"]');
  }

  test("the picker: an In the app section between 1:1 and Group chats opens chatId app", async () => {
    await mount();
    await click("#sbChat");
    await click('#sbPickTabs [data-tab="mine"]');
    expect(qa("#sbChatList .mh").map((o) => o.textContent)).toEqual(["1:1", "In the app", "Group chats"]);
    expect(q('#sbChatList [data-chat="app"]')?.textContent).toBe("Tex in the appin app");
    await click('#sbChatList [data-chat="app"]');
    expect(mockCalls.filter((c) => c.op === "open").pop()?.body).toMatchObject({ source: "chat", chatId: "app" });
    expect(q("#sbChatName")?.textContent).toBe("Tex in the app");
    expect(q("#sbChat .cwho")).toBeNull();
  });

  test("the composer sends what is on screen and keeps it; the line shows under the bubble and in the dock grid", async () => {
    await openApp();
    act(() => setDockView("chat"));
    await tick();
    expect(q("#sbCompose .asrow")?.getAttribute("aria-label")).toBe("On screen");
    expect(q("#sbOnScreen")?.textContent).toBe("+ Nothing open");
    await click("#sbOnScreen");
    typeIn(q<HTMLInputElement>("#osWs")!, "@acme");
    typeIn(q<HTMLInputElement>("#osPath")!, "plans/q3.md");
    await click("#osDone");
    expect(sandbox.screen).toEqual({ note: PLAN });
    expect(q("#sbOnScreen")?.textContent).toBe("On screen:@acme · plans/q3.md✕");
    typeIn(q<HTMLInputElement>("#sbTxt")!, "what's still open in this?");
    await click("#sbSend");
    await tick();
    expect(mockCalls.filter((c) => c.op === "send").pop()?.body).toMatchObject({ text: "what's still open in this?", screen: { note: PLAN } });
    // Kept after the send: the app still has the note open.
    expect(q("#sbOnScreen")?.textContent).toBe("On screen:@acme · plans/q3.md✕");
    expect(q("#sbChatView .und.out .osl")?.textContent).toBe("On screen@acme\u00a0·\u00a0plans/q3.md");
    // ✕ is Nothing open; the next text goes without a screen and says so.
    await click("#sbOnScreenX");
    expect(sandbox.screen).toBeNull();
    typeIn(q<HTMLInputElement>("#sbTxt")!, "and the budget?");
    await click("#sbSend");
    await tick();
    expect(mockCalls.filter((c) => c.op === "send").pop()?.body).not.toHaveProperty("screen");
    expect(qa("#sbChatView .und.out .osl").map((x) => x.dataset.osl)).toEqual(["set", "none"]);
    act(() => setDockView("grid"));
    await tick();
    expect(qa('#sbGrid td[data-c="text"] .osl').map((x) => x.dataset.osl)).toEqual(["set", "none"]);
  });

  test("a 1:1 test chat's composer is the Texting as row, with no On screen", async () => {
    await mount();
    await click("#sbChat");
    await click('#sbPickTabs [data-tab="mine"]');
    await click('#sbChatList [data-chat="me"]');
    act(() => setDockView("chat"));
    await tick();
    expect(q("#sbCompose .asrow")?.getAttribute("aria-label")).toBe("Texting as");
    expect(q("#sbOnScreen")).toBeNull();
  });
});
