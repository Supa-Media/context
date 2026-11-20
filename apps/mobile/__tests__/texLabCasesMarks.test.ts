/**
 * @jest-environment jsdom
 */

/**
 * /lab: a step's own test cases and a draft's change marks (Dev2, 2026-11-15: "a lot of nodes don't even have test
 * cases listed here. And there's not a way to add them" and "it should be pretty visual which node has been changed,
 * or if something's been deleted, mark it as red, or maybe like a toggle to show what's been changed, like in a
 * ghost"). Design: https://claude.ai/artifact/VnAnSNDprEUJ4fFDEmXqhp.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `computeMarks` skipping removed steps -> "a removed step is drawn red where it was" fails;
 *  2. `keepNodeCase` ignoring the 20 cap -> "a step's form stops at 20" fails;
 *  3. `currentMarks` ignoring Off -> "Off draws no marks" fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: () => async () => null,
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => true }));
// The test chat under the canvas reaches the gateway with the person's own grant; no gateway here.
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "@context/lab/app/TexLab.web";
import { clone, edit, G, lab, MAIN, set } from "@context/lab/app/engine/state";
import { CASE_CAP, emptySteps, fieldsOf, nodeArea } from "@context/lab/app/engine/cases";
import { computeMarks, currentMarks, markCounts, putBack, wireKey } from "@context/lab/app/engine/changeMarks";
import { drafts, keepNodeCase, startNodeCase } from "@context/lab/app/engine/caseDraft";
import type { LabCase } from "@context/lab/app/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  drafts.node = null;
  drafts.swap = null;
});

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
}

const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
function click(s: string) {
  const el = q(s);
  expect(el).not.toBeNull();
  act(() => el!.click());
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  act(() =>
    set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, addCtxOpen: false, modFocus: null, cfocus: null, dirty: false, undoStack: [], caseEdits: {}, chg: "marks", chgVs: "main", revBase: null }),
  );
});

/** A step drawn on the canvas with no cases yet, and with an input shape. */
const drawnEmpty = () => {
  const drawn = new Set(G().nodes.map((n) => n.id));
  const n = emptySteps().find((x) => drawn.has(x.id) && fieldsOf(x).ins.length > 1) ?? emptySteps().find((x) => drawn.has(x.id));
  expect(n).toBeDefined();
  return n!;
};

describe("a step's own test cases", () => {
  test("a step with no cases gets a dashed + on the canvas and an add form from its shapes in its panel", () => {
    mount();
    const n = drawnEmpty();
    expect(q(`[data-addcase="${n.id}"]`)).not.toBeNull();

    act(() => set({ sel: { t: "node", id: n.id } }));
    expect(q("#nCases")?.textContent).toContain(`0 / ${CASE_CAP}`);
    click("#addFirstCase");
    expect(q("#nodeCaseForm")).not.toBeNull();
    const boxes = qa("#nodeCaseForm [data-given]");
    expect(boxes.map((b) => b.getAttribute("data-given"))).toEqual(fieldsOf(n).ins.map((f) => f.name));
    type(boxes[0] as HTMLInputElement, "a fake input");
    click("#keepCase");

    const kept = lab.caseEdits[`${nodeArea(n.id)}/new-1`] as LabCase | undefined;
    expect(kept).toMatchObject({ area: nodeArea(n.id), id: "new-1", isNew: true });
    expect(Object.values(kept!.given ?? {})).toContain("a fake input");
    expect(q(`[data-cases="${n.id}"]`)?.textContent).toContain("1");
    expect(q("#addAnotherCase")).not.toBeNull();
  });

  test("a step's form stops at 20", async () => {
    mount();
    const n = drawnEmpty();
    const area = nodeArea(n.id);
    const edits: Record<string, LabCase> = {};
    for (let i = 0; i < CASE_CAP; i++) edits[`${area}/c${i}`] = { area, id: `c${i}`, ask: "", expect: "", isNew: true, given: {}, want: {} } as LabCase;
    act(() => set({ caseEdits: edits }));
    act(() => startNodeCase(n.id));
    await act(async () => void (await keepNodeCase()));
    expect(Object.keys(lab.caseEdits).filter((k) => k.startsWith(area + "/")).length).toBe(CASE_CAP);
    act(() => set({ sel: { t: "node", id: n.id } }));
    expect(q("#addAnotherCase")).toBeNull();
  });
});

describe("a draft's change marks", () => {
  const first = () => MAIN.graph.nodes.find((n) => !n.group && MAIN.graph.edges.some((e) => e.from === n.id))!;

  test("a changed step is marked with what changed, and main's value is the from", () => {
    const id = first().id;
    const cur = clone(MAIN).graph;
    cur.nodes.find((n) => n.id === id)!.label = "Renamed";
    const m = computeMarks(cur, MAIN.graph, "marks", "main");
    expect(m.nodes[id]).toMatchObject({ kind: "changed", fields: ["name"] });
    expect(m.nodes[id].base?.label).toBe(first().label);
    expect(markCounts(m)).toEqual({ changed: 1, added: 0, removed: 0 });
  });

  test("a removed step is drawn red where it was, with its wires dashed red", () => {
    mount();
    const gone = first();
    act(() =>
      edit(() => {
        const g = G();
        g.nodes = g.nodes.filter((n) => n.id !== gone.id);
        g.edges = g.edges.filter((e) => e.from !== gone.id && e.to !== gone.id);
      }),
    );
    const m = currentMarks()!;
    expect(m.removed.map((n) => n.id)).toEqual([gone.id]);
    expect(m.goneWires.length).toBeGreaterThan(0);
    expect(q(`.rmv[data-mark="${gone.id}"]`)).not.toBeNull();
    expect(qa(".wire.wgone").length).toBe(m.goneWires.length);
    expect(q("#chgLegend")?.textContent).toContain("removed");
  });

  test("a new wire is green, Ghost draws main's version dashed, Off draws no marks, and Put back restores main's", () => {
    mount();
    const a = first();
    const b = MAIN.graph.nodes.find((n) => n.id !== a.id && !n.group && !MAIN.graph.edges.some((e) => e.from === a.id && e.to === n.id))!;
    act(() =>
      edit(() => {
        const n = G().nodes.find((x) => x.id === a.id)!;
        n.label = "Renamed";
        n.x += 40;
        G().edges.push({ from: a.id, to: b.id, mode: "wait", when: [] } as never);
      }),
    );
    const m = currentMarks()!;
    expect(m.newWires.has(wireKey({ from: a.id, to: b.id, mode: "wait", when: [] }))).toBe(true);
    expect(q(`.nd.chg-changed[data-id="${a.id}"]`)).not.toBeNull();
    expect(qa(".wire.wnew").length).toBe(1);

    // How a draft's changes are drawn is in the version menu (decluttered Lab, 2026-11-16).
    click("#verBtn");
    click('[data-chg="ghost"]');
    expect(lab.chg).toBe("ghost");
    expect(q(`.ghostn[data-mark="${a.id}"]`)).not.toBeNull();

    click('[data-chg="off"]');
    expect(currentMarks()).toBeNull();
    expect(q(".chg-changed")).toBeNull();
    expect(q("#chgLegend")).toBeNull();

    act(() => set({ chg: "marks" }));
    act(() => putBack(a.id));
    expect(G().nodes.find((n) => n.id === a.id)?.label).toBe(a.label);
    expect(currentMarks()!.nodes[a.id]).toBeUndefined();
  });

  test("main itself has nothing to compare and draws no marks", () => {
    mount();
    expect(lab.cur.id).toBe("main");
    expect(currentMarks()).toBeNull();
  });
});
