/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://lab.example.test/lab?sandbox=sbAI"}
 */

/**
 * The test chat dock of the Lab live sandbox (approved by Dev2 2026-11-16, mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): Grid | Timeline in the same space, a text sent playing at once at
 * the Lab's speed and never past what has happened, ▶ on Tex's texts playing only the steps its logged `cause` names,
 * the timeline's densities, the grip, and test chats an AI opened (`/lab?sandbox=<id>`, Recent test chats) followed
 * live. The gateway here is a stand-in that keeps the chat in memory.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `tick` not capping at a running text's total -> "a running text" fails;
 *  2. `take` not reporting new texts -> "a link to a test chat" fails (the AI's text never plays).
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

type Step = { id: string; node: string; at: number; ms: number | null; out: string };
type Row = { id: string; who: string; text: string; at: number; reply?: string; cause?: string[]; steps?: Step[] };
const mockCalls: Array<{ op: string; body: Record<string, unknown> }> = [];
const mock = { rows: [] as Row[], seq: 0, running: null as null | { msgId: string; node: string }, listFails: false, now: 0 };
/** A turn as the gateway logs it: decide, then the front door with tools inside it, then send; Tex's text names its cause. */
function mockTurn(who: string, text: string, done = true): Row[] {
  const id = "t" + ++mock.seq;
  const at = Date.now();
  const steps: Step[] = [
    { id: id + "a", node: "triage", at: 0, ms: 2, out: "to: judge" },
    { id: id + "b", node: "decide", at: 10, ms: 400, out: "act: respond" },
    { id: id + "c", node: "fd", at: 420, ms: done ? 3000 : null, out: "draft" },
    { id: id + "d", node: "tools", at: 900, ms: 300, out: "1 call" },
    ...(done ? [{ id: id + "e", node: "send", at: 3430, ms: 20, out: "sent" }] : []),
  ];
  return done
    ? [{ id, who, text, at }, { id: id + "r", reply: id, who: "Tex", text: "Done.", at: at + 3460, cause: [id + "b", id + "c", id + "e"], steps }]
    : [{ id, who, text, at: at - 2000, steps }];
}
jest.mock("../features/tex/lab/views/canvas/sandboxCall", () => {
  const { setSandboxCall } = jest.requireActual<typeof import("../features/tex/lab/engine/sandbox")>("../features/tex/lab/engine/sandbox");
  setSandboxCall(async (op: string, body: Record<string, unknown>) => {
    mockCalls.push({ op, body });
    if (op === "chats") return { chats: [{ chatId: "me", name: "me" }] };
    if (op === "list") {
      if (mock.listFails) throw new Error("unknown op");
      return {
        chats: [
          { sandboxId: "sbOld", source: "maya", versionId: "main", openedBy: "Lab", lastBy: "Lab", openedAt: 1_000, lastAt: 2_000, testRows: 2, running: false },
          { sandboxId: "sbAI", source: "chat", chat: { chatId: "me", name: "Your 1:1 with Tex" }, versionId: "main", openedBy: "AI (Claude Code)", lastBy: "AI (Claude Code)", openedAt: 3_000, lastAt: 9_000, testRows: 1, running: false },
        ],
      };
    }
    if (op === "open") {
      mock.rows = [];
      return { sandboxId: "sb1", people: [{ handle: "", name: "Maya" }], rows: [] };
    }
    if (op === "use") return { sandboxId: body.sandboxId, people: [{ handle: "", name: "Maya" }], rows: mock.rows, running: mock.running };
    if (op === "send") {
      mock.rows.push(...mockTurn("Maya", String(body.text)));
      return { msgId: "t" + mock.seq };
    }
    if (op === "reset") return { ok: true };
    return { sandboxId: body.sandboxId, rows: mock.rows, writes: [], running: mock.running };
  });
  return { useSandboxCall: () => true };
});

jest.setTimeout(30_000);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../features/tex/lab/TexLab.web";
import { clone, lab, MAIN, set } from "../features/tex/lab/engine/state";
import { resetSandboxState, rowOf, sandbox } from "../features/tex/lab/engine/sandbox";
import { followText, holdPlayClock, resetPlay, stepPlayClock } from "../features/tex/lab/engine/sandboxPlay";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockCalls.length = 0;
  mock.rows = [];
  mock.seq = 0;
  mock.running = null;
  resetSandboxState();
  resetPlay();
  localStorage.clear();
});
beforeEach(() => {
  holdPlayClock(true);
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  act(() => set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, mode: "lab", speed: 1, pin: false }));
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
async function type(text: string) {
  const el = q<HTMLInputElement>("#sbTxt")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("#sbSend");
  await tick();
}
const clockBy = async (ms: number) => {
  act(() => stepPlayClock(ms));
  await tick();
};
/** Named rows on the timeline that have a bar showing. */
const tracks = () => qa("#sbTimeline .sbtrk[data-n]").filter((r) => !r.hidden).map((r) => r.getAttribute("data-n"));

describe("the test chat dock", () => {
  // First: the page's address is `/lab?sandbox=sbAI` (this file's environment), read once as the Lab loads.
  test("a link to a test chat opens it, follows it live, and plays a text an AI sends there", async () => {
    mock.rows = mockTurn("Maya", "find a page on Canadian universities");
    await mount();
    expect(mockCalls.find((c) => c.op === "open")).toBeUndefined();
    expect(mockCalls.find((c) => c.op === "use")?.body).toEqual({ sandboxId: "sbAI" });
    expect(sandbox.id).toBe("sbAI");
    expect(sandbox.shared).toBe(true);
    expect(qa("#sbGrid tbody tr.mr").length).toBe(2);
    // An AI texts in it: read again while idle, the new text shows and plays on the Timeline.
    mock.rows.push(...mockTurn("Maya", "email jo the link"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 2700))));
    await tick();
    expect(mockCalls.some((c) => c.op === "get" && c.body.sandboxId === "sbAI")).toBe(true);
    expect(qa("#sbGrid tbody tr.mr").length).toBe(4);
    expect(q("#sbTimeline")).not.toBeNull();
    expect(q<HTMLSelectElement>("#sbtlPick")?.value).toBe("t2");
    // The Lab opening another version doesn't swap a shared chat for a fresh one.
    act(() => set({ cur: { ...clone(MAIN), id: "draft-x", name: "draft x" } }));
    await tick();
    expect(mockCalls.find((c) => c.op === "open")).toBeUndefined();
  });

  test("Grid | Timeline in the head, the Timeline in the grid's space, T switching them", async () => {
    await mount();
    expect(qa("#sbView button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Grid", "true"],
      ["Timeline", "false"],
    ]);
    await click('#sbView [data-v="timeline"]');
    expect(q("#sbTimeline")).not.toBeNull();
    expect(q("#sbGrid .scroll")?.hidden).toBe(true);
    // The composer stays.
    expect(q("#sbTxt")).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true })));
    await tick();
    expect(q("#sbTimeline")).toBeNull();
    expect(q("#sbGrid .scroll")?.hidden).toBe(false);
  });

  test("a text sent switches to the Timeline and plays from its first step, drawing only what has started", async () => {
    await mount();
    await type("add the gig");
    expect(q('#sbView [data-v="timeline"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(q<HTMLSelectElement>("#sbtlPick")?.value).toBe("t1");
    expect(qa("#sbtlPick option").map((o) => o.textContent)).toEqual(["Text 1 · add the gig", "Text 2 · Tex: Done."]);
    expect(q("#sbtlKind")?.textContent).toBe(" · sandbox");
    expect(q("#sbtlTime")?.textContent).toBe("<1 ms / 3.5 s");
    await clockBy(500);
    expect(tracks()).toEqual(["triage", "decide", "fd"]);
    expect(q("#sbtlTime")?.textContent).toBe("500 ms / 3.5 s");
    // The node panel follows the step running, while nothing is pinned.
    expect(lab.sel).toEqual({ t: "node", id: "fd" });
    expect(q("#runPill")?.textContent).toMatch(/Playback · text 1 · 500 ms of 3.5 s/);
    await clockBy(5000);
    expect(tracks()).toEqual(["triage", "decide", "fd", "tools", "send"]);
    expect(qa("#sbTimeline .sbtb.msg").length).toBe(1);
    expect(q("#sbtlTime")?.textContent).toBe("3.5 s / 3.5 s");
    // At the end it stops; ▶ plays it again from the start.
    expect(q("#sbtlPlay")?.getAttribute("aria-label")).toBe("Play");
    // A click on a track: the head goes there and the step is picked and pinned.
    await click(q('#sbTimeline .sbtrk[data-n="decide"]'));
    expect(lab.sel).toEqual({ t: "node", id: "decide" });
    expect(lab.pin).toBe(true);
  });

  test("a running text: the playback never passes what has happened, and says how far behind live it is", async () => {
    await mount();
    // The gateway's view mid-turn: the front door still running (no `ms`), its text sent 2 s ago.
    act(() => void Object.assign(sandbox, { rows: mockTurn("Maya", "slow one", false).map((r) => rowOf(r)), running: "t1", hot: "fd" }));
    act(() => followText("t1"));
    await tick();
    await clockBy(100_000);
    const t = Number((q("#sbtlTime")?.textContent ?? "").split(" ")[0]);
    // Capped at how long it has run (about 2 s), still playing, never a total before it is known.
    expect(q("#sbtlTime")?.textContent).not.toMatch(/\//);
    expect(t).toBeLessThan(3);
    expect(q("#sbtlPlay")?.getAttribute("aria-label")).toBe("Pause");
    expect(q("#runPill")?.textContent).toMatch(/^Live · text 1 · watching at real time/);
  });

  test("▶ on Tex's text plays only the steps that led to it; with no cause there is no ▶", async () => {
    await mount();
    await type("add the gig");
    await click('#sbView [data-v="grid"]');
    expect(q('#sbGrid [data-play-tex="t1r"]')).not.toBeNull();
    // A Tex text the gateway logged no cause for gets no ▶: never inferred.
    act(() => void (sandbox.rows[1].cause = undefined));
    await click('#sbView [data-v="timeline"]');
    await click('#sbView [data-v="grid"]');
    expect(q('#sbGrid [data-play-tex="t1r"]')).toBeNull();
    act(() => void (sandbox.rows[1].cause = ["t1b", "t1c", "t1e"]));
    await click('#sbView [data-v="timeline"]');
    await click('#sbView [data-v="grid"]');
    await click('#sbGrid [data-play-tex="t1r"]');
    expect(q<HTMLSelectElement>("#sbtlPick")?.value).toBe("t1#t1r");
    expect(q("#sbtlKind")?.textContent).toBe(" · 3 steps that led to it");
    expect(q("#runPill")?.textContent).toMatch(/^Tex's text 2 · the 3 steps that led to it/);
    expect(q(".archcv")?.classList.contains("only")).toBe(true);
    await clockBy(10_000);
    expect(tracks()).toEqual(["decide", "fd", "send"]);
  });

  test("a grid cell shows a running step only as running, with how long, never its output yet", async () => {
    await mount();
    const rows = mockTurn("Maya", "slow one", false).map((r) => rowOf(r));
    rows[0].steps![2].out = "half a draft";
    act(() => void Object.assign(sandbox, { rows, running: "t1", hot: "fd" }));
    await click('#sbView [data-v="timeline"]');
    await click('#sbView [data-v="grid"]');
    const cell = q('#sbGrid tr[data-id="t1"] td[data-c="fd"]')!;
    expect(cell.textContent).toMatch(/^running\d/);
    expect(cell.textContent).not.toContain("half a draft");
    expect(q('#sbGrid tr[data-id="t1"] td[data-c="decide"]')?.textContent).toBe("act: respond400 ms");
  });

  test("the timeline packs its rows when the dock is short", async () => {
    const RO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(private f: () => void) {}
      observe() {
        this.f();
      }
      disconnect() {}
    };
    const h = jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(60);
    try {
      await mount();
      await type("add the gig");
      await clockBy(10_000);
      expect(q("#sbTimeline .sbtracks")?.getAttribute("data-density")).toBe("packed");
      expect(qa("#sbTimeline .sbtrk .nm").length).toBe(0);
      // Tools runs inside the front door: two rows, the texts delivered on the first.
      expect(qa("#sbTimeline .sbtrk").length).toBe(2);
      expect(qa('#sbTimeline .sbtrk[data-row="0"] .sbtb.msg').length).toBe(1);
      expect(q('#sbTimeline .sbtb[data-n="fd"]')?.getAttribute("title")).toBe("Front door · 3.0 s");
    } finally {
      h.mockRestore();
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
    }
  });

  test("the grip makes the dock taller, between 120px and the canvas less 120px, and it is remembered", async () => {
    await mount();
    const rect = jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = this.classList.contains("archsplit") ? 800 : this.id === "sandbox" ? 300 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON() {} } as DOMRect;
    });
    try {
      const grip = q("#sbGrip")!;
      act(() => void grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 500 })));
      act(() => void grip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 300 })));
      expect(q("#sandbox")?.style.height).toBe("500px");
      act(() => void grip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: -900 })));
      expect(q("#sandbox")?.style.height).toBe("680px");
      act(() => void grip.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
      expect(localStorage.getItem("texLab.dockH")).toBe("680");
    } finally {
      rect.mockRestore();
    }
  });

  test("Recent test chats in the picker, newest first, an AI's marked; a gateway without `list` shows none", async () => {
    await mount();
    await click("#sbChat");
    await tick();
    expect(qa("#sbRecent .mi .nm").map((x) => x.textContent)).toEqual(["Your 1:1 with Tex", "Maya (test account)"]);
    expect(qa("#sbRecent .mi").map((x) => !!x.querySelector(".aib"))).toEqual([true, false]);
    await click('#sbRecent [data-sandbox="sbAI"]');
    await tick();
    expect(mockCalls.filter((c) => c.op === "use").at(-1)?.body).toEqual({ sandboxId: "sbAI" });
    expect(sandbox.id).toBe("sbAI");
    expect(q("#sbChatName")?.textContent).toBe("Your 1:1 with Tex");
    mock.listFails = true;
    try {
      await click("#sbChat");
      await tick();
      expect(q("#sbRecent")).toBeNull();
    } finally {
      mock.listFails = false;
    }
  });
});
