/**
 * @jest-environment jsdom
 */

/**
 * /lab Architecture test chat (Dev2, 2026-11-16; decluttered, mockup https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N):
 * texts as the shared grid docked under the canvas, a column per step with its output, a chat picked from your
 * account, the test account or the Training / Dev sets, send as anyone in the chat, one smart ▶ (plays back when
 * nothing changed, runs fresh when the version did), go back to a text, delete, react, reply, edit, pictures, and the
 * sandbox's changes listed; every call goes to the gateway's `/tex-lab/sandbox` with the version open in the Lab. The
 * gateway here is a stand-in that keeps the chat in memory.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `backTo` sending op "drop" -> "go back to a text keeps it and its reply" fails;
 *  2. the grid ignoring a row's steps -> "each step's output fills its column" fails;
 *  3. `gatewaySandbox` not retrying on 401 -> "a stale grant is minted again once" fails;
 *  4. `backTo` sending "back" for a real text -> "going back to a real text opens the chat again" fails;
 *  5. reply rows' steps left on the reply -> "each step's output fills its column" fails.
 * (2026-11-16, decluttered Lab)
 *  6. `isStale` always false -> "▶ plays back what ran while nothing changed, and runs fresh once the version did" fails;
 *  7. `sendText` dropping `replyTo` -> "tapbacks, replies and pictures are each sent to Tex" fails.
 * (2026-11-16, Shared with devs)
 *  8. the shared tab's open sent without `chatId` -> "it opens under the canvas ..." fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: () => async () => ({ status: "ok" }),
    useAction: () => async () => null,
    useConvex: () => ({ query: async () => null, mutation: async () => null, action: async () => null }),
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => true }));
jest.mock("../features/tex/lab/views/canvas/usePicUpload", () => ({
  usePicUpload: () => async (f: File) => ({ url: "https://files.example.test/" + f.name }),
}));

type Row = { id: string; who: string; text: string; prod?: boolean; reply?: string; kind?: string; on?: string; edited?: boolean; unsent?: boolean; quiet?: boolean; steps?: Array<{ node: string; out: string; ms: number }> };
const mockCalls: Array<{ op: string; body: Record<string, unknown> }> = [];
let mockRows: Row[] = [];
let mockWrites: Array<{ kind: string; summary: string; by: string }> = [];
let mockSeq = 0;
let mockChatsFail = false;
const answer = (text: string): Row[] => {
  const id = "t" + ++mockSeq;
  return [
    // As the route has it: the turn's steps on Tex's reply row, which names the text it answers.
    { id, who: "", text },
    { id: id + "r", reply: id, who: "Tex", text: "Added it to the calendar.", steps: [{ node: "triage", out: "to: judge", ms: 2 }, { node: "decide", out: "act: respond", ms: 410 }, { node: "fd", out: "draft 22 chars", ms: 3400 }] },
  ];
};
jest.mock("../features/tex/lab/views/canvas/sandboxCall", () => {
  const { setSandboxCall } = jest.requireActual<typeof import("../features/tex/lab/engine/sandbox")>("../features/tex/lab/engine/sandbox");
  setSandboxCall(async (op: string, body: Record<string, unknown>) => {
    mockCalls.push({ op, body });
    const at = (id: unknown) => mockRows.findIndex((r) => r.id === id);
    if (op === "chats" && mockChatsFail) throw new Error("not_found");
    if (op === "chats") return { chats: [{ chatId: "me", name: "me" }, { chatId: "band", name: "Band" }] };
    if (op === "shared") return { chats: [{ chatId: "u:usam", name: "@sam", kind: "1:1", people: 1, sharedBy: ["sam"] }, { chatId: "c".repeat(64), name: "Trip", kind: "group", people: 3, sharedBy: ["sam", "lee"] }] };
    if (op === "open") {
      const real: Row[] = body.source === "chat" ? [{ id: "h1", who: "Priya", text: "practice thursday?", prod: true }, { id: "h2", who: "Tex", text: "Yes, 7 pm.", prod: true }] : [];
      const until = real.findIndex((r) => r.id === body.base);
      mockRows = until < 0 ? real : real.slice(0, until);
      mockWrites = [];
      // The line a test text goes over: an invented number.
      return { sandboxId: "sb1", line: { name: "Tex", number: "+14155550142" }, people: body.source === "chat" ? [{ handle: "priya", name: "Priya" }, { handle: "sam", name: "Sam" }] : [{ handle: "", name: "Maya" }], rows: mockRows };
    }
    if (["retry", "back", "drop"].includes(op) && mockRows[at(body.msgId)]?.prod) throw new Error("That is a real text: open the chat with base set to it to try from there.");
    const sent = (as: string, text: string) => {
      const [t, r] = answer(text);
      t.who = as;
      mockRows.push(t, r);
      mockWrites.push({ kind: "Calendar", summary: "new event, held in the sandbox", by: t.id });
      return { msgId: t.id };
    };
    // send and retry answer only the new text's id; get shows it.
    if (op === "send") return sent(String(body.as), String(body.text));
    if (op === "retry") {
      const t = mockRows[at(body.msgId)];
      mockRows = mockRows.slice(0, at(body.msgId));
      return sent(t.who, t.text);
    }
    if (op === "edit") {
      const t = mockRows[at(body.msgId)];
      // The chat object's edit step decides: the same words keep a quiet reply, changed ones take a turn.
      const [e, r] = answer(String(body.text));
      Object.assign(e, { who: t.who, kind: "edit", on: t.id, edited: true });
      if (String(body.text).trim() === t.text) Object.assign(r, { text: "", quiet: true, steps: [{ node: "edit", out: "to: same", ms: 3 }] });
      mockRows.push(e, r);
      return { msgId: e.id };
    }
    if (op === "unsend") {
      const t = mockRows[at(body.msgId)];
      const id = "t" + ++mockSeq;
      mockRows.push({ id, who: t.who, text: "", kind: "unsend", on: t.id }, { id: id + "r", reply: id, who: "Tex", text: "", quiet: true });
      Object.assign(t, { unsent: true });
      return { msgId: id };
    }
    if (op === "back") mockRows = mockRows.slice(0, at(body.msgId) + 2);
    if (op === "drop") mockRows = mockRows.slice(0, at(body.msgId));
    if (op === "reset") {
      mockRows = [];
      return { ok: true };
    }
    const ids = new Set(mockRows.map((r) => r.id));
    mockWrites = mockWrites.filter((w) => ids.has(w.by));
    return { sandboxId: "sb1", rows: mockRows, writes: mockWrites, running: null };
  });
  return { useSandboxCall: () => true };
});

// Each step renders the whole Lab with its canvas: ~3 s here, past 5 s on a loaded CI runner.
jest.setTimeout(20_000);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../features/tex/lab/TexLab.web";
import { clone, lab, MAIN, set } from "../features/tex/lab/engine/state";
import { numColW } from "../features/tex/lab/views/grid/TextGrid.web";
import { gatewaySandbox, resetSandboxState, failureWords, sandbox, tryFromHere } from "../features/tex/lab/engine/sandbox";
import { holdPlayClock, resetPlay } from "../features/tex/lab/engine/sandboxPlay";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockCalls.length = 0;
  mockSeq = 0;
  resetSandboxState();
  resetPlay();
  localStorage.clear();
});
beforeEach(() => {
  // A text sent plays at once: its clock is held here and stepped where a test reads it.
  holdPlayClock(true);
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  act(() => set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, mode: "lab" }));
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
const click = async (s: string | HTMLElement | null) => {
  const el = typeof s === "string" ? q(s) : s;
  if (!el) throw new Error("nothing to click: " + String(s));
  act(() => el.click());
  await tick();
};
async function pick(sel: string, value: string) {
  const el = q<HTMLSelectElement>(sel)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
}
/** The chat picker: a tab, then a chat in it. */
async function pickChat(tab: string, sel: string) {
  await click("#sbChat");
  await click(`#sbPickTabs [data-tab="${tab}"]`);
  await click(`#sbChatList ${sel}`);
}
async function type(text: string) {
  const el = q<HTMLInputElement>("#sbTxt")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("#sbSend");
}
/** Each row's message, without its ⋯ button. */
const texts = () =>
  qa("#sbGrid tbody tr.mr").map((r) => {
    const td = r.querySelector('td[data-c="text"]')!.cloneNode(true) as HTMLElement;
    td.querySelectorAll(".popw").forEach((x) => x.remove());
    return td.textContent;
  });

describe("the Architecture test chat", () => {
  test("it opens under the canvas on the version open in the Lab, with Maya and your chats to pick from", async () => {
    await mount();
    expect(q("#stage")).not.toBeNull();
    expect(q("#sandbox")).not.toBeNull();
    expect(mockCalls.find((c) => c.op === "open")?.body).toEqual({ source: "maya", versionId: "main" });
    expect(q("#sbChatName")?.textContent).toBe("Maya (test account)");
    expect(qa("#sbAs option").map((o) => o.textContent)).toEqual(["Maya"]);
    // The picker: your account's chats, the test account, the Training / Dev sets; never the Test set.
    await click("#sbChat");
    expect(qa("#sbPickTabs button").map((b) => b.textContent)).toEqual(["Your account", "Test account", "Training / Dev", "Shared with devs"]);
    expect(q('#sbPickTabs [data-tab="test"]')?.getAttribute("aria-selected")).toBe("true");
    expect(qa("#sbChatList .mi .nm").map((o) => o.textContent)).toEqual(["Maya (test account)"]);
    await click('#sbPickTabs [data-tab="mine"]');
    expect(qa("#sbChatList .mh").map((o) => o.textContent)).toEqual(["1:1", "Group chats"]);
    expect(qa("#sbChatList .mi .nm").map((o) => o.textContent)).toEqual(["Your 1:1 with Tex", "Band"]);
    await click('#sbPickTabs [data-tab="sets"]');
    expect(q("#sbChatList")?.textContent).toMatch(/The Test set never shows here/);
    // Shared with developers: the people who said yes; a test text there runs as them.
    await click('#sbPickTabs [data-tab="shared"]');
    expect(qa("#sbChatList .mh").map((o) => o.textContent)).toEqual(["1:1", "Group chats"]);
    expect(qa("#sbChatList .mi .nm").map((o) => o.textContent)).toEqual(["@sam", "Trip"]);
    await click('#sbChatList [data-shared="u:usam"]');
    expect(mockCalls.find((c) => c.op === "open" && c.body.source === "shared")?.body).toEqual({ source: "shared", chatId: "u:usam", versionId: "main" });
    expect(q("#sbTxt")).not.toBeNull();
  });

  test("each step's output fills its column, and the texts are the shared grid", async () => {
    await mount();
    await pickChat("mine", '[data-chat="band"]');
    expect(mockCalls.at(-1)).toEqual({ op: "open", body: { source: "chat", chatId: "band", versionId: "main" } });
    await pick("#sbAs", "Sam");
    await type("Tex add the gig to the band calendar");
    // A person in the chat is sent by their handle.
    expect(mockCalls.find((c) => c.op === "send")?.body).toEqual({ sandboxId: "sb1", as: "sam", text: "Tex add the gig to the band calendar" });
    expect(texts()).toEqual(["practice thursday?", "Yes, 7 pm.", "Tex add the gig to the band calendar", "Added it to the calendar."]);
    // The real chat's texts are greyed, a line marks where the test texts start.
    expect(qa("#sbGrid tbody tr.prod").length).toBe(2);
    expect(q("#sbGrid tr.sepr")?.textContent).toBe("Sandbox from here · copied 2 texts from your real chat · writes stay in the sandbox");
    const row = q('#sbGrid tr.test[data-id="t1"]')!;
    expect(row.querySelector('td[data-c="decide"]')?.textContent).toBe("act: respond410 ms");
    expect(row.querySelector('td[data-c="fd"]')?.textContent).toBe("draft 22 chars3.4 s");
    // Columns are picked like Testing's.
    expect(qa("#sbGrid thead th").map((t) => t.textContent)).toContain("Front door");
    // Columns are the grid's: a text sent opened the Timeline, so back to the Grid.
    await click('#sbView [data-v="grid"]');
    await click("#sbGridColBtn");
    const box = q<HTMLInputElement>('#sbGridColMenu input[data-show="fd"]')!;
    act(() => box.click());
    await tick();
    expect(qa("#sbGrid thead th").map((t) => t.textContent)).not.toContain("Front door");
    // What Tex changed stays in the sandbox, listed.
    await click("#sbChanges");
    expect(q(".sbwrites")?.textContent).toMatch(/Calendar.*held in the sandbox/);
    // The composer names the number the test texts go to, as a phone shows it.
    expect(q<HTMLInputElement>("#sbTxt")?.placeholder).toBe("Text Tex at +1 (415) 555-0142…");
  });

  test("the chat opens scrolled to its newest text, and follows each new one", async () => {
    const tall = jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    try {
      await mount();
      await pickChat("mine", '[data-chat="band"]');
      const sc = q("#sbGrid .scroll")!;
      expect(sc.scrollTop).toBe(900);
      act(() => void (sc.scrollTop = 0));
      await type("Tex add the gig to the band calendar");
      expect(sc.scrollTop).toBe(900);
    } finally {
      tall.mockRestore();
    }
  });

  test("the # column is wide enough for the highest row number", () => {
    expect(numColW(9)).toBe(32);
    expect(numColW(99)).toBe(32);
    expect(numColW(250)).toBe(38);
    expect(numColW(1200)).toBe(46);
  });

  test("go back to a text keeps it and its reply; delete drops what came after; Reset starts again", async () => {
    await mount();
    await type("one");
    await type("two");
    await type("three");
    expect(texts()).toEqual(["one", "Added it to the calendar.", "two", "Added it to the calendar.", "three", "Added it to the calendar."]);
    await click('#sbGrid [data-back="t1"]');
    expect(mockCalls.at(-1)).toEqual({ op: "back", body: { sandboxId: "sb1", msgId: "t1" } });
    expect(texts()).toEqual(["one", "Added it to the calendar."]);
    await type("again");
    expect(texts()).toEqual(["one", "Added it to the calendar.", "again", "Added it to the calendar."]);
    await click('#sbGrid [data-drop="t4"]');
    expect(texts()).toEqual(["one", "Added it to the calendar."]);
    await click("#sbReset");
    // Reset deletes the test chat, and a fresh one opens over the same chat.
    expect(mockCalls.slice(-2).map((c) => c.op)).toEqual(["reset", "open"]);
    expect(sandbox.rows).toEqual([]);
  });

  test("Try from here opens one chat, up to the picked text, even as the test chat mounts", async () => {
    await mount();
    // Off the canvas, with no test chat yet: Replay's "Try from here" is where it is pressed.
    act(() => set({ view: "tools" }));
    await tick();
    expect(q("#sbTxt")).toBeNull();
    resetSandboxState();
    mockCalls.length = 0;
    await act(async () => void (await tryFromHere("band", "Band", "h2", "priya", "hi")));
    await tick();
    expect(mockCalls.filter((c) => c.op === "open")).toEqual([{ op: "open", body: { source: "chat", chatId: "band", versionId: "main", base: "h2" } }]);
    expect(texts()).toEqual(["practice thursday?"]);
  });

  test("chats that didn't load say so, and Your account reads them again", async () => {
    mockChatsFail = true;
    try {
      await mount();
      expect(document.body.textContent).toContain("Your chats didn't load: not_found");
      mockChatsFail = false;
      await click("#sbChat");
      await click('#sbPickTabs [data-tab="test"]');
      await click('#sbPickTabs [data-tab="mine"]');
      expect(qa("#sbChatList [data-chat]").map((b) => b.getAttribute("data-chat"))).toEqual(["me", "band"]);
    } finally {
      mockChatsFail = false;
    }
  });

  test("going back to a real text opens the chat again up to the text after it", async () => {
    await mount();
    await pickChat("mine", '[data-chat="band"]');
    await type("one");
    expect(texts()).toEqual(["practice thursday?", "Yes, 7 pm.", "one", "Added it to the calendar."]);
    await click('#sbGrid [data-back="h1"]');
    expect(mockCalls.slice(-2)).toEqual([
      { op: "reset", body: { sandboxId: "sb1" } },
      { op: "open", body: { source: "chat", chatId: "band", versionId: "main", base: "h2" } },
    ]);
    expect(texts()).toEqual(["practice thursday?"]);
  });
});

describe("the test chat's ▶ and message options", () => {
  test("▶ plays back what ran while nothing changed, and runs fresh once the version did", async () => {
    await mount();
    await type("one");
    const play = () => q<HTMLButtonElement>('#sbGrid [data-play="t1"]')!;
    // A text sent plays at once: ⏸ on its row; ⏸ pauses it.
    expect(play().textContent).toMatch(/^⏸ /);
    await click(play());
    expect(play().textContent).toBe("▶");
    expect(play().classList.contains("stale")).toBe(false);
    const before = mockCalls.length;
    await click(play());
    // A playback: no call to the gateway, ⏸ and its time while it plays, ▶ again once paused.
    expect(mockCalls.length).toBe(before);
    expect(play().textContent).toMatch(/^⏸ /);
    await click(play());
    expect(play().textContent).toBe("▶");
    // A step's cell lights the canvas up to it and picks its text.
    await click(q('#sbGrid tr[data-id="t1"] td[data-c="decide"]'));
    expect(q('#sbGrid tr[data-id="t1"]')?.classList.contains("sel")).toBe(true);
    expect(q('#sbGrid tr[data-id="t1"] td[data-c="decide"]')?.classList.contains("on")).toBe(true);
    // Only the canvas as drawn changes (a step moved): nothing a turn runs, so ▶ still plays back.
    act(() => {
      lab.cur.graph = { ...lab.cur.graph, nodes: lab.cur.graph.nodes.map((x) => (x.id === "decide" ? { ...x, x: x.x + 40 } : x)) };
      set({ dirty: true });
    });
    expect(play().classList.contains("stale")).toBe(false);
    // The version as saved changes: ▶ is marked stale and runs the text again on live models.
    act(() => {
      lab.cur.rev = (lab.cur.rev ?? 0) + 1;
      set({ dirty: false });
    });
    expect(play().classList.contains("stale")).toBe(true);
    await click(play());
    expect(mockCalls.slice(-2)).toEqual([
      { op: "retry", body: { sandboxId: "sb1", msgId: "t1" } },
      { op: "get", body: { sandboxId: "sb1" } },
    ]);
    // The fresh run's text ran on this version: not stale.
    expect(q('#sbGrid [data-play="t2"]')?.classList.contains("stale")).toBe(false);
  });

  test("tapbacks, replies and pictures are each sent to Tex", async () => {
    await mount();
    await type("one");
    // ⋯ on the text: the tapbacks, Reply, Edit.
    await click('#sbGrid tr[data-id="t1"] .mopt');
    expect(qa("#sbOpt-t1Menu [data-tap]").map((b) => b.textContent)).toEqual(["❤️", "👍", "👎", "😂", "‼️", "❓"]);
    await click('#sbOpt-t1Menu [data-tap="👍"]');
    expect(mockCalls.find((c) => c.op === "react")?.body).toEqual({ sandboxId: "sb1", as: "", msgId: "t1", emoji: "👍" });
    // Tex's own text has Reply but no Edit.
    await click('#sbGrid tr[data-id="t1r"] .mopt');
    expect(q("#sbOpt-t1rMenu [data-edit-open]")).toBeNull();
    await click("#sbOpt-t1rMenu [data-reply]");
    expect(q("#sbPend")?.textContent).toMatch(/Replying to Tex: Added it to the calendar\./);
    // A picture, picked.
    const file = new File(["x"], "p1.png", { type: "image/png" });
    const input = q<HTMLInputElement>("#sbAttIn")!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await tick();
    await tick();
    expect(qa("#sbPend img").map((i) => i.getAttribute("src"))).toEqual(["https://files.example.test/p1.png"]);
    await type("this one");
    expect(mockCalls.find((c) => c.op === "send" && c.body.text === "this one")?.body).toEqual({ sandboxId: "sb1", as: "", text: "this one", pics: [{ url: "https://files.example.test/p1.png" }], replyTo: "t1r" });
    expect(q("#sbPend")).toBeNull();
  });

  test("Edit sends an edit of a test text with its new words, and Delete takes one back (Undo Send)", async () => {
    await mount();
    await type("dinner at 7?");
    // Tex's text has neither.
    await click('#sbGrid tr[data-id="t1r"] .mopt');
    expect(q("#sbOpt-t1rMenu [data-unsend]")).toBeNull();
    await click('#sbGrid tr[data-id="t1"] .mopt');
    await click('#sbOpt-t1Menu [data-edit-open="t1"]');
    expect(q("#sbPend")?.textContent).toMatch(/Editing .*dinner at 7\?/);
    expect(q<HTMLInputElement>("#sbTxt")!.value).toBe("dinner at 7?");
    expect(q("#sbSend")?.textContent).toBe("Save edit");
    // The same words: the edit is still the person's change, a row of its own, and the chat object's edit step answers it quietly.
    await click("#sbSend");
    expect(mockCalls.find((c) => c.op === "edit")?.body).toEqual({ sandboxId: "sb1", as: "", msgId: "t1", text: "dinner at 7?" });
    expect(q('#sbGrid tr[data-id="t2"]')?.textContent).toMatch(/edited/);
    await click('#sbGrid tr[data-id="t1"] .mopt');
    await click('#sbOpt-t1Menu [data-edit-open="t1"]');
    await type("dinner at 8?");
    expect(mockCalls.filter((c) => c.op === "edit").at(-1)?.body).toEqual({ sandboxId: "sb1", as: "", msgId: "t1", text: "dinner at 8?" });
    // The edit is its own row, quoting the text it changed, marked edited; the text it changed keeps its words.
    const row = q('#sbGrid tr[data-id="t3"]')!;
    expect(row.textContent).toMatch(/dinner at 8\?/);
    expect(row.textContent).toMatch(/edited/);
    expect(row.textContent).toMatch(/dinner at 7\?/);
    // Delete on the text: Undo Send, its sender's.
    await click('#sbGrid tr[data-id="t1"] .mopt');
    await click('#sbOpt-t1Menu [data-unsend="t1"]');
    expect(mockCalls.find((c) => c.op === "unsend")?.body).toEqual({ sandboxId: "sb1", as: "", msgId: "t1" });
    expect(q('#sbGrid tr[data-id="t1"]')?.textContent).toMatch(/\(unsent\)/);
    expect(q('#sbGrid tr[data-id="t4"]')?.textContent).toMatch(/took back a text/);
    // A text taken back is edited or taken back no more.
    await click('#sbGrid tr[data-id="t1"] .mopt');
    expect(q("#sbOpt-t1Menu [data-edit-open]")).toBeNull();
    expect(q("#sbOpt-t1Menu [data-unsend]")).toBeNull();
  });
});

describe("the gateway route", () => {
  test("a stale grant is minted again once, and a refusal says why", async () => {
    const seen: string[] = [];
    const doFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.authorization);
      if (init.headers.authorization === "Bearer old") return { status: 401, json: async () => ({}) };
      return { status: 403, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const call = gatewaySandbox("https://mcp.example.test/mcp", async (refresh) => (refresh ? "new" : "old"), doFetch)!;
    await expect(call("get", { sandboxId: "x" })).rejects.toThrow("Only Tex developers can use the test chat");
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
  });

  test("a failure shows words, never a bare code like server_error", async () => {
    const doFetch = (async () => ({ status: 500, json: async () => ({ error: "server_error" }) })) as unknown as typeof fetch;
    const call = gatewaySandbox("https://mcp.example.test/mcp", async () => "t", doFetch)!;
    await expect(call("open", { source: { kind: "chat", chatId: "me" } })).rejects.toThrow("The test chat hit a problem on the server");
    expect(failureWords(422, { error: "refused", message: "A Lab test chat changes nothing outside itself." })).toBe("A Lab test chat changes nothing outside itself.");
    expect(failureWords(400, { error: "pick a chat to copy" })).toBe("pick a chat to copy");
  });
});
