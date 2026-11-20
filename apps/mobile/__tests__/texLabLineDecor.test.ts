/**
 * @jest-environment jsdom
 */

/**
 * /lab, Lab live sandbox (approved mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): the test chat's simulated
 * line drawn on the canvas as two dashed pseudo-steps, "<line> line in" left of "A text arrives" and "<line> line out"
 * right of "Text them", lit and timed from the text's `lineIn` / `lineOut` steps, only while a test chat is open. They
 * are decorations: never nodes of the graph, never in a draft, never moved, wired, focused or deleted; a click shows
 * what the line did in Run details. Also: the Run details tabs on the floating card are the mockup's flat tabs.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *  1. `lineNodes` drawing with no test chat open        -> "nothing is drawn without a test chat" fails;
 *  2. `delSel` without its line guard                   -> "Delete on the line changes nothing and starts no draft" fails;
 *  3. the step-card tab rules scoped to `.props-pane`   -> "the Run details tabs are the mockup's flat tabs" fails.
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
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "@context/lab/app/TexLab.web";
import { clone, delSel, G, isMain, lab, MAIN, set } from "@context/lab/app/engine/state";
import { drawnFor } from "@context/lab/app/engine/groups";
import { resetSandboxState, rowOf, sandbox } from "@context/lab/app/engine/sandbox";
import { pickStep, resetPlay } from "@context/lab/app/engine/sandboxPlay";
import { lineNodes } from "@context/lab/app/engine/lineSteps";
import { lineDecorHtml, lineTimes } from "@context/lab/app/views/canvas/lineDecor";
import { LAB_CSS_CARD } from "@context/lab/app/labCssCard";
import { LAB_CSS_6 } from "@context/lab/app/labCss6";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  resetSandboxState();
});
beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  act(() => {
    resetPlay();
    set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", mode: "lab", viewer: null, cfocus: null, dirty: false, undoStack: [], pin: false, card: null, runTab: "sum" });
  });
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
/** A press and release on the canvas, as a pointer makes them. */
function press(el: Element) {
  const stage = q("#stage")!;
  act(() => void el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 5, clientY: 5 })));
  act(() => void stage.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 5, clientY: 5 })));
}
/** A test chat with one text: held 850 ms on the line in, Tex's step, then 640 ms on the line out. */
function openChat() {
  Object.assign(sandbox, {
    id: "sb1",
    line: { name: "photon", number: "+14155550142" },
    rows: [rowOf({ id: "m1", who: "Maya", text: "hi", steps: [{ node: "lineIn", out: "arrived", ms: 850 }, { node: "text", out: "in", ms: 2 }, { node: "send", out: "sent", ms: 300 }, { node: "lineOut", out: "delivered", ms: 640 }] })],
  });
  act(() => pickStep("m1", null));
}

describe("the line, drawn", () => {
  test("nothing is drawn without a test chat", () => {
    expect(lineNodes(G())).toEqual([]);
    expect(lineDecorHtml(G(), null, null)).toEqual({ under: "", over: "" });
    mount();
    expect(q("[data-line]")).toBeNull();
  });

  test("with one open, left of A text arrives and right of Text them, and never in the graph", () => {
    sandbox.id = "sb1";
    sandbox.line = { name: "photon" };
    const [i, o] = lineNodes(G());
    const text = drawnFor(G(), "text")!;
    const send = G().nodes.find((n) => n.id === "send")!;
    expect([i.id, i.label, i.x < text.x, i.y]).toEqual(["lineIn", "Photon line in", true, text.y]);
    expect([o.id, o.label, o.x > send.x, o.y]).toEqual(["lineOut", "Photon line out", true, send.y]);
    expect(G().nodes.some((n) => n.id === "lineIn" || n.id === "lineOut")).toBe(false);
    expect(lineTimes([{ node: "lineIn", ms: 800 }, { node: "lineOut", ms: 10 }, { node: "lineOut", ms: 5 }, { node: "fd", ms: 9 }])).toEqual({ lineIn: 800, lineOut: 15 });
    const html = lineDecorHtml(G(), null, new Map([["lineIn", 1], ["lineOut", 0.5]]), { lineIn: 850 }).over;
    expect(html).toMatch(/class="nd line lit done" data-line="lineIn"/);
    expect(html).toMatch(/class="nd line lit run" data-line="lineOut"/);
    expect(html).toContain(">850 ms</text>");
    expect(html).not.toContain("data-id=");
  });

  test("on the canvas: lit and timed by the text picked, and a click shows what the line did", () => {
    mount();
    openChat();
    const nodes = G().nodes.length;
    const li = q('#world [data-line="lineIn"]')!;
    expect(li.getAttribute("class")).toMatch(/\bline\b.*\blit\b/);
    expect(li.querySelector(".tm")?.textContent).toBe("850 ms");
    expect(q('#world [data-line="lineOut"] .tm')?.textContent).toBe("640 ms");
    expect(qa("#world .wire.lnw").length).toBe(2);
    press(li.querySelector(".card")!);
    expect(lab.sel).toEqual({ t: "node", id: "lineIn" });
    expect(q("#lineName")?.textContent).toBe("Photon line in");
    expect(q("#props .ph .st.ok")?.textContent).toBe("Ran");
    expect(q("#props .runmeta")?.textContent).toContain("0.8 s");
    // No settings, no focus: the line is not a step of Tex.
    expect(q("#cardSet")).toBeNull();
    expect(q("#props .pfocus")).toBeNull();
    expect(G().nodes.length).toBe(nodes);
    expect(lab.dirty).toBe(false);
  });

  test("Delete on the line changes nothing and starts no draft", () => {
    mount();
    openChat();
    act(() => set({ sel: { t: "node", id: "lineOut" } }));
    const before = JSON.stringify(G());
    act(() => delSel());
    expect(JSON.stringify(G())).toBe(before);
    expect(isMain()).toBe(true);
  });

  test("closing the test chat takes the line away", () => {
    mount();
    openChat();
    expect(qa("#world [data-line]").length).toBe(2);
    act(() => {
      resetSandboxState();
      set({});
    });
    expect(q("#world [data-line]")).toBeNull();
  });
});

test("the Run details tabs are the mockup's flat tabs", () => {
  mount();
  openChat();
  act(() => set({ sel: { t: "node", id: "send" }, pin: true }));
  const tab = q('#props .tabs [data-tab="sum"]')!;
  expect(tab.getAttribute("aria-pressed")).toBe("true");
  // Some rule for the pressed tab, and one for every tab, matches the tabs on the floating card.
  const css = LAB_CSS_6 + LAB_CSS_CARD;
  const selectorsOf = (needle: RegExp) =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => needle.test(m[1]))
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim());
  expect(selectorsOf(/\.tabs button\[aria-pressed=true\]/).some((s) => tab.matches(s))).toBe(true);
  expect(selectorsOf(/\.tabs button$/).some((s) => tab.matches(s))).toBe(true);
});
