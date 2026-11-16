/**
 * @jest-environment jsdom
 */

/**
 * /lab Architecture test chat (Dev2, 2026-11-16, mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): texts as
 * the shared grid under the canvas, a column per step with its output, send as anyone in the chat, Retry, go back to
 * a text, delete, and the sandbox's changes listed; every call goes to the gateway's `/tex-lab/sandbox` with the
 * version open in the Lab. The gateway here is a stand-in that keeps the chat in memory.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `backTo` sending op "drop" -> "go back to a text keeps it and its reply" fails;
 *  2. the grid ignoring a row's steps -> "each step's output fills its column" fails;
 *  3. `gatewaySandbox` not retrying on 401 -> "a stale grant is minted again once" fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: () => async () => ({ status: "ok" }),
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => true }));

type Row = { id: string; who: string; text: string; prod?: boolean; steps?: Array<{ node: string; out: string; ms: number }> };
const mockCalls: Array<{ op: string; body: Record<string, unknown> }> = [];
let mockRows: Row[] = [];
let mockWrites: Array<{ kind: string; summary: string; by: string }> = [];
let mockSeq = 0;
const answer = (text: string): Row[] => {
  const id = "t" + ++mockSeq;
  return [
    { id, who: "", text, steps: [{ node: "triage", out: "to: judge", ms: 2 }, { node: "decide", out: "act: respond", ms: 410 }, { node: "fd", out: "draft 22 chars", ms: 3400 }] },
    { id: id + "r", who: "Tex", text: "Added it to the calendar." },
  ];
};
jest.mock("../features/tex/lab/views/canvas/sandboxCall", () => {
  const { setSandboxCall } = jest.requireActual<typeof import("../features/tex/lab/engine/sandbox")>("../features/tex/lab/engine/sandbox");
  setSandboxCall(async (op: string, body: Record<string, unknown>) => {
    mockCalls.push({ op, body });
    const at = (id: unknown) => mockRows.findIndex((r) => r.id === id);
    if (op === "chats") return { chats: [{ chatId: "me", name: "me" }, { chatId: "band", name: "Band" }] };
    if (op === "open") {
      mockRows = body.source === "chat" ? [{ id: "h1", who: "Priya", text: "practice thursday?", prod: true }, { id: "h2", who: "Tex", text: "Yes, 7 pm.", prod: true }] : [];
      mockWrites = [];
      return { sandboxId: "sb1", people: body.source === "chat" ? ["Priya", "Sam"] : ["Maya"], rows: mockRows, writes: [] };
    }
    if (op === "send") {
      const [t, r] = answer(String(body.text));
      t.who = String(body.as);
      mockRows.push(t, r);
      mockWrites.push({ kind: "Calendar", summary: "new event, held in the sandbox", by: t.id });
    }
    if (op === "back") mockRows = mockRows.slice(0, at(body.msgId) + 2);
    if (op === "drop") mockRows = mockRows.slice(0, at(body.msgId));
    if (op === "retry") mockRows = mockRows.slice(0, at(body.msgId) + 2);
    if (op === "reset") mockRows = mockRows.filter((r) => r.prod);
    const ids = new Set(mockRows.map((r) => r.id));
    mockWrites = mockWrites.filter((w) => ids.has(w.by));
    return { sandboxId: "sb1", rows: mockRows, writes: mockWrites, running: null };
  });
  return { useSandboxCall: () => true };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../features/tex/lab/TexLab.web";
import { clone, MAIN, set } from "../features/tex/lab/engine/state";
import { gatewaySandbox, resetSandboxState, sandbox } from "../features/tex/lab/engine/sandbox";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockCalls.length = 0;
  mockSeq = 0;
  resetSandboxState();
  localStorage.clear();
});
beforeEach(() => {
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
async function type(text: string) {
  const el = q<HTMLInputElement>("#sbTxt")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("#sbSend");
}
const texts = () => qa("#sbGrid tbody tr.mr").map((r) => r.querySelector('td[data-c="text"]')?.textContent);

describe("the Architecture test chat", () => {
  test("it opens under the canvas on the version open in the Lab, with Maya and your chats to pick from", async () => {
    await mount();
    expect(q("#stage")).not.toBeNull();
    expect(q("#sandbox")).not.toBeNull();
    expect(mockCalls.find((c) => c.op === "open")?.body).toEqual({ source: "maya", versionId: "main" });
    expect(qa("#sbSrc option").map((o) => o.textContent)).toEqual(["Maya (test user) · 1:1", "Your 1:1 with Tex", "Band"]);
    expect(qa("#sbAs option").map((o) => o.textContent)).toEqual(["Maya"]);
  });

  test("each step's output fills its column, and the texts are the shared grid", async () => {
    await mount();
    await pick("#sbSrc", "chat:band");
    expect(mockCalls.at(-1)).toEqual({ op: "open", body: { source: "chat", chatId: "band", versionId: "main" } });
    await pick("#sbAs", "Sam");
    await type("Tex add the gig to the band calendar");
    expect(mockCalls.find((c) => c.op === "send")?.body).toEqual({ sandboxId: "sb1", as: "Sam", text: "Tex add the gig to the band calendar" });
    expect(texts()).toEqual(["practice thursday?", "Yes, 7 pm.", "Tex add the gig to the band calendar", "Added it to the calendar."]);
    // The real chat's texts are greyed, a line marks where the test texts start.
    expect(qa("#sbGrid tbody tr.prod").length).toBe(2);
    expect(q("#sbGrid tr.sepr")?.textContent).toBe("Test texts");
    const row = q('#sbGrid tr.test[data-id="t1"]')!;
    expect(row.querySelector('td[data-c="decide"]')?.textContent).toBe("act: respond410 ms");
    expect(row.querySelector('td[data-c="fd"]')?.textContent).toBe("draft 22 chars3.4 s");
    // Columns are picked like Testing's.
    expect(qa("#sbGrid thead th").map((t) => t.textContent)).toContain("Front door");
    await click("#sbGridColBtn");
    const box = q<HTMLInputElement>('#sbGridColMenu input[data-show="fd"]')!;
    act(() => box.click());
    await tick();
    expect(qa("#sbGrid thead th").map((t) => t.textContent)).not.toContain("Front door");
    // What Tex changed stays in the sandbox, listed.
    await click("#sbChanges");
    expect(q(".sbwrites")?.textContent).toMatch(/Calendar.*held in the sandbox/);
  });

  test("go back to a text keeps it and its reply; Retry and delete drop what came after", async () => {
    await mount();
    await type("one");
    await type("two");
    await type("three");
    expect(texts()).toEqual(["one", "Added it to the calendar.", "two", "Added it to the calendar.", "three", "Added it to the calendar."]);
    await click('#sbGrid [data-back="t1"]');
    expect(mockCalls.at(-1)).toEqual({ op: "back", body: { sandboxId: "sb1", msgId: "t1" } });
    expect(texts()).toEqual(["one", "Added it to the calendar."]);
    await type("again");
    await click('#sbGrid [data-retry="t4"]');
    expect(mockCalls.at(-1)?.op).toBe("retry");
    await click('#sbGrid [data-drop="t4"]');
    expect(texts()).toEqual(["one", "Added it to the calendar."]);
    await click("#sbReset");
    expect(mockCalls.at(-1)?.op).toBe("reset");
    expect(sandbox.rows).toEqual([]);
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
});
