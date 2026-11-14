/**
 * @jest-environment jsdom
 */
/**
 * The Lab's "You" as a test user, in the page (Dev2, 2026-11-13: "give me the ability to change the user to my user,
 * and essentially replay old messages ... it also should probably be read only"): the swap in the sidebar, Your texts
 * on the Test cases page, a ticked text in the run config and prompt, and a pasted replay shown beside it and never
 * saved with the version (every staff member reads a saved version).
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
// The person's own ledger, as the Tex page's history route answers it, stood in for: what the loader would read.
jest.mock("../features/tex/lab/views/mine/useMine", () => {
  const { lab, emit } = jest.requireActual<typeof import("../features/tex/lab/engine/state")>("../features/tex/lab/engine/state");
  return {
    MineLoader: () => {
      if (lab.me === null) {
        lab.me = { handle: "sam", name: "Sam", workspaces: [{ n: "sam", kind: "personal", role: "owner" }, { n: "band", kind: "shared", role: "member" }] };
        lab.myTexts = [
          { id: "ev3", at: Date.UTC(2026, 10, 12, 15), seq: 4, text: "remind me about the shelves", earlier: [{ from: "person", text: "hey" }, { from: "tex", text: "Hi." }], then: { text: "Done.", version: { code: "abc1234def56", setup: "a1b2c3d4e5f6" } }, turn: "t2" },
          { id: "ev1", at: Date.UTC(2026, 10, 12, 14), seq: 1, text: "hey", earlier: [], then: { text: "Hi.", version: null }, turn: "t1" },
        ];
        setTimeout(emit, 0);
      }
      return null;
    },
    readMyTexts: async () => {},
    // What that turn's reply timing and reviewer entries measured, as `realTimes` reads them.
    readTurnTimes: async (t: { text: string }) => {
      lab.real = { text: t.text, times: { reply: 6300, ms: { lanes: 450, door: 700, fd: 2700, tools: 650, reviewer: 2100, send: 150 }, calls: { fd: 2, reviewer: 1 } } };
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
import { clone, lab, MAIN } from "../features/tex/lab/engine/state";
import { promptText } from "../features/tex/lab/views/run/runText";

const roots: Array<() => void> = [];
afterEach(() => {
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
  lab.myPicks = [];
  lab.myReads = {};
  lab.myNow = {};
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
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("expected an element to click");
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the Lab's test user as You", () => {
  test("the swap shows you and your workspaces, opens Your texts, and swaps back to Maya", async () => {
    expect(q("#tuser b")?.textContent).toBe("Maya");
    await click(q("#tuserSwap"));
    expect(q("#tuser b")?.textContent).toBe("Sam");
    expect(qa("#wsList .nm").map((x) => x.textContent)).toEqual(["sam", "band"]);
    expect(q("#gcList")).toBeNull();
    expect(q('[data-area="mine"]')?.getAttribute("aria-current")).toBe("true");
    expect(qa(".tc .cid").length).toBe(2);
    expect(q(".tc .pill.acc")?.textContent).toBe("abc1234 · setup a1b2c3");
    expect(qa(".tc .bb.tex .bw").map((x) => x.textContent)).toEqual(["Tex then", "Tex then"]);
    await click(q("#tuserSwap"));
    expect(q("#tuser b")?.textContent).toBe("Maya");
    expect(q('[data-area="mine"]')).toBeNull();
  });

  test("as You, the canvas's picker lists the texts you sent, not test cases, and traces the one you pick", async () => {
    await click(q("#tuserSwap"));
    await click(q('[data-view="canvas"]'));
    await click(q("#scnBtn"));
    expect(qa("#scnPop [data-mine] .nm").map((x) => x.textContent)).toEqual(["remind me about the shelves", "hey"]);
    expect(qa("#scnPop [data-tr]")).toEqual([]);
    await click(q('#scnPop [data-mine="ev1"]'));
    expect(q("#scnName")?.textContent).toBe("hey");
    // Its real times, not estimates: the reply as measured, each measured step as is, the rest marked "≈".
    expect(q("#stats")?.textContent).toMatch(/Reply 6\.3 s real/);
    expect(q('.nd[data-id="fd"] .tm')?.textContent).toBe("2.7 s");
    expect(q('.nd[data-id="reviewer"] .tm')?.textContent).toBe("2.1 s");
    expect(q('.nd[data-id="checks"] .tm')?.textContent ?? "").toMatch(/^(≈ .* s)?$/);
    // Back to Maya: a bench test again, and her picker lists tests.
    await click(q("#tuserSwap"));
    await click(q('[data-view="canvas"]'));
    expect(q("#scnName")?.textContent).not.toBe("hey");
    expect(q("#stats")?.textContent).not.toMatch(/real/);
    await click(q("#scnBtn"));
    expect(qa("#scnPop [data-mine]")).toEqual([]);
    expect(qa("#scnPop [data-tr]").length).toBeGreaterThan(0);
    await click(q("#scnBtn"));
    // You again, with your texts already read: the canvas opens on your newest.
    await click(q("#tuserSwap"));
    await click(q('[data-view="canvas"]'));
    expect(q("#scnName")?.textContent).toBe("remind me about the shelves");
  });

  test("a ticked text goes into the run config and the prompt, with the notes its turn read", async () => {
    await click(q("#tuserSwap"));
    await click(q('[data-mypick="ev3"]'));
    const c = config() as ReturnType<typeof config> & { replays?: Array<{ id: string; reads: string[]; then: unknown }>; replayAs?: unknown };
    expect(c.replayAs).toEqual({ handle: "sam", name: "Sam" });
    expect(c.replays?.map((r) => r.id)).toEqual(["ev3"]);
    expect(c.replays?.[0].reads).toEqual(["projects/shelves.md"]);
    expect(promptText(c)).toMatch(/pnpm ai lab replay --config lab\.json --notes/);
    expect(promptText(c)).toMatch(/write nothing to Context for it/);
  });

  test("a pasted replay shows beside the text it replayed, and is never saved with the version", async () => {
    await click(q("#tuserSwap"));
    await click(q('[data-view="run"]'));
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
    await click(q('[data-view="tests"]'));
    expect(qa(".tc .bb.tex .bw").map((x) => x.textContent)).toContain("Tex now");
    expect(document.body.textContent).toMatch(/Saturday at 9\./);
  });
});

describe("the Lab's look", () => {
  test("the toggle sets light or dark on the Lab, auto follows the system, and the choice is remembered here", async () => {
    const root = () => q('[data-testid="tex-lab"]')!;
    expect(root().getAttribute("data-theme")).toBeNull();
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
