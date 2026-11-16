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
 * step panel, Replay, the ticked texts and the pasted replay, with the tester set by `asYou()` since nothing in the
 * page sets it now; the look's toggle, now in the top bar's ⋯; and the wires' key, open in Replay's top row and behind
 * the toolbar's ? in the Lab.
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
    readMomentDetail: async () => {},
    refreshChat: async () => {},
    // Replay's details: the Worker's judgings and each turn's reply timing, as the ledger keeps them.
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
    // What that turn's reply timing and reviewer entries measured, as `realTimes` reads them.
    readTurnTimes: async (t: { text: string }) => {
      lab.real = {
        text: t.text,
        times: { reply: 6300, ms: { lanes: 450, door: 700, fd: 2700, tools: 650, reviewer: 2100, send: 150 }, calls: { fd: 2, reviewer: 1 }, at: { tools: 1500 } },
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
import { clone, emit, G, lab, MAIN, set as setLab } from "../features/tex/lab/engine/state";
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
 * now; Replay's loader reads your ledger (the mocked MineLoader), and the tester is set here.
 */
async function asYou() {
  await click(q("#modeReplay"));
  await click(q("#modeLab"));
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
    // set here (Replay's scrubber is what traces a text now, and leaving Replay clears it).
    await act(async () => {
      traceMine("hey");
      await readTurnTimes({ text: "hey" } as never);
    });
    // Its real times on the canvas, not estimates: the front door with its tool call, the reviewer as measured.
    expect(q('.nd[data-id="fd"] .tm')?.textContent).toBe("3.4 s");
    expect(q('.nd[data-id="reviewer"] .tm')?.textContent).toBe("2.1 s");
    expect(q('.nd[data-id="checks"] .tm')?.textContent ?? "").toMatch(/^(≈ .* s)?$/);
    act(() => {
      lab.sel = { t: "node", id: "tools" };
      emit();
    });
    expect(qa("#nIO .io b").map((x) => x.textContent)).toEqual(["search_web · 650 ms"]);
    expect(q("#nIO pre")?.textContent).toContain("→ results");
    await click(q("#nIcon"));
    await click(q('#nIconPick [data-icon="star"]'));
    expect(G().nodes.find((n) => n.id === "tools")?.icon).toBe("star");
    expect(q("#nIconPick")).toBeNull();
  });

  test("Replay is its own mode: your chats, the conversation in moments, a timeline of how they queued, read only", async () => {
    await click(q("#modeReplay"));
    // Where they are is in the address, so a refresh or Back keeps it (Dev2, 2026-11-14).
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("replay");
    expect(new URLSearchParams(window.location.search).get("moment")).toBe("ev3");
    // No text strip over the canvas (the chat on the left already shows it). In Replay the wires' key stays open and
    // leads the top row on the left (Dev2, 2026-11-14: "put the key back to float left"); there is no toolbar, so no ?.
    expect(q(".ctop .moment")).toBeNull();
    expect(q(".ctop")?.className).toBe("ctop replay");
    expect(q(".ctop.replay #keyw")?.textContent).toMatch(/Next/);
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(false);
    expect(q("#keyBtn")).toBeNull();
    // The chats hide from beside them, and come back from the canvas's edge.
    await click(q("#rCollapse"));
    expect(q("#side")?.hasAttribute("hidden")).toBe(true);
    await click(q("#rExpand"));
    expect(q("#side")?.hasAttribute("hidden")).toBe(false);
    // The Lab's editing goes away: no tools, no version controls.
    expect(q("#tSel")).toBeNull();
    expect(q("#saveBtn")).toBeNull();
    // The chats are a drop-down (Dev2 on the mock: "Should probably be a drop down").
    expect(qa("#rChat option").map((x) => x.textContent)).toEqual(["1:1 with Tex", "Band · 4 people", "Old pals · 1 person"]);
    // The chat reads as it was; every text someone sent replays from it (Dev2: "replay from any text").
    // A grid of Speaker and Message only (Dev2, 2026-11-16: "just keep it on the left only showing speaker and message").
    expect(qa("#replayGrid thead th").map((x) => x.textContent)).toEqual(["Speaker", "Message"]);
    expect(qa("#replayGrid tbody tr.mr").map((x) => x.textContent)).toEqual(["Youhey", "TexHi.", "Youremind me about the shelves", "TexDone."]);
    expect(qa("#replaySide [data-moment]").map((x) => x.getAttribute("data-moment"))).toEqual(["ev1", "ev3"]);
    // It opens on the newest moment, and the timeline shows its texts, the judge's calls and the turn.
    expect(q('[data-moment="ev3"]')?.getAttribute("aria-current")).toBe("true");
    expect(qa('#replayTimeline [data-lane="decide"] .rbar').map((x) => x.textContent)).toEqual(["answer", "fold it in"]);
    expect(qa('#replayTimeline [data-lane="queue"] .rbar').map((x) => x.className)).toEqual(["rbar wait"]);
    // One row per step that ran, each helper under the step that waited on it (Dev2, 2026-11-14: "what about helpers?").
    const rowNames = qa("#replayTimeline .rrow .rln").map((x) => x.textContent);
    expect(rowNames[0]).toBe("Texts");
    expect(rowNames).toContain("Front door");
    expect(rowNames).not.toContain("Judge");
    expect(rowNames.at(-1)).toBe("Sent");
    // Compact: unnamed tracks, as few as what ran at once needs, each bar named (Dev2, 2026-11-14).
    await click(q("#rCompact"));
    expect(q("#rCompact")?.getAttribute("aria-pressed")).toBe("true");
    // Back to one row per step reads "Expand" (Dev2, 2026-11-14: "Instead of saying by step, just say expand").
    expect(q("#rCompact")?.textContent).toBe("Expand");
    // Every bar stays inside its track: the clock runs to the last bar's end, and a tiny bar keeps clear of the edge.
    const lefts = qa("#replayTimeline .rbar").map((x) => parseFloat(x.style.left));
    expect(lefts.length).toBeGreaterThan(0);
    expect(lefts.every((l) => l >= 0 && l < 100)).toBe(true);
    expect(qa("#replayTimeline .rrow .rln")).toEqual([]);
    const tracks = qa("#replayTimeline .rrow.compact");
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.length).toBeLessThan(rowNames.length);
    const named = qa("#replayTimeline .rrow.compact .rbar").map((x) => x.getAttribute("aria-label") ?? "");
    expect(named.some((x) => x.startsWith("Front door · "))).toBe(true);
    expect(named.some((x) => x.startsWith("Decide · answer"))).toBe(true);
    await click(q("#rCompact"));
    expect(qa("#replayTimeline .rrow .rln").length).toBe(rowNames.length);
    // The panel doesn't repeat the texts (they're on the left): it shows each turn and the judge's calls.
    expect(q("#replayPanel h3")?.textContent).toBe("From your text");
    expect(qa("#rTurns .rturnt").map((x) => x.textContent)).toEqual(["Done."]);
    expect(q("#rTurns .rturnh")?.textContent).toMatch(/waited 0\.3 s.*ran 3\.4 s/);
    expect(qa("#rJudge .rjrow b").map((x) => x.textContent)).toEqual(["answer", "fold it in"]);
    expect(q("#replayPanel pre")).toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    // Each judging lights Decide when the head is on it, and each text that comes in its start step, on the moment's
    // own clock, not only the turn's first (Dev2, 2026-11-14: "how come 'a text arrives' did not light up").
    await act(async () => {
      setValue.call(q<HTMLInputElement>("#rScrub")!, "1300");
      q("#rScrub")!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(q('.nd[data-id="decide"]')?.classList.contains("lit")).toBe(true);
    // Scrubbing plays the turn under the head at its measured times: at 2.5 s its front door (2.7 s long) is running.
    await click(q('[data-moment="ev1"]'));
    const scrubber = q<HTMLInputElement>("#rScrub")!;
    await act(async () => {
      setValue.call(scrubber, "2500");
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(q("#rClock")?.textContent).toBe("2.5 s / 4.4 s");
    expect(lab.ownText).toBe("hey");
    const ring = q('.nd.run[data-id="fd"] .ring');
    expect(ring).not.toBeNull();
    expect(lab.sel).toEqual({ t: "node", id: "fd" });
    expect(q("#replayPanel .pill")?.textContent).toMatch(/Haiku/);
    expect(q("#replayPanel .pill:nth-child(2)")?.textContent).toBe("2.7 s real");
    // A group chat they're in: other people's names, and its texts trace the group path.
    await act(async () => {
      const pick = q<HTMLSelectElement>("#rChat")!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(pick, "g1");
      pick.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(q('#replayGrid tbody tr.mr td[data-c="who"]')?.textContent).toBe("Ada");
    await act(async () => {
      setValue.call(q<HTMLInputElement>("#rScrub")!, "500");
      q("#rScrub")!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lab.ownText).toBe("who has the van?");
    expect(SCENARIOS.own.tags).toContain("group");
    // Texts from before every step was logged in full don't replay (Dev2: "make sure that replay only works after the
    // proper logging is in place"): their moment is left out and Older texts goes away.
    lab.myOlder = 123;
    await act(async () => {
      const pick = q<HTMLSelectElement>("#rChat")!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(pick, "g2");
      pick.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(qa("#replaySide [data-moment]").map((x) => x.getAttribute("data-moment"))).toEqual(["o3", "o5"]);
    expect(q("#rOlder")).toBeNull();
    // A routine's run is in the chat too, and replays from the routine's own start step with what it thought.
    expect(q('[data-moment="o5"] .cds')?.textContent).toBe("Routine · morning news");
    await click(q('[data-moment="o5"]'));
    expect(q("#replayPanel h3")?.textContent).toBe("Routine · morning news");
    await act(async () => {
      setValue.call(q<HTMLInputElement>("#rScrub")!, "1000");
      q("#rScrub")!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lab.ownFrom).toBe("routine");
    expect(lab.real?.io?.fd?.map((l) => l.k)).toContain("Thought · 4.0 s");
    // Back to the Lab: its tools and the version controls return, and no conversation.
    await click(q("#modeLab"));
    expect(q("#tSel")).not.toBeNull();
    expect(q("#replaySide")).toBeNull();
    // There the key is a popover behind the toolbar's ?, shut until asked for.
    expect(q("#keyw")?.classList.contains("keypop")).toBe(true);
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(true);
    await click(q("#keyBtn"));
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(false);
    expect(q("#keyw")?.textContent).toMatch(/Next/);
    await click(q("#keyBtn"));
    expect(q("#keyw")?.hasAttribute("hidden")).toBe(true);
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
