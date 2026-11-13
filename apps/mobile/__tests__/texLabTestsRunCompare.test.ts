/**
 * @jest-environment jsdom
 */

/**
 * tex.lc/admin/lab's Tests, Run, Compare and Workspace views, actually rendered: the whole route mounted with the
 * staff answer it uses, then each page reached by its nav row. What it proves: the fit warnings say what a version
 * has lost against a case; the report reader takes a pasted "## Tex replay" block apart; the prompt a session gets
 * names the version and ends with its config; a case can be run, edited, undone and added, and each change forks
 * main first; the search filters the cards; a model change shows on Run as a setup change with its warning; a saved
 * version's run numbers show on Compare and open on a click; a workspace's notes open from their row.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-13):
 *   (a) tests/caseParts.tsx `caseFit` returning [] always        "a version without Decide says so" and the off, reads
 *       and act fit tests fail
 *   (b) Tests.web.tsx `pickEdit` skipping `forkFromMain`          "unticking a case forks main" fails
 *   (c) run/runText.ts `parseReport` area regex broken            "a passing report", "a failing report" and the Run
 *       results row fail
 *
 * Found by these tests and fixed: the artifact's `parseReport` cost capture `\$([\d.]+)` took the sentence's
 * closing period, so "spent about $0.00." read usd NaN. The two report tests assert the stated cost.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
let mockTexHost = true;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      return args === "skip" ? undefined : mockAnswers.get(name);
    },
    useMutation: () => async () => null,
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => mockTexHost }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
// jsdom has no CSS.escape; the browser has it. The case editor's Keep uses it to find its own boxes.
if (!("CSS" in globalThis)) {
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch) };
}

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import TexLabRoute from "../app/(app)/admin/lab";
import { AREAS } from "../features/tex/lab/data/areas";
import { BASE_MODELS } from "../features/tex/lab/data/models";
import { CASES } from "../features/tex/lab/labData.generated";
import { config } from "../features/tex/lab/engine/diff";
import { mods } from "../features/tex/lab/engine/modules";
import { clone, emit, lab, MAIN } from "../features/tex/lab/engine/state";
import { caseFit } from "../features/tex/lab/views/tests/caseParts";
import { parseReport, promptText } from "../features/tex/lab/views/run/runText";
import { Workspace } from "../features/tex/lab/views/Workspace.web";
import type { LabCase, LabNode } from "../features/tex/lab/types";

/** Put the Lab's shared state back where a fresh page load leaves it, so each test stands alone. */
function resetLab() {
  lab.cur = clone(MAIN);
  lab.versions = [MAIN];
  lab.caseEdits = {};
  lab.dirty = false;
  lab.tArea = "core";
  lab.tQ = "";
  lab.view = "canvas";
  lab.viewer = null;
  lab.sel = null;
  lab.cfocus = null;
  lab.toastText = null;
  MAIN.results = [];
}

const roots: Array<() => void> = [];
function render(el: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(el));
  return container;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockTexHost = true;
});

beforeEach(() => {
  resetLab();
});

const ADMIN = "functions/admin:amIAdmin";
const LIST = "functions/texLab:list";

/** The route, as staff: the Lab mounts and its shared list comes back empty (only main). */
function mountLab(): HTMLElement {
  mockAnswers.set(ADMIN, true);
  mockAnswers.set(LIST, { me: "u1", versions: [], caseEdits: [] });
  return render(createElement(TexLabRoute));
}

const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const qa = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)];
function click(el: Element | null | undefined) {
  if (!el) throw new Error("expected an element to click");
  act(() => (el as HTMLElement).click());
}
/** Set a field's value the way React sees a typed value: the native setter, then an input event. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const view = (name: string) => click(q(`[data-view="${name}"]`));
/** Open the Tests page on an area; the area click also drops any open case editor, as the page does. */
function openTests(area = "core") {
  view("tests");
  click(q(`[data-area="${area}"]`));
}
const hintOf = () => q(".tbar .hint")?.textContent?.trim();
const cardOf = (id: string) => qa(".cid").find((e) => e.textContent === id)?.closest("article") ?? null;
const pillsOf = (el: Element | null) => [...(el?.querySelectorAll(".pill") ?? [])].map((p) => p.textContent?.trim());

const respondCases = () => CASES.filter((c) => c.area === "respond");
const coreCount = () => CASES.filter((c) => c.area === "core").length;
const DECIDE_LABEL = MAIN.graph.nodes.find((n) => n.id === "decide")!.label;
const RECENT_NAME = mods(MAIN.graph).recent.name;

function decideNode(): LabNode {
  return lab.cur.graph.nodes.find((n) => n.id === "decide")!;
}

describe("caseFit: what a version has lost against a case", () => {
  const respond = (): LabCase => respondCases()[0];

  test("on main every respond case fits, with no warnings", () => {
    expect(respondCases().length).toBeGreaterThan(0);
    for (const c of respondCases()) expect(caseFit(c)).toEqual([]);
  });

  test("a version without the step says it has no Decide", () => {
    lab.cur.graph = { ...lab.cur.graph, nodes: lab.cur.graph.nodes.filter((n) => n.id !== "decide") };
    expect(caseFit(respond())).toEqual([`This version has no ${DECIDE_LABEL}`]);
  });

  test("a step switched off says it is off", () => {
    decideNode().on = false;
    expect(caseFit(respond())).toEqual([`${DECIDE_LABEL} is off`]);
  });

  test("a step that no longer reads a module the case gives says so, by the module's name", () => {
    decideNode().ctx = decideNode().ctx.filter((k) => k !== "recent");
    expect(caseFit(respond())).toEqual([`${DECIDE_LABEL} no longer reads ${RECENT_NAME}`]);
  });

  test("a step whose output no longer has the act field says it no longer answers it", () => {
    decideNode().outSchema = decideNode().outSchema!.filter((f) => f.name !== "act");
    expect(caseFit(respond())).toEqual([`checks act, which ${DECIDE_LABEL} no longer answers`]);
  });
});

describe("parseReport: a pasted Tex replay report", () => {
  test("a passing report gives the pass, the headline, each area's numbers and no regressions", () => {
    const r = parseReport("## Tex replay: ✅ nothing regressed\n**core:** practice 17/19 right, held-out 9/10 right; spent about $0.00.");
    expect(r.pass).toBe(true);
    expect(r.headline).toBe("nothing regressed");
    expect(r.areas.core).toEqual({ practice: [17, 19], held: [9, 10], usd: 0 });
    expect(r.regressed).toBe(0);
  });

  test("a failing report counts the regressed cases", () => {
    const r = parseReport("## Tex replay: ❌ 2 case(s) regressed\n**core:** practice 15/19 right, held-out 8/10 right; spent about $0.12.");
    expect(r.pass).toBe(false);
    expect(r.regressed).toBe(2);
    expect(r.areas.core).toEqual({ practice: [15, 19], held: [8, 10], usd: 0.12 });
  });

  test("text without a headline is unread: no pass, no regressed count", () => {
    const r = parseReport("some notes from a run, with no report block");
    expect(r.pass).toBeUndefined();
    expect(r.regressed).toBeNull();
    expect(r.areas).toEqual({});
  });
});

describe("promptText: what a Claude Code session is handed", () => {
  test("on main it names main, says a run is a baseline, gives the run command, and ends with the config", () => {
    const c = config();
    const text = promptText(c);
    expect(text).toContain('Tex lab run for version "main"');
    expect(text).toContain("   - nothing (a baseline run)");
    expect(text).toContain("pnpm ai lab run --config lab.json");
    expect(text.endsWith(JSON.stringify(c))).toBe(true);
  });
});

describe("tex.lc/admin/lab: the Tests, Run, Compare and Workspace views", () => {
  test("Tests: the area nav lists every area, and a click shows that area's respond cases", () => {
    mountLab();
    view("tests");

    const keys = qa("[data-area]").map((e) => e.getAttribute("data-area"));
    expect([...keys].sort()).toEqual(Object.keys(AREAS).sort());
    for (const k of Object.keys(AREAS)) expect(q(`[data-area="${k}"] .an`)?.textContent?.startsWith(AREAS[k])).toBe(true);

    click(q('[data-area="respond"]'));
    expect(q('[data-area="respond"]')?.getAttribute("aria-current")).toBe("true");
    const n = respondCases().length;
    expect(qa(".tc").length).toBe(n);
    expect(hintOf()).toBe(`${n} of ${n} in the run`);
  });

  test("Tests: unticking a case forks main; All ticks every case back and None unticks them all", () => {
    mountLab();
    openTests("core");
    const n = coreCount();
    expect(hintOf()).toBe(`${n} of ${n} in the run`);

    const box = q<HTMLInputElement>("[data-pick]")!;
    const id = box.getAttribute("data-pick")!;
    click(box);

    expect(lab.cur.name).toBe("My version");
    expect(lab.dirty).toBe(true);
    expect(cardOf(id)?.classList.contains("off")).toBe(true);
    expect(hintOf()).toBe(`${n - 1} of ${n} in the run`);

    click(q("#selAll"));
    expect(hintOf()).toBe(`${n} of ${n} in the run`);
    expect(qa(".tc.off").length).toBe(0);

    click(q("#selNone"));
    expect(hintOf()).toBe(`0 of ${n} in the run`);
    expect(qa(".tc.off").length).toBe(n);
  });

  test("Tests: the search box filters the cards by case id", () => {
    mountLab();
    openTests("respond");
    const term = respondCases()[0].id;
    setValue(q<HTMLInputElement>("#caseQ")!, term);

    const shown = qa(".cid").map((e) => e.textContent);
    const expected = respondCases()
      .filter((c) => (c.id + " " + c.ask + " " + c.expect).toLowerCase().includes(term))
      .map((c) => c.id);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(respondCases().length);
    expect(shown).toEqual(expected);
  });

  test("Tests: editing a case opens its text, Keep saves it and shows edited, and Back to main's drops it", () => {
    mountLab();
    openTests("respond");
    const c = respondCases()[0];
    const id = c.id;

    click(q(`[data-edit="${id}"]`));
    const ask = q<HTMLTextAreaElement>(`[data-ask="${id}"]`)!;
    expect(ask.value).toBe(c.ask);

    setValue(ask, "A new text for the test");
    click(q(`[data-savecase="${id}"]`));
    expect(lab.caseEdits[`respond/${id}`]).toMatchObject({ area: "respond", id, ask: "A new text for the test" });
    expect(pillsOf(cardOf(id))).toContain("edited");

    click(q(`[data-edit="${id}"]`));
    expect(q<HTMLTextAreaElement>(`[data-ask="${id}"]`)?.value).toBe("A new text for the test");
    click(q(`[data-undo="${id}"]`));
    expect(lab.caseEdits[`respond/${id}`]).toBeUndefined();
    expect(pillsOf(cardOf(id))).not.toContain("edited");
  });

  test("Tests: Case adds a new case in the area, with the new pill", () => {
    mountLab();
    openTests("core");
    click(q("#addCase"));

    expect(lab.caseEdits["core/new-1"]).toMatchObject({ area: "core", id: "new-1", isNew: true });
    expect(pillsOf(cardOf("new-1"))).toContain("new");
    expect(hintOf()).toBe(`${coreCount() + 1} of ${coreCount() + 1} in the run`);
  });

  test("Run: on main it is a baseline; an area click forks main and toggles; a pasted report is kept as a results row", () => {
    mountLab();
    view("run");
    expect(q("#v-run")?.textContent).toContain("Same as main. A run now is a baseline.");

    const ra = q('[data-ra="respond"]')!;
    expect(ra.getAttribute("aria-pressed")).toBe("false");
    click(ra);
    expect(lab.cur.name).toBe("My version");
    expect(q('[data-ra="respond"]')?.getAttribute("aria-pressed")).toBe("true");

    setValue(q<HTMLTextAreaElement>("#resIn")!, "## Tex replay: ✅ nothing regressed\n**core:** practice 17/19 right, held-out 9/10 right; spent about $0.00.");
    click(q("#resBtn"));

    const row = qa("#v-run tr").find((tr) => tr.textContent?.includes("nothing regressed"));
    expect(row).toBeDefined();
    expect(row?.textContent).toContain("Front door and prompt 17/19 · held-out 9/10");
    expect(lab.cur.results.length).toBe(1);
  });

  test("Run: a model change on a step shows as a setup change, with the model-swap warning", () => {
    expect(BASE_MODELS["sonnet-5-5"]).toBeDefined();
    const fork = clone(MAIN);
    fork.id = "v-model";
    fork.name = "Sonnet front door";
    fork.authorId = null;
    fork.graph.nodes.find((n) => n.id === "fd")!.model = "sonnet-5-5";
    lab.cur = fork;
    lab.dirty = true;
    emit();

    mountLab();
    view("run");

    const row = qa("#v-run tr").find((tr) => tr.querySelector("td") && tr.textContent?.includes("Haiku 5.5"));
    expect(row).toBeDefined();
    expect(row?.textContent).toContain("model");
    expect(row?.textContent).toContain("Sonnet 5.5");
    expect(row?.textContent).toContain("setup: models.main");
    expect(qa(".callout").some((c) => c.textContent?.startsWith("A model swap only proves the wiring here"))).toBe(true);
  });

  test("Compare: main is live, a saved version shows its run numbers, and its row opens it on the canvas", () => {
    mountLab();
    // Added after mount: the shared list's sync replaces lab.versions when it first arrives.
    const saved = clone(MAIN);
    saved.id = "v-saved";
    saved.name = "Faster judge";
    saved.authorId = "u2";
    saved.results = [{ at: 1, areas: { core: { practice: [3, 4], held: [1, 2], usd: 0 } }, raw: "" }];
    lab.versions = [MAIN, saved];
    emit();
    view("compare");

    const mainRow = q('[data-cv="main"]')!.closest("tr");
    expect(mainRow?.textContent).toContain("live");

    const savedRow = q('[data-cv="v-saved"]')!.closest("tr");
    expect(savedRow?.textContent).toContain("3/4");
    expect(savedRow?.textContent).toContain("held 1/2");

    click(q('[data-cv="v-saved"]'));
    expect(lab.cur.id).toBe("v-saved");
    expect(lab.view).toBe("canvas");
    expect(q("#v-canvas")?.hasAttribute("hidden")).toBe(false);
  });

  test("Workspace: the header names the workspace and its path, a note row opens it, and the close button clears it", () => {
    const container = render(createElement(Workspace, { ws: "maya" }));
    expect(container.querySelector("b")?.textContent).toBe("maya");
    expect(container.textContent).toContain("apps/mcp/bench/ai/workspaces/maya");

    const rows = container.querySelectorAll<HTMLElement>("[data-wf]");
    expect(rows.length).toBeGreaterThan(0);
    const path = rows[0].getAttribute("data-wf")!;
    act(() => rows[0].click());
    expect(lab.viewer).toEqual({ kind: "ws", ws: "maya", at: path });

    act(() => (container.querySelector("#vX") as HTMLElement).click());
    expect(lab.viewer).toBeNull();
  });
});
