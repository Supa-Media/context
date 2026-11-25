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
 *  2. `take` not reporting new texts -> "a link to a test chat" fails (the AI's text never plays);
 *  3. the canvas ignoring a real run's `graph` -> "▶ on a real text" fails;
 *  4. `stepRunOf` not reading a real run's steps -> "▶ on a real text" fails (Run details empty).
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
jest.mock("../../../apps/mobile/features/site/host", () => ({ isTexHost: () => true }));
/** What production's log gives for a real text (`views/mine/playProd.ts`), set by the test that plays one. */
const mockProd: { value: unknown } = { value: null };
jest.mock("@context/lab/app/views/mine/playProd", () => ({
  chatKeyOf: (src: { kind: string }) => (src.kind === "chat" ? "me" : null),
  playProd: async () => mockProd.value,
}));

type Step = { id: string; node: string; at: number; ms: number | null; out: string };
type Row = { id: string; who: string; text: string; at: number; prod?: boolean; reply?: string; cause?: string[]; steps?: Step[] };
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
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => {
  const { setSandboxCall } = jest.requireActual<typeof import("@context/lab/app/engine/sandbox")>("@context/lab/app/engine/sandbox");
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
      // Over your 1:1: two real texts first, up to the one a "Test from here" names.
      const real: Row[] = body.source === "chat" ? [{ id: "h1", who: "Maya", text: "call at 8?", at: 1_000 }, { id: "h2", who: "Tex", text: "Yes, 8 pm.", at: 2_000 }].map((r) => ({ ...r, prod: true })) : [];
      const until = real.findIndex((r) => r.id === body.base);
      mock.rows = until < 0 ? real : real.slice(0, until);
      if (body.source === "chat") return { sandboxId: "sb1", people: [{ handle: "maya", name: "Maya" }], rows: mock.rows };
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
import { TexLab } from "@context/lab/app/TexLab.web";
import { clone, lab, MAIN, set } from "@context/lab/app/engine/state";
import { resetSandboxState, rowOf, sandbox } from "@context/lab/app/engine/sandbox";
import { followText, holdPlayClock, resetPlay, seek, stepPlayClock, togglePlay } from "@context/lab/app/engine/sandboxPlay";

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

  test("Chat | Grid | Timeline in the head, the Timeline in the grid's space, T switching them", async () => {
    await mount();
    // The test writes chip is always there, its count first, as the mockup's.
    expect(q("#sbChanges")?.textContent).toBe("0 test writes ▾");
    await click("#sbChanges");
    expect(q(".sbwrites")?.textContent).toMatch(/^What Tex wrote in this test chatNothing yet\..*Reset throws all of these away\./);
    await click("#sbChanges");
    expect(qa("#sbView button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Chat", "false"],
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
    expect(q("#sbtlKind")?.textContent).toBe(" · test chat");
    expect(q("#sbtlTime")?.textContent).toBe("<1 ms / 3.5 s");
    await clockBy(500);
    expect(tracks()).toEqual(["triage", "decide", "fd"]);
    expect(q("#sbtlTime")?.textContent).toBe("500 ms / 3.5 s");
    // The node panel follows the step running, while nothing is pinned.
    expect(lab.sel).toEqual({ t: "node", id: "fd" });
    expect(q("#runPill")?.textContent).toMatch(/Playback · text 1 · 500 ms of 3.5 s/);
    // Top left, as the mockup's: first in the canvas's top row, the row the change legend shares, so never under it.
    expect(q("#runPill")?.parentElement?.classList.contains("ctop")).toBe(true);
    expect(q("#runPill")?.parentElement?.firstElementChild?.id).toBe("runPill");
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
    // Back on the Grid, nothing playing: the pill says what the canvas lights, the newest text, done.
    await click('#sbView [data-v="grid"]');
    expect(q("#runPill")?.textContent).toBe("Text 1 · done in 3.5 s · 5 steps · $0.000");
  });

  test("a running text: the playback never passes what has happened, and says how far behind live it is", async () => {
    await mount();
    // The gateway's view mid-turn: the front door still running (no `ms`), its text sent 2 s ago.
    act(() => void Object.assign(sandbox, { rows: mockTurn("Maya", "slow one", false).map((r) => rowOf(r)), running: "t1", hot: "fd" }));
    act(() => followText("t1"));
    await tick();
    await clockBy(100_000);
    const t = Number((q("#sbtlTime")?.textContent ?? "").split(" ")[0]);
    // Capped at how long it has run (2 s, plus however long this runner took since), still playing, never a total
    // before it is known. Measured from the row's own time, so a slow runner can't push it past a fixed number.
    const sent = sandbox.rows[0]?.at;
    expect(typeof sent).toBe("number");
    const ranFor = (Date.now() - (sent as number)) / 1000;
    expect(q("#sbtlTime")?.textContent).not.toMatch(/\//);
    expect(t).toBeGreaterThanOrEqual(2);
    expect(t).toBeLessThanOrEqual(ranFor + 0.1);
    expect(q("#sbtlPlay")?.getAttribute("aria-label")).toBe("Pause");
    expect(q("#runPill")?.textContent).toMatch(/^Live · text 1 · watching at real time/);
    // Not being watched (the Grid, the playback paused): live, with the step that runs now.
    act(() => togglePlay());
    await click('#sbView [data-v="grid"]');
    expect(q("#runPill")?.textContent).toMatch(/^Live · text 1 · \d.* · Front door$/);
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

  test("▶ on a real text plays what ran in prod on the graph of its time, read only; Test from here drafts it", async () => {
    await mount();
    await click("#sbChat");
    await click('#sbPickTabs [data-tab="mine"]');
    await click('#sbChatList [data-chat="me"]');
    const then = clone(MAIN).graph;
    then.nodes = then.nodes.filter((n) => n.id !== "fd");
    then.edges = then.edges.filter((e) => e.from !== "fd" && e.to !== "fd");
    mockProd.value = {
      run: { id: "h1", steps: [{ id: "p1", node: "decide", at: 0, ms: 400, ok: true, out: { when: "answer" } }], texts: [{ at: 500, rowId: "h2" }], total: 600, running: false, graph: then, graphNote: "The graph of that time", prod: { at: 1_000 } },
      replies: { h2: { id: "h1#h2", of: "h1", steps: [{ id: "p1", node: "decide", at: 0, ms: 400, ok: true, out: { when: "answer" } }], texts: [{ at: 500, rowId: "h2" }], total: 500, running: false, prod: { at: 1_000 } } },
      cause: { h2: ["p1"] },
      turns: [{ turn: "u1", version: null, prompt: null, steps: ["p1"] }],
      jobs: [],
      moment: {},
    };
    try {
      await click('#sbView [data-v="grid"]');
      await click('#sbGrid [data-play-prod="h1"]');
      await tick();
      expect(q<HTMLSelectElement>("#sbtlPick")?.value).toBe("h1");
      expect(q("#sbtlKind")?.textContent).toMatch(/ran in prod/);
      expect(q("#runNote")?.textContent).toBe("The graph of that time");
      // The mockup's Replay pill: the text, on Tex as it was then.
      expect(q("#runPill")?.textContent).toMatch(/^Replay · text 1 on Tex as it was .+: its graph, its steps, only what was logged$/);
      // ▶ on Tex's real text: only its steps, said to be as they ran in prod.
      await click('#sbView [data-v="grid"]');
      await click('#sbGrid [data-play-prod="h2"]');
      await tick();
      expect(q("#runPill")?.textContent).toMatch(/^Tex's text 2 · the 1 step that led to it, as they ran in prod · /);
      await click('#sbView [data-v="grid"]');
      await click('#sbGrid [data-play-prod="h1"]');
      await tick();
      // The graph of its time: the front door wasn't there then.
      expect(q('#svg .nd[data-id="fd"]')).toBeNull();
      // Decide is in the folded Intake box then as now: the box is what's drawn, and the panel follows Decide itself.
      expect(q('#svg .nd[data-id="intake"]')).not.toBeNull();
      await clockBy(300);
      expect(lab.sel).toEqual({ t: "node", id: "decide" });
      expect(q(".runbody")?.textContent).toContain("running");
    } finally {
      mockProd.value = null;
    }
    // Production's moment id is not the test chat row's: Run details still reads the run at the head (Dev2,
    // 2026-11-16: the Reply reviewer ran for most of a minute and its card said it didn't run).
    mockProd.value = {
      run: { id: "moment-9", steps: [{ id: "p1", node: "decide", at: 0, ms: 400, ok: true, out: { when: "answer" } }], texts: [{ at: 500, rowId: "h2" }], total: 600, running: false, prod: { at: 1_000 } },
      replies: {},
      cause: {},
      turns: [],
      jobs: [],
      moment: {},
    };
    // The real row carries its own logged steps, under ids the ledger's moment doesn't use.
    const h1 = sandbox.rows.find((r) => r.id === "h1")!;
    const had = h1.steps;
    h1.steps = [{ id: "x1", node: "decide", ms: 5, out: "act: respond", ok: true }] as typeof h1.steps;
    try {
      await click('#sbView [data-v="grid"]');
      await click('#sbGrid [data-play-prod="h1"]');
      await tick();
      await act(async () => seek(600));
      set({ sel: { t: "node", id: "decide" }, pin: true });
      await tick();
      expect(q("#props .st")?.textContent).toBe("Ran");
      // Its own output, never a test text's that happens to be newest.
      expect(q("#props")?.textContent).toContain("answer");
      expect(q("#props")?.textContent).not.toContain("act: respond");
      expect(q("#insFoot")?.textContent).toMatch(/^Logged step/);
    } finally {
      mockProd.value = null;
      h1.steps = had;
    }
    // Test from here: the real texts before it, and it waiting in the composer.
    await click('#sbView [data-v="grid"]');
    await click('#sbGrid [data-fork="h1"]');
    await tick();
    expect(mockCalls.filter((c) => c.op === "open").at(-1)?.body).toEqual({ source: "chat", chatId: "me", versionId: "main", base: "h1" });
    expect(q<HTMLInputElement>("#sbTxt")?.value).toBe("call at 8?");
  });
});
