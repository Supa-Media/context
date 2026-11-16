/**
 * @jest-environment jsdom
 */
/**
 * The Lab's "You" as a test user, in the page (Dev2, 2026-11-13: "give me the ability to change the user to my user,
 * and essentially replay old messages ... it also should probably be read only"): Your texts
 * on the Test cases page, a ticked text in the run config and prompt, and a pasted replay shown beside it and never
 * saved with the version (every staff member reads a saved version).
 *
 * The decluttered Lab (mockup https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2 2026-11-16) took
 * out the sidebar's test user swap (Maya / You) and its Workspaces list, the canvas's scenario picker and the playbar
 * with its speed slider, so the tests of those went with them. What they led to is still checked here: a traced text's
 * step panel, that Replay is not a mode (an old address opens the Lab), the ticked texts and the pasted replay, with the tester set by `asYou()` since nothing in the
 * page sets it now; the look's toggle, now in the top bar's ⋯; and the wires' key behind the toolbar's ?.
 *
 * Sabotage checks: drop the `lab.myNow` branch in Run's keepResults and "a pasted replay ..." fails on the saved raw;
 * drop the replays spread from `config()` and "a ticked text ..." fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockSaved: unknown[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: () => async (row: unknown) => (mockSaved.push(row), null),
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => true }));
// The test chat under the canvas reaches the gateway with the person's own grant; no gateway here.
jest.mock("../features/tex/lab/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));
// The person's own ledger, as the Tex page's history route answers it, stood in for: what the loader would read.
jest.mock("../features/tex/lab/views/mine/useMine", () => {
  const { lab, emit } = jest.requireActual<typeof import("../features/tex/lab/engine/state")>("../features/tex/lab/engine/state");
  return {
    MineLoader: () => {
      if (lab.me === null) {
        lab.me = { handle: "sam", name: "Sam", workspaces: [{ n: "sam", kind: "personal", role: "owner" }, { n: "band", kind: "shared", role: "member" }] };
        lab.myTexts = [
          { id: "ev3", at: Date.UTC(2026, 10, 14, 15), seq: 4, text: "remind me about the shelves", earlier: [{ from: "person", text: "hey" }, { from: "tex", text: "Hi." }], then: { text: "Done.", version: { code: "abc1234def56", setup: "a1b2c3d4e5f6" } }, turn: "t2" },
          { id: "ev1", at: Date.UTC(2026, 10, 14, 14), seq: 1, text: "hey", earlier: [], then: { text: "Hi.", version: null }, turn: "t1" },
        ];
        lab.myChats = [{ key: "me", name: "Just you and Tex" }, { key: "g1", name: "Band", people: 4 }, { key: "g2", name: "Old pals", people: 1 }];
        lab.myLines = [
          { id: "ev1", at: Date.UTC(2026, 10, 14, 14), from: "person", who: "You", text: "hey", play: lab.myTexts[1] },
          { id: "ev2", at: Date.UTC(2026, 10, 14, 14, 0, 4), from: "tex", who: "Tex", text: "Hi.", play: null },
          { id: "ev3", at: Date.UTC(2026, 10, 14, 15), from: "person", who: "You", text: "remind me about the shelves", play: lab.myTexts[0] },
          { id: "ev4", at: Date.UTC(2026, 10, 14, 15, 0, 5), from: "tex", who: "Tex", text: "Done.", play: null },
        ];
        setTimeout(emit, 0);
      }
      return null;
    },
    readMyTexts: async () => {},
    readMyChats: async () => {},
    // The details read for a job's work: the Worker's judgings and each turn's reply timing, as the ledger keeps them.
    replayEntries: () => {
      const T1 = Date.UTC(2026, 10, 14, 14);
      const T2 = Date.UTC(2026, 10, 14, 15);
      const T3 = Date.UTC(2026, 10, 14, 18);
      const timing = { waitMs: 300, replyMs: 3400, rounds: [{ at: 400, ms: 2700 }] };
      return [
        { id: "s1", at: T1 + 300, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 250, output: { act: "answer" } } },
        { id: "r1", at: T1 + 3700, kind: "reply", turn: "t1", text: "Hi.", ms: 3400, timing },
        { id: "s2", at: T2 + 300, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 250, output: { act: "answer" } } },
        { id: "s3", at: T2 + 1500, kind: "step", step: { name: "decide", of: "running", ok: true, ms: 300, output: { act: "answer", midTurn: "fold" } } },
        { id: "r2", at: T2 + 3700, kind: "reply", turn: "t2", text: "Done.", ms: 3400, timing },
        { id: "r3", at: T3 + 3700, kind: "reply", turn: "tg1", text: "Kemi does.", ms: 3400, timing },
        { id: "gt", at: Date.UTC(2026, 10, 14, 10, 0, 4), kind: "thinking", turn: "gr1", ms: 4000, text: "Checking the news notes." },
        { id: "gv", at: Date.UTC(2026, 10, 14, 10, 0, 9), kind: "judge", turn: "gr1", by: "review", went: true, ms: 2000, text: "Nothing new overnight." },
      ];
    },
    // A group chat they're in, as its history file would read: someone else's text and Tex's answer.
    pickChat: (key: string) => {
      lab.myChat = key;
      lab.myLines =
        key === "me"
          ? lab.myLines
          : key === "g2"
            ? [
                // One exchange from before full logging (Nov 13, 23:52 UTC), one after: only the second replays.
                { id: "o1", at: Date.UTC(2026, 10, 13, 20), from: "person", who: "Ada", text: "old question", play: null },
                { id: "o2", at: Date.UTC(2026, 10, 13, 20, 1), from: "tex", who: "Tex", text: "Old answer.", play: null },
                { id: "o3", at: Date.UTC(2026, 10, 14, 9), from: "person", who: "Ada", text: "new question", play: null },
                { id: "o4", at: Date.UTC(2026, 10, 14, 9, 1), from: "tex", who: "Tex", text: "New answer.", play: null },
                // A routine's run: Tex texting on its own, from its own start step.
                { id: "o5", at: Date.UTC(2026, 10, 14, 10, 0, 10), from: "tex", who: "Tex", text: "Nothing new overnight.", play: null, start: "routine", turn: "gr1", routine: "tex/routines/daily/morning-news.md" },
              ]
            : [
              { id: "g1", at: Date.UTC(2026, 10, 14, 18), from: "person", who: "Ada", text: "who has the van?", play: { id: "g1", at: Date.UTC(2026, 10, 14, 18), seq: 1, text: "who has the van?", earlier: [], then: { text: "Kemi does.", version: null }, turn: "tg1", who: "Ada" } },
              { id: "g2", at: Date.UTC(2026, 10, 14, 18, 1), from: "tex", who: "Tex", text: "Kemi does.", play: null },
            ];
      emit();
    },
    // What that turn's reply timing and Answer check entries measured, as `realTimes` reads them.
    readTurnTimes: async (t: { text: string }) => {
      lab.real = {
        text: t.text,
        times: { reply: 6300, ms: { lanes: 450, doorStep: 700, fd: 2700, tools: 650, answerCheck: 2100, send: 150 }, calls: { fd: 2, answerCheck: 1 }, at: { tools: 1500 } },
        io: { fd: [{ k: "Got", v: t.text }, { k: "Answer", v: "Hi." }], tools: [{ k: "search_web · 650 ms", v: '{"q":"x"}\n→ results' }] },
      };
      emit();
    },
    readTurnReads: async (id: string) => {
      lab.myReads = { ...lab.myReads, [id]: ["projects/shelves.md"] };
      emit();
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import TexLabRoute from "../app/(app)/lab";
import { config } from "../features/tex/lab/engine/diff";
import { clone, emit, G, lab, MAIN, node, set as setLab } from "../features/tex/lab/engine/state";
import { promptText } from "../features/tex/lab/views/run/runText";
import { SCENARIOS, traceMine } from "../features/tex/lab/engine/traces";
import { readTurnTimes } from "../features/tex/lab/views/mine/useMine";

const roots: Array<() => void> = [];
const afterThis: Array<() => void> = [];
afterEach(() => {
  while (afterThis.length > 0) afterThis.pop()!();
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});
beforeEach(() => {
  lab.cur = clone(MAIN);
  lab.versions = [MAIN];
  lab.view = "canvas";
  lab.tester = "bench";
  lab.tArea = "core";
  lab.me = null;
  lab.myTexts = null;
  lab.myChats = null;
  lab.myChat = "me";
  lab.myLines = [];
  lab.mode = "lab";
  lab.moment = null;
  lab.myPicks = [];
  lab.myReads = {};
  lab.myNow = {};
  lab.real = null;
  lab.sel = null;
  lab.ownText = "";
  lab.scn = "";
  MAIN.results = [];
  mockSaved.length = 0;
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLabRoute)));
});

const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
/**
 * The test user as You. The sidebar swap that set this left with the decluttered Lab and nothing in the page sets it
 * now; the loader reads your ledger (the mocked MineLoader), and the tester is set here.
 */
async function asYou() {
  act(() => setLab({ tester: "me" }));
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("expected an element to click");
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the Lab with your own texts", () => {
  test("a step's panel shows what it got and gave in your text, and its icon can be changed", async () => {
    // Traced as the swap's canvas picker traced one of your texts; neither is in the decluttered Lab, so the state is
    // set here (a real text's play button traces it now, `engine/prodRun.ts`).
    await act(async () => {
      traceMine("hey");
      await readTurnTimes({ text: "hey" } as never);
    });
    // Its real times on the canvas, not estimates: the front door with its tool call, the Answer check as measured.
    expect(q('.nd[data-id="fd"] .tm')?.textContent).toBe("3.4 s");
    expect(q('.nd[data-id="answerCheck"] .tm')?.textContent).toBe("2.1 s");
    expect(q('.nd[data-id="bypass"] .tm')?.textContent ?? "").toMatch(/^(≈ .* s)?$/);
    act(() => {
      lab.sel = { t: "node", id: "tools" };
      emit();
    });
    expect(qa("#nIO .io b").map((x) => x.textContent)).toEqual(["search_web · 650 ms"]);
    expect(q("#nIO pre")?.textContent).toContain("→ results");
    await click(q("#nIcon"));
    await click(q('#nIconPick [data-icon="star"]'));
    expect(node("tools")?.icon).toBe("star");
    expect(q("#nIconPick")).toBeNull();
  });

  test("Replay is not a mode: Lab and Testing only, and an old Replay address opens the Lab at its chat and text", async () => {
    expect(q("#modeReplay")).toBeNull();
    expect(qa("#modeLab, #modeTesting").map((x) => x.id)).toEqual(["modeLab", "modeTesting"]);
    // An address from when Replay was a mode: the Lab opens at that chat and text, and writes its own address back.
    window.history.replaceState(null, "", "/lab?mode=replay&chat=g1&moment=ev3");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lab.mode).toBe("lab");
    expect(lab.myChat).toBe("g1");
    expect(lab.moment).toBe("ev3");
    const search = new URLSearchParams(window.location.search);
    expect(search.get("mode")).toBeNull();
    expect(search.get("chat")).toBe("g1");
    expect(search.get("moment")).toBe("ev3");
    // The Lab is whole: its tools and version controls, no Replay chats, panel or timeline.
    expect(q("#tSel")).not.toBeNull();
    expect(q("#replaySide")).toBeNull();
    expect(q("#replayPanel")).toBeNull();
    expect(q("#replayTimeline")).toBeNull();
    // The wires' key is a popover behind the toolbar's ?, shut until asked for.
    expect(q("#keyw")?.classList.contains("keypop")).toBe(true);
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(true);
    await click(q("#keyBtn"));
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(false);
    expect(q("#keyw")?.textContent).toMatch(/Next/);
    await click(q("#keyBtn"));
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(true);
  });

  test("a text from one of their group chats traces the group path, whatever its words say", async () => {
    await asYou();
    act(() => {
      lab.myChat = "g1";
      traceMine("who has the van?");
    });
    expect(lab.ownText).toBe("who has the van?");
    expect(SCENARIOS.own.tags).toContain("group");
    act(() => {
      lab.myChat = "me";
      traceMine("who has the van?");
    });
    expect(SCENARIOS.own.tags).not.toContain("group");
  });

  test("a ticked text goes into the run config and the prompt, with the notes its turn read", async () => {
    await asYou();
    act(() => setLab({ view: "tests", tArea: "mine" }));
    await click(q('[data-mypick="ev3"]'));
    const c = config() as ReturnType<typeof config> & { replays?: Array<{ id: string; reads: string[]; then: unknown }>; replayAs?: unknown };
    expect(c.replayAs).toEqual({ handle: "sam", name: "Sam" });
    expect(c.replays?.map((r) => r.id)).toEqual(["ev3"]);
    expect(c.replays?.[0].reads).toEqual(["projects/shelves.md"]);
    expect(promptText(c)).toMatch(/pnpm ai lab replay --config lab\.json --notes/);
    expect(promptText(c)).toMatch(/write nothing to Context for it/);
  });

  test("a pasted replay shows beside the text it replayed, and is never saved with the version", async () => {
    await asYou();
    // Run and Test cases left the nav (Runs panel, 2026-11-16); the pages stay for You's texts.
    act(() => setLab({ view: "run" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const box = q<HTMLTextAreaElement>("#resIn")!;
    const pasted = '## Lab replay: main\n\n### ev3\n\n**Text:** "remind me about the shelves"\n\n**Then** (code abc1234): "Done."\n\n**Now:** "Saturday at 9."\n';
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      set.call(box, pasted);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(q("#resBtn"));
    expect(MAIN.results.length).toBe(0);
    expect(JSON.stringify(mockSaved)).not.toMatch(/Saturday at 9|shelves/);
    act(() => setLab({ view: "tests", tArea: "mine" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(qa(".tc .bb.tex .bw").map((x) => x.textContent)).toContain("Tex now");
    expect(document.body.textContent).toMatch(/Saturday at 9\./);
  });
});

describe("the Lab's look", () => {
  test("the toggle sets light or dark on the Lab, auto follows the system, and the choice is remembered here", async () => {
    const root = () => q('[data-testid="tex-lab"]')!;
    expect(root().getAttribute("data-theme")).toBeNull();
    // The look moved into the top bar's ⋯ (decluttered Lab).
    expect(q('[data-theme-pick="light"]')).toBeNull();
    await click(q("#moreBtn"));
    expect(q("#moreBtnMenu #themeToggle")).not.toBeNull();
    await click(q('[data-theme-pick="light"]'));
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("tex-lab-theme")).toBe("light");
    await click(q('[data-theme-pick="dark"]'));
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(q('[data-theme-pick="dark"]')?.getAttribute("aria-checked")).toBe("true");
    await click(q('[data-theme-pick="auto"]'));
    expect(root().getAttribute("data-theme")).toBeNull();
    expect(window.localStorage.getItem("tex-lab-theme")).toBeNull();
  });
});
