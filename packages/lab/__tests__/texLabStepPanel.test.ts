/**
 * @jest-environment jsdom
 */

/**
 * /lab, Lab live sandbox (approved mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5), the step panel, the
 * change marks and the play speed: a changed step is outlined yellow and nothing else fades, moving a step is never
 * a change, the top bar's play speed sets `lab.speed`, the step panel's Run details card shows what a step logged for
 * the picked test text (and only a running step's elapsed time while it runs), its Settings card outlines each
 * changed field with "was ... on main", and the panel follows the running step until a node is clicked.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *  1. `computeMarks` marking a moved step again                           "moving a step is never a change" fails;
 *  2. `renderGraphHtml` putting `chg-same` back on unchanged steps         "a changed step is outlined and nothing else fades" fails;
 *  3. `stepRunOf` returning the logged step for a running one              "a running step shows only how long it has run" fails;
 *  4. `useFollowRunning` ignoring `lab.pin`                                "clicking a node pins the panel" fails.
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
jest.mock("../../../apps/mobile/features/site/host", () => ({ isTexHost: () => true }));
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { groupsOf } from "@context/lab/app/data/graph";
import { TexLab } from "@context/lab/app/TexLab.web";
import { clone, edit, G, lab, MAIN, set } from "@context/lab/app/engine/state";
import { computeMarks, currentMarks, markCounts } from "@context/lab/app/engine/changeMarks";
import { sandbox, rowOf } from "@context/lab/app/engine/sandbox";
import { pickStep, resetPlay } from "@context/lab/app/engine/sandboxPlay";
import { callsHeading, flat, humanKey, summaryOf, type RunStep } from "@context/lab/app/engine/stepRun";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
  return container;
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const click = (s: string) => {
  const el = q(s);
  expect(el).not.toBeNull();
  act(() => el!.click());
};

beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  Object.assign(sandbox, { id: "sb1", rows: [], running: null, hot: null });
  act(() => {
    resetPlay();
    set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", mode: "lab", viewer: null, cfocus: null, dirty: false, undoStack: [], pin: false, card: null, runTab: "sum", chg: "marks", chgVs: "main", speed: 0.5 });
  });
});

const first = () => MAIN.graph.nodes.find((n) => !n.group && !groupsOf(MAIN.graph)[n.id] && MAIN.graph.edges.some((e) => e.from === n.id))!;

describe("a draft's change marks", () => {
  test("moving a step is never a change", () => {
    const id = first().id;
    const cur = clone(MAIN).graph;
    const n = cur.nodes.find((x) => x.id === id)!;
    n.x += 120;
    n.y -= 60;
    const m = computeMarks(cur, MAIN.graph, "ghost", "main");
    expect(m.nodes[id]).toBeUndefined();
    expect(markCounts(m)).toEqual({ changed: 0, added: 0, removed: 0 });
  });

  test("a changed step is outlined and nothing else fades", () => {
    mount();
    const id = first().id;
    act(() =>
      edit(() => {
        const n = G().nodes.find((x) => x.id === id)!;
        n.label = "Renamed";
        n.x += 40;
      }),
    );
    expect(currentMarks()!.nodes[id].fields).toEqual(["name"]);
    expect(qa(".nd .chgo").length).toBe(1);
    expect(q(`.nd.chg-changed[data-id="${id}"] .chgo`)).not.toBeNull();
    // No badge, no tag, no label on the canvas, and no step or wire faded for the mark.
    expect(q(".mk")).toBeNull();
    expect(q(".mtag")).toBeNull();
    expect(q(".chg-same")).toBeNull();
    expect(q(".wsame")).toBeNull();
  });

  test("a step moved and nothing else draws no mark", () => {
    mount();
    const id = first().id;
    act(() => edit(() => void (G().nodes.find((x) => x.id === id)!.x += 80)));
    expect(currentMarks()!.nodes[id]).toBeUndefined();
    expect(q(".chgo")).toBeNull();
  });
});

describe("the play speed", () => {
  test("the top bar's speed button sets lab.speed for every playback", () => {
    mount();
    expect(q("#speedName")!.textContent).toBe("½×");
    click("#speedBtn");
    expect(qa("#speedMenu [data-speed]").map((b) => b.querySelector(".nm")!.textContent)).toEqual(["¼×", "½×", "1×", "2×", "4×"]);
    expect(q("#speedMenu")!.textContent).toContain("Real time");
    expect(q("#speedMenu")!.textContent).toContain("Tex itself always runs at real speed.");
    click('#speedMenu [data-speed="2"]');
    expect(lab.speed).toBe(2);
    expect(q("#speedName")!.textContent).toBe("2×");
  });
});

describe("the words of a step's output", () => {
  const step = (o: Record<string, unknown>, think?: string): RunStep => ({ node: "fd", out: "", ms: 1000, data: o, ...(think ? { think } : {}) });

  test("decided, wrote or sent, why and the details, with nested values on one line", () => {
    const s = summaryOf(step({ when: ["new text", "no reply yet"], reply: "On it.", why: "They asked.", confidence_pct: 90, picked: { who: "Maya", n: [1, 2] } }));
    expect(s.decided).toEqual(["new text", "no reply yet"]);
    expect(s.said).toEqual({ kind: "Wrote", text: "On it." });
    expect(s.why).toBe("They asked.");
    expect(s.details).toEqual([
      ["Confidence pct", "90"],
      ["Picked", "Who: Maya · N: 1, 2"],
    ]);
    expect(summaryOf(step({ sent: "Done." })).said).toEqual({ kind: "Sent", text: "Done." });
  });

  test("why falls back to the first sentence of the thinking; text out is read as JSON when it is", () => {
    expect(summaryOf({ node: "x", out: '{"when":"asked"}', ms: 1, ...{ think: "First thought. Second one." } }).why).toBe("First thought.");
    expect(summaryOf({ node: "x", out: "just words", ms: 1 })).toEqual({ decided: [], said: null, why: "", details: [] });
    expect(humanKey("a_b_c")).toBe("A b c");
    expect(flat({ a: { b: "x" }, c: [1, 2] })).toBe("A: B: x · C: 1, 2");
  });

  test("the tool calls' heading counts reads and writes, or says they ran in prod", () => {
    const c = (kind: "read" | "write" | "prod") => ({ tool: "t", kind, ms: 1, d: "" });
    expect(callsHeading([c("read"), c("read"), c("write")])).toBe("Tool calls · 2 real reads, 1 test write");
    expect(callsHeading([c("prod"), c("prod")])).toBe("Tool calls · 2 in prod");
  });

  test("a step as the gateway sends it keeps its optional fields", () => {
    const r = rowOf({ id: "a", who: "Maya", text: "hi", steps: [{ node: "fd", out: { when: ["x"] }, ms: 5, id: "s1", at: 10, tokIn: 7, cost: 0.5, calls: [{ tool: "read_note", kind: "read", ms: 3, d: "a note" }], think: "hmm" }] });
    expect(r.steps![0]).toMatchObject({ node: "fd", ms: 5, id: "s1", at: 10, tokIn: 7, cost: 0.5, think: "hmm", data: { when: ["x"] } });
    expect(r.steps![0].calls).toEqual([{ tool: "read_note", kind: "read", ms: 3, d: "a note" }]);
    expect(r.steps![0].out).toBe('{"when":["x"]}');
  });
});

describe("the step panel's cards", () => {
  const ran = () => {
    sandbox.rows = [
      rowOf({
        id: "m1",
        who: "Maya",
        text: "hi",
        steps: [
          { node: "fd", out: { when: ["new text"], reply: "Booked it.", why: "They asked for a table.", venue: { name: "Sample Cafe" } }, ms: 3400, tokIn: 1204, cost: 0.0123, think: "Check the calendar. Then book.", calls: [{ tool: "read_cal", kind: "read", ms: 40, d: "week" }, { tool: "add_event", kind: "write", ms: 12, d: "lunch" }] },
        ],
      }),
    ];
    act(() => pickStep("m1", null));
  };

  test("Run details is first once a text has run: tiles, decided, wrote, why, details and the calls", () => {
    mount();
    ran();
    act(() => set({ sel: { t: "node", id: "fd" }, pin: true }));
    expect(q("#cardRun")!.getAttribute("aria-pressed")).toBe("true");
    const t = q("#props")!.textContent!;
    // The status sits beside the step's name, as in the mockup.
    expect(q("#props .ph .st.ok")?.textContent).toBe("Ran");
    expect(q("#props .runhead .st")).toBeNull();
    expect(t).toContain("1.2k in");
    expect(t).toContain("$0.012");
    expect(t).toContain("Decided");
    expect(t).toContain("new text");
    expect(t).toContain("Wrote");
    expect(t).toContain("Booked it.");
    expect(t).toContain("They asked for a table.");
    expect(t).toContain("Venue");
    expect(t).toContain("Name: Sample Cafe");
    expect(t).toContain("Tool calls · 1 real read, 1 test write");
    expect(t).toContain("Real read");
    expect(t).toContain("Test write");
    expect(q("#nLabel")).not.toBeNull();
    // The run card never shows change info or settings.
    expect(q("#nModel")).toBeNull();
    expect(q("#setShort")).toBeNull();
    expect(q("#nChanges")).toBeNull();
    // The card floats on the canvas, and its foot says where the step's log comes from.
    expect(q(".archcv #props.ins")).not.toBeNull();
    expect(q("#insFoot")?.textContent).toMatch(/^Logged step · main@\w+ · tex_dev test_chat step$/);
    click('[data-tab="calls"]');
    expect(qa(".call").length).toBe(2);
    click('[data-tab="think"]');
    expect(q(".think")!.textContent).toContain("Check the calendar");
    click('[data-tab="in"]');
    expect(q(".runbody .empty")).not.toBeNull();
    // Another step opens on Summary, whichever tab the last one was on.
    act(() => set({ sel: { t: "node", id: "triage" } }));
    act(() => set({ sel: { t: "node", id: "fd" } }));
    expect(q('[data-tab="sum"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  test("a step that did not run for the text says so", () => {
    mount();
    ran();
    act(() => set({ sel: { t: "node", id: "triage" }, pin: true }));
    expect(q("#props .ph .st.none")?.textContent).toBe("Didn't run");
    expect(q("#insFoot")?.textContent).toBe("Nothing logged for this text");
    expect(q("#props")!.textContent).toContain("Didn't run for this text, so there's nothing to show.");
    expect(q(".tabs")).toBeNull();
  });

  test("a running step shows only how long it has run", () => {
    mount();
    sandbox.rows = [rowOf({ id: "m2", who: "Maya", text: "hello", steps: [{ node: "triage", out: "to: judge", ms: 2 }, { node: "fd", out: "SECRET OUTPUT", think: "SECRET THOUGHT", tokIn: 999, cost: 0.9, calls: [{ tool: "secret_tool", kind: "read", ms: 1, d: "" }] }] })];
    sandbox.running = "m2";
    sandbox.hot = "fd";
    act(() => set({ sel: { t: "node", id: "fd" }, pin: true }));
    const t = q("#props")!.textContent!;
    expect(t).toContain("Running");
    expect(t).toContain("Running now. What it decided, wrote and called lands here the moment it logs it; nothing is shown before it happens.");
    expect(t).not.toContain("SECRET");
    expect(t).not.toContain("999");
    expect(t).not.toContain("secret_tool");
    expect(q(".stat")).not.toBeNull();
    // The tabs stay, as the mockup's; each says only how long it has run.
    expect(qa(".tabs [data-tab]").map((b) => b.textContent)).toEqual(["Summary", "Output", "Input", "Thinking", "Calls"]);
    for (const k of ["out", "in", "think", "calls"]) {
      click(`[data-tab="${k}"]`);
      const body = q(".runbody")!.textContent!;
      expect(body).toMatch(/^Running for .*when it finishes\.$/);
      expect(q("#props")!.textContent).not.toMatch(/SECRET|999|secret_tool/);
    }
    act(() => set({ runTab: "sum" }));
  });

  test("Settings is the editable card; a field changed from main is outlined yellow with what main had, and the switch has a dot", () => {
    mount();
    ran();
    act(() => set({ sel: { t: "node", id: "fd" }, pin: true }));
    expect(q("#cardDot")).toBeNull();
    click("#cardSet");
    // The mockup's short list; the rest is behind More settings.
    expect(q("#setShort")).not.toBeNull();
    expect(q("#setModel")).not.toBeNull();
    expect(q("#nModel")).toBeNull();
    expect(q("#props .ph .st")).toBeNull();
    expect(q("#insFoot")?.textContent).toBe("main: a change starts your own copy · tex_dev node set");
    expect(q(".chgf")).toBeNull();
    const was = G().nodes.find((n) => n.id === "fd")!.effort;
    act(() =>
      edit(() => {
        G().nodes.find((n) => n.id === "fd")!.effort = was === "low" ? "high" : "low";
      }),
    );
    expect(q("#cardDot")).not.toBeNull();
    expect(q('#setShort [data-field="effort"].chgf #setEffort')).not.toBeNull();
    expect(qa(".chgf").length).toBe(1);
    expect(q('#setShort [data-field="effort"] .was')?.textContent).toBe(`was ${was} on main`);
    expect(q("#insFoot")?.textContent).toMatch(/^Draft .+ · saved as you change it · tex_dev node set$/);
    // More settings opens the full panel, its own field outlined too.
    expect(q("#nMore")?.textContent).toBe("More settings ▾");
    click("#nMore");
    expect(q("#nEffort.chgf")).not.toBeNull();
    expect(q("#nGoal")).not.toBeNull();
    click("#nMore");
    expect(q("#nGoal")).toBeNull();
    expect(q("#props")!.textContent).toContain("settings in draft");
    click("#cardRun");
    expect(q("#cardDot")).not.toBeNull();
    expect(q(".chgf")).toBeNull();
    expect(q("#props")!.textContent).not.toContain("on main");
  });
});

describe("a code step's own settings", () => {
  test("Settings draws what the step's code declares; a change is outlined with main's value, and a number out of bounds is not saved", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "finish" }, pin: true }));
    click("#cardSet");
    expect(q(".stepsec")?.textContent).toBe("Settingsfrom the code");
    const sw = q("#step-set-trimFlattery")!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(q("#step-set-linkSavedNote")).not.toBeNull();
    expect(q('[data-setting="trimFlattery"].chgf')).toBeNull();
    click("#step-set-trimFlattery");
    expect(q("#step-set-trimFlattery")!.getAttribute("aria-checked")).toBe("false");
    expect(G().nodes.find((n) => n.id === "finish")!.settings).toEqual({ trimFlattery: false, linkSavedNote: true, dropStaleAnswer: true });
    expect(q('[data-setting="trimFlattery"].chgf .was')?.textContent).toBe("was on, on main");
    expect(q('[data-setting="linkSavedNote"].chgf')).toBeNull();

    act(() => set({ sel: { t: "node", id: "claimChecks" }, pin: true }));
    const box = q("#step-set-proseWords") as HTMLInputElement;
    expect(box.value).toBe("70");
    act(() => {
      box.value = "5";
      box.dispatchEvent(new Event("change"));
    });
    expect(q('[data-setting="proseWords"] [role="alert"]')?.textContent).toBe("Prose limit must be a whole number from 20 to 400. Not saved.");
    expect(G().nodes.find((n) => n.id === "claimChecks")!.settings?.proseWords).toBe(70);
    const box2 = q("#step-set-proseWords") as HTMLInputElement;
    act(() => {
      box2.value = "120";
      box2.dispatchEvent(new Event("change"));
    });
    expect(G().nodes.find((n) => n.id === "claimChecks")!.settings?.proseWords).toBe(120);
    expect(q('[data-setting="proseWords"] [role="alert"]')).toBeNull();
    expect(q('[data-setting="proseWords"].chgf .was')?.textContent).toBe("was 70 on main");
  });

  test("a step whose code declares no settings shows no section", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" }, pin: true }));
    click("#cardSet");
    expect(q(".stepsec")).toBeNull();
  });
});

describe("following the running step", () => {
  test("the panel follows the step running, a click on a node pins it, and Follow running lets go", () => {
    mount();
    sandbox.rows = [rowOf({ id: "m3", who: "Maya", text: "yo", steps: [{ node: "triage", out: "x", ms: 2 }, { node: "decide", out: "y" }] })];
    sandbox.running = "m3";
    sandbox.hot = "decide";
    act(() => set({}));
    expect(lab.sel).toEqual({ t: "node", id: "decide" });
    expect(q("#insFollow")!.textContent).toBe("● Following");

    // The run moves on: the panel moves with it.
    sandbox.hot = "fd";
    act(() => set({}));
    expect(lab.sel).toEqual({ t: "node", id: "fd" });

    // A click on a node (the canvas sets pin with the selection) holds the panel there.
    act(() => set({ sel: { t: "node", id: "triage" }, pin: true }));
    sandbox.hot = "tools";
    act(() => set({}));
    expect(lab.sel).toEqual({ t: "node", id: "triage" });
    expect(q("#insFollow")!.textContent).toBe("Follow running");

    click("#insFollow");
    expect(lab.pin).toBe(false);
    expect(lab.sel).toEqual({ t: "node", id: "tools" });
  });
});
